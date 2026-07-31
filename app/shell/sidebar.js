import {estimateLabelSize} from '/rom/shell/layout.js';
import {theme} from '/rom/theme.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';

function settled(promise)
{
    return promise.then((value) => ({ok: true, value}), (error) => ({ok: false, error}));
}

/**
 * Left sidebar with activity tabs + stacked view bodies.
 * Core mounts Explorer; plugins contribute via contribute().
 */
export async function createSideBar(win, parent, opts = {})
{
    let paneWidth = typeof opts.width === 'number' ? opts.width : theme.treeWidth;
    const tabH    = theme.menuHeight || theme.tabHeight || 36;
    const tabW    = 40;

    const pane = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panel},
        layout: {type: 'column', gap: 0},
        item: {size: {x: paneWidth}, flexShrink: 0, minHeight: 0},
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

    const activity = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.panelAlt},
        layout: {type: 'row', gap: 0, alignItems: 'center', justifyContent: 'start', padding: {l: 4, r: 4, t: 0, b: 0}},
        item: {size: {x: paneWidth, y: tabH}, flexShrink: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, pane, activity);

    const viewHost =
        await UI.createElement(win, {layout: {type: 'column', gap: 0}, item: {flexGrow: 1, flexShrink: 1, minHeight: 0}, contentAlign: 'fill', clipToBounds: true});
    await UI.attach(win, pane, viewHost);

    /**
     * @type {Map<string, {
     *   id: string, title: string, icon: string, order: number,
     *   tab: number, tabLabel: number, body: number,
     *   mount?: Function, unmount?: Function, mounted: boolean
     * }>}
     */
    const views  = new Map();
    let activeId = null;
    let tabOrder = [];

    const syncActivityWidth = async () => { await settled(UI.setLayoutSize(win, activity, {x: paneWidth, y: tabH})); };

    const paintTab = async (view, active) => {
        await Promise.all([
            settled(UI.setBoxColour(win, view.tab, active ? theme.panelHigh : [0, 0, 0, 0])),
            settled(UI.setTextColour(win, view.tabLabel, active ? theme.primary : theme.textMuted))
        ]);
    };

    const showView = async (id) => {
        if(!views.has(id)) return;
        if(activeId === id)
        {
            const cur = views.get(id);
            if(cur && !cur.mounted && typeof cur.mount === 'function')
            {
                await cur.mount(cur.body);
                cur.mounted = true;
            }
            return;
        }
        const prev = activeId ? views.get(activeId) : null;
        if(prev)
        {
            await settled(UI.setEnabled(win, prev.body, false));
            await paintTab(prev, false);
        }
        activeId   = id;
        const next = views.get(id);
        if(!next) return;
        if(!next.mounted && typeof next.mount === 'function')
        {
            await next.mount(next.body);
            next.mounted = true;
        }
        await settled(UI.setEnabled(win, next.body, true));
        await paintTab(next, true);
    };

    const rebuildTabOrder = async () => {
        tabOrder = [...views.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
        // Detach/reattach tabs in order (retained nodes).
        for(const v of tabOrder)
        {
            if(typeof UI.detach === 'function') await settled(UI.detach(win, activity, v.tab));
        }
        for(const v of tabOrder)
            await UI.attach(win, activity, v.tab);
    };

    const createViewChrome = async (spec) => {
        const id    = String(spec.id || '');
        const title = String(spec.title || id);
        const icon  = String(spec.icon || '•');
        const order = typeof spec.order === 'number' ? spec.order : 100;

        const tab      = await UI.createElement(win, {
            renderable: {type: 'box', colour: [0, 0, 0, 0]},
            layout: {type: 'row', alignItems: 'center', justifyContent: 'center'},
            item: {size: {x: tabW, y: tabH - 4}, flexShrink: 0},
            contentAlign: 'fill'
        });
        const tabLabel = await UI.createElement(win, {
            renderable:
                {type: 'text', string: icon, size: 16, font: theme.fontIcon, colour: theme.textMuted, metricsBasis: 'line', justify: 'center', vAlign: 'center'},
            item: {size: {x: tabW, y: tabH - 4}},
            contentAlign: {x: 'center', y: 'center'}
        });
        await UI.attach(win, tab, tabLabel);

        const body = await UI.createElement(
            win, {layout: {type: 'column', gap: 0}, item: {flexGrow: 1, flexShrink: 1, minHeight: 0}, contentAlign: 'fill', clipToBounds: true});
        await UI.attach(win, viewHost, body);
        await UI.setEnabled(win, body, false);

        const view = {
            id,
            title,
            icon,
            order,
            tab,
            tabLabel,
            body,
            mount: typeof spec.mount === 'function' ? spec.mount : null,
            unmount: typeof spec.unmount === 'function' ? spec.unmount : null,
            mounted: false
        };

        await UI.setOnMouseDown(win, tab, async () => { await showView(id); });
        if(typeof UI.setOnMouseEnter === 'function')
        {
            await UI.setOnMouseEnter(win, tab, async () => {
                try
                {
                    await Compositor.setCursor(win, 'default');
                } catch(e)
                {
                    void e;
                }
            });
        }

        views.set(id, view);
        await rebuildTabOrder();
        return view;
    };

    const contribute = async (spec = {}) => {
        const id = String(spec.id || '');
        if(!id) return {remove: async () => {}, focus: async () => {}};
        if(views.has(id))
        {
            const existing = views.get(id);
            return {remove: async () => { await removeView(id); }, focus: async () => { await showView(id); }};
        }
        await createViewChrome(spec);
        if(!activeId) await showView(id);
        return {remove: async () => { await removeView(id); }, focus: async () => { await showView(id); }};
    };

    const removeView = async (id) => {
        const view = views.get(id);
        if(!view) return;
        if(view.mounted && typeof view.unmount === 'function')
        {
            try
            {
                await view.unmount();
            } catch(e)
            {
                void e;
            }
        }
        views.delete(id);
        if(activeId === id) activeId = null;
        await settled(UI.destroyElement(win, view.tab));
        await settled(UI.destroyElement(win, view.body));
        await rebuildTabOrder();
        if(!activeId && views.size) await showView(tabOrder[0] ? tabOrder[0].id : [...views.keys()][0]);
    };

    /**
     * Register a core view whose body is already built (e.g. file tree).
     * `attachBody(parent)` should attach the explorer into the container.
     */
    const registerCoreView = async (spec) => {
        const id   = String(spec.id || 'explorer');
        const view = await createViewChrome(
            {id, title: spec.title || 'Explorer', icon: spec.icon || '🗀', order: typeof spec.order === 'number' ? spec.order : 0, mount: null});
        if(typeof spec.attachBody === 'function') await spec.attachBody(view.body);
        view.mounted = true;
        await showView(id);
        return {focus: async () => { await showView(id); }, remove: async () => { await removeView(id); }};
    };

    void estimateLabelSize;

    return {
        root: pane,
        contribute,
        registerCoreView,
        focus: showView,
        getActiveId: () => activeId,
        getWidth() {
            return paneWidth;
        },
        async setWidth(next) {
            const w = Math.max(160, Math.min(640, Math.round(next)));
            if(w === paneWidth) return paneWidth;
            paneWidth = w;
            await Promise.all([settled(UI.setLayoutSize(win, pane, {x: paneWidth})), syncActivityWidth()]);
            return paneWidth;
        }
    };
}
