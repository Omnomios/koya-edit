/**
 * Read-only Source Control list UI for the git pack.
 */
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import { theme } from '/rom/theme.js';
import { estimateLabelSize } from '/rom/shell/layout.js';
import { basename } from '/rom/editor/buffer.js';

function settled(promise)
{
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

/**
 * Git porcelain wraps unusual pathnames in C-style double quotes
 * (e.g. `"this is dog.txt"`). Strip that so open/diff use real paths.
 */
function unquoteGitPath(path)
{
  let s = String(path || '').trim();
  if(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))
  {
    s = s.slice(1, -1);
    s = s.replace(/\\([\\"ntr])/g, (_, c) => {
      if(c === 'n') return '\n';
      if(c === 't') return '\t';
      if(c === 'r') return '\r';
      return c;
    });
  }
  return s;
}

function parsePorcelain(text)
{
  const staged = [];
  const changes = [];
  const lines = String(text || '').split('\n');
  for(const line of lines)
  {
    if(line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    if(path.includes(' -> ')) path = path.split(' -> ').pop();
    path = unquoteGitPath(path);
    if(!path) continue;
    if(x === '?' && y === '?')
    {
      changes.push({ path, code: 'U', label: 'U' });
      continue;
    }
    if(x !== ' ' && x !== '?')
      staged.push({ path, code: x, label: x });
    if(y !== ' ' && y !== '?')
      changes.push({ path, code: y, label: y });
  }
  return { staged, changes };
}

/**
 * @param {object} opts
 * @param {(path: string) => Promise<void>} opts.openFile
 * @param {() => Promise<void>} [opts.onRefresh]
 */
export async function createScmView(win, container, opts = {})
{
  const openFile = typeof opts.openFile === 'function' ? opts.openFile : async () => {};
  const onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : async () => {};
  const rowH = theme.treeRowHeight || 26;
  const fontSize = theme.fontSizeUiSm;
  const maxRows = 80;

  const root = await UI.createElement(win, {
    layout: {
      type: 'column',
      gap: 0,
      padding: { l: 0, r: 0, t: 8, b: 8 }
    },
    item: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
    contentAlign: 'fill',
    clipToBounds: true
  });
  await UI.attach(win, container, root);

  const header = await UI.createElement(win, {
    layout: {
      type: 'row',
      gap: 8,
      padding: { l: 12, r: 12, t: 0, b: 0 },
      alignItems: 'center'
    },
    item: { size: { y: 28 }, flexShrink: 0 },
    contentAlign: 'fill'
  });
  await UI.attach(win, root, header);

  const title = await UI.createElement(win, {
    renderable: {
      type: 'text',
      string: 'Source Control',
      size: theme.fontSizeUi,
      font: theme.fontUi,
      colour: theme.text,
      metricsBasis: 'line',
      justify: 'left',
      vAlign: 'center'
    },
    item: { size: { x: 140, y: 28 }, flexGrow: 1 },
    contentAlign: { x: 'start', y: 'center' }
  });
  await UI.attach(win, header, title);

  const refreshBtn = await UI.createElement(win, {
    renderable: {
      type: 'text',
      string: '↻',
      size: 14,
      font: theme.fontIcon,
      colour: theme.textMuted,
      metricsBasis: 'line',
      justify: 'center',
      vAlign: 'center'
    },
    item: { size: { x: 24, y: 28 }, flexShrink: 0 },
    contentAlign: { x: 'center', y: 'center' }
  });
  await UI.attach(win, header, refreshBtn);
  await UI.setOnMouseDown(win, refreshBtn, async () => {
    await onRefresh();
  });

  const list = await UI.createElement(win, {
    layout: { type: 'column', gap: 0 },
    item: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
    contentAlign: 'fill',
    clipToBounds: true
  });
  await UI.attach(win, root, list);

  /** @type {{ root: number, badge: number, label: number, path: string, kind: string }[]} */
  const rows = [];
  for(let i = 0; i < maxRows; i++)
  {
    const rowRoot = await UI.createElement(win, {
      renderable: { type: 'box', colour: [0, 0, 0, 0] },
      layout: {
        type: 'row',
        gap: 8,
        padding: { l: 12, r: 8, t: 0, b: 0 },
        alignItems: 'center'
      },
      item: { size: { y: rowH }, flexShrink: 0 },
      contentAlign: 'fill'
    });
    const badge = await UI.createElement(win, {
      renderable: {
        type: 'text',
        string: ' ',
        size: fontSize,
        font: theme.fontMono,
        colour: theme.primary,
        metricsBasis: 'line',
        justify: 'center',
        vAlign: 'center'
      },
      item: { size: { x: 16, y: rowH }, flexShrink: 0 },
      contentAlign: { x: 'center', y: 'center' }
    });
    const label = await UI.createElement(win, {
      renderable: {
        type: 'text',
        string: ' ',
        size: fontSize,
        font: theme.fontUi,
        colour: theme.textDim,
        metricsBasis: 'line',
        justify: 'left',
        vAlign: 'center'
      },
      item: { size: { x: 120, y: rowH }, flexGrow: 1 },
      contentAlign: { x: 'start', y: 'center' }
    });
    await UI.attach(win, list, rowRoot);
    await UI.attach(win, rowRoot, badge);
    await UI.attach(win, rowRoot, label);
    await UI.setEnabled(win, rowRoot, false);
    const row = { root: rowRoot, badge, label, path: '', kind: '' };
    await UI.setOnMouseDown(win, rowRoot, async () => {
      if(row.kind === 'header' || !row.path) return;
      await openFile(row.path);
    });
    if(typeof UI.setOnMouseEnter === 'function')
    {
      await UI.setOnMouseEnter(win, rowRoot, async () => {
        if(row.kind === 'header') return;
        await settled(UI.setBoxColour(win, rowRoot, theme.treeHover));
      });
      if(typeof UI.setOnMouseExit === 'function')
      {
        await UI.setOnMouseExit(win, rowRoot, async () => {
          await settled(UI.setBoxColour(win, rowRoot, [0, 0, 0, 0]));
        });
      }
    }
    rows.push(row);
  }

  const emptyLabel = await UI.createElement(win, {
    renderable: {
      type: 'text',
      string: 'No changes',
      size: fontSize,
      font: theme.fontUi,
      colour: theme.textMuted,
      metricsBasis: 'line',
      justify: 'left',
      vAlign: 'center'
    },
    item: { size: { x: 120, y: rowH }, flexShrink: 0 },
    contentAlign: { x: 'start', y: 'center' }
  });
  await UI.attach(win, list, emptyLabel);
  await UI.setEnabled(win, emptyLabel, false);

  const paintRow = async (row, spec) => {
    if(!spec)
    {
      row.path = '';
      row.kind = '';
      await settled(UI.setEnabled(win, row.root, false));
      return;
    }
    row.path = spec.path || '';
    row.kind = spec.kind || 'file';
    const badgeText = spec.kind === 'header' ? ' ' : (spec.label || ' ');
    const name = spec.kind === 'header'
      ? spec.title
      : basename(spec.path);
    const colour = spec.kind === 'header'
      ? theme.textMuted
      : (spec.code === 'A' || spec.code === 'U'
        ? theme.diffAdded
        : spec.code === 'D'
          ? theme.diffDeleted
          : theme.textDim);
    const size = estimateLabelSize(name, fontSize, 220);
    await Promise.all([
      settled(UI.setEnabled(win, row.root, true)),
      settled(UI.setTextString(win, row.badge, badgeText)),
      settled(UI.setTextColour(win, row.badge, theme.primary)),
      settled(UI.setTextString(win, row.label, name)),
      settled(UI.setTextColour(win, row.label, colour)),
      settled(UI.setLayoutSize(win, row.label, { x: Math.max(20, size.x), y: rowH }))
    ]);
  };

  const setStatus = async (porcelainText, workspaceRoot) => {
    const { staged, changes } = parsePorcelain(porcelainText);
    const items = [];
    if(staged.length)
    {
      items.push({ kind: 'header', title: `Staged (${staged.length})` });
      for(const e of staged)
        items.push({ kind: 'file', path: `${workspaceRoot}/${e.path}`, label: e.label, code: e.code });
    }
    if(changes.length)
    {
      items.push({ kind: 'header', title: `Changes (${changes.length})` });
      for(const e of changes)
        items.push({ kind: 'file', path: `${workspaceRoot}/${e.path}`, label: e.label, code: e.code });
    }
    const empty = items.length === 0;
    await settled(UI.setEnabled(win, emptyLabel, empty));
    for(let i = 0; i < rows.length; i++)
      await paintRow(rows[i], empty ? null : items[i] || null);
  };

  if(typeof UI.setOnMouseEnter === 'function')
  {
    await UI.setOnMouseEnter(win, refreshBtn, async () => {
      try { await Compositor.setCursor(win, 'default'); }
      catch(e) { void e; }
      await settled(UI.setTextColour(win, refreshBtn, theme.primary));
    });
    if(typeof UI.setOnMouseExit === 'function')
    {
      await UI.setOnMouseExit(win, refreshBtn, async () => {
        await settled(UI.setTextColour(win, refreshBtn, theme.textMuted));
      });
    }
  }

  return {
    root,
    setStatus,
    async dispose()
    {
      await settled(UI.destroyElement(win, root));
    }
  };
}
