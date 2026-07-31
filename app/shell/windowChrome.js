import {theme} from '/rom/theme.js';
import * as Engine from 'Helix/Engine';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';

const RESIZE_BORDER = 5;

const EDGE_CURSORS = {
    top: 'ns-resize',
    bottom: 'ns-resize',
    left: 'ew-resize',
    right: 'ew-resize',
    'top-left': 'nwse-resize',
    'top-right': 'nesw-resize',
    'bottom-left': 'nesw-resize',
    'bottom-right': 'nwse-resize'
};

/**
 * Client-side decorations. The shell fills the window edge-to-edge; resize
 * grips sit in a transparent overlay so hit-testing is preserved without a
 * visible border inset.
 */
export async function createWindowChrome(win, opts = {})
{
    const onGeometryInteraction = typeof opts.onGeometryInteraction === 'function' ? opts.onGeometryInteraction : null;
    const titleBarH             = theme.menuHeight || theme.titleBarHeight;
    const b                     = RESIZE_BORDER;
    // Caption buttons: full bar height, contiguous, flush to the right edge.
    const btnW    = 40;
    const btnRowW = btnW * 2;

    // Root is layout-none: children without absolute position fill the canvas.
    const root = await UI.createElement(win, {renderable: {type: 'box', colour: theme.shell}, item: {size: {x: 'auto', y: 'auto'}}, contentAlign: 'fill'});
    await UI.attachRoot(win, root);

    // App chrome — fills the window (no resize inset).
    const shell = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.shell},
        layout: {type: 'column', gap: 0},
        item: {size: {x: 'auto', y: 'auto'}},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, root, shell);

    const bindGrip = async (el, edge) => {
        await UI.setOnMouseDown(win, el, async () => {
            if(onGeometryInteraction) onGeometryInteraction();
            try
            {
                await Compositor.startResize(win, edge);
            } catch(e)
            {
                void e;
            }
        });
        if(typeof UI.setOnMouseEnter === 'function')
        {
            await UI.setOnMouseEnter(win, el, async () => {
                try
                {
                    await Compositor.setCursor(win, EDGE_CURSORS[edge] || 'default');
                } catch(e)
                {
                    void e;
                }
            });
        }
    };

    const makeStrip = async (edge, size) => {
        const el = await UI.createElement(win, {
            // Fully transparent — overlay must not paint a border.
            renderable: {type: 'box', colour: [0, 0, 0, 0]},
            item: {size}
        });
        await bindGrip(el, edge);
        return el;
    };

    // Transparent overlay matching the window. Only edge children register
    // hit targets; the open centre returns no hit so clicks reach the shell.
    const gripHost = await UI.createElement(win, {layout: {type: 'column', gap: 0}, item: {size: {x: 'auto', y: 'auto'}}, contentAlign: 'fill'});
    await UI.attach(win, root, gripHost);

    const topRow = await UI.createElement(win, {layout: {type: 'row', gap: 0}, item: {size: {y: b}}});
    await UI.attach(win, gripHost, topRow);
    const tl     = await makeStrip('top-left', {x: b, y: b});
    const topMid = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {y: b}, flexGrow: 1}});
    await bindGrip(topMid, 'top');
    const tr = await makeStrip('top-right', {x: b, y: b});
    await Promise.all([UI.attach(win, topRow, tl), UI.attach(win, topRow, topMid), UI.attach(win, topRow, tr)]);

    const midRow = await UI.createElement(win, {layout: {type: 'row', gap: 0}, item: {flexGrow: 1}});
    await UI.attach(win, gripHost, midRow);

    const left = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: b}}});
    await bindGrip(left, 'left');
    await UI.attach(win, midRow, left);

    // Spacer: no mouse handlers → findAt yields no hit → shell receives the click.
    const passThrough = await UI.createElement(win, {item: {size: {x: 'auto', y: 'auto'}, flexGrow: 1, flexShrink: 1, minHeight: 0}});
    await UI.attach(win, midRow, passThrough);

    const right = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {x: b}}});
    await bindGrip(right, 'right');
    await UI.attach(win, midRow, right);

    const botRow = await UI.createElement(win, {layout: {type: 'row', gap: 0}, item: {size: {y: b}}});
    await UI.attach(win, gripHost, botRow);
    const bl     = await makeStrip('bottom-left', {x: b, y: b});
    const botMid = await UI.createElement(win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {y: b}, flexGrow: 1}});
    await bindGrip(botMid, 'bottom');
    const br = await makeStrip('bottom-right', {x: b, y: b});
    await Promise.all([UI.attach(win, botRow, bl), UI.attach(win, botRow, botMid), UI.attach(win, botRow, br)]);

    // Header (mockup): hamburger | drag spacer | window buttons. Menus/search gone.
    const titleBar = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panelAlt},
        layout: {type: 'row', gap: 16, padding: {l: 24, r: 0, t: 0, b: 0}, alignItems: 'center', justifyContent: 'start'},
        item: {size: {y: titleBarH}},
        contentAlign: 'fill',
        clipToBounds: true
    });

    // Status-bar text pattern: slot takes the full row height, contentAlign/vAlign
    // centre the glyphs inside it (never size text to ink height + flex-centre).
    const menuIcon = await UI.createElement(win, {
        renderable: {type: 'text', string: '☰', size: 16, font: theme.fontIcon, colour: theme.textDim, metricsBasis: 'line', justify: 'center', vAlign: 'center'},
        item: {size: {x: 22, y: titleBarH}, flexShrink: 0},
        contentAlign: {x: 'center', y: 'center'}
    });
    await UI.attach(win, titleBar, menuIcon);
    if(typeof UI.setOnMouseEnter === 'function' && typeof UI.setOnMouseExit === 'function')
    {
        await UI.setOnMouseEnter(win, menuIcon, async () => { await UI.setTextColour(win, menuIcon, theme.text); });
        await UI.setOnMouseExit(win, menuIcon, async () => { await UI.setTextColour(win, menuIcon, theme.textDim); });
    }

    // Flexible drag region between the hamburger and the caption buttons.
    const dragHit = await UI.createElement(
        win, {renderable: {type: 'box', colour: [0, 0, 0, 0]}, item: {size: {y: titleBarH - 4}, flexGrow: 1, flexShrink: 1}, clipToBounds: true});
    await UI.attach(win, titleBar, dragHit);

    const btnRow = await UI.createElement(win, {
        layout: {type: 'row', gap: 0, alignItems: 'center', justifyContent: 'end'},
        item: {size: {x: btnRowW, y: titleBarH}, flexGrow: 0, flexShrink: 0},
        contentAlign: 'fill'
    });
    await UI.attach(win, titleBar, btnRow);

    /**
     * Full-height caption button. Idle: transparent, muted glyph.
     * Hover (mouse enter/exit): filled box + brightened glyph.
     */
    const makeBtn = async (label, hover = {}) => {
        const idleFg  = theme.textMuted;
        const hoverBg = hover.bg || theme.panelHighest;
        const hoverFg = hover.fg || theme.text;
        const btn     = await UI.createElement(win, {
            renderable: {type: 'box', colour: [0, 0, 0, 0]},
            layout: {type: 'row', alignItems: 'center', justifyContent: 'center'},
            item: {size: {x: btnW, y: titleBarH}, flexShrink: 0},
            contentAlign: 'fill'
        });
        const text    = await UI.createElement(win, {
            renderable:
                {type: 'text', string: label, size: theme.fontSizeUi, font: theme.fontUi, colour: idleFg, metricsBasis: 'line', justify: 'center', vAlign: 'center'},
            item: {size: {x: btnW, y: titleBarH}},
            contentAlign: {x: 'center', y: 'center'}
        });
        await UI.attach(win, btnRow, btn);
        await UI.attach(win, btn, text);
        if(typeof UI.setOnMouseEnter === 'function' && typeof UI.setOnMouseExit === 'function')
        {
            await UI.setOnMouseEnter(win, btn, async () => {
                try
                {
                    await Compositor.setCursor(win, 'default');
                } catch(e)
                {
                    void e;
                }
                await Promise.all([UI.setBoxColour(win, btn, hoverBg), UI.setTextColour(win, text, hoverFg)]);
            });
            await UI.setOnMouseExit(win, btn, async () => { await Promise.all([UI.setBoxColour(win, btn, [0, 0, 0, 0]), UI.setTextColour(win, text, idleFg)]); });
        }
        return btn;
    };

    const maxBtn   = await makeBtn('□');
    const closeBtn = await makeBtn('×', {bg: theme.primaryContainer, fg: theme.onPrimaryContainer});

    let maximized = false;

    const startMove = async () => {
        try
        {
            await Compositor.startMove(win);
        } catch(e)
        {
            void e;
        }
    };
    await UI.setOnMouseDown(win, dragHit, startMove);

    await UI.setOnMouseDown(win, maxBtn, async () => {
        maximized = !maximized;
        if(onGeometryInteraction) onGeometryInteraction();
        try
        {
            await Compositor.setMaximized(win, maximized);
        } catch(e)
        {
            void e;
        }
    });

    await UI.setOnMouseDown(win, closeBtn, async () => {
        try
        {
            await Compositor.destroyWindow(win);
        } catch(e)
        {
            void e;
        }
        try
        {
            Engine.quit();
        } catch(e)
        {
            void e;
        }
    });

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, shell, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
        });
    }

    return {
        root,
        shell,
        titleBar,
        titleBarHeight: titleBarH,
        resizeBorder: b,
        /** Window title stays on the compositor; menu bar has no title label. */
        async setTitle(_text) {
            void _text;
        }
    };
}
