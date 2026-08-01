import {KEY, keyIn} from '/rom/editor/keys.js';
import {estimateLabelSize} from '/rom/shell/layout.js';
import {theme} from '/rom/theme.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';

function settled(promise)
{
    return promise.then((value) => ({ok: true, value}), (error) => ({ok: false, error}));
}

/**
 * VS Code / Atom-style command palette overlay.
 * @param {object} registry createCommandRegistry()
 */
export async function createCommandPalette(win, parent, opts = {})
{
    const registry     = opts.registry;
    const onOpenChange = typeof opts.onOpenChange === 'function' ? opts.onOpenChange : () => {};
    const maxVisible   = 10;
    const rowH         = 28;
    const inputH       = 36;
    const boxW         = 520;
    const pad          = 12;
    const topInset     = Math.max(8, (theme.menuHeight || 36) + 4);

    // Row + justifyContent centres on the main (horizontal) axis. Column +
    // alignItems does not — Helix cross-aligns to the line's max child size,
    // so a single fixed-width child stays left.
    const backdrop = await UI.createElement(win, {
        renderable: {type: 'box', colour: [0, 0, 0, 0.45]},
        layout: {type: 'row', gap: 0, alignItems: 'start', justifyContent: 'center', padding: {l: 0, r: 0, t: topInset, b: 0}},
        item: {size: {x: 'auto', y: 'auto'}},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, backdrop);
    await UI.setEnabled(win, backdrop, false);

    const box = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panelHigh},
        layout: {type: 'column', gap: 0, padding: {l: 0, r: 0, t: 0, b: 0}},
        item: {size: {x: boxW, y: inputH + rowH * maxVisible + 8}, flexShrink: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, backdrop, box);

    const inputWrap = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panelAlt},
        layout: {type: 'row', padding: {l: pad, r: pad, t: 0, b: 0}, alignItems: 'center'},
        item: {size: {x: boxW, y: inputH}, flexShrink: 0},
        contentAlign: 'fill'
    });
    await UI.attach(win, box, inputWrap);

    const inputText = await UI.createElement(win, {
        renderable: {
            type: 'text',
            string: 'Type a command…',
            size: theme.fontSizeUi,
            font: theme.fontUi,
            colour: theme.textMuted,
            metricsBasis: 'line',
            justify: 'left',
            vAlign: 'center'
        },
        item: {size: {x: boxW - pad * 2, y: inputH}},
        contentAlign: {x: 'start', y: 'center'}
    });
    await UI.attach(win, inputWrap, inputText);

    const listHost = await UI.createElement(
        win, {layout: {type: 'column', gap: 0}, item: {size: {x: boxW, y: rowH * maxVisible}, flexShrink: 0}, contentAlign: 'fill', clipToBounds: true});
    await UI.attach(win, box, listHost);

    /** @type {{ root: number, label: number, title: string, id: string }[]} */
    const rows = [];
    for(let i = 0; i < maxVisible; i++)
    {
        const root  = await UI.createElement(win, {
            renderable: {type: 'box', colour: [0, 0, 0, 0]},
            layout: {type: 'row', padding: {l: pad, r: pad, t: 0, b: 0}, alignItems: 'center'},
            item: {size: {x: boxW, y: rowH}, flexShrink: 0},
            contentAlign: 'fill'
        });
        const label = await UI.createElement(win, {
            renderable: {
                type: 'text',
                string: ' ',
                size: theme.fontSizeUiSm,
                font: theme.fontUi,
                colour: theme.textDim,
                metricsBasis: 'line',
                justify: 'left',
                vAlign: 'center'
            },
            item: {size: {x: boxW - pad * 2, y: rowH}},
            contentAlign: {x: 'start', y: 'center'}
        });
        await UI.attach(win, listHost, root);
        await UI.attach(win, root, label);
        await UI.setEnabled(win, root, false);
        const row = {root, label, title: '', id: ''};
        await UI.setOnMouseDown(win, root, async () => {
            if(!open || !row.id) return;
            await runSelected(row.id);
        });
        rows.push(row);
    }

    let open     = false;
    let filter   = '';
    let selected = 0;
    /** @type {object[]} */
    let matches = [];

    const paintInput = async () => {
        const shown  = filter.length ? filter : 'Type a command…';
        const colour = filter.length ? theme.text : theme.textMuted;
        const size   = estimateLabelSize(shown, theme.fontSizeUi, boxW - pad * 2);
        await Promise.all([
            settled(UI.setTextString(win, inputText, shown)), settled(UI.setTextColour(win, inputText, colour)),
            settled(UI.setLayoutSize(win, inputText, {x: Math.max(40, size.x), y: inputH}))
        ]);
    };

    const paintList = async () => {
        const ops = [];
        for(let i = 0; i < maxVisible; i++)
        {
            const row  = rows[i];
            const item = matches[i];
            if(!item)
            {
                row.id    = '';
                row.title = '';
                ops.push(settled(UI.setEnabled(win, row.root, false)));
                continue;
            }
            row.id       = item.id;
            const title  = item.category ? `${item.category}: ${item.title}` : item.title;
            row.title    = title;
            const active = i === selected;
            ops.push(settled(UI.setEnabled(win, row.root, true)));
            ops.push(settled(UI.setBoxColour(win, row.root, active ? theme.treeActive : [0, 0, 0, 0])));
            ops.push(settled(UI.setTextString(win, row.label, title)));
            ops.push(settled(UI.setTextColour(win, row.label, active ? theme.primary : theme.textDim)));
            const size = estimateLabelSize(title, theme.fontSizeUiSm, boxW - pad * 2);
            ops.push(settled(UI.setLayoutSize(win, row.label, {x: Math.max(20, size.x), y: rowH})));
        }
        if(ops.length) await Promise.all(ops);
    };

    const refreshMatches = async () => {
        matches = registry ? registry.query(filter) : [];
        if(selected >= matches.length) selected = Math.max(0, matches.length - 1);
        await paintInput();
        await paintList();
    };

    const runSelected = async (id) => {
        const runId = id || (matches[selected] && matches[selected].id);
        await close();
        if(runId && registry) await registry.run(runId);
    };

    const openPalette = async (initialFilter = '') => {
        if(open) return;
        open     = true;
        filter   = String(initialFilter || '');
        selected = 0;
        await Promise.all([
            settled(UI.setBoxColour(win, box, theme.panelHigh)),
            settled(UI.setBoxColour(win, inputWrap, theme.panelAlt))
        ]);
        await UI.setEnabled(win, backdrop, true);
        await refreshMatches();
        onOpenChange(true);
    };

    const close = async () => {
        if(!open) return;
        open   = false;
        filter = '';
        await UI.setEnabled(win, backdrop, false);
        onOpenChange(false);
    };

    if(typeof UI.setOnMouseDown === 'function')
    {
        await UI.setOnMouseDown(win, backdrop, async () => { await close(); });
        // Don't close when clicking the box itself — stop by handling on box.
        await UI.setOnMouseDown(win, box, async () => {});
    }

    const deleteFilterChar = async () => {
        if(!filter.length) return;
        // Code-point safe (avoids leaving orphan surrogates).
        const chars = Array.from(filter);
        chars.pop();
        filter   = chars.join('');
        selected = 0;
        await refreshMatches();
    };

    /**
     * @returns {boolean} true if the event was consumed
     */
    const handleKey = async (key, mods) => {
        if(!open) return false;
        const code  = key | 0;
        const ctrl  = mods && mods.hasCtrl && mods.hasCtrl();
        const shift = mods && mods.hasShift && mods.hasShift();
        const alt   = mods && mods.hasAlt && mods.hasAlt();

        if(ctrl && shift && !alt && keyIn(code, KEY.P))
        {
            await close();
            return true;
        }
        if(keyIn(code, KEY.ESCAPE))
        {
            await close();
            return true;
        }
        if(keyIn(code, KEY.ENTER))
        {
            await runSelected();
            return true;
        }
        if(keyIn(code, KEY.UP))
        {
            if(matches.length)
            {
                selected = (selected - 1 + matches.length) % matches.length;
                await paintList();
            }
            return true;
        }
        if(keyIn(code, KEY.DOWN))
        {
            if(matches.length)
            {
                selected = (selected + 1) % matches.length;
                await paintList();
            }
            return true;
        }
        if(keyIn(code, KEY.BACKSPACE) || keyIn(code, KEY.DELETE))
        {
            await deleteFilterChar();
            return true;
        }
        // Swallow other editor chords while open.
        return true;
    };

    const handleText = async (text) => {
        if(!open) return false;
        const raw = String(text || '');
        if(!raw || raw === '\n' || raw === '\r') return true;
        // Some compositors deliver backspace/delete via textInput.
        if(raw === '\b' || raw === '\x7f')
        {
            await deleteFilterChar();
            return true;
        }
        const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').replace(/\r?\n/g, '');
        if(!cleaned) return true;
        filter   += cleaned;
        selected  = 0;
        await refreshMatches();
        return true;
    };

    return {
        root: backdrop,
        isOpen: () => open,
        open: openPalette,
        close,
        handleKey,
        handleText,
        toggle: async () => {
            if(open)
                await close();
            else
                await openPalette();
        }
    };
}
