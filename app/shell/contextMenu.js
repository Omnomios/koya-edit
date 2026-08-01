/**
 * Floating context menu overlay (right-click).
 * Positioned in window coordinates on a raw layer above the shell.
 */
import {estimateLabelSize, frameSize} from '/rom/shell/layout.js';
import {theme} from '/rom/theme.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import {KEY, keyIn} from '/rom/editor/keys.js';

function settled(promise)
{
    return promise.then((value) => ({ok: true, value}), (error) => ({ok: false, error}));
}

/**
 * @param {number} win
 * @param {number} parent — usually chrome.root
 */
export async function createContextMenu(win, parent, opts = {})
{
    const fontSize = theme.fontSizeUiSm || theme.fontSizeUi || 13;
    const rowH     = 28;
    const padX     = 12;
    const minW     = 180;
    const maxW     = 320;
    const sepH     = 9;

    const layer = await UI.createElement(win, {
        renderable: {type: 'box', colour: [0, 0, 0, 0.001]},
        contentPositioning: 'raw',
        item: {size: {x: 'auto', y: 'auto'}, flexGrow: 1, flexShrink: 1, minHeight: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, layer);
    await UI.setEnabled(win, layer, false);

    const menu = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panelHigh},
        layout: {type: 'column', gap: 0, padding: {l: 0, r: 0, t: 4, b: 4}},
        item: {size: {x: minW, y: rowH}, position: {x: 0, y: 0}},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, layer, menu);

    /** @type {{ root: number, label: number, kind: 'item'|'sep', item?: object }[]} */
    let rows = [];
    let open = false;
    let runChain = Promise.resolve();

    const clearRows = async () => {
        for(const row of rows)
            await settled(UI.destroyElement(win, row.root));
        rows = [];
    };

    const close = async () => {
        if(!open) return;
        open = false;
        await UI.setEnabled(win, layer, false);
        await clearRows();
        if(typeof opts.onOpenChange === 'function') opts.onOpenChange(false);
    };

    if(typeof UI.setOnMouseDown === 'function')
    {
        // Click outside the menu dismisses.
        await UI.setOnMouseDown(win, layer, async () => { await close(); });
        // Clicks on the menu itself must not bubble to the layer dismiss.
        await UI.setOnMouseDown(win, menu, async () => {});
    }

    const measureItems = (items) => {
        let width = minW;
        let height = 8;
        for(const it of items || [])
        {
            if(it && it.separator)
            {
                height += sepH;
                continue;
            }
            const label = String(it && it.label != null ? it.label : '');
            const sz = estimateLabelSize(label, fontSize, maxW - padX * 2);
            width = Math.max(width, Math.min(maxW, Math.ceil((sz && sz.x) || 0) + padX * 2 + 8));
            height += rowH;
        }
        return {width, height};
    };

    const paintRow = async (row, hovered) => {
        if(row.kind !== 'item') return;
        const enabled = !row.item || row.item.enabled !== false;
        await settled(UI.setBoxColour(win, row.root, hovered && enabled ? theme.panelHighest : [0, 0, 0, 0]));
        const colour = !enabled ? theme.textMuted : (hovered ? theme.text : theme.textDim);
        await settled(UI.setTextColour(win, row.label, colour));
    };

    /**
     * @param {{
     *   x: number, y: number,
     *   items: Array<{ id?: string, label?: string, enabled?: boolean, separator?: boolean, run?: Function }>
     * }} spec
     */
    const show = async (spec = {}) => {
        const items = Array.isArray(spec.items) ? spec.items.filter(Boolean) : [];
        if(items.length === 0) return;

        runChain = runChain.then(async () => {
            await close();
            open = true;
            const {width, height} = measureItems(items);
            await settled(UI.setBoxColour(win, menu, theme.panelHigh));

            // Measure an always-enabled ancestor — the overlay layer is disabled
            // between shows and keeps a stale frame after window resize.
            let winW = 1280;
            let winH = 800;
            try
            {
                if(typeof UI.getElementFrame === 'function')
                {
                    const frame = await UI.getElementFrame(win, parent);
                    const size = frameSize(frame);
                    if(size.x > 0) winW = size.x;
                    if(size.y > 0) winH = size.y;
                }
            }
            catch(e) { void e; }

            let x = Math.round(spec.x || 0);
            let y = Math.round(spec.y || 0);
            if(x + width > winW - 4) x = Math.max(4, winW - width - 4);
            if(y + height > winH - 4) y = Math.max(4, winH - height - 4);
            x = Math.max(0, x);
            y = Math.max(0, y);

            // Enable before positioning — layout writes on a disabled subtree are
            // often deferred and show at the previous place on the first open.
            await settled(UI.setLayoutSize(win, menu, {x: width, y: height}));
            await UI.setEnabled(win, layer, true);
            await settled(UI.setLayoutPosition(win, menu, {x, y}));

            for(const it of items)
            {
                if(it.separator)
                {
                    const root = await UI.createElement(win, {
                        layout: {type: 'row', alignItems: 'center', justifyContent: 'center', padding: {l: padX, r: padX, t: 0, b: 0}},
                        item: {size: {x: width, y: sepH}, flexShrink: 0},
                        contentAlign: 'fill'
                    });
                    const line = await UI.createElement(win, {
                        renderable: {type: 'box', colour: theme.border},
                        item: {size: {x: width - padX * 2, y: 1}, flexShrink: 0}
                    });
                    await UI.attach(win, root, line);
                    await UI.attach(win, menu, root);
                    rows.push({root, label: 0, kind: 'sep'});
                    continue;
                }

                const labelStr = String(it.label || it.id || '');
                const enabled = it.enabled !== false;
                const root = await UI.createElement(win, {
                    renderable: {type: 'box', colour: [0, 0, 0, 0]},
                    layout: {type: 'row', padding: {l: padX, r: padX, t: 0, b: 0}, alignItems: 'center'},
                    item: {size: {x: width, y: rowH}, flexShrink: 0},
                    contentAlign: 'fill'
                });
                const label = await UI.createElement(win, {
                    renderable: {
                        type: 'text',
                        string: labelStr,
                        size: fontSize,
                        font: theme.fontUi,
                        colour: enabled ? theme.textDim : theme.textMuted,
                        metricsBasis: 'line',
                        justify: 'left',
                        vAlign: 'center'
                    },
                    item: {size: {x: width - padX * 2, y: rowH}},
                    contentAlign: {x: 'start', y: 'center'}
                });
                await UI.attach(win, root, label);
                await UI.attach(win, menu, root);

                const row = {root, label, kind: 'item', item: it};
                rows.push(row);

                if(typeof UI.setOnMouseEnter === 'function')
                {
                    await UI.setOnMouseEnter(win, root, async () => {
                        try { await Compositor.setCursor(win, 'default'); } catch(e) { void e; }
                        await paintRow(row, true);
                    });
                }
                if(typeof UI.setOnMouseExit === 'function')
                    await UI.setOnMouseExit(win, root, async () => { await paintRow(row, false); });

                if(typeof UI.setOnMouseDown === 'function')
                {
                    await UI.setOnMouseDown(win, root, async () => {
                        if(!enabled) return;
                        const run = typeof it.run === 'function' ? it.run : null;
                        await close();
                        if(run) await run();
                    });
                }
            }

            // Re-assert after children attach — first layout pass can ignore the
            // earlier position when the layer had just been re-enabled.
            await Promise.all([
                settled(UI.setLayoutSize(win, menu, {x: width, y: height})),
                settled(UI.setLayoutPosition(win, menu, {x, y}))
            ]);

            if(typeof opts.onOpenChange === 'function') opts.onOpenChange(true);
        });
        await runChain;
    };

    const handleKey = async (key) => {
        if(!open) return false;
        if(keyIn(key, KEY.ESCAPE))
        {
            await close();
            return true;
        }
        return false;
    };

    return {
        show,
        close,
        isOpen: () => open,
        handleKey
    };
}
