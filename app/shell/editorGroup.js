/**
 * One editor group column: tabs + breadcrumbs + text viewport / custom viewer.
 */
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import { theme } from '/rom/theme.js';
import { isUntitledPath, isCustomDoc } from '/rom/workspace/documents.js';
import { createTabBar, createBreadcrumbBar } from '/rom/shell/chrome.js';
import { createEditorViewport } from '/rom/editor/viewport.js';
import { basename } from '/rom/editor/buffer.js';

function settled(p)
{
    return p.then((v) => v, () => null);
}

/**
 * @param {number} win
 * @param {number} parent
 * @param {{
 *   id: string,
 *   workspaceRoot: string,
 *   workspaceLabel: string,
 *   docs: object,
 *   editorRegistry: object,
 *   getGroupState: () => { tabPaths: string[], activePath: string|null },
 *   isFocused: () => boolean,
 *   onFocus: () => void|Promise<void>,
 *   onDirty: (doc: object|null) => void|Promise<void>,
 *   onStatus: (info: any) => void|Promise<void>,
 *   onSelect: (path: string) => void|Promise<void>,
 *   onPin: (path: string) => void|Promise<void>,
 *   onClose: (path: string) => void|Promise<void>,
 *   onNew: () => void|Promise<void>,
 * }} opts
 */
export async function createEditorGroup(win, parent, opts)
{
    const id = String(opts.id || 'g1');
    const docs = opts.docs;
    const editorRegistry = opts.editorRegistry;
    const workspaceRoot = opts.workspaceRoot || '';
    const workspaceLabel = opts.workspaceLabel || 'Workspace';
    const getGroupState = typeof opts.getGroupState === 'function' ? opts.getGroupState : () => ({tabPaths: [], activePath: null});
    const isFocused = typeof opts.isFocused === 'function' ? opts.isFocused : () => true;
    const onFocus = typeof opts.onFocus === 'function' ? opts.onFocus : async () => {};
    const onDirty = typeof opts.onDirty === 'function' ? opts.onDirty : async () => {};
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : async () => {};

    const root = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.bg},
        layout: {type: 'column', gap: 0},
        item: {flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    // Caller attaches `root` (editor area controls sibling order with splitters).
    void parent;

    if(typeof UI.setOnMouseDown === 'function')
    {
        await UI.setOnMouseDown(win, root, async () => {
            await onFocus();
        });
    }

    const tabs = await createTabBar(win, root, {
        isRightClick: typeof opts.isRightClick === 'function' ? opts.isRightClick : () => false,
        isMiddleClick: typeof opts.isMiddleClick === 'function' ? opts.isMiddleClick : () => false,
        onSelect: async (path) => {
            await onFocus();
            if(typeof opts.onSelect === 'function') await opts.onSelect(path);
        },
        onPin: async (path) => {
            await onFocus();
            if(typeof opts.onPin === 'function') await opts.onPin(path);
        },
        onClose: async (path) => {
            await onFocus();
            if(typeof opts.onClose === 'function') await opts.onClose(path);
        },
        onNew: async () => {
            await onFocus();
            if(typeof opts.onNew === 'function') await opts.onNew();
        },
        onContextMenu: async (path, wp) => {
            await onFocus();
            if(typeof opts.onTabContextMenu === 'function') await opts.onTabContextMenu(path, wp);
        },
        onBarContextMenu: async (wp) => {
            await onFocus();
            if(typeof opts.onBarContextMenu === 'function') await opts.onBarContextMenu(wp);
        }
    });

    const crumbs = await createBreadcrumbBar(win, root, {workspaceName: workspaceLabel});

    const content = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.bg},
        layout: {type: 'column', gap: 0},
        item: {flexGrow: 1, flexShrink: 1, minHeight: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, root, content);

    const editor = await createEditorViewport(win, content, {
        onDirty: async () => {
            const state = getGroupState();
            const doc = state.activePath ? docs.get(state.activePath) : null;
            await onDirty(doc);
        },
        onStatus: async (info) => {
            if(!isFocused()) return;
            const state = getGroupState();
            const doc = state.activePath ? docs.get(state.activePath) : null;
            if(isCustomDoc(doc)) return;
            await onStatus(info);
        },
        onFocus: () => { void onFocus(); }
    });

    const viewerHost = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.bg},
        layout: {
            type: 'column',
            gap: 0,
            alignItems: 'stretch',
            justifyContent: 'start'
        },
        item: {
            size: {x: 'auto', y: 0},
            flexGrow: 0,
            flexShrink: 0,
            minHeight: 0
        },
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, content, viewerHost);

    /** @type {Map<string, { providerId: string, instance: object, mounted: boolean, active: boolean }>} */
    const customInstances = new Map();
    let centerMode = 'text';
    let activeCustomPath = null;
    let lastTabSig = '';
    let disposed = false;

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
        const ctx = {win, workspaceRoot, host: null};
        const instance = await provider.create(doc, ctx);
        if(!instance || typeof instance.mount !== 'function') return null;
        rec = {providerId: provider.id, instance, mounted: false, active: false};
        customInstances.set(doc.path, rec);
        return rec;
    };

    const setCenterMode = async (mode) => {
        if(disposed || !editor || !viewerHost) return;
        const wantCustom = mode === 'custom';
        if(centerMode === (wantCustom ? 'custom' : 'text')) return;
        centerMode = wantCustom ? 'custom' : 'text';
        try
        {
            if(wantCustom)
            {
                if(typeof UI.setGrow === 'function')
                {
                    await settled(UI.setGrow(win, editor.root, 0));
                    await settled(UI.setGrow(win, viewerHost, 1));
                }
                await settled(UI.setLayoutSize(win, editor.root, {x: 1, y: 0}));
                await settled(UI.setLayoutSize(win, viewerHost, {x: 'auto', y: 'auto'}));
                if(typeof UI.setGrow === 'function')
                    await settled(UI.setGrow(win, viewerHost, 1));
            }
            else
            {
                if(typeof UI.setGrow === 'function')
                {
                    await settled(UI.setGrow(win, editor.root, 1));
                    await settled(UI.setGrow(win, viewerHost, 0));
                }
                await settled(UI.setLayoutSize(win, editor.root, {x: 'auto', y: 'auto'}));
                await settled(UI.setLayoutSize(win, viewerHost, {x: 'auto', y: 0}));
            }
        }
        catch(e) { void e; }
    };

    const refreshBreadcrumbs = async () => {
        const state = getGroupState();
        const active = state.activePath ? docs.get(state.activePath) : null;
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
        const rootPath = workspaceRoot.replace(/\/+$/, '');
        let rel = crumbPath;
        if(rel.startsWith(rootPath + '/')) rel = rel.slice(rootPath.length + 1);
        else if(rel === rootPath) rel = '';
        const parts = rel ? rel.split('/').filter(Boolean) : [active.title || basename(crumbPath)];
        if(active.sourcePath && active.kind === 'markdown')
            parts.push('Preview');
        await crumbs.setPath(parts);
    };

    const refreshTabs = async () => {
        const state = getGroupState();
        const list = state.tabPaths.map((p) => docs.get(p)).filter(Boolean);
        const sig = list
            .map((d) => `${d.path}\0${d.dirty ? 1 : 0}\0${d.preview ? 1 : 0}\0${d.title || ''}`)
            .join('\n') + `\n#${state.activePath || ''}\n@${isFocused() ? 1 : 0}`;
        if(sig !== lastTabSig)
        {
            lastTabSig = sig;
            await tabs.render(list, state.activePath);
        }
        await refreshBreadcrumbs();
        await paintFocus();
    };

    const paintFocus = async () => {
        const focused = isFocused();
        try
        {
            // Subtle focus cue on the group chrome via tab-bar hinter — box on root edge.
            await settled(UI.setBoxColour(win, root, focused ? theme.bg : theme.bg));
        }
        catch(e) { void e; }
        void focused;
    };

    const syncLayout = async () => {
        if(disposed) return false;
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
    };

    const activateForDoc = async (doc) => {
        if(disposed || !editor) return;

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
            if(isFocused()) await onStatus({row: 0, col: 0, language: '', dirty: false});
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
                try { await syncLayout(); } catch(e) { void e; }
            }
            if(isFocused())
            {
                const isMdPreview = doc.kind === 'markdown';
                await onStatus({
                    cursor: false,
                    label: isMdPreview ? 'Preview' : 'Image',
                    language: doc.language || doc.kind || 'image',
                    dirty: false
                });
            }
            return;
        }

        await setCenterMode('text');
        // Already showing this buffer — avoid setDocument (wipes colours) / syncLayout.
        const already = editor.getDocument && editor.getDocument() === doc;
        if(!already)
            editor.setDocument(doc);
        if(isFocused()) editor.focus();
        else editor.blur();
        if(!already)
        {
            try { await editor.syncLayout(); } catch(e) { void e; }
        }
    };

    /** Show whatever the group state says is active. */
    const activateActive = async () => {
        const state = getGroupState();
        const doc = state.activePath ? docs.get(state.activePath) : null;
        await activateForDoc(doc);
        await refreshTabs();
    };

    const setFocusedVisual = async () => {
        await paintFocus();
        const state = getGroupState();
        const doc = state.activePath ? docs.get(state.activePath) : null;
        if(isFocused())
        {
            if(doc && !isCustomDoc(doc)) editor.focus();
        }
        else
            editor.blur();
    };

    const dispose = async () => {
        disposed = true;
        for(const path of [...customInstances.keys()])
            await disposeCustomInstance(path);
        try { if(editor && editor.dispose) editor.dispose(); } catch(e) { void e; }
        try { await settled(UI.destroyElement(win, root)); } catch(e) { void e; }
    };

    void Compositor;

    return {
        id,
        root,
        editor,
        getEditor: () => editor,
        refreshTabs,
        activateForDoc,
        activateActive,
        syncLayout,
        setFocusedVisual,
        disposeCustomInstance,
        disposeCustomAll: async () => {
            for(const path of [...customInstances.keys()])
                await disposeCustomInstance(path);
        },
        hasCustom: (path) => customInstances.has(path),
        reloadCustom: async (path) => {
            const rec = customInstances.get(path);
            if(rec && typeof rec.instance.reload === 'function')
                await rec.instance.reload();
        },
        queueRenderIfPath: (path) => {
            const state = getGroupState();
            if(state.activePath === path && editor) editor.queueRender();
        },
        async reapplyTheme() {
            try
            {
                await Promise.all([
                    settled(UI.setBoxColour(win, root, theme.bg)),
                    settled(UI.setBoxColour(win, content, theme.bg)),
                    settled(UI.setBoxColour(win, viewerHost, theme.bg))
                ]);
            }
            catch(e) { void e; }
            if(tabs && typeof tabs.reapplyTheme === 'function') await tabs.reapplyTheme();
            await refreshTabs();
            if(crumbs && typeof crumbs.reapplyTheme === 'function') await crumbs.reapplyTheme();
            if(editor && typeof editor.reapplyTheme === 'function') await editor.reapplyTheme();
            // Custom viewers: next layout/reload reads theme; force layout if active.
            if(activeCustomPath)
            {
                const rec = customInstances.get(activeCustomPath);
                if(rec && typeof rec.instance.layout === 'function')
                    try { await rec.instance.layout(); } catch(e) { void e; }
                else if(rec && typeof rec.instance.reload === 'function')
                    try { await rec.instance.reload(); } catch(e) { void e; }
            }
        },
        dispose
    };
}
