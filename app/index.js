import * as Log from 'Helix/Log';
import * as Event from 'Helix/Event';
import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Engine from 'Helix/Engine';

import { theme } from '/rom/theme.js';
import { createDocumentStore, isUntitledPath, isCustomDoc } from '/rom/workspace/documents.js';
import * as Fs from '/rom/workspace/fs.js';
import { pickSavePath } from '/rom/workspace/dialogs.js';
import { createTabBar, createFileTree, createStatusBar, createTreeSplitter, createBreadcrumbBar } from '/rom/shell/chrome.js';
import { createSideBar } from '/rom/shell/sidebar.js';
import { createCommandPalette } from '/rom/shell/commandPalette.js';
import { createCommandRegistry } from '/rom/commands/registry.js';
import { createWindowChrome } from '/rom/shell/windowChrome.js';
import { createEditorViewport } from '/rom/editor/viewport.js';
import { initHighlightPacks } from '/rom/editor/highlight.js';
import { basename } from '/rom/editor/buffer.js';
import { createEmitter, createPluginHost, loadFeaturePlugins } from '/rom/plugins/host.js';
import { createEditorRegistry } from '/rom/editors/registry.js';

async function resolveWorkspace(args)
{
  const list = Array.isArray(args) ? args.filter((a) => a && a !== '--') : [];
  const path = list.length > 0 ? list[0] : null;
  if(!path)
  {
    await Log.error('Usage: koyaedit -- /absolute/or/relative/workspace/path');
    setTimeout(() => Engine.quit(), 100);
    return null;
  }
  const exists = await Fs.exists(path);
  if(!exists)
  {
    await Log.error('Workspace path does not exist: ' + path);
    setTimeout(() => Engine.quit(), 100);
    return null;
  }
  return path;
}

export default function main(args = [])
{
  // Return immediately so Koya's bootstrap timeout is not tripped; build UI async.
  (async () => {
    try { await initHighlightPacks(); }
    catch(e) { await Log.warn('Highlight packs: ' + String(e && e.message ? e.message : e)); }

    const workspaceRoot = await resolveWorkspace(args);
    if(!workspaceRoot) return;

    await Log.info('KoyaEdit opening workspace: ' + workspaceRoot);

    const displays = await Compositor.listDisplays();
    const display = displays.length > 0 ? displays[0].display : '';

    const win = await Compositor.createWindow({
      role: 'window',
      title: 'KoyaEdit',
      appId: 'org.koya.edit',
      size: theme.windowSize,
      display,
      transparent: false,
      msaaSamples: 0,
      acceptPointerEvents: true,
      keyboardInteractivity: 'on_demand',
      state: { maximized: false, fullscreen: false }
    });

    await Compositor.setClearColor(win, theme.shell[0], theme.shell[1], theme.shell[2], 1);

    const docs = createDocumentStore();
    const editorRegistry = createEditorRegistry();
    /** @type {Map<string, { providerId: string, instance: object, mounted: boolean, active: boolean }>} */
    const customInstances = new Map();
    let editor = null;
    let viewerHost = null;
    let centerMode = 'text'; // 'text' | 'custom'
    let activeCustomPath = null;
    let tabs = null;
    let tree = null;
    let sidebar = null;
    let crumbs = null;
    let status = null;
    let palette = null;
    const commands = createCommandRegistry();
    let watchGeometry = false;
    let geometryIdle = 0;
    let geometrySyncing = false;
    /** Keep polling until this time — Wayland resize grabs the pointer so we
     *  cannot rely on pointerUp to know when the gesture ends. */
    let geometryWatchUntil = 0;
    const pluginBus = createEmitter();
    let pluginsLoaded = false;

    const settledUi = (p) => p.then((v) => v, () => null);

    const disposeCustomInstance = async (path) => {
      const rec = customInstances.get(path);
      if(!rec) return;
      customInstances.delete(path);
      try
      {
        if(rec.active && typeof rec.instance.deactivate === 'function')
          await rec.instance.deactivate();
      }
      catch(e) { void e; }
      try
      {
        if(rec.mounted && typeof rec.instance.unmount === 'function')
          await rec.instance.unmount();
      }
      catch(e) { void e; }
      if(activeCustomPath === path) activeCustomPath = null;
    };

    const ensureCustomInstance = async (doc) => {
      if(!doc || !isCustomDoc(doc)) return null;
      let rec = customInstances.get(doc.path);
      if(rec) return rec;
      const provider = editorRegistry.get(doc.kind);
      if(!provider) return null;
      const ctx = { win, workspaceRoot, host: null };
      const instance = await provider.create(doc, ctx);
      if(!instance || typeof instance.mount !== 'function') return null;
      rec = { providerId: provider.id, instance, mounted: false, active: false };
      customInstances.set(doc.path, rec);
      return rec;
    };

    const setCenterMode = async (mode) => {
      if(!editor || !viewerHost) return;
      const wantCustom = mode === 'custom';
      if(centerMode === (wantCustom ? 'custom' : 'text')) return;
      centerMode = wantCustom ? 'custom' : 'text';
      try
      {
        if(wantCustom)
        {
          if(typeof UI.setGrow === 'function')
          {
            await settledUi(UI.setGrow(win, editor.root, 0));
            await settledUi(UI.setGrow(win, viewerHost, 1));
          }
          await settledUi(UI.setLayoutSize(win, editor.root, { x: 1, y: 0 }));
          await settledUi(UI.setLayoutSize(win, viewerHost, {
            x: 'auto',
            y: 'auto'
          }));
          if(typeof UI.setGrow === 'function')
            await settledUi(UI.setGrow(win, viewerHost, 1));
        }
        else
        {
          if(typeof UI.setGrow === 'function')
          {
            await settledUi(UI.setGrow(win, editor.root, 1));
            await settledUi(UI.setGrow(win, viewerHost, 0));
          }
          await settledUi(UI.setLayoutSize(win, editor.root, { x: 'auto', y: 'auto' }));
          await settledUi(UI.setLayoutSize(win, viewerHost, { x: 'auto', y: 0 }));
        }
      }
      catch(e) { void e; }
    };

    const activateForDoc = async (doc) => {
      if(!editor) return;

      // Deactivate previous custom instance when leaving it.
      if(activeCustomPath && (!doc || doc.path !== activeCustomPath))
      {
        const prev = customInstances.get(activeCustomPath);
        if(prev && prev.active)
        {
          try
          {
            if(typeof prev.instance.deactivate === 'function')
              await prev.instance.deactivate();
          }
          catch(e) { void e; }
          prev.active = false;
        }
        activeCustomPath = null;
      }

      if(!doc)
      {
        await setCenterMode('text');
        editor.setDocument(null);
        editor.blur();
        if(status) await status.setState({ row: 0, col: 0, language: '', dirty: false });
        return;
      }

      if(isCustomDoc(doc))
      {
        await setCenterMode('custom');
        editor.setDocument(null);
        editor.blur();
        const rec = await ensureCustomInstance(doc);
        if(rec)
        {
          if(!rec.mounted)
          {
            await rec.instance.mount(viewerHost);
            rec.mounted = true;
          }
          if(typeof rec.instance.activate === 'function')
            await rec.instance.activate();
          rec.active = true;
          activeCustomPath = doc.path;
          // Pane size may settle a frame after the grow swap.
          try { await syncEditorLayout(); } catch(e) { void e; }
        }
        if(status)
        {
          const isMdPreview = doc.kind === 'markdown';
          await status.setState({
            cursor: false,
            label: isMdPreview ? 'Preview' : 'Image',
            language: doc.language || doc.kind || 'image',
            dirty: false
          });
        }
        return;
      }

      await setCenterMode('text');
      editor.setDocument(doc);
      editor.focus();
      try { await editor.syncLayout(); } catch(e) { void e; }
    };

    const syncEditorLayout = async () => {
      if(geometrySyncing) return false;
      geometrySyncing = true;
      try
      {
        let changed = false;
        if(centerMode === 'text' && editor)
          changed = !!(await editor.syncLayout());
        else if(centerMode === 'custom' && activeCustomPath)
        {
          const rec = customInstances.get(activeCustomPath);
          if(rec && typeof rec.instance.layout === 'function')
            changed = !!(await rec.instance.layout());
          else if(rec && typeof rec.instance.activate === 'function')
            await rec.instance.activate();
        }
        return changed;
      }
      finally { geometrySyncing = false; }
    };

    const beginGeometryWatch = () => {
      watchGeometry = true;
      geometryIdle = 0;
      // Cover the whole interactive resize / maximize animation.
      geometryWatchUntil = Date.now() + 2500;
    };

    const workspaceLabel = basename(workspaceRoot) || 'Workspace';

    const chrome = await createWindowChrome(win, {
      title: 'KoyaEdit — ' + workspaceLabel,
      // Helix has no window-resized bus event; watch layout while geometry
      // is changing (edge drag / maximize). Wayland startResize steals the
      // pointer, so we must not stop on pointerUp.
      onGeometryInteraction: beginGeometryWatch
    });
    await Compositor.setTitle(win, 'KoyaEdit — ' + workspaceRoot);

    const settled = (p) => p.then((v) => v, () => null);

    const setWindowTitle = async (text) => {
      await Promise.all([
        settled(Compositor.setTitle(win, text)),
        settled(chrome.setTitle(text))
      ]);
    };

    let lastTabSig = '';
    const refreshTabs = async () => {
      if(tabs)
      {
        const list = docs.list();
        const sig = list
          .map((d) => `${d.path}\0${d.dirty ? 1 : 0}\0${d.preview ? 1 : 0}\0${d.title || ''}`)
          .join('\n') + `\n#${docs.activePath() || ''}`;
        if(sig !== lastTabSig)
        {
          lastTabSig = sig;
          await tabs.render(list, docs.activePath());
        }
      }
      await refreshBreadcrumbs();
    };

    const refreshBreadcrumbs = async () => {
      if(!crumbs) return;
      const active = docs.active();
      if(!active || !active.path)
      {
        await crumbs.setPath([]);
        return;
      }
      if(active.untitled || isUntitledPath(active.path))
      {
        await crumbs.setPath([active.title || 'Untitled']);
        return;
      }
      const crumbPath = active.sourcePath || active.path;
      const root = workspaceRoot.replace(/\/+$/, '');
      let rel = crumbPath;
      if(rel.startsWith(root + '/')) rel = rel.slice(root.length + 1);
      else if(rel === root) rel = '';
      const parts = rel ? rel.split('/').filter(Boolean) : [active.title || basename(crumbPath)];
      if(active.sourcePath && active.kind === 'markdown')
        parts.push('Preview');
      await crumbs.setPath(parts);
    };

    const refreshTreeSelection = async () => {
      if(tree)
      {
        if(typeof tree.syncActive === 'function') await tree.syncActive();
        else await tree.refreshNow();
      }
    };

    const openPath = async (path, opts = {}) => {
      try
      {
        const prev = docs.activePath();
        const replaceCandidate = opts.preview !== false ? docs.previewPath() : null;
        const provider = editorRegistry.match(path);
        const doc = provider
          ? await docs.openCustom(path, provider.id, opts)
          : await docs.open(path, opts);
        if(replaceCandidate && replaceCandidate !== path && !docs.get(replaceCandidate))
          await disposeCustomInstance(replaceCandidate);
        await activateForDoc(doc);
        await refreshTabs();
        await refreshTreeSelection();
        await setWindowTitle(`${doc.dirty ? '• ' : ''}${doc.title} — KoyaEdit`);
        pluginBus.emit('docOpened', { path: doc.path, doc });
        if(prev !== doc.path)
          pluginBus.emit('activeDocChanged', { path: doc.path, doc });
      }
      catch(error)
      {
        await Log.error('Failed to open ' + path + ': ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('Open failed: ' + path);
      }
    };

    const newUntitled = async () => {
      const doc = docs.createUntitled();
      await activateForDoc(doc);
      await refreshTabs();
      await refreshTreeSelection();
      await setWindowTitle(`${doc.title} — KoyaEdit`);
      pluginBus.emit('docOpened', { path: doc.path, doc });
      pluginBus.emit('activeDocChanged', { path: doc.path, doc });
    };

    const saveActiveAs = async () => {
      const doc = docs.active();
      if(!doc || isCustomDoc(doc)) return;
      const suggested = (doc.untitled || isUntitledPath(doc.path))
        ? (doc.title && doc.title !== 'Untitled' ? doc.title : 'Untitled.txt')
        : (doc.title || basename(doc.path));
      const picked = await pickSavePath({
        cwd: workspaceRoot,
        suggestedName: suggested,
        title: 'Save As'
      });
      if(!picked) return;
      try
      {
        const from = doc.path;
        await docs.saveAs(from, picked);
        const next = docs.active();
        await activateForDoc(next);
        await refreshTabs();
        await refreshTreeSelection();
        if(status) await status.setText('Saved ' + picked);
        await setWindowTitle(`${next.title} — KoyaEdit`);
        pluginBus.emit('docSaved', { path: picked, doc: next });
        pluginBus.emit('activeDocChanged', { path: picked, doc: next });
      }
      catch(error)
      {
        await Log.error('Save As failed: ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('Save As failed');
      }
    };

    const saveActive = async () => {
      const doc = docs.active();
      if(!doc || isCustomDoc(doc)) return;
      if(doc.untitled || isUntitledPath(doc.path))
      {
        await saveActiveAs();
        return;
      }
      try
      {
        await docs.save(doc.path);
        await refreshTabs();
        if(status) await status.setText('Saved ' + doc.path);
        await setWindowTitle(`${doc.title} — KoyaEdit`);
        pluginBus.emit('docSaved', { path: doc.path, doc });
      }
      catch(error)
      {
        if(String(error && error.message) === 'SAVE_AS_REQUIRED')
        {
          await saveActiveAs();
          return;
        }
        await Log.error('Save failed: ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('Save failed');
      }
    };

    const closePath = async (path) => {
      const doc = docs.get(path);
      if(doc && doc.dirty)
      {
        await Log.warn('Closing dirty buffer without save: ' + path);
        if(status) await status.setText('Closed dirty file (unsaved): ' + path);
      }
      await disposeCustomInstance(path);
      docs.close(path);
      const active = docs.active();
      await activateForDoc(active);
      await refreshTabs();
      await refreshTreeSelection();
      if(active)
        await setWindowTitle(`${active.dirty ? '• ' : ''}${active.title} — KoyaEdit`);
      else
        await setWindowTitle(`KoyaEdit — ${workspaceLabel}`);
    };

    // Body must shrink below content size (minHeight: 0) or it overflows the
    // status bar and the last editor lines are clipped underneath.
    const body = await UI.createElement(win, {
      layout: { type: 'row', gap: 0 },
      item: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, chrome.shell, body);

    sidebar = await createSideBar(win, body, { width: theme.treeWidth });
    await sidebar.registerCoreView({
      id: 'explorer',
      title: 'Explorer',
      icon: '🗀',
      order: 0,
      attachBody: async (container) => {
        tree = await createFileTree(win, container, {
          root: workspaceRoot,
          embedded: true,
          width: sidebar.getWidth(),
          onOpen: openPath,
          getActivePath: () => docs.activePath()
        });
      }
    });

    await createTreeSplitter(win, body, {
      dragHost: chrome.shell,
      getWidth: () => sidebar.getWidth(),
      setWidth: async (w) => {
        await sidebar.setWidth(w);
        if(tree) await tree.setWidth(w);
        if(editor) await editor.syncLayout();
      }
    });

    const editorColumn = await UI.createElement(win, {
      renderable: { type: 'box', colour: theme.bg },
      layout: { type: 'column', gap: 0 },
      item: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, body, editorColumn);

    await UI.attach(win, editorColumn, chrome.titleBar);

    tabs = await createTabBar(win, editorColumn, {
      onSelect: async (path) => {
        const doc = docs.setActive(path);
        await activateForDoc(doc);
        await refreshTabs();
        await refreshTreeSelection();
        if(doc)
        {
          await setWindowTitle(`${doc.dirty ? '• ' : ''}${doc.title} — KoyaEdit`);
          pluginBus.emit('activeDocChanged', { path, doc });
        }
      },
      onPin: async (path) => {
        const doc = docs.pin(path);
        if(doc)
        {
          docs.setActive(path);
          await activateForDoc(doc);
          await refreshTabs();
          await refreshTreeSelection();
          pluginBus.emit('activeDocChanged', { path, doc });
        }
      },
      onClose: closePath,
      onNew: newUntitled
    });

    crumbs = await createBreadcrumbBar(win, editorColumn, {
      workspaceName: workspaceLabel
    });

    editor = await createEditorViewport(win, editorColumn, {
      onDirty: async () => {
        await refreshTabs();
        if(pluginBus) pluginBus.emit('docChanged', { doc: docs.active() });
      },
      onStatus: async (info) => {
        if(!status) return;
        // Custom editors own the status strip while active.
        if(isCustomDoc(docs.active())) return;
        if(info && typeof info === 'object') await status.setState(info);
        else if(typeof info === 'string') await status.setText(info);
      }
    });

    viewerHost = await UI.createElement(win, {
      renderable: { type: 'box', colour: theme.bg },
      layout: {
        type: 'column',
        gap: 0,
        alignItems: 'stretch',
        justifyContent: 'start'
      },
      item: {
        size: { x: 'auto', y: 0 },
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0
      },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, editorColumn, viewerHost);

    status = await createStatusBar(win, chrome.shell);
    await status.setState({ row: 0, col: 0, language: '', dirty: false });

    palette = await createCommandPalette(win, chrome.root || chrome.shell, {
      registry: commands
    });

    commands.register({
      id: 'file.new',
      title: 'New File',
      category: 'File',
      run: async () => { await newUntitled(); }
    });
    commands.register({
      id: 'file.save',
      title: 'Save',
      category: 'File',
      run: async () => { await saveActive(); }
    });
    commands.register({
      id: 'file.saveAs',
      title: 'Save As…',
      category: 'File',
      run: async () => { await saveActiveAs(); }
    });
    commands.register({
      id: 'file.closeTab',
      title: 'Close Tab',
      category: 'File',
      run: async () => {
        const active = docs.activePath();
        if(active) await closePath(active);
      }
    });
    commands.register({
      id: 'view.commandPalette',
      title: 'Command Palette',
      category: 'View',
      run: async () => { if(palette) await palette.open(); }
    });
    commands.register({
      id: 'view.focusExplorer',
      title: 'Focus Explorer',
      category: 'View',
      run: async () => {
        if(sidebar) await sidebar.focus('explorer');
      }
    });
    commands.register({
      id: 'view.toggleWordWrap',
      title: 'Toggle Word Wrap',
      category: 'View',
      run: async () => {
        if(editor && typeof editor.toggleWordWrap === 'function')
          editor.toggleWordWrap();
      }
    });
    commands.register({
      id: 'app.quit',
      title: 'Quit',
      category: 'File',
      run: async () => {
        try { await Compositor.destroyWindow(win); } catch(e) { void e; }
        try { Engine.quit(); } catch(e) { void e; }
      }
    });

    await refreshTabs();
    if(editor) await editor.syncLayout();

    const host = createPluginHost({
      workspaceRoot,
      win,
      getActiveDoc: () => docs.active(),
      editor,
      status,
      sidebar,
      commands,
      editors: editorRegistry,
      openFile: openPath,
      bus: pluginBus
    });
    try
    {
      await loadFeaturePlugins(host);
      pluginsLoaded = true;
      pluginBus.emit('ready', { workspaceRoot });
    }
    catch(error)
    {
      await Log.warn('Feature plugins: ' + String(error && error.message ? error.message : error));
    }
    void pluginsLoaded;

    // Watch is optional and non-recursive — avoid inotify storms on large trees.
    try
    {
      await Fs.watchWorkspace(workspaceRoot, (evt) => {
        if(tree) tree.refresh();
        if(evt && evt.type === 'modify' && evt.path)
        {
          for(const doc of docs.list())
          {
            if(!doc || doc.dirty) continue;
            // Images use doc.path; markdown preview uses sourcePath.
            const filePath = doc.sourcePath || doc.path;
            if(!filePath || filePath !== evt.path) continue;
            if(isCustomDoc(doc))
            {
              const rec = customInstances.get(doc.path);
              if(rec && typeof rec.instance.reload === 'function')
                void rec.instance.reload().catch(() => {});
              continue;
            }
            Fs.readText(evt.path).then((text) => {
              if(docs.replaceFromDisk(evt.path, text) && docs.activePath() === evt.path)
                editor.queueRender();
            }).catch(() => {});
          }
        }
      });
    }
    catch(error)
    {
      await Log.warn('Workspace watch unavailable: ' + String(error && error.message ? error.message : error));
    }

    Event.on('preRender', () => {
      if(!watchGeometry) return;
      void (async () => {
        const changed = await syncEditorLayout();
        if(changed)
        {
          geometryIdle = 0;
          // Size still moving — keep watching a bit past the last change.
          geometryWatchUntil = Math.max(geometryWatchUntil, Date.now() + 400);
          return;
        }
        // Stop only once size has been stable for several frames and the
        // post-interaction grace period has elapsed.
        if(++geometryIdle > 12 && Date.now() >= geometryWatchUntil)
          watchGeometry = false;
      })();
    });

    // Final sync when the pointer returns to the client (resize may already
    // have finished). Do not clear watchGeometry here — startResize often
    // delivers pointerUp as soon as the compositor grabs the edge drag.
    Event.on('pointerUp', ({ id }) => {
      if(id !== undefined && id !== win) return;
      if(!watchGeometry) return;
      geometryIdle = 0;
      void syncEditorLayout();
    });

    const applyKeyResult = async (result) => {
      if(result === 'command-palette')
      {
        if(palette) await palette.toggle();
        return;
      }
      if(result === 'save') await saveActive();
      if(result === 'save-as') await saveActiveAs();
      if(result === 'new') await newUntitled();
      if(result === 'close')
      {
        const active = docs.activePath();
        if(active) await closePath(active);
      }
      if(result === 'tab-next' || result === 'tab-prev')
      {
        const doc = docs.cycleActive(result === 'tab-next' ? 1 : -1);
        await activateForDoc(doc);
        await refreshTabs();
        await refreshTreeSelection();
        if(doc)
        {
          await setWindowTitle(`${doc.dirty ? '• ' : ''}${doc.title} — KoyaEdit`);
          pluginBus.emit('activeDocChanged', { path: doc.path, doc });
        }
      }
      if(result === 'quit' || result === 'close-window')
      {
        try { await Compositor.destroyWindow(win); } catch(e) { void e; }
        try { Engine.quit(); } catch(e) { void e; }
      }
    };

    Event.on('keyDown', async ({ key, id }) => {
      if(id !== win) return;
      editor.mods.down(key);
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleKey(key, editor.mods);
        if(consumed) return;
      }
      const result = await editor.onKey(key);
      await applyKeyResult(result);
    });

    Event.on('keyRepeat', async ({ key, id }) => {
      if(id !== win) return;
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleKey(key, editor.mods);
        if(consumed) return;
      }
      const result = await editor.onKey(key);
      await applyKeyResult(result);
    });

    Event.on('keyUp', ({ key, id }) => {
      if(id !== win) return;
      editor.mods.up(key);
    });

    // Compositor reports xkb modifier masks; when nothing is depressed/latched,
    // drop any sticky Ctrl/Shift/Alt left behind by a missed keyUp.
    Event.on('keyModifiers', ({ id, depressed, latched }) => {
      if(id !== undefined && id !== win) return;
      if(((depressed | 0) | (latched | 0)) === 0) editor.mods.clear();
    });

    Event.on('textInput', async ({ text, id }) => {
      if(id !== win) return;
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleText(text);
        if(consumed) return;
      }
      if(isCustomDoc(docs.active())) return;
      await editor.onTextInput(text);
    });

    Event.on('textRepeat', async ({ text, id }) => {
      if(id !== win) return;
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleText(text);
        if(consumed) return;
      }
      if(isCustomDoc(docs.active())) return;
      await editor.onTextInput(text);
    });

    Event.on('windowClosed', ({ id }) => {
      if(id !== undefined && id !== win) return;
      for(const path of [...customInstances.keys()])
        void disposeCustomInstance(path);
      try { if(editor && editor.dispose) editor.dispose(); } catch(e) { void e; }
      try { Engine.quit(); } catch(e) { void e; }
    });

    await Log.info('KoyaEdit ready');
  })().catch(async (error) => {
    try { await Log.error('KoyaEdit failed: ' + String(error && error.stack ? error.stack : error)); }
    catch(_) { void _; }
  });
}
