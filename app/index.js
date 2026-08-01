import * as Log from 'Helix/Log';
import * as Event from 'Helix/Event';
import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Engine from 'Helix/Engine';

import { theme, listThemes, setTheme, getThemeId, onThemeChange, loadThemePreference, registerTheme } from '/rom/theme.js';
import { createDocumentStore, isUntitledPath, isCustomDoc } from '/rom/workspace/documents.js';
import { createEditorGroupStore } from '/rom/workspace/editorGroups.js';
import * as Fs from '/rom/workspace/fs.js';
import { pickSavePath } from '/rom/workspace/dialogs.js';
import { createFileTree, createStatusBar, createTreeSplitter } from '/rom/shell/chrome.js';
import { createSideBar } from '/rom/shell/sidebar.js';
import { createEditorGroup } from '/rom/shell/editorGroup.js';
import { createCommandPalette } from '/rom/shell/commandPalette.js';
import { createContextMenu } from '/rom/shell/contextMenu.js';
import { installPointerButtonTracker } from '/rom/shell/pointerButtons.js';
import { frameSize } from '/rom/shell/layout.js';
import { createCommandRegistry } from '/rom/commands/registry.js';
import { createWindowChrome } from '/rom/shell/windowChrome.js';
import { initHighlightPacks } from '/rom/editor/highlight.js';
import { basename } from '/rom/editor/buffer.js';
import { keyIn, KEY } from '/rom/editor/keys.js';
import { createEmitter, createPluginHost, loadFeaturePlugins, bootstrapThemePlugins } from '/rom/plugins/host.js';
import { createEditorRegistry } from '/rom/editors/registry.js';

/** Evdev: backslash / digits for split focus chords. */
const KEY_BACKSLASH = new Set([43]);
const KEY_1 = new Set([2]);
const KEY_2 = new Set([3]);

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

    try { await bootstrapThemePlugins(registerTheme); }
    catch(e) { await Log.warn('Theme packs: ' + String(e && e.message ? e.message : e)); }

    try { await loadThemePreference(); }
    catch(e) { await Log.warn('Theme preference: ' + String(e && e.message ? e.message : e)); }

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
    const groups = createEditorGroupStore();
    const editorRegistry = createEditorRegistry();
    /** @type {Map<string, Awaited<ReturnType<typeof createEditorGroup>>>} */
    const groupUi = new Map();
    let tree = null;
    let sidebar = null;
    let rightSidebar = null;
    let rightSplitter = null;
    let leftSplitter = null;
    let groupSplitter = null;
    let groupsHost = null;
    let status = null;
    let palette = null;
    let contextMenu = null;
    const pointerBtns = installPointerButtonTracker(win);
    let leftFraction = 0.5;
    let lastLeftWidth = 0;
    const commands = createCommandRegistry();
    let watchGeometry = false;
    let geometryIdle = 0;
    let geometrySyncing = false;
    let geometryWatchUntil = 0;
    const pluginBus = createEmitter();
    let pluginsLoaded = false;

    const settled = (p) => p.then((v) => v, () => null);

    const workspaceLabel = basename(workspaceRoot) || 'Workspace';

    const beginGeometryWatch = () => {
      watchGeometry = true;
      geometryIdle = 0;
      geometryWatchUntil = Date.now() + 2500;
    };

    const chrome = await createWindowChrome(win, {
      title: 'KoyaEdit — ' + workspaceLabel,
      onGeometryInteraction: beginGeometryWatch
    });
    await Compositor.setTitle(win, 'KoyaEdit — ' + workspaceRoot);

    const setWindowTitle = async (text) => {
      await Promise.all([
        settled(Compositor.setTitle(win, text)),
        settled(chrome.setTitle(text))
      ]);
    };

    const focusedUi = () => groupUi.get(groups.focusedId()) || null;

    const focusedEditor = () => {
      const ui = focusedUi();
      return ui ? ui.getEditor() : null;
    };

    const forEachEditor = (fn) => {
      for(const ui of groupUi.values())
      {
        const ed = ui.getEditor();
        if(ed) fn(ed);
      }
    };

    const syncDocsActiveFromFocus = () => {
      const g = groups.focused();
      if(g && g.activePath && docs.get(g.activePath))
        docs.setActive(g.activePath);
    };

    const refreshTreeSelection = async () => {
      if(tree)
      {
        if(typeof tree.syncActive === 'function') await tree.syncActive();
        else await tree.refreshNow();
      }
    };

    const refreshAllTabs = async () => {
      for(const ui of groupUi.values())
        await ui.refreshTabs();
    };

    const activateFocused = async () => {
      syncDocsActiveFromFocus();
      const ui = focusedUi();
      if(ui) await ui.activateActive();
      for(const [gid, other] of groupUi)
      {
        if(gid === groups.focusedId()) continue;
        await other.setFocusedVisual();
        await other.refreshTabs();
      }
    };

    const syncAllLayouts = async () => {
      if(geometrySyncing) return false;
      geometrySyncing = true;
      try
      {
        let changed = false;
        for(const ui of groupUi.values())
        {
          if(await ui.syncLayout()) changed = true;
        }
        return changed;
      }
      finally { geometrySyncing = false; }
    };

    const applyGroupSplitWidths = async () => {
      if(!groupsHost || groups.count() < 2) return;
      const ids = groups.ids();
      const left = groupUi.get(ids[0]);
      const right = groupUi.get(ids[1]);
      if(!left || !right) return;
      let hostW = 0;
      try
      {
        if(typeof UI.getElementFrame === 'function')
        {
          const frame = await UI.getElementFrame(win, groupsHost);
          hostW = frameSize(frame).x;
        }
      }
      catch(e) { void e; }
      // Before first layout, frame may be empty — keep last known width.
      if(hostW < 160) hostW = Math.max(lastLeftWidth * 2 + 7, 400);
      const splitHit = 7;
      const usable = Math.max(160, hostW - splitHit);
      const leftW = Math.max(80, Math.min(usable - 80, Math.round(usable * leftFraction)));
      lastLeftWidth = leftW;
      await settled(UI.setLayoutSize(win, left.root, {x: leftW}));
      if(typeof UI.setGrow === 'function')
      {
        await settled(UI.setGrow(win, left.root, 0));
        await settled(UI.setGrow(win, right.root, 1));
      }
      await settled(UI.setLayoutSize(win, right.root, {x: 'auto', y: 'auto'}));
    };

    const updateTitleForDoc = async (doc) => {
      if(doc)
        await setWindowTitle(`${doc.dirty ? '• ' : ''}${doc.title} — KoyaEdit`);
      else
        await setWindowTitle(`KoyaEdit — ${workspaceLabel}`);
    };

    const disposePathIfOrphan = async (path) => {
      if(groups.groupsReferencing(path).length > 0) return;
      for(const ui of groupUi.values())
      {
        if(ui.hasCustom(path)) await ui.disposeCustomInstance(path);
      }
      docs.close(path);
    };

    const closeTabInGroup = async (groupId, path) => {
      const doc = docs.get(path);
      if(doc && doc.dirty)
      {
        await Log.warn('Closing dirty buffer without save: ' + path);
        if(status) await status.setText('Closed dirty file (unsaved): ' + path);
      }
      groups.removeTab(groupId, path);
      groups.focus(groupId);
      await disposePathIfOrphan(path);
      syncDocsActiveFromFocus();
      const ui = groupUi.get(groupId);
      if(ui) await ui.activateActive();
      await refreshAllTabs();
      await refreshTreeSelection();
      await updateTitleForDoc(docs.active());
      pluginBus.emit('activeDocChanged', {path: docs.activePath(), doc: docs.active()});
    };

    const closeOtherTabsInGroup = async (groupId, keepPath) => {
      const g = groups.get(groupId);
      if(!g) return;
      const toClose = g.tabPaths.filter((p) => p !== keepPath);
      for(const path of toClose)
        await closeTabInGroup(groupId, path);
    };

    const closeAllTabsInGroup = async (groupId) => {
      const g = groups.get(groupId);
      if(!g) return;
      const toClose = [...g.tabPaths];
      for(const path of toClose)
        await closeTabInGroup(groupId, path);
    };

    /** Open/focus this path in the other group (split if needed). */
    const openTabToSide = async (groupId, path) => {
      if(!path || !docs.get(path)) return;
      const {created, group} = groups.splitRight(groupId, {seedActive: false});
      if(created) await ensureGroupUi();
      groups.openInGroup(group.id, path);
      docs.setActive(path);
      const ui = groupUi.get(group.id);
      if(ui) await ui.activateForDoc(docs.get(path));
      await refreshAllTabs();
      for(const [gid, other] of groupUi)
      {
        if(gid !== group.id) await other.setFocusedVisual();
      }
      if(groups.count() >= 2)
      {
        leftFraction = 0.5;
        await applyGroupSplitWidths();
      }
      await refreshTreeSelection();
      await updateTitleForDoc(docs.active());
      pluginBus.emit('activeDocChanged', {path, doc: docs.active()});
      beginGeometryWatch();
    };

    const showTabContextMenu = async (groupId, path, wp) => {
      if(!contextMenu || !path) return;
      const g = groups.get(groupId);
      const doc = docs.get(path);
      if(!g || !doc) return;
      const tabCount = g.tabPaths.length;
      const isPreview = !!doc.preview;
      await contextMenu.show({
        x: wp && wp.x != null ? wp.x : 0,
        y: wp && wp.y != null ? wp.y : 0,
        items: [
          {
            id: 'close',
            label: 'Close',
            run: async () => { await closeTabInGroup(groupId, path); }
          },
          {
            id: 'closeOthers',
            label: 'Close Others',
            enabled: tabCount > 1,
            run: async () => { await closeOtherTabsInGroup(groupId, path); }
          },
          {
            id: 'closeAll',
            label: 'Close All',
            enabled: tabCount > 0,
            run: async () => { await closeAllTabsInGroup(groupId); }
          },
          {separator: true},
          {
            id: 'pin',
            label: 'Keep Open',
            enabled: isPreview,
            run: async () => {
              const pinned = docs.pin(path);
              if(!pinned) return;
              groups.setActiveInGroup(groupId, path);
              docs.setActive(path);
              const ui = groupUi.get(groupId);
              if(ui) await ui.activateForDoc(pinned);
              await refreshAllTabs();
            }
          },
          {separator: true},
          {
            id: 'splitRight',
            label: 'Split Right',
            run: async () => {
              groups.setActiveInGroup(groupId, path);
              docs.setActive(path);
              await splitEditorRight();
            }
          },
          {
            id: 'openToSide',
            label: 'Open to the Side',
            run: async () => { await openTabToSide(groupId, path); }
          }
        ]
      });
    };

    const showBarContextMenu = async (groupId, wp) => {
      if(!contextMenu) return;
      await contextMenu.show({
        x: wp && wp.x != null ? wp.x : 0,
        y: wp && wp.y != null ? wp.y : 0,
        items: [
          {
            id: 'new',
            label: 'New File',
            run: async () => { await newUntitled(groupId); }
          },
          {
            id: 'splitRight',
            label: 'Split Editor Right',
            run: async () => {
              groups.focus(groupId);
              await splitEditorRight();
            }
          },
          {
            id: 'closeGroup',
            label: 'Close Editor Group',
            enabled: groups.count() > 1,
            run: async () => {
              groups.focus(groupId);
              await closeEditorGroup();
            }
          }
        ]
      });
    };

    const copyTextToClipboard = async (text) => {
      const value = String(text || '');
      if(!value) return;
      try { await Compositor.setClipboardText(value); }
      catch(e) { void e; }
      if(status) await status.setText('Copied path');
    };

    const relativeToWorkspace = (absPath) => {
      const root = workspaceRoot.replace(/\/+$/, '');
      const p = String(absPath || '');
      if(p === root) return '.';
      if(p.startsWith(root + '/')) return p.slice(root.length + 1);
      return p;
    };

    const parentDirOf = (absPath) => {
      const p = String(absPath || '').replace(/\/+$/, '');
      const i = p.lastIndexOf('/');
      if(i <= 0) return workspaceRoot;
      return p.slice(0, i) || '/';
    };

    const revealInFileManager = async (targetPath) => {
      const dir = targetPath;
      try
      {
        const Editor = await import('Module/editor');
        await Editor.runCommand({cmd: 'xdg-open', args: [dir]});
      }
      catch(e)
      {
        await Log.warn('Reveal failed: ' + String(e && e.message ? e.message : e));
        if(status) await status.setText('Reveal failed');
      }
    };

    const newFileInDir = async (dirPath) => {
      const picked = await pickSavePath({
        cwd: dirPath || workspaceRoot,
        suggestedName: 'Untitled.txt',
        title: 'New File'
      });
      if(!picked) return;
      try
      {
        await Fs.writeText(picked, '');
        await openPath(picked, {preview: false});
        if(tree && typeof tree.refreshNow === 'function') await tree.refreshNow();
        else if(tree) tree.refresh();
      }
      catch(error)
      {
        await Log.error('New file failed: ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('New file failed');
      }
    };

    const showTreeContextMenu = async (info) => {
      if(!contextMenu || !info || !info.path) return;
      const path = info.path;
      const isDir = !!info.isDir;
      const wp = info.wp || {x: 0, y: 0};
      const expanded = tree && typeof tree.isExpanded === 'function' ? tree.isExpanded(path) : false;

      /** @type {object[]} */
      const items = [];
      if(!isDir)
      {
        items.push(
          {
            id: 'open',
            label: 'Open',
            run: async () => { await openPath(path, {preview: false}); }
          },
          {
            id: 'openToSide',
            label: 'Open to the Side',
            run: async () => { await openPath(path, {preview: false, viewColumn: 'beside'}); }
          },
          {separator: true}
        );
      }
      else
      {
        items.push(
          {
            id: 'expand',
            label: expanded ? 'Collapse' : 'Expand',
            run: async () => {
              if(!tree) return;
              if(expanded && typeof tree.collapsePath === 'function') await tree.collapsePath(path);
              else if(!expanded && typeof tree.expandPath === 'function') await tree.expandPath(path);
            }
          },
          {
            id: 'newFile',
            label: 'New File…',
            run: async () => { await newFileInDir(path); }
          },
          {separator: true}
        );
      }

      items.push(
        {
          id: 'copyPath',
          label: 'Copy Path',
          run: async () => { await copyTextToClipboard(path); }
        },
        {
          id: 'copyRel',
          label: 'Copy Relative Path',
          run: async () => { await copyTextToClipboard(relativeToWorkspace(path)); }
        },
        {separator: true},
        {
          id: 'reveal',
          label: 'Reveal in File Manager',
          run: async () => { await revealInFileManager(isDir ? path : parentDirOf(path)); }
        }
      );

      await contextMenu.show({
        x: wp.x != null ? wp.x : 0,
        y: wp.y != null ? wp.y : 0,
        items
      });
    };

    const showTreeBackgroundContextMenu = async (wp) => {
      if(!contextMenu) return;
      await contextMenu.show({
        x: wp && wp.x != null ? wp.x : 0,
        y: wp && wp.y != null ? wp.y : 0,
        items: [
          {
            id: 'newFile',
            label: 'New File…',
            run: async () => { await newFileInDir(workspaceRoot); }
          },
          {
            id: 'refresh',
            label: 'Refresh Explorer',
            run: async () => {
              if(tree && typeof tree.refreshNow === 'function') await tree.refreshNow();
              else if(tree) tree.refresh();
            }
          }
        ]
      });
    };

    const openPath = async (path, opts = {}) => {
      try
      {
        const viewColumn = opts.viewColumn === 'beside' ? 'beside' : 'active';
        let targetId = groups.focusedId();
        if(viewColumn === 'beside')
        {
          const {created, group} = groups.splitRight(groups.focusedId(), {seedActive: false});
          targetId = group.id;
          if(created) await ensureGroupUi();
          else groups.focus(targetId);
        }

        const prev = docs.activePath();
        const replaceCandidate = opts.preview !== false ? docs.previewPath() : null;
        const provider = editorRegistry.match(path);
        const doc = provider
          ? await docs.openCustom(path, provider.id, opts)
          : await docs.open(path, opts);

        if(replaceCandidate && replaceCandidate !== path)
        {
          groups.replaceTabPath(replaceCandidate, path);
          if(!docs.get(replaceCandidate))
          {
            for(const ui of groupUi.values())
            {
              if(ui.hasCustom(replaceCandidate))
                await ui.disposeCustomInstance(replaceCandidate);
            }
          }
        }

        groups.openInGroup(targetId, doc.path);
        docs.setActive(doc.path);

        const ui = groupUi.get(targetId);
        if(ui) await ui.activateForDoc(doc);
        await refreshAllTabs();
        for(const [gid, other] of groupUi)
        {
          if(gid !== targetId) await other.setFocusedVisual();
        }
        await refreshTreeSelection();
        await updateTitleForDoc(doc);
        if(groups.count() >= 2) await applyGroupSplitWidths();
        pluginBus.emit('docOpened', {path: doc.path, doc});
        if(prev !== doc.path)
          pluginBus.emit('activeDocChanged', {path: doc.path, doc});
      }
      catch(error)
      {
        await Log.error('Failed to open ' + path + ': ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('Open failed: ' + path);
      }
    };

    const newUntitled = async (groupId = groups.focusedId()) => {
      const doc = docs.createUntitled();
      groups.openInGroup(groupId, doc.path);
      const ui = groupUi.get(groupId);
      if(ui) await ui.activateForDoc(doc);
      await refreshAllTabs();
      await refreshTreeSelection();
      await updateTitleForDoc(doc);
      pluginBus.emit('docOpened', {path: doc.path, doc});
      pluginBus.emit('activeDocChanged', {path: doc.path, doc});
    };

    const saveActiveAs = async () => {
      syncDocsActiveFromFocus();
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
        groups.replaceTabPath(from, picked);
        const next = docs.active();
        await activateFocused();
        await refreshAllTabs();
        await refreshTreeSelection();
        if(status) await status.setText('Saved ' + picked);
        await updateTitleForDoc(next);
        pluginBus.emit('docSaved', {path: picked, doc: next});
        pluginBus.emit('activeDocChanged', {path: picked, doc: next});
      }
      catch(error)
      {
        await Log.error('Save As failed: ' + String(error && error.message ? error.message : error));
        if(status) await status.setText('Save As failed');
      }
    };

    const saveActive = async () => {
      syncDocsActiveFromFocus();
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
        await refreshAllTabs();
        if(status) await status.setText('Saved ' + doc.path);
        await updateTitleForDoc(doc);
        pluginBus.emit('docSaved', {path: doc.path, doc});
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

    const focusGroup = async (id) => {
      if(!groups.get(id)) return;
      groups.focus(id);
      syncDocsActiveFromFocus();
      for(const [gid, ui] of groupUi)
      {
        await ui.setFocusedVisual();
        await ui.refreshTabs();
        if(gid === id) await ui.activateActive();
      }
      await refreshTreeSelection();
      await updateTitleForDoc(docs.active());
      pluginBus.emit('activeDocChanged', {path: docs.activePath(), doc: docs.active()});
    };

    const splitEditorRight = async () => {
      const fromId = groups.focusedId();
      const {created, group} = groups.splitRight(fromId);
      if(created)
      {
        await ensureGroupUi();
        leftFraction = 0.5;
        await applyGroupSplitWidths();
      }
      await focusGroup(group.id);
      beginGeometryWatch();
    };

    const closeEditorGroup = async () => {
      if(groups.count() <= 1) return;
      const closingId = groups.focusedId();
      const neighbor = groups.closeGroup(closingId);
      const ui = groupUi.get(closingId);
      if(ui)
      {
        await ui.dispose();
        groupUi.delete(closingId);
      }
      if(groupSplitter)
      {
        await settled(UI.destroyElement(win, groupSplitter.root));
        groupSplitter = null;
      }
      // Re-attach remaining group to fill.
      await ensureGroupUi();
      if(neighbor) await focusGroup(neighbor.id);
      beginGeometryWatch();
    };

    async function buildGroupUi(groupId)
    {
      if(!groupsHost) return null;
      if(groupUi.has(groupId)) return groupUi.get(groupId);

      const ui = await createEditorGroup(win, groupsHost, {
        id: groupId,
        workspaceRoot,
        workspaceLabel,
        docs,
        editorRegistry,
        getGroupState: () => groups.get(groupId) || {tabPaths: [], activePath: null},
        isFocused: () => groups.focusedId() === groupId,
        onFocus: async () => {
          if(groups.focusedId() === groupId) return;
          await focusGroup(groupId);
        },
        onDirty: async (doc) => {
          await refreshAllTabs();
          if(pluginBus) pluginBus.emit('docChanged', {doc: doc || docs.active()});
        },
        onStatus: async (info) => {
          if(!status) return;
          if(info && typeof info === 'object') await status.setState(info);
          else if(typeof info === 'string') await status.setText(info);
        },
        onSelect: async (path) => {
          const g = groups.get(groupId);
          const alreadyActive = g && g.activePath === path && groups.focusedId() === groupId;
          if(alreadyActive)
          {
            // Same tab in the focused group — no doc rebind / tab chrome refresh.
            return;
          }
          groups.setActiveInGroup(groupId, path);
          docs.setActive(path);
          const doc = docs.get(path);
          const gUi = groupUi.get(groupId);
          if(gUi) await gUi.activateForDoc(doc);
          await refreshAllTabs();
          await refreshTreeSelection();
          await updateTitleForDoc(doc);
          pluginBus.emit('activeDocChanged', {path, doc});
        },
        onPin: async (path) => {
          const doc = docs.pin(path);
          if(!doc) return;
          groups.setActiveInGroup(groupId, path);
          docs.setActive(path);
          const gUi = groupUi.get(groupId);
          if(gUi) await gUi.activateForDoc(doc);
          await refreshAllTabs();
          await refreshTreeSelection();
          pluginBus.emit('activeDocChanged', {path, doc});
        },
        onClose: async (path) => { await closeTabInGroup(groupId, path); },
        onNew: async () => { await newUntitled(groupId); },
        isRightClick: () => pointerBtns.isRight(),
        isMiddleClick: () => pointerBtns.isMiddle(),
        onTabContextMenu: async (path, wp) => { await showTabContextMenu(groupId, path, wp); },
        onBarContextMenu: async (wp) => { await showBarContextMenu(groupId, wp); }
      });
      groupUi.set(groupId, ui);
      return ui;
    }

    async function ensureGroupUi()
    {
      if(!groupsHost) return;
      const ids = groups.ids();

      // Remove UI for groups that no longer exist.
      for(const [gid, ui] of [...groupUi.entries()])
      {
        if(!ids.includes(gid))
        {
          await ui.dispose();
          groupUi.delete(gid);
        }
      }

      // Detach all children and rebuild order: g0 [| splitter] g1
      for(const gid of ids)
      {
        const existing = groupUi.get(gid);
        if(existing && typeof UI.detach === 'function')
          await settled(UI.detach(win, groupsHost, existing.root));
      }
      if(groupSplitter && typeof UI.detach === 'function')
        await settled(UI.detach(win, groupsHost, groupSplitter.root));

      for(let i = 0; i < ids.length; i++)
      {
        const gid = ids[i];
        await buildGroupUi(gid);
        const ui = groupUi.get(gid);
        if(ui) await UI.attach(win, groupsHost, ui.root);

        if(i === 0 && ids.length >= 2)
        {
          if(!groupSplitter)
          {
            groupSplitter = await createTreeSplitter(win, groupsHost, {
              dragHost: chrome.shell,
              hitWidth: 7,
              getWidth: () => lastLeftWidth || Math.round(400 * leftFraction),
              setWidth: async (w) => {
                let hostW = Math.max(lastLeftWidth * 2 + 7, 400);
                try
                {
                  if(typeof UI.getElementFrame === 'function')
                  {
                    const frame = await UI.getElementFrame(win, groupsHost);
                    const measured = frameSize(frame).x;
                    if(measured >= 160) hostW = measured;
                  }
                }
                catch(e) { void e; }
                const usable = Math.max(160, hostW - 7);
                leftFraction = Math.max(0.15, Math.min(0.85, w / usable));
                await applyGroupSplitWidths();
                beginGeometryWatch();
              },
              onDragStart: beginGeometryWatch
            });
          }
          else
            await UI.attach(win, groupsHost, groupSplitter.root);
        }
      }

      if(ids.length < 2 && groupSplitter)
      {
        await settled(UI.destroyElement(win, groupSplitter.root));
        groupSplitter = null;
      }

      if(ids.length >= 2)
        await applyGroupSplitWidths();
      else
      {
        const only = groupUi.get(ids[0]);
        if(only)
        {
          if(typeof UI.setGrow === 'function')
            await settled(UI.setGrow(win, only.root, 1));
          await settled(UI.setLayoutSize(win, only.root, {x: 'auto', y: 'auto'}));
        }
      }

      for(const gid of ids)
      {
        const ui = groupUi.get(gid);
        if(ui) await ui.activateActive();
      }
    }

    // Body must shrink below content size (minHeight: 0) or it overflows the
    // status bar and the last editor lines are clipped underneath.
    const body = await UI.createElement(win, {
      layout: { type: 'row', gap: 0 },
      item: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, chrome.shell, body);

    sidebar = await createSideBar(win, body, { width: theme.treeWidth, side: 'left' });
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
          getActivePath: () => {
            syncDocsActiveFromFocus();
            return docs.activePath();
          },
          isRightClick: () => pointerBtns.isRight(),
          isMiddleClick: () => pointerBtns.isMiddle(),
          onContextMenu: async (info) => { await showTreeContextMenu(info); },
          onBackgroundContextMenu: async (wp) => { await showTreeBackgroundContextMenu(wp); }
        });
      }
    });

    leftSplitter = await createTreeSplitter(win, body, {
      dragHost: chrome.shell,
      getWidth: () => sidebar.getWidth(),
      setWidth: async (w) => {
        await sidebar.setWidth(w);
        if(tree) await tree.setWidth(w);
        await syncAllLayouts();
      },
      onDragStart: beginGeometryWatch
    });

    const editorColumn = await UI.createElement(win, {
      renderable: { type: 'box', colour: theme.bg },
      layout: { type: 'column', gap: 0 },
      item: { flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0 },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, body, editorColumn);

    await UI.attach(win, editorColumn, chrome.titleBar);

    groupsHost = await UI.createElement(win, {
      layout: { type: 'row', gap: 0 },
      item: { flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0 },
      contentAlign: 'fill',
      clipToBounds: true
    });
    await UI.attach(win, editorColumn, groupsHost);

    rightSplitter = await createTreeSplitter(win, body, {
      dragHost: chrome.shell,
      invert: true,
      hitWidth: 0,
      getWidth: () => (rightSidebar ? rightSidebar.getWidth() : 0),
      setWidth: async (w) => {
        if(!rightSidebar) return;
        await rightSidebar.setWidth(w);
        await syncAllLayouts();
      },
      onDragStart: beginGeometryWatch
    });

    rightSidebar = await createSideBar(win, body, {
      width: theme.treeWidth,
      side: 'right',
      collapsed: true,
      onVisibilityChange: async (visible, width) => {
        if(rightSplitter)
          await rightSplitter.setHitWidth(visible && width > 0 ? 7 : 0);
        beginGeometryWatch();
        await syncAllLayouts();
      }
    });

    status = await createStatusBar(win, chrome.shell);
    await status.setState({ row: 0, col: 0, language: '', dirty: false });

    palette = await createCommandPalette(win, chrome.root || chrome.shell, {
      registry: commands
    });

    contextMenu = await createContextMenu(win, chrome.root || chrome.shell);

    await ensureGroupUi();

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
        const g = groups.focused();
        if(g && g.activePath) await closeTabInGroup(g.id, g.activePath);
      }
    });
    commands.register({
      id: 'file.closeOtherTabs',
      title: 'Close Other Tabs',
      category: 'File',
      run: async () => {
        const g = groups.focused();
        if(g && g.activePath) await closeOtherTabsInGroup(g.id, g.activePath);
      }
    });
    commands.register({
      id: 'file.closeAllTabs',
      title: 'Close All Tabs in Group',
      category: 'File',
      run: async () => {
        const g = groups.focused();
        if(g) await closeAllTabsInGroup(g.id);
      }
    });
    commands.register({
      id: 'file.openToSide',
      title: 'Open to the Side',
      category: 'File',
      run: async () => {
        const g = groups.focused();
        if(g && g.activePath) await openTabToSide(g.id, g.activePath);
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
        const editor = focusedEditor();
        if(editor && typeof editor.toggleWordWrap === 'function')
          editor.toggleWordWrap();
      }
    });
    commands.register({
      id: 'view.splitEditorRight',
      title: 'Split Editor Right',
      category: 'View',
      run: async () => { await splitEditorRight(); }
    });
    commands.register({
      id: 'view.focusFirstGroup',
      title: 'Focus First Editor Group',
      category: 'View',
      run: async () => {
        const ids = groups.ids();
        if(ids[0]) await focusGroup(ids[0]);
      }
    });
    commands.register({
      id: 'view.focusSecondGroup',
      title: 'Focus Second Editor Group',
      category: 'View',
      run: async () => {
        const ids = groups.ids();
        if(ids[1]) await focusGroup(ids[1]);
        else await splitEditorRight();
      }
    });
    commands.register({
      id: 'view.closeEditorGroup',
      title: 'Close Editor Group',
      category: 'View',
      run: async () => { await closeEditorGroup(); }
    });

    commands.register({
      id: 'preferences.colorTheme',
      title: 'Preferences: Color Theme',
      category: 'Preferences',
      run: async () => {
        if(palette) await palette.open('theme ');
      }
    });

    const applyThemeToUi = async ({id} = {}) => {
      try
      {
        await Compositor.setClearColor(win, theme.shell[0], theme.shell[1], theme.shell[2], 1);
      }
      catch(e) { void e; }
      if(chrome && typeof chrome.reapplyTheme === 'function') await chrome.reapplyTheme();
      if(sidebar && typeof sidebar.reapplyTheme === 'function') await sidebar.reapplyTheme();
      if(rightSidebar && typeof rightSidebar.reapplyTheme === 'function') await rightSidebar.reapplyTheme();
      if(status && typeof status.reapplyTheme === 'function') await status.reapplyTheme();
      if(leftSplitter && typeof leftSplitter.reapplyTheme === 'function') await leftSplitter.reapplyTheme();
      if(rightSplitter && typeof rightSplitter.reapplyTheme === 'function') await rightSplitter.reapplyTheme();
      if(groupSplitter && typeof groupSplitter.reapplyTheme === 'function') await groupSplitter.reapplyTheme();
      if(tree && typeof tree.reapplyTheme === 'function') await tree.reapplyTheme();
      for(const ui of groupUi.values())
      {
        if(ui && typeof ui.reapplyTheme === 'function') await ui.reapplyTheme();
      }
      pluginBus.emit('themeChanged', {id: id || getThemeId()});
      if(status)
      {
        const label = (listThemes().find((t) => t.id === getThemeId()) || {}).label || getThemeId();
        await status.setText('Theme: ' + label);
      }
    };

    onThemeChange((payload) => { void applyThemeToUi(payload); });

    /** @type {{ unregister: () => void }[]} */
    let themeCommandHandles = [];
    const syncThemeCommands = () => {
      for(const h of themeCommandHandles)
      {
        try { h.unregister(); } catch(e) { void e; }
      }
      themeCommandHandles = [];
      for(const t of listThemes())
      {
        themeCommandHandles.push(commands.register({
          id: `theme.use.${t.id}`,
          title: t.label,
          category: 'Theme',
          run: async () => {
            if(getThemeId() === t.id) return;
            setTheme(t.id);
          }
        }));
      }
    };
    syncThemeCommands();

    commands.register({
      id: 'app.quit',
      title: 'Quit',
      category: 'File',
      run: async () => {
        try { await Compositor.destroyWindow(win); } catch(e) { void e; }
        try { Engine.quit(); } catch(e) { void e; }
      }
    });

    const host = createPluginHost({
      workspaceRoot,
      win,
      getActiveDoc: () => {
        syncDocsActiveFromFocus();
        return docs.active();
      },
      forEachEditor,
      editor: focusedEditor(),
      status,
      sidebar,
      rightSidebar,
      commands,
      editors: editorRegistry,
      openFile: openPath,
      bus: pluginBus
    });
    try
    {
      await loadFeaturePlugins(host);
      pluginsLoaded = true;
      syncThemeCommands();
      const beforeId = getThemeId();
      try
      {
        const afterId = await loadThemePreference();
        if(afterId && afterId !== beforeId)
          await applyThemeToUi({id: afterId});
      }
      catch(e) { void e; }
      pluginBus.emit('ready', { workspaceRoot });
    }
    catch(error)
    {
      await Log.warn('Feature plugins: ' + String(error && error.message ? error.message : error));
    }
    void pluginsLoaded;

    try
    {
      await Fs.watchWorkspace(workspaceRoot, (evt) => {
        if(tree) tree.refresh();
        if(evt && evt.type === 'modify' && evt.path)
        {
          for(const doc of docs.list())
          {
            if(!doc || doc.dirty) continue;
            const filePath = doc.sourcePath || doc.path;
            if(!filePath || filePath !== evt.path) continue;
            if(isCustomDoc(doc))
            {
              for(const ui of groupUi.values())
              {
                if(ui.hasCustom(doc.path))
                  void ui.reloadCustom(doc.path).catch(() => {});
              }
              continue;
            }
            Fs.readText(evt.path).then((text) => {
              if(docs.replaceFromDisk(evt.path, text))
              {
                for(const ui of groupUi.values())
                  ui.queueRenderIfPath(evt.path);
              }
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
        if(groups.count() >= 2) await applyGroupSplitWidths();
        const changed = await syncAllLayouts();
        if(changed)
        {
          geometryIdle = 0;
          geometryWatchUntil = Math.max(geometryWatchUntil, Date.now() + 400);
          return;
        }
        if(++geometryIdle > 12 && Date.now() >= geometryWatchUntil)
          watchGeometry = false;
      })();
    });

    Event.on('pointerUp', ({ id }) => {
      if(id !== undefined && id !== win) return;
      if(!watchGeometry) return;
      geometryIdle = 0;
      void syncAllLayouts();
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
        const g = groups.focused();
        if(g && g.activePath) await closeTabInGroup(g.id, g.activePath);
      }
      if(result === 'tab-next' || result === 'tab-prev')
      {
        const path = groups.cycleTabsInGroup(groups.focusedId(), result === 'tab-next' ? 1 : -1);
        if(path)
        {
          docs.setActive(path);
          await activateFocused();
          await refreshTreeSelection();
          await updateTitleForDoc(docs.active());
          pluginBus.emit('activeDocChanged', { path, doc: docs.active() });
        }
      }
      if(result === 'split-right') await splitEditorRight();
      if(result === 'focus-group-1')
      {
        const ids = groups.ids();
        if(ids[0]) await focusGroup(ids[0]);
      }
      if(result === 'focus-group-2')
      {
        const ids = groups.ids();
        if(ids[1]) await focusGroup(ids[1]);
        else await splitEditorRight();
      }
      if(result === 'quit' || result === 'close-window')
      {
        try { await Compositor.destroyWindow(win); } catch(e) { void e; }
        try { Engine.quit(); } catch(e) { void e; }
      }
    };

    const interceptGroupKeys = (key, mods) => {
      if(!mods || !mods.hasCtrl() || mods.hasAlt()) return null;
      if(!mods.hasShift() && keyIn(key, KEY_BACKSLASH)) return 'split-right';
      if(!mods.hasShift() && keyIn(key, KEY_1)) return 'focus-group-1';
      if(!mods.hasShift() && keyIn(key, KEY_2)) return 'focus-group-2';
      return null;
    };

    Event.on('keyDown', async ({ key, id }) => {
      if(id !== win) return;
      const editor = focusedEditor();
      if(editor) editor.mods.down(key);
      if(contextMenu && contextMenu.isOpen())
      {
        const consumed = await contextMenu.handleKey(key);
        if(consumed) return;
      }
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleKey(key, editor ? editor.mods : null);
        if(consumed) return;
      }
      const chord = editor ? interceptGroupKeys(key, editor.mods) : null;
      if(chord)
      {
        await applyKeyResult(chord);
        return;
      }
      if(!editor) return;
      const result = await editor.onKey(key);
      await applyKeyResult(result);
    });

    Event.on('keyRepeat', async ({ key, id }) => {
      if(id !== win) return;
      if(contextMenu && contextMenu.isOpen())
      {
        const consumed = await contextMenu.handleKey(key);
        if(consumed) return;
      }
      const editor = focusedEditor();
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleKey(key, editor ? editor.mods : null);
        if(consumed) return;
      }
      const chord = editor ? interceptGroupKeys(key, editor.mods) : null;
      if(chord)
      {
        await applyKeyResult(chord);
        return;
      }
      if(!editor) return;
      const result = await editor.onKey(key);
      await applyKeyResult(result);
    });

    Event.on('keyUp', ({ key, id }) => {
      if(id !== win) return;
      const editor = focusedEditor();
      if(editor) editor.mods.up(key);
    });

    Event.on('keyModifiers', ({ id, depressed, latched }) => {
      if(id !== undefined && id !== win) return;
      const editor = focusedEditor();
      if(editor && ((depressed | 0) | (latched | 0)) === 0) editor.mods.clear();
    });

    Event.on('textInput', async ({ text, id }) => {
      if(id !== win) return;
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleText(text);
        if(consumed) return;
      }
      syncDocsActiveFromFocus();
      if(isCustomDoc(docs.active())) return;
      const editor = focusedEditor();
      if(editor) await editor.onTextInput(text);
    });

    Event.on('textRepeat', async ({ text, id }) => {
      if(id !== win) return;
      if(palette && palette.isOpen())
      {
        const consumed = await palette.handleText(text);
        if(consumed) return;
      }
      syncDocsActiveFromFocus();
      if(isCustomDoc(docs.active())) return;
      const editor = focusedEditor();
      if(editor) await editor.onTextInput(text);
    });

    Event.on('windowClosed', ({ id }) => {
      if(id !== undefined && id !== win) return;
      for(const ui of groupUi.values())
        void ui.dispose();
      try { Engine.quit(); } catch(e) { void e; }
    });

    void KEY;
    await refreshAllTabs();
    await syncAllLayouts();
    await Log.info('KoyaEdit ready');
  })().catch(async (error) => {
    try { await Log.error('KoyaEdit failed: ' + String(error && error.stack ? error.stack : error)); }
    catch(_) { void _; }
  });
}
