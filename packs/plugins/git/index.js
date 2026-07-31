/**
 * Read-only git feature pack.
 * Status branch chip, Source Control sidebar, gutter marks, palette refresh/focus.
 * No mutating git commands.
 */
import * as Editor from 'Module/editor';
import { createScmView } from '/rom/plugins/git/scmView.js';

const SOURCE_GIT = 'git.diff';
const SOURCE_UNSAVED = 'editor.unsaved';
const REFRESH_MS = 120;
const LCS_CELL_CAP = 1_500_000;

async function git(cwd, args)
{
  try
  {
    return await Editor.runCommand({ cmd: 'git', args, cwd });
  }
  catch(e)
  {
    return { code: 127, stdout: '', stderr: String(e && e.message ? e.message : e) };
  }
}

function relPath(workspaceRoot, absPath)
{
  const root = String(workspaceRoot || '').replace(/\/+$/, '');
  const p = String(absPath || '');
  if(root && p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

function marksFromUnifiedDiff(diffText)
{
  const marks = [];
  const lines = String(diffText || '').split('\n');
  for(const line of lines)
  {
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if(!m) continue;
    const oldCount = m[2] !== undefined ? (m[2] | 0) : 1;
    const newStart = (m[3] | 0);
    const newCount = m[4] !== undefined ? (m[4] | 0) : 1;
    if(newCount === 0 && oldCount > 0)
      marks.push({ row: Math.max(0, newStart - 1), type: 'deleted' });
    else if(oldCount === 0 && newCount > 0)
    {
      for(let i = 0; i < newCount; i++)
        marks.push({ row: newStart - 1 + i, type: 'added' });
    }
    else
    {
      for(let i = 0; i < newCount; i++)
        marks.push({ row: newStart - 1 + i, type: 'modified' });
    }
  }
  return marks;
}

function marksFromLineDiff(oldText, newText)
{
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  // Same line count: mark only rows that actually differ (avoids LCS on 9k-line files).
  if(a.length === b.length)
  {
    let i0 = 0;
    while(i0 < a.length && a[i0] === b[i0]) i0++;
    if(i0 >= a.length) return [];
    let i1 = a.length - 1;
    while(i1 > i0 && a[i1] === b[i1]) i1--;
    const marks = [];
    for(let i = i0; i <= i1; i++)
    {
      if(a[i] !== b[i]) marks.push({ row: i, type: 'modified' });
    }
    return marks;
  }
  let start = 0;
  while(start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while(aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd])
  {
    aEnd--;
    bEnd--;
  }
  const aMid = a.slice(start, aEnd + 1);
  const bMid = b.slice(start, bEnd + 1);
  if(aMid.length === 0 && bMid.length === 0) return [];
  if(aMid.length === 0)
    return bMid.map((_, i) => ({ row: start + i, type: 'added' }));
  if(bMid.length === 0)
  {
    const row = b.length === 0 ? 0 : Math.min(start, b.length - 1);
    return [{ row: Math.max(0, row), type: 'deleted' }];
  }

  const n = aMid.length;
  const m = bMid.length;
  if(n * m > LCS_CELL_CAP)
  {
    if(n === m)
    {
      const marks = [];
      for(let i = 0; i < m; i++)
      {
        if(aMid[i] !== bMid[i]) marks.push({ row: start + i, type: 'modified' });
      }
      return marks;
    }
    return bMid.map((_, i) => ({ row: start + i, type: 'modified' }));
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for(let i = 1; i <= n; i++)
  {
    for(let j = 1; j <= m; j++)
    {
      dp[i][j] = aMid[i - 1] === bMid[j - 1]
        ? (dp[i - 1][j - 1] + 1)
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while(i > 0 || j > 0)
  {
    if(i > 0 && j > 0 && aMid[i - 1] === bMid[j - 1])
    {
      ops.push('eq');
      i--;
      j--;
    }
    else if(j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j]))
    {
      ops.push({ t: 'ins', j: j - 1 });
      j--;
    }
    else
    {
      ops.push({ t: 'del' });
      i--;
    }
  }
  ops.reverse();

  const marks = [];
  let k = 0;
  let bCursor = start;
  while(k < ops.length)
  {
    if(ops[k] === 'eq')
    {
      bCursor++;
      k++;
      continue;
    }
    const dels = [];
    const ins = [];
    while(k < ops.length && ops[k] !== 'eq')
    {
      if(ops[k].t === 'del') dels.push(ops[k]);
      else ins.push(ops[k]);
      k++;
    }
    const paired = Math.min(dels.length, ins.length);
    for(let p = 0; p < paired; p++)
      marks.push({ row: start + ins[p].j, type: 'modified' });
    for(let p = paired; p < ins.length; p++)
      marks.push({ row: start + ins[p].j, type: 'added' });
    if(dels.length > paired)
    {
      const row = ins.length
        ? start + ins[ins.length - 1].j
        : Math.max(0, Math.min(bCursor, Math.max(0, b.length - 1)));
      marks.push({ row, type: 'deleted' });
    }
    if(ins.length) bCursor = start + ins[ins.length - 1].j + 1;
  }
  return marks;
}

export async function init(host)
{
  const root = host.workspaceRoot;
  let branchHandle = null;
  let scmHandle = null;
  let scmView = null;
  let timer = null;
  let inFlight = false;
  let pending = false;
  let disposed = false;
  let lastPorcelain = '';
  /** @type {{ unregister: Function }[]} */
  const cmdHandles = [];

  const clearMarks = () => {
    try { host.editor.clearLineMarks(SOURCE_GIT); } catch(e) { void e; }
    try { host.editor.clearLineMarks(SOURCE_UNSAVED); } catch(e) { void e; }
  };

  /** Tear down repo UI only — keep palette commands registered. */
  const clearRepoUi = async () => {
    if(branchHandle)
    {
      try { await branchHandle.remove(); } catch(e) { void e; }
      branchHandle = null;
    }
    if(scmHandle)
    {
      try { await scmHandle.remove(); } catch(e) { void e; }
      scmHandle = null;
    }
    if(scmView)
    {
      try { await scmView.dispose(); } catch(e) { void e; }
      scmView = null;
    }
    lastPorcelain = '';
    clearMarks();
  };

  const disposeAll = async () => {
    for(const h of cmdHandles)
    {
      try { h.unregister(); } catch(e) { void e; }
    }
    cmdHandles.length = 0;
    await clearRepoUi();
  };

  const setUnsavedMarks = (doc) => {
    if(doc && doc.path && doc.dirty && typeof doc.savedText === 'string')
      host.editor.setLineMarks(SOURCE_UNSAVED, marksFromLineDiff(doc.savedText, doc.text));
    else
      host.editor.clearLineMarks(SOURCE_UNSAVED);
  };

  const setGitMarks = async (doc) => {
    if(!doc || !doc.path || doc.untitled || String(doc.path).startsWith('untitled:'))
    {
      host.editor.clearLineMarks(SOURCE_GIT);
      return;
    }
    const rel = relPath(root, doc.path);
    const diff = await git(root, [
      'diff', '-U0', '--no-color', 'HEAD', '--', rel || doc.path
    ]);
    if(diff.code !== 0 && !(diff.stdout || '').length)
    {
      host.editor.clearLineMarks(SOURCE_GIT);
      return;
    }
    host.editor.setLineMarks(SOURCE_GIT, marksFromUnifiedDiff(diff.stdout));
  };

  const ensureScm = async () => {
    if(scmHandle || disposed) return;
    if(!host.sidebar || typeof host.sidebar.contribute !== 'function') return;
    scmHandle = await host.sidebar.contribute({
      id: 'git.scm',
      title: 'Source Control',
      icon: '⎇',
      order: 20,
      async mount(container)
      {
        scmView = await createScmView(host.win, container, {
          openFile: async (path) => { await host.openFile(path, { preview: true }); },
          onRefresh: async () => { await refresh(); }
        });
        await scmView.setStatus(lastPorcelain, root);
      },
      async unmount()
      {
        if(scmView)
        {
          try { await scmView.dispose(); } catch(e) { void e; }
          scmView = null;
        }
      }
    });
  };

  const refresh = async () => {
    if(disposed) return;
    if(inFlight)
    {
      pending = true;
      return;
    }
    inFlight = true;
    try
    {
      const doc = host.getActiveDoc();
      setUnsavedMarks(doc);

      const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const inRepo = head.code === 0;
      if(!inRepo)
      {
        await clearRepoUi();
        return;
      }

      await ensureScm();

      const branch = String(head.stdout || '').trim() || 'HEAD';
      const st = await git(root, ['status', '--porcelain']);
      const dirty = st.code === 0 && String(st.stdout || '').trim().length > 0;
      const label = dirty ? `${branch}*` : branch;
      lastPorcelain = st.code === 0 ? (st.stdout || '') : '';

      if(!branchHandle)
      {
        branchHandle = await host.status.contribute({
          id: 'git.branch',
          side: 'left',
          order: 10,
          icon: '⎇',
          text: label,
          onClick: async () => {
            if(scmHandle && scmHandle.focus) await scmHandle.focus();
            else if(host.sidebar.focus) await host.sidebar.focus('git.scm');
          }
        });
      }
      else
        await branchHandle.set({ text: label });

      if(scmView)
        await scmView.setStatus(lastPorcelain, root);

      await setGitMarks(doc);
    }
    finally
    {
      inFlight = false;
      if(pending && !disposed)
      {
        pending = false;
        void refresh();
      }
    }
  };

  const schedule = () => {
    if(disposed) return;
    // Do not diff the full buffer synchronously on every keystroke — that
    // splits ~9k-line files twice per character. Debounced refresh is enough.
    if(timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, REFRESH_MS);
  };

  if(host.commands && typeof host.commands.register === 'function')
  {
    cmdHandles.push(host.commands.register({
      id: 'git.refresh',
      title: 'Refresh',
      category: 'Git',
      run: async () => { await refresh(); }
    }));
    cmdHandles.push(host.commands.register({
      id: 'git.focusScm',
      title: 'Focus Source Control',
      category: 'Git',
      run: async () => {
        await ensureScm();
        if(scmHandle && scmHandle.focus) await scmHandle.focus();
        else if(host.sidebar.focus) await host.sidebar.focus('git.scm');
      }
    }));
  }

  host.on('ready', schedule);
  host.on('docOpened', schedule);
  host.on('docSaved', schedule);
  host.on('docChanged', schedule);
  host.on('activeDocChanged', schedule);

  await refresh();

  return {
    async dispose()
    {
      disposed = true;
      if(timer) clearTimeout(timer);
      await disposeAll();
    }
  };
}
