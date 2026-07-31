import {basename} from '/rom/editor/buffer.js';
import {indentStatusLabel} from '/rom/editor/settings.js';
import {estimateLabelSize} from '/rom/shell/layout.js';
import {theme} from '/rom/theme.js';
import * as Fs from '/rom/workspace/fs.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';

/** Settle rejected UI ops so one failure does not abort a batch. */
function settled(promise)
{
    return promise.then((value) => ({ok: true, value}), (error) => ({ok: false, error}));
}

/** Symbola glyph per entry — mockup rows/tabs carry folder & file-type icons. */
function fileGlyph(name, isDir)
{
    if(isDir) return '🗀';
    const n = String(name || '').toLowerCase();
    if(/^readme(\.|$)/.test(n)) return 'ⓘ';
    if(/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/.test(n)) return '🖻';
    return '🗎';
}

function langLabel(language)
{
    const id = String(language || '').toLowerCase();
    if(id === 'javascript' || id === 'js') return 'JavaScript';
    if(id === 'typescript' || id === 'ts') return 'TypeScript';
    if(id === 'c') return 'C';
    if(id === 'cpp' || id === 'c++') return 'C++';
    if(id === 'markdown' || id === 'md') return 'Markdown';
    if(id === 'json') return 'JSON';
    if(id === 'css') return 'CSS';
    if(id === 'html') return 'HTML';
    if(id === 'png' || id === 'jpg' || id === 'jpeg' || id === 'gif' || id === 'webp' || id === 'bmp' || id === 'ico') return id.toUpperCase();
    if(id === 'image') return 'Image';
    if(id === 'markdown' || id === 'md') return 'Markdown';
    if(id === 'markdown-preview') return 'Markdown Preview';
    if(!id) return 'Plain Text';
    return id.charAt(0).toUpperCase() + id.slice(1);
}

export async function createTabBar(win, parent, opts = {})
{
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : async () => {};
    const onPin    = typeof opts.onPin === 'function' ? opts.onPin : async () => {};
    const onClose  = typeof opts.onClose === 'function' ? opts.onClose : async () => {};
    const onNew    = typeof opts.onNew === 'function' ? opts.onNew : async () => {};
    void onClose;
    const tabHeight = theme.tabHeight;
    const padL      = 16;
    const padR      = 16;
    const gap       = 8;
    const fontSize  = theme.fontSizeUi;
    const iconW     = 14;
    /** VS Code: double-click a tab to pin the preview; empty tab row → new file. */
    let lastClick   = {path: null, at: 0};
    const NEW_CLICK = '__new__';

    const bar = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panel},
        layout: {type: 'row', gap: 0, padding: {l: 0, r: 0, t: 0, b: 0}, alignItems: 'center', justifyContent: 'start'},
        item: {size: {y: tabHeight}},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, bar);

    const noteNewClick = async () => {
        const now      = Date.now();
        const isDouble = lastClick.path === NEW_CLICK && (now - lastClick.at) < 400;
        lastClick      = {path: NEW_CLICK, at: now};
        if(isDouble) await onNew();
    };

    // Empty tab-row space: bar handler. Tab chips bind their own mouseDown and win.
    if(typeof UI.setOnMouseDown === 'function') await UI.setOnMouseDown(win, bar, noteNewClick);

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, bar, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    /**
     * Retained tab slots keyed by path.
     * @type {Map<string, {
     *   path: string, root: number, icon: number, text: number, divider: number,
     *   label: string, active: boolean, preview: boolean, chipWidth: number,
     *   iconGlyph: string, labelColour: object, hoverBound: boolean
     * }>}
     */
    const tabs = new Map();
    /** Visual order of path keys currently attached to the bar. */
    let order = [];
    /** Retained empty-state chip (created lazily). */
    let emptySlot    = null;
    let emptyVisible = false;
    let renderChain  = Promise.resolve();

    const bindTabClick = async (slot) => {
        await UI.setOnMouseDown(win, slot.root, async () => {
            const path     = slot.path;
            const now      = Date.now();
            const isDouble = lastClick.path === path && (now - lastClick.at) < 400;
            lastClick      = {path, at: now};
            if(isDouble)
                await onPin(path);
            else
                await onSelect(path);
        });
    };

    const bindTabHover = async (slot) => {
        if(slot.hoverBound) return;
        if(typeof UI.setOnMouseEnter !== 'function' || typeof UI.setOnMouseExit !== 'function') return;
        slot.hoverBound = true;
        await Promise.all([
            UI.setOnMouseEnter(
                win, slot.root,
                async () => {
                    if(slot.active) return;
                    await settled(UI.setBoxColour(win, slot.root, theme.panelHigh));
                }),
            UI.setOnMouseExit(win, slot.root, async () => { await settled(UI.setBoxColour(win, slot.root, slot.active ? theme.tabActive : theme.tabInactive)); })
        ]);
    };

    const createTabSlot = async (path) => {
        const root    = await UI.createElement(win, {
            renderable: {type: 'box', colour: theme.tabInactive, cornerRadius: 0},
            layout: {type: 'row', gap, padding: {l: padL, r: padR, t: 0, b: 0}, alignItems: 'center'},
            item: {size: {x: 80, y: tabHeight}, flexShrink: 0},
            contentAlign: 'fill'
        });
        const icon    = await UI.createElement(win, {
            renderable:
                {type: 'text', string: '🗎', size: 12, font: theme.fontIcon, colour: theme.tertiary, metricsBasis: 'line', justify: 'center', vAlign: 'center'},
            item: {size: {x: iconW, y: tabHeight}, flexShrink: 0},
            contentAlign: {x: 'center', y: 'center'}
        });
        const text    = await UI.createElement(win, {
            renderable:
                {type: 'text', string: ' ', size: fontSize, font: theme.fontUi, colour: theme.textMuted, metricsBasis: 'line', justify: 'left', vAlign: 'center'},
            item: {size: {x: 40, y: tabHeight}},
            contentAlign: {x: 'start', y: 'center'}
        });
        const divider = await UI.createElement(win, {renderable: {type: 'box', colour: theme.border}, item: {size: {x: 1, y: tabHeight}, flexShrink: 0}});
        await UI.attach(win, root, icon);
        await UI.attach(win, root, text);
        const slot = {
            path,
            root,
            icon,
            text,
            divider,
            label: '',
            active: false,
            preview: false,
            chipWidth: 80,
            iconGlyph: '🗎',
            labelColour: theme.textMuted,
            hoverBound: false,
            attached: false
        };
        await bindTabClick(slot);
        await bindTabHover(slot);
        return slot;
    };

    const ensureEmpty = async () => {
        if(emptySlot) return emptySlot;
        const root = await UI.createElement(
            win, {layout: {type: 'row', padding: {l: 16, r: 16, t: 0, b: 0}, alignItems: 'center'}, item: {size: {y: tabHeight}}, contentAlign: 'fill'});
        const text = await UI.createElement(win, {
            renderable: {
                type: 'text',
                string: 'No open files',
                size: fontSize,
                font: theme.fontUi,
                colour: theme.textMuted,
                metricsBasis: 'line',
                justify: 'left',
                vAlign: 'center'
            },
            item: {size: {x: estimateLabelSize('No open files', fontSize, 200).x, y: tabHeight}},
            contentAlign: {x: 'start', y: 'center'}
        });
        await UI.attach(win, root, text);
        emptySlot = {root, text, attached: false};
        return emptySlot;
    };

    const setEmptyVisible = async (show) => {
        if(show)
        {
            const slot = await ensureEmpty();
            if(emptyVisible) return;
            if(!slot.attached)
            {
                await UI.attach(win, bar, slot.root);
                slot.attached = true;
            }
            if(typeof UI.setEnabled === 'function') await settled(UI.setEnabled(win, slot.root, true));
            emptyVisible = true;
            return;
        }
        if(!emptySlot || !emptyVisible) return;
        if(typeof UI.detach === 'function')
        {
            await settled(UI.detach(win, bar, emptySlot.root));
            emptySlot.attached = false;
        } else if(typeof UI.setEnabled === 'function')
            await settled(UI.setEnabled(win, emptySlot.root, false));
        emptyVisible = false;
    };

    const syncTabVisual = async (slot, spec) => {
        const ops = [];
        if(slot.label !== spec.label)
        {
            slot.label = spec.label;
            ops.push(UI.setTextString(win, slot.text, spec.label));
            ops.push(UI.setLayoutSize(win, slot.text, {x: Math.max(1, spec.textSize.x), y: tabHeight}));
        }
        if(slot.chipWidth !== spec.chipWidth)
        {
            slot.chipWidth = spec.chipWidth;
            ops.push(UI.setLayoutSize(win, slot.root, {x: spec.chipWidth, y: tabHeight}));
        }
        if(slot.iconGlyph !== spec.icon)
        {
            slot.iconGlyph = spec.icon;
            ops.push(UI.setTextString(win, slot.icon, spec.icon));
        }
        if(slot.active !== spec.active || slot.preview !== spec.preview)
        {
            slot.active  = spec.active;
            slot.preview = spec.preview;
            ops.push(UI.setBoxColour(win, slot.root, spec.active ? theme.tabActive : theme.tabInactive));
            ops.push(UI.setTextColour(win, slot.icon, spec.active ? theme.primary : theme.tertiary));
            ops.push(UI.setTextColour(win, slot.text, spec.labelColour));
        }
        if(ops.length) await Promise.all(ops.map((p) => settled(p)));
    };

    const detachSlot = async (slot) => {
        if(!slot.attached) return;
        if(typeof UI.detach === 'function')
        {
            await settled(UI.detach(win, bar, slot.root));
            await settled(UI.detach(win, bar, slot.divider));
        } else
        {
            await Promise.all([settled(UI.setEnabled(win, slot.root, false)), settled(UI.setEnabled(win, slot.divider, false))]);
        }
        slot.attached = false;
    };

    const attachSlot = async (slot) => {
        if(slot.attached) return;
        await UI.attach(win, bar, slot.root);
        await UI.attach(win, bar, slot.divider);
        if(typeof UI.setEnabled === 'function')
        {
            await Promise.all([settled(UI.setEnabled(win, slot.root, true)), settled(UI.setEnabled(win, slot.divider, true))]);
        }
        slot.attached = true;
    };

    const destroySlot = async (slot) => {
        await detachSlot(slot);
        await Promise.all([settled(UI.destroyElement(win, slot.root)), settled(UI.destroyElement(win, slot.divider))]);
    };

    /**
     * Retained sync: create/update/remove only what changed; reorder via detach/attach
     * when document order drifts from the bar's child order.
     */
    const renderInner = async (docs, activePath) => {
        const list = Array.isArray(docs) ? docs : [];
        if(list.length === 0)
        {
            for(const path of [...tabs.keys()])
            {
                const slot = tabs.get(path);
                tabs.delete(path);
                await destroySlot(slot);
            }
            order = [];
            await setEmptyVisible(true);
            return;
        }

        await setEmptyVisible(false);

        const specs     = list.map((doc) => {
            const active      = doc.path === activePath;
            const name        = doc.title || basename(doc.path);
            const label       = `${doc.dirty ? '• ' : ''}${name}`;
            const icon        = fileGlyph(name, false);
            const textSize    = estimateLabelSize(label, fontSize, 220);
            const chipWidth   = padL + iconW + gap + textSize.x + padR;
            const labelColour = active ? (doc.preview ? theme.textDim : theme.text) : theme.textMuted;
            return {path: doc.path, doc, active, preview: !!doc.preview, label, icon, textSize, chipWidth, labelColour};
        });
        const nextPaths = specs.map((s) => s.path);
        const nextSet   = new Set(nextPaths);

        // Drop closed buffers (destroy is required — path is gone).
        for(const path of [...tabs.keys()])
        {
            if(nextSet.has(path)) continue;
            const slot = tabs.get(path);
            tabs.delete(path);
            await destroySlot(slot);
        }

        // Ensure slots exist and visuals match.
        for(const spec of specs)
        {
            let slot = tabs.get(spec.path);
            if(!slot)
            {
                slot = await createTabSlot(spec.path);
                tabs.set(spec.path, slot);
            }
            await syncTabVisual(slot, spec);
        }

        // Reorder only when the sequence changed — detach/reattach retained nodes.
        const orderSame = order.length === nextPaths.length && order.every((p, i) => p === nextPaths[i]);
        const isAppend  = nextPaths.length > order.length && order.every((p, i) => p === nextPaths[i]);
        if(isAppend)
        {
            for(let i = order.length; i < nextPaths.length; i++)
            {
                const slot = tabs.get(nextPaths[i]);
                if(slot) await attachSlot(slot);
            }
            order = nextPaths.slice();
        } else if(!orderSame)
        {
            for(const path of order)
            {
                const slot = tabs.get(path);
                if(slot) await detachSlot(slot);
            }
            for(const path of nextPaths)
            {
                const slot = tabs.get(path);
                if(slot) await attachSlot(slot);
            }
            order = nextPaths.slice();
        } else
        {
            for(const path of nextPaths)
            {
                const slot = tabs.get(path);
                if(slot && !slot.attached) await attachSlot(slot);
            }
            order = nextPaths.slice();
        }
    };

    const render = (docs, activePath) => {
        const run   = renderChain.then(() => renderInner(docs, activePath));
        renderChain = run.then(() => {}, () => {});
        return run;
    };

    return {root: bar, render};
}

export async function createBreadcrumbBar(win, parent, opts = {})
{
    const workspaceName = typeof opts.workspaceName === 'string' ? opts.workspaceName : 'Workspace';
    const height        = theme.breadcrumbHeight || 24;
    const fontSize      = theme.fontSizeUiSm;

    const bar = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.bg},
        layout: {type: 'row', gap: 0, padding: {l: 16, r: 16, t: 0, b: 0}, alignItems: 'center'},
        item: {size: {y: height}, flexShrink: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, bar);

    // Single text node — splitting head/tail into separate layout boxes left a
    // large gap because estimateLabelSize over-sized the path slot.
    const labelId = await UI.createElement(win, {
        renderable: {type: 'text', string: ' ', size: fontSize, font: theme.fontUi, colour: theme.textMuted, metricsBasis: 'line', justify: 'left', vAlign: 'center'},
        item: {size: {x: 8, y: height}, flexGrow: 0, flexShrink: 0},
        contentAlign: {x: 'start', y: 'center'}
    });
    await UI.attach(win, bar, labelId);

    let lastLabel = '';

    return {
        root: bar,
        async setPath(relParts) {
            const parts = Array.isArray(relParts) ? relParts.filter(Boolean) : [];
            const segs  = [workspaceName, ...parts];
            const text  = segs.length ? segs.join(' › ') : ' ';
            if(text === lastLabel) return;
            lastLabel = text;

            await UI.setTextString(win, labelId, text);
            let w = estimateLabelSize(text, fontSize, 2000).x;
            try
            {
                const metrics = await UI.measureText(win, labelId);
                const mx      = metrics && metrics.size && metrics.size.x;
                if(Number.isFinite(mx) && mx > 0) w = Math.ceil(mx);
            } catch(e)
            {
                void e;
            }
            await UI.setLayoutSize(win, labelId, {x: Math.max(8, Math.min(2000, w)), y: height});
        }
    };
}

export async function createFileTree(win, parent, opts = {})
{
    const workspaceRoot = opts.root;
    const onOpen        = typeof opts.onOpen === 'function' ? opts.onOpen : async () => {};
    const getActivePath = typeof opts.getActivePath === 'function' ? opts.getActivePath : () => null;
    const embedded      = !!opts.embedded;
    /** Soft cap on flattened expanded rows kept in the DOM. */
    const maxFlatRows = 4000;
    let treeWidth     = typeof opts.width === 'number' ? opts.width : theme.treeWidth;
    const fontSize    = theme.fontSizeUi;
    const rowH        = theme.treeRowHeight || 28;
    const accentW     = 2;
    const chevronW    = 12;
    const iconW       = 16;
    /** Space between folder icon and label (not between chevron and icon). */
    const iconGap = 6;
    /** Tight gap after the disclosure chevron before the icon. */
    const chevronGap = 2;
    /** libinput / Wayland conventional axis units per mouse-wheel detent. */
    const WHEEL_AXIS_STEP      = 15;
    const WHEEL_LINES_PER_STEP = 3;
    /** VS Code: single-click preview open; double-click pins. */
    let lastClick = {path: null, at: 0};
    /** Pixel scroll of the retained list inside the clip. */
    let scrollY    = 0;
    let clipH      = 400;
    let activePath = getActivePath();
    /**
     * Exclusive hover path. Engine mouseExit can race async setBoxColour when the
     * pointer moves quickly across rows, leaving multiple hover paints applied.
     */
    let hoveredPath = null;
    let hoverEpoch  = 0;

    const pane = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panel},
        layout: {type: 'column', gap: 0, padding: {l: 0, r: 0, t: 10, b: 10}},
        item: embedded ? {flexGrow: 1, flexShrink: 1, minHeight: 0} : {size: {x: treeWidth}, flexShrink: 0, minHeight: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, pane);

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, pane, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    const headerLabel = 'Explorer';
    const headerSize  = estimateLabelSize(headerLabel, fontSize, Math.max(32, treeWidth - 48));
    const headerWrap  = await UI.createElement(
        win, {layout: {type: 'row', gap: 8, padding: {l: 16, r: 16, t: 0, b: 0}, alignItems: 'center'}, item: {size: {y: 30}}, contentAlign: 'fill'});
    await UI.attach(win, pane, headerWrap);

    const headerH    = 30;
    const headerIcon = await UI.createElement(win, {
        renderable: {type: 'text', string: '▾', size: 10, font: theme.fontIcon, colour: theme.text, metricsBasis: 'line', justify: 'center', vAlign: 'center'},
        item: {size: {x: 10, y: headerH}, flexShrink: 0},
        contentAlign: {x: 'center', y: 'center'}
    });
    await UI.attach(win, headerWrap, headerIcon);

    const header = await UI.createElement(win, {
        renderable:
            {type: 'text', string: headerLabel, size: fontSize, font: theme.fontUi, colour: theme.text, metricsBasis: 'line', justify: 'left', vAlign: 'center'},
        item: {size: {x: Math.min(Math.max(32, treeWidth - 48), Math.max(headerSize.x, 60)), y: headerH}},
        contentAlign: {x: 'start', y: 'center'}
    });
    await UI.attach(win, headerWrap, header);

    const headerPad = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {y: 6}}});
    await UI.attach(win, pane, headerPad);

    // Clip viewport — listCol is retained and translated for scroll (no row rebuild).
    const listClip = await UI.createElement(
        win, {contentPositioning: 'raw', item: {flexGrow: 1, flexShrink: 1, minHeight: 0, size: {x: 'auto', y: 'auto'}}, contentAlign: 'fill', clipToBounds: true});
    await UI.attach(win, pane, listClip);

    const listCol = await UI.createElement(win, {contentPositioning: 'raw', item: {size: {x: treeWidth, y: 1}, position: {x: 0, y: 0}}});
    await UI.attach(win, listClip, listCol);

    /** @type {Map<string, object>} path → row record */
    const rowsByPath = new Map();
    /** Flattened visible order (paths). */
    let flatOrder = [];
    /** Dir path → directory entries (cached across collapse/expand). */
    const childrenCache = new Map();
    const expanded      = new Set([workspaceRoot]);
    let refreshToken    = 0;
    let refreshInFlight = null;
    let pendingRefresh  = false;
    let debounceTimer   = null;
    let toggleBusy      = false;

    const contentH = () => flatOrder.length * rowH;
    const maxScrollY = () => Math.max(0, contentH() - clipH);
    const clampScroll = () => { scrollY = Math.max(0, Math.min(maxScrollY(), scrollY)); };

    const syncClipHeight = async () => {
        try
        {
            const frame = await UI.getElementFrame(win, listClip);
            const minY  = frame?.min?.y;
            const maxY  = frame?.max?.y;
            if(typeof minY === 'number' && typeof maxY === 'number' && maxY > minY) clipH = Math.max(1, Math.floor(maxY - minY));
        } catch(e)
        {
            void e;
        }
    };

    const applyScroll = async () => { await UI.setLayoutPosition(win, listCol, {x: 0, y: -scrollY}); };

    /** Reposition rows from `fromIndex` and resize the scroll host. */
    const layoutFrom = async (fromIndex = 0) => {
        const ops = [UI.setLayoutSize(win, listCol, {x: treeWidth, y: Math.max(1, contentH())})];
        for(let i = Math.max(0, fromIndex); i < flatOrder.length; i++)
        {
            const rec = rowsByPath.get(flatOrder[i]);
            if(rec) ops.push(UI.setLayoutPosition(win, rec.root, {x: 0, y: i * rowH}));
        }
        await Promise.all(ops);
    };

    const loadChildren = async (dirPath) => {
        if(childrenCache.has(dirPath)) return childrenCache.get(dirPath);
        let entries = [];
        try
        {
            entries = await Fs.readDir(dirPath);
        } catch(e)
        {
            entries = [];
        }
        entries = entries.filter((e) => e && !Fs.isIgnoredName(e.name));
        childrenCache.set(dirPath, entries);
        return entries;
    };

    const isRowActive = (rec) => !rec.isDir && rec.path === activePath;

    const paintRowIdleBg = async (rec) => {
        if(!rec) return;
        await settled(UI.setBoxColour(win, rec.root, isRowActive(rec) ? theme.treeActive : [0, 0, 0, 0]));
    };

    const clearTreeHover = async () => {
        const prev  = hoveredPath;
        hoveredPath = null;
        hoverEpoch++;
        if(prev) await paintRowIdleBg(rowsByPath.get(prev));
    };

    const setTreeHover = async (path) => {
        const prev  = hoveredPath;
        const epoch = ++hoverEpoch;
        hoveredPath = path;
        if(prev && prev !== path) await paintRowIdleBg(rowsByPath.get(prev));
        if(epoch !== hoverEpoch || hoveredPath !== path) return;
        const rec = rowsByPath.get(path);
        if(!rec || isRowActive(rec)) return;
        await settled(UI.setBoxColour(win, rec.root, theme.treeHover));
        // Stale enter paint after a faster exit/ superseding enter.
        if(epoch !== hoverEpoch || hoveredPath !== path) await paintRowIdleBg(rec);
    };

    const paintRowActive = async (rec, active) => {
        if(!rec) return;
        await Promise.all([
            settled(UI.setBoxColour(win, rec.root, active ? theme.treeActive : [0, 0, 0, 0])),
            settled(UI.setBoxColour(win, rec.accent, active ? theme.primary : [0, 0, 0, 0])),
            settled(UI.setTextColour(win, rec.label, active ? theme.primary : (rec.isDir ? theme.text : theme.textDim))),
            settled(UI.setTextColour(win, rec.icon, (active || (rec.isDir && expanded.has(rec.path)) || rec.glyph === 'ⓘ') ? theme.primary : theme.tertiary))
        ]);
    };

    const paintDirOpen = async (rec, open) => {
        if(!rec || !rec.isDir) return;
        const ops = [];
        if(rec.chevron) ops.push(settled(UI.setTextString(win, rec.chevron, open ? '▾' : '▸')));
        const active = isRowActive(rec);
        ops.push(settled(UI.setTextColour(win, rec.icon, (active || open || rec.glyph === 'ⓘ') ? theme.primary : theme.tertiary)));
        await Promise.all(ops);
    };

    const destroyRow = async (path) => {
        const rec = rowsByPath.get(path);
        if(!rec) return;
        if(hoveredPath === path)
        {
            hoveredPath = null;
            hoverEpoch++;
        }
        rowsByPath.delete(path);
        await settled(UI.destroyElement(win, rec.root));
    };

    const createRow = async (entry, depth) => {
        const isDir       = entry.type === 'dir';
        const path        = entry.path;
        const isOpen      = isDir && expanded.has(path);
        const active      = !isDir && path === activePath;
        const glyph       = fileGlyph(entry.name, isDir);
        const indent      = 16 + depth * 24;
        const chevronSlot = isDir ? chevronW + chevronGap : 0;
        const maxLabelW   = Math.max(8, treeWidth - indent - accentW - chevronSlot - iconW - iconGap - 16);
        const labelSize   = estimateLabelSize(entry.name, fontSize, maxLabelW);

        const root = await UI.createElement(win, {
            renderable: {type: 'box', colour: active ? theme.treeActive : [0, 0, 0, 0]},
            layout: {type: 'row', gap: 0, padding: {l: 0, r: 8, t: 0, b: 0}, alignItems: 'center'},
            item: {size: {x: treeWidth, y: rowH}, position: {x: 0, y: 0}},
            contentAlign: 'fill'
        });

        const accent = await UI.createElement(
            win, {renderable: {type: 'box', colour: active ? theme.primary : [0, 0, 0, 0]}, item: {size: {x: accentW, y: rowH}, flexShrink: 0}});

        const spacer =
            await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: Math.max(0, indent - accentW), y: 1}, flexShrink: 0}});

        let chevron      = null;
        let afterChevron = null;
        if(isDir)
        {
            chevron      = await UI.createElement(win, {
                renderable: {
                    type: 'text',
                    string: isOpen ? '▾' : '▸',
                    size: 10,
                    font: theme.fontIcon,
                    colour: theme.textMuted,
                    metricsBasis: 'line',
                    justify: 'center',
                    vAlign: 'center'
                },
                item: {size: {x: chevronW, y: rowH}, flexShrink: 0},
                contentAlign: {x: 'center', y: 'center'}
            });
            afterChevron = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: chevronGap, y: 1}, flexShrink: 0}});
        }

        const icon = await UI.createElement(win, {
            renderable: {
                type: 'text',
                string: glyph,
                size: 12,
                font: theme.fontIcon,
                colour: (active || isOpen || glyph === 'ⓘ') ? theme.primary : theme.tertiary,
                metricsBasis: 'line',
                justify: 'center',
                vAlign: 'center'
            },
            item: {size: {x: iconW, y: rowH}, flexShrink: 0},
            contentAlign: {x: 'center', y: 'center'}
        });

        const labelPad = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: iconGap, y: 1}, flexShrink: 0}});

        const label = await UI.createElement(win, {
            renderable: {
                type: 'text',
                string: entry.name,
                size: fontSize,
                font: theme.fontUi,
                colour: active ? theme.primary : (isDir ? theme.text : theme.textDim),
                metricsBasis: 'line',
                justify: 'left',
                vAlign: 'center'
            },
            item: {size: {x: labelSize.x, y: rowH}},
            contentAlign: {x: 'start', y: 'center'}
        });

        await Promise.all([
            UI.attach(win, root, accent), UI.attach(win, root, spacer), chevron ? UI.attach(win, root, chevron) : Promise.resolve(),
            afterChevron ? UI.attach(win, root, afterChevron) : Promise.resolve(), UI.attach(win, root, icon), UI.attach(win, root, labelPad),
            UI.attach(win, root, label)
        ]);

        const rec = {path, depth, isDir, entry, glyph, root, accent, spacer, chevron, icon, label};

        await UI.setOnMouseDown(win, root, async () => {
            if(isDir)
            {
                if(toggleBusy) return;
                toggleBusy = true;
                try
                {
                    if(expanded.has(path))
                        await collapseDir(path);
                    else
                        await expandDir(path);
                } finally
                {
                    toggleBusy = false;
                }
                return;
            }
            const now      = Date.now();
            const isDouble = lastClick.path === path && (now - lastClick.at) < 400;
            lastClick      = {path, at: now};
            await onOpen(path, {preview: !isDouble});
        });

        if(typeof UI.setOnMouseEnter === 'function' && typeof UI.setOnMouseExit === 'function')
        {
            await UI.setOnMouseEnter(win, root, async () => {
                try
                {
                    await Compositor.setCursor(win, 'default');
                } catch(e)
                {
                    void e;
                }
                await setTreeHover(path);
            });
            await UI.setOnMouseExit(win, root, async () => {
                if(hoveredPath === path)
                {
                    hoveredPath = null;
                    hoverEpoch++;
                }
                await paintRowIdleBg(rec);
            });
        }

        return rec;
    };

    /**
     * Insert visible descendants of `dirPath` into flatOrder at `insertAt`.
     * Creates row elements for any path not yet in rowsByPath.
     * @returns {Promise<number>} next insert index
     */
    const insertExpandedBranch = async (dirPath, insertAt, depth) => {
        if(flatOrder.length >= maxFlatRows) return insertAt;
        const children = await loadChildren(dirPath);
        const room     = Math.max(0, maxFlatRows - flatOrder.length);
        const slice    = room < children.length ? children.slice(0, room) : children;

        const missing = slice.filter((entry) => !rowsByPath.has(entry.path));
        if(missing.length)
        {
            const created = await Promise.all(missing.map((entry) => createRow(entry, depth)));
            await Promise.all(created.map((rec) => {
                rowsByPath.set(rec.path, rec);
                return UI.attach(win, listCol, rec.root);
            }));
        }

        let at = insertAt;
        for(const entry of slice)
        {
            const rec = rowsByPath.get(entry.path);
            if(!rec) continue;
            flatOrder.splice(at, 0, entry.path);
            await UI.setLayoutPosition(win, rec.root, {x: 0, y: at * rowH});
            at += 1;
            if(entry.type === 'dir' && expanded.has(entry.path)) at = await insertExpandedBranch(entry.path, at, depth + 1);
        }
        return at;
    };

    const expandDir = async (dirPath) => {
        if(expanded.has(dirPath)) return;
        const parentIdx = flatOrder.indexOf(dirPath);
        if(parentIdx < 0) return;
        const rec = rowsByPath.get(dirPath);
        if(!rec || !rec.isDir) return;

        expanded.add(dirPath);
        await paintDirOpen(rec, true);

        await insertExpandedBranch(dirPath, parentIdx + 1, rec.depth + 1);
        // Shift rows that were below the parent (and finalize host size).
        await layoutFrom(parentIdx + 1);
        await syncClipHeight();
        clampScroll();
        await applyScroll();
    };

    const collapseDir = async (dirPath) => {
        if(!expanded.has(dirPath)) return;
        const parentIdx = flatOrder.indexOf(dirPath);
        if(parentIdx < 0) return;
        const rec = rowsByPath.get(dirPath);
        if(!rec || !rec.isDir) return;

        expanded.delete(dirPath);
        await paintDirOpen(rec, false);

        let end = parentIdx + 1;
        while(end < flatOrder.length)
        {
            const child = rowsByPath.get(flatOrder[end]);
            if(!child || child.depth <= rec.depth) break;
            end += 1;
        }
        const removed = flatOrder.splice(parentIdx + 1, end - parentIdx - 1);
        await Promise.all(removed.map((p) => destroyRow(p)));
        await layoutFrom(parentIdx + 1);
        await syncClipHeight();
        clampScroll();
        await applyScroll();
    };

    const wipeTree = async () => {
        const recs = [...rowsByPath.values()];
        flatOrder  = [];
        rowsByPath.clear();
        if(recs.length === 0) return;
        await Promise.all(recs.map((r) => settled(UI.destroyElement(win, r.root))));
    };

    const rebuildTree = async (token) => {
        childrenCache.clear();
        await wipeTree();
        if(token !== refreshToken) return;
        // Always keep workspace root expanded; seed top-level entries.
        expanded.add(workspaceRoot);
        await insertExpandedBranch(workspaceRoot, 0, 0);
        if(token !== refreshToken) return;
        await layoutFrom(0);
        await syncClipHeight();
        clampScroll();
        await applyScroll();
    };

    const refreshNow = async () => {
        if(refreshInFlight)
        {
            pendingRefresh = true;
            return refreshInFlight;
        }
        const token     = ++refreshToken;
        refreshInFlight = (async () => {
            try
            {
                await rebuildTree(token);
            } finally
            {
                refreshInFlight = null;
                if(pendingRefresh)
                {
                    pendingRefresh = false;
                    await refreshNow();
                }
            }
        })();
        return refreshInFlight;
    };

    const syncActive = async () => {
        const next = getActivePath();
        if(next === activePath) return;
        const prev = activePath;
        activePath = next;
        const ops  = [];
        if(prev)
        {
            const oldRec = rowsByPath.get(prev);
            if(oldRec) ops.push(paintRowActive(oldRec, false));
        }
        if(next)
        {
            const newRec = rowsByPath.get(next);
            if(newRec) ops.push(paintRowActive(newRec, true));
        }
        if(ops.length) await Promise.all(ops);
    };

    const refresh = () => {
        if(debounceTimer) clearTimeout(debounceTimer);
        return new Promise((resolve) => {
            debounceTimer = setTimeout(async () => {
                debounceTimer = null;
                await refreshNow();
                resolve();
            }, 500);
        });
    };

    await UI.setOnMouseScroll(win, pane, async (_wp, _lp, delta) => {
        const dy = typeof delta === 'number' ? delta : (delta?.y || 0);
        if(!dy) return;
        const lineDelta = Math.round((dy / WHEEL_AXIS_STEP) * WHEEL_LINES_PER_STEP);
        if(!lineDelta) return;
        await syncClipHeight();
        const next = Math.max(0, Math.min(maxScrollY(), scrollY + lineDelta * rowH));
        if(next === scrollY) return;
        scrollY = next;
        // Rows move under a still pointer — engine won't exit the old hover target.
        await clearTreeHover();
        await applyScroll();
    });

    await refreshNow();

    return {
        root: pane,
        refresh,
        refreshNow,
        syncActive,
        getWidth() {
            return treeWidth;
        },
        async setWidth(next) {
            const w = Math.max(160, Math.min(640, Math.round(next)));
            if(w === treeWidth) return treeWidth;
            treeWidth    = w;
            const labelW = Math.max(32, treeWidth - 32);
            const size   = estimateLabelSize(headerLabel, fontSize, labelW);
            const ops    = [
                UI.setLayoutSize(win, header, {x: Math.min(labelW, Math.max(size.x, 80)), y: headerH}),
                UI.setLayoutSize(win, listCol, {x: treeWidth, y: Math.max(1, contentH())}),
                ...[...rowsByPath.values()].map((rec) => UI.setLayoutSize(win, rec.root, {x: treeWidth, y: rowH}))
            ];
            if(!embedded) ops.unshift(UI.setLayoutSize(win, pane, {x: treeWidth}));
            await Promise.all(ops);
            clampScroll();
            await applyScroll();
            return treeWidth;
        }
    };
}

/**
 * Vertical splitter between the file tree and editor.
 * Wide transparent hit strip with a 1px rule so grab works on both sides of the seam.
 */
export async function createTreeSplitter(win, parent, opts = {})
{
    const getWidth = typeof opts.getWidth === 'function' ? opts.getWidth : () => theme.treeWidth;
    const setWidth = typeof opts.setWidth === 'function' ? opts.setWidth : async () => {};
    const dragHost = opts.dragHost;
    const hitW     = 7;

    const strip = await UI.createElement(win, {
        renderable: {type: 'box', colour: [0, 0, 0, 0]},
        layout: {type: 'row', gap: 0, justifyContent: 'center', alignItems: 'stretch'},
        item: {size: {x: hitW}, flexShrink: 0},
        contentAlign: 'fill'
    });
    await UI.attach(win, parent, strip);

    const rule = await UI.createElement(win, {renderable: {type: 'box', colour: theme.border}, item: {size: {x: 1}, flexShrink: 0}});
    await UI.attach(win, strip, rule);

    let dragging = false;
    let startX   = 0;
    let startW   = 0;

    const endDrag = async () => {
        if(!dragging) return;
        dragging = false;
        if(dragHost)
        {
            await Promise.all([UI.setOnMouseMove(win, dragHost, null), UI.setOnMouseUp(win, dragHost, null)]);
        }
        try
        {
            await Compositor.setCursor(win, 'default');
        } catch(e)
        {
            void e;
        }
    };

    await UI.setOnMouseDown(win, strip, async (windowPoint) => {
        dragging = true;
        startX   = windowPoint?.x || 0;
        startW   = getWidth();
        try
        {
            await Compositor.setCursor(win, 'ew-resize');
        } catch(e)
        {
            void e;
        }
        if(!dragHost) return;
        await UI.setOnMouseMove(win, dragHost, async (wp) => {
            if(!dragging) return;
            const dx = (wp?.x || 0) - startX;
            await setWidth(startW + dx);
        });
        await UI.setOnMouseUp(win, dragHost, endDrag);
    });

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, strip, async () => {
            try
            {
                await Compositor.setCursor(win, 'ew-resize');
            } catch(e)
            {
                void e;
            }
        });
    }
    if(typeof UI.setOnMouseExit === 'function')
    {
        await UI.setOnMouseExit(win, strip, async () => {
            if(dragging) return;
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    return {root: strip};
}

/**
 * Status bar: orange strip with contributable left/right regions + editor meta.
 * Plugins use contribute({ id, side, order, text, icon?, onClick? }).
 * setState({ row, col, language, dirty }) updates editor-owned right segments.
 *
 * Text alignment (Koya docs): the text element takes the full layout slot
 * (item.size = segment height), then contentAlign centres the glyphs in that slot.
 */
export async function createStatusBar(win, parent, opts = {})
{
    const fontSize = theme.fontSizeCodeSm;
    const h        = theme.statusHeight;

    const bar = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.statusBg},
        layout: {type: 'row', gap: 0, padding: {l: 0, r: 0, t: 0, b: 0}, alignItems: 'center'},
        item: {size: {y: h}, flexGrow: 0, flexShrink: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, bar);

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, bar, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    const leftHost = await UI.createElement(
        win, {layout: {type: 'row', gap: 0, alignItems: 'center'}, item: {size: {x: 1, y: h}, flexGrow: 0, flexShrink: 0}, contentAlign: 'fill'});
    await UI.attach(win, bar, leftHost);

    const spacer =
        await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: 8, y: h}, flexGrow: 1, flexShrink: 1, minWidth: 0}});
    await UI.attach(win, bar, spacer);
    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, spacer, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    const rightHost = await UI.createElement(
        win,
        {layout: {type: 'row', gap: 0, alignItems: 'center', justifyContent: 'end'}, item: {size: {x: 1, y: h}, flexGrow: 0, flexShrink: 0}, contentAlign: 'fill'});
    await UI.attach(win, bar, rightHost);

    /** @type {object[]} */
    const leftSegs = [];
    /** @type {object[]} */
    const rightSegs = [];

    const syncHostWidth = async (host, segs) => {
        let w = 0;
        for(const seg of segs)
        {
            if(!seg || seg.removed) continue;
            w += Math.max(0, seg.width | 0);
        }
        await settled(UI.setLayoutSize(win, host, {x: Math.max(1, w), y: h}));
    };

    const makeSeg = async (parentEl, {icon = null, label = '', chip = false, padX = 16} = {}) => {
        const size  = label ? estimateLabelSize(label, fontSize, 240) : {x: 0, y: h};
        const iconW = icon ? 14 : 0;
        const gap   = icon && label ? 5 : 0;
        const w     = Math.max(padX * 2, padX * 2 + iconW + gap + size.x);
        const wrap  = await UI.createElement(win, {
            renderable: {type: 'box', colour: chip ? theme.statusChip : [0, 0, 0, 0]},
            layout: {type: 'row', gap, padding: {l: padX, r: padX, t: 0, b: 0}, alignItems: 'center'},
            item: {size: {x: w, y: h}, flexGrow: 0, flexShrink: 0},
            contentAlign: 'fill',
            clipToBounds: true
        });
        await UI.attach(win, parentEl, wrap);
        let iconId = null;
        if(icon)
        {
            iconId = await UI.createElement(win, {
                renderable: {
                    type: 'text',
                    string: icon,
                    size: fontSize,
                    font: theme.fontIcon,
                    colour: theme.statusFg,
                    metricsBasis: 'line',
                    justify: 'center',
                    vAlign: 'center'
                },
                item: {size: {x: iconW, y: h}, flexShrink: 0},
                contentAlign: {x: 'center', y: 'center'}
            });
            await UI.attach(win, wrap, iconId);
        }
        let text = null;
        if(label)
        {
            // Use UI font — mono faces (e.g. Hack) may be missing and paint nothing.
            text = await UI.createElement(win, {
                renderable: {
                    type: 'text',
                    string: label,
                    size: fontSize,
                    font: theme.fontUi,
                    colour: theme.statusFg,
                    metricsBasis: 'line',
                    justify: 'left',
                    vAlign: 'center'
                },
                item: {size: {x: Math.max(1, size.x), y: h}, flexShrink: 0},
                contentAlign: {x: 'start', y: 'center'}
            });
            await UI.attach(win, wrap, text);
        }
        if(typeof UI.setOnMouseEnter === 'function')
        {
            await UI.setOnMouseEnter(win, wrap, async () => {
                try
                {
                    await Compositor.setCursor(win, 'default');
                } catch(e)
                {
                    void e;
                }
                if(!chip) await settled(UI.setBoxColour(win, wrap, theme.statusChip));
            });
            if(!chip && typeof UI.setOnMouseExit === 'function')
            {
                await UI.setOnMouseExit(win, wrap, async () => { await settled(UI.setBoxColour(win, wrap, [0, 0, 0, 0])); });
            }
        }
        return {wrap, text, iconId, label, padX, iconW, gap, chip, width: w, removed: false, host: parentEl};
    };

    // Editor-owned right meta (always present).
    const rightLn     = await makeSeg(rightHost, {label: 'Ln 1, Col 1'});
    const rightIndent = await makeSeg(rightHost, {label: indentStatusLabel()});
    const rightUtf    = await makeSeg(rightHost, {label: 'UTF-8'});
    const rightLang   = await makeSeg(rightHost, {label: 'Plain Text', chip: true});
    rightSegs.push(rightLn, rightIndent, rightUtf, rightLang);
    await syncHostWidth(rightHost, rightSegs);

    const fitSeg = async (seg, label) => {
        if(!seg || seg.removed) return;
        const next = String(label || '');
        const size = estimateLabelSize(next || ' ', fontSize, 280);
        const w    = Math.max(seg.padX * 2, seg.padX * 2 + seg.iconW + seg.gap + size.x);
        const same = seg.label === next && seg.text && seg.width === w;
        if(same) return;
        seg.label = next;
        seg.width = w;
        if(!seg.text && next)
        {
            seg.text = await UI.createElement(win, {
                renderable:
                    {type: 'text', string: next, size: fontSize, font: theme.fontUi, colour: theme.statusFg, metricsBasis: 'line', justify: 'left', vAlign: 'center'},
                item: {size: {x: Math.max(1, size.x), y: h}, flexShrink: 0},
                contentAlign: {x: 'start', y: 'center'}
            });
            await UI.attach(win, seg.wrap, seg.text);
            await settled(UI.setLayoutSize(win, seg.wrap, {x: w, y: h}));
            if(seg.host === leftHost)
                await syncHostWidth(leftHost, leftSegs);
            else if(seg.host === rightHost)
                await syncHostWidth(rightHost, rightSegs);
            return;
        }
        if(!seg.text) return;
        await Promise.all([
            UI.setTextString(win, seg.text, next || ' '), UI.setLayoutSize(win, seg.text, {x: Math.max(1, size.x), y: h}),
            UI.setLayoutSize(win, seg.wrap, {x: w, y: h})
        ].map((p) => settled(p)));
        if(seg.host === leftHost)
            await syncHostWidth(leftHost, leftSegs);
        else if(seg.host === rightHost)
            await syncHostWidth(rightHost, rightSegs);
    };

    /** @type {Map<string, { id: string, side: string, order: number, seg: object, onClick?: Function }>} */
    const contributions = new Map();

    const contribute = async (spec = {}) => {
        const id = String(spec.id || '');
        if(!id) return {set: async () => {}, remove: async () => {}};
        if(contributions.has(id))
        {
            const existing = contributions.get(id);
            if(spec.text != null) await fitSeg(existing.seg, spec.text);
            return {
                set: async (next = {}) => {
                    if(next.text != null) await fitSeg(existing.seg, next.text);
                },
                remove: async () => {
                    const c = contributions.get(id);
                    if(!c) return;
                    contributions.delete(id);
                    c.seg.removed = true;
                    const list    = c.side === 'right' ? rightSegs : leftSegs;
                    const idx     = list.indexOf(c.seg);
                    if(idx >= 0) list.splice(idx, 1);
                    await settled(UI.destroyElement(win, c.seg.wrap));
                    await syncHostWidth(c.side === 'right' ? rightHost : leftHost, list);
                }
            };
        }

        const side     = spec.side === 'right' ? 'right' : 'left';
        const parentEl = side === 'right' ? rightHost : leftHost;
        const list     = side === 'right' ? rightSegs : leftSegs;
        const order    = typeof spec.order === 'number' ? spec.order : 100;
        const seg      = await makeSeg(parentEl, {icon: spec.icon || null, label: spec.text != null ? String(spec.text) : '', padX: 8, chip: !!spec.chip});
        list.push(seg);
        await syncHostWidth(parentEl, list);
        if(typeof spec.onClick === 'function' && typeof UI.setOnMouseDown === 'function')
        {
            await UI.setOnMouseDown(win, seg.wrap, async () => {
                try
                {
                    await spec.onClick();
                } catch(e)
                {
                    void e;
                }
            });
        }
        contributions.set(id, {id, side, order, seg, onClick: spec.onClick});

        return {
            set: async (next = {}) => {
                if(next.text != null) await fitSeg(seg, next.text);
            },
            remove: async () => {
                const c = contributions.get(id);
                if(!c) return;
                contributions.delete(id);
                c.seg.removed = true;
                const idx     = list.indexOf(c.seg);
                if(idx >= 0) list.splice(idx, 1);
                await settled(UI.destroyElement(win, c.seg.wrap));
                await syncHostWidth(parentEl, list);
            }
        };
    };

    let lastKey = '';

    return {
        root: bar,
        contribute,
        async setText(text) {
            void text;
        },
        async setState(state = {}) {
            const lang       = langLabel(state.language);
            const indent     = indentStatusLabel();
            const showCursor = state.cursor !== false && !state.empty;
            const ln         = (typeof state.row === 'number' ? state.row : 0) + 1;
            const cn         = (typeof state.col === 'number' ? state.col : 0) + 1;
            const posLabel   = showCursor ? `Ln ${ln}, Col ${cn}` : (typeof state.label === 'string' && state.label ? state.label : '—');
            const key        = `${posLabel}:${lang}:${!!state.dirty}:${indent}`;
            if(key === lastKey) return;
            lastKey = key;
            await Promise.all([fitSeg(rightLn, posLabel), fitSeg(rightIndent, indent), fitSeg(rightLang, lang)]);
        }
    };
}
