/**
 * Soft-mounted feature plugins under /rom/plugins/<id>/.
 * Highlight packs keep their own loader; this discovers { id, entry } manifests.
 */
import * as Log from 'Helix/Log';
import * as Assets from 'Koya/Assets';
import {registerTheme as registerThemeCore} from '/rom/theme.js';

const PLUGINS_ROOT = '/rom/plugins';
/** Highlight uses a different pack contract — skip here. */
const SKIP_IDS = new Set(['highlight']);

function romPluginEntry(id, entry)
{
    const file = String(entry || 'index.js').replace(/^\//, '');
    return `${PLUGINS_ROOT}/${id}/${file}`;
}

/**
 * Tiny event bus for plugin host lifecycle.
 */
export function createEmitter()
{
    const listeners = new Map();
    return {
        on(event, fn) {
            if(typeof fn !== 'function') return () => {};
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
            return () => {
                const next = (listeners.get(event) || []).filter((f) => f !== fn);
                if(next.length)
                    listeners.set(event, next);
                else
                    listeners.delete(event);
            };
        },
        emit(event, payload) {
            const list = listeners.get(event) || [];
            for(const fn of list)
            {
                try
                {
                    fn(payload);
                } catch(e)
                {
                    void e;
                }
            }
        }
    };
}

/**
 * @param {{
 *   workspaceRoot: string,
 *   win?: number,
 *   getActiveDoc: () => object|null,
 *   editor?: object,
 *   forEachEditor?: (fn: (editor: object) => void) => void,
 *   status: object,
 *   sidebar?: object,
 *   rightSidebar?: object,
 *   commands?: object,
 *   editors?: { register: Function },
 *   openFile?: (path: string, opts?: object) => Promise<void>,
 *   bus?: ReturnType<typeof createEmitter>
 * }} deps
 */
export function createPluginHost(deps)
{
    const bus      = deps.bus || createEmitter();
    const editor   = deps.editor;
    const status   = deps.status;
    const sidebar  = deps.sidebar;
    const rightSidebar = deps.rightSidebar;
    const commands = deps.commands;
    const editors  = deps.editors;
    const forEachEditor = typeof deps.forEachEditor === 'function'
        ? deps.forEachEditor
        : (fn) => { if(editor) fn(editor); };

    return {
        workspaceRoot: deps.workspaceRoot,
        win: deps.win,
        getActiveDoc: typeof deps.getActiveDoc === 'function' ? deps.getActiveDoc : () => null,
        openFile: typeof deps.openFile === 'function' ? deps.openFile : async () => {},
        on(event, fn) {
            return bus.on(event, fn);
        },
        /**
         * Contribute a colour theme. Spec: { id, label, colours }.
         * @returns {{ unregister: () => void }}
         */
        registerTheme(spec) {
            return registerThemeCore(spec);
        },
        status: {
            contribute(spec) {
                if(!status || typeof status.contribute !== 'function') return {set: async () => {}, remove: async () => {}};
                return status.contribute(spec);
            }
        },
        sidebar: {
            contribute(spec) {
                if(!sidebar || typeof sidebar.contribute !== 'function') return {remove: async () => {}, focus: async () => {}};
                return sidebar.contribute(spec);
            },
            focus(id) {
                if(sidebar && typeof sidebar.focus === 'function') return sidebar.focus(id);
            }
        },
        rightSidebar: {
            contribute(spec) {
                if(!rightSidebar || typeof rightSidebar.contribute !== 'function')
                    return {remove: async () => {}, focus: async () => {}};
                return rightSidebar.contribute(spec);
            },
            focus(id) {
                if(rightSidebar && typeof rightSidebar.focus === 'function') return rightSidebar.focus(id);
            }
        },
        commands: {
            register(spec) {
                if(!commands || typeof commands.register !== 'function') return {unregister() {}};
                return commands.register(spec);
            }
        },
        editors: {
            register(spec) {
                if(!editors || typeof editors.register !== 'function') return {unregister() {}};
                return editors.register(spec);
            }
        },
        editor: {
            setLineMarks(source, marks) {
                forEachEditor((ed) => {
                    if(ed && typeof ed.setLineMarks === 'function') ed.setLineMarks(source, marks);
                });
            },
            clearLineMarks(source) {
                forEachEditor((ed) => {
                    if(ed && typeof ed.clearLineMarks === 'function') ed.clearLineMarks(source);
                });
            }
        }
    };
}

/**
 * Load the bundled themes pack early (before chrome) so the saved theme can paint first.
 * Other packs register themes later via host.registerTheme() in init().
 */
export async function bootstrapThemePlugins(registerTheme)
{
    const register = typeof registerTheme === 'function' ? registerTheme : registerThemeCore;
    try
    {
        const mod = await import(romPluginEntry('themes', 'index.js'));
        if(mod && typeof mod.registerThemes === 'function')
        {
            mod.registerThemes(register);
            return;
        }
        if(mod && typeof mod.init === 'function')
            await mod.init({registerTheme: register});
    }
    catch(e)
    {
        try { await Log.warn('Theme pack bootstrap failed: ' + String(e && e.message ? e.message : e)); }
        catch(_) { void _; }
    }
}

/**
 * Discover and init feature packs. Safe when /rom/plugins is missing.
 * @returns {Promise<{ id: string, dispose?: Function }[]>}
 */
export async function loadFeaturePlugins(host)
{
    const loaded = [];
    let names    = [];
    try
    {
        names = await Assets.readDir(PLUGINS_ROOT);
    } catch(e)
    {
        try
        {
            await Log.info('No /rom/plugins tree (feature packs skipped)');
        } catch(_)
        {
            void _;
        }
        return loaded;
    }

    const ids = new Set();
    for(const name of names || [])
    {
        const s = String(name || '');
        // readDir may return files as "plugins/git/manifest.json" or basenames
        const m  = s.match(/(?:^|\/)plugins\/([^/]+)\//) || s.match(/^([^/]+)\/manifest\.json$/) || (s.includes('/') ? null : [null, s]);
        const id = m && m[1] ? m[1] : null;
        if(!id || SKIP_IDS.has(id) || id.includes('.')) continue;
        ids.add(id);
    }

    // Fallback: probe known pack dirs if readDir only listed files
    if(ids.size === 0)
    {
        for(const probe of ['themes', 'git', 'image', 'markdown'])
        {
            try
            {
                await Assets.getText(`${PLUGINS_ROOT}/${probe}/manifest.json`);
                ids.add(probe);
            } catch(e)
            {
                void e;
            }
        }
    }

    for(const id of [...ids].sort())
    {
        let manifestText = null;
        try
        {
            manifestText = await Assets.getText(`${PLUGINS_ROOT}/${id}/manifest.json`);
        } catch(e)
        {
            continue;
        }
        let manifest = null;
        try
        {
            manifest = JSON.parse(manifestText);
        } catch(e)
        {
            try
            {
                await Log.warn(`Plugin ${id}: invalid manifest`);
            } catch(_)
            {
                void _;
            }
            continue;
        }
        if(!manifest || typeof manifest.id !== 'string') continue;
        const entryPath = romPluginEntry(manifest.id, manifest.entry || 'index.js');
        try
        {
            const mod = await import(entryPath);
            const init = mod && typeof mod.init === 'function' ? mod.init : (mod && mod.default && typeof mod.default.init === 'function' ? mod.default.init : null);
            if(!init)
            {
                await Log.warn(`Plugin ${manifest.id}: no init()`);
                continue;
            }
            const handle = await init(host);
            loaded.push({id: manifest.id, dispose: handle && typeof handle.dispose === 'function' ? handle.dispose : undefined});
            try
            {
                await Log.info(`Plugin loaded: ${manifest.id}`);
            } catch(_)
            {
                void _;
            }
        } catch(error)
        {
            try
            {
                await Log.warn(`Plugin ${manifest.id} failed: ` + String(error && error.message ? error.message : error));
            } catch(_)
            {
                void _;
            }
        }
    }
    return loaded;
}
