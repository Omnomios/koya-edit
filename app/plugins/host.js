/**
 * Soft-mounted feature plugins under /rom/plugins/<id>/.
 * Highlight packs keep their own loader; this discovers { id, entry } manifests.
 */
import * as Log from 'Helix/Log';
import * as Assets from 'Koya/Assets';

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
 *   editor: object,
 *   status: object,
 *   sidebar?: object,
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
    const commands = deps.commands;
    const editors  = deps.editors;

    return {
        workspaceRoot: deps.workspaceRoot,
        win: deps.win,
        getActiveDoc: typeof deps.getActiveDoc === 'function' ? deps.getActiveDoc : () => null,
        openFile: typeof deps.openFile === 'function' ? deps.openFile : async () => {},
        on(event, fn) {
            return bus.on(event, fn);
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
                if(editor && typeof editor.setLineMarks === 'function') return editor.setLineMarks(source, marks);
            },
            clearLineMarks(source) {
                if(editor && typeof editor.clearLineMarks === 'function') return editor.clearLineMarks(source);
            }
        }
    };
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
        for(const probe of ['git', 'image', 'markdown'])
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
            const mod   = await import(entryPath);
            let dispose = typeof mod.dispose === 'function' ? mod.dispose : null;
            if(typeof mod.init === 'function')
            {
                const result = await mod.init(host);
                if(result && typeof result.dispose === 'function') dispose = result.dispose.bind(result);
            }
            loaded.push({id: manifest.id, dispose});
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
                await Log.warn(`Plugin ${id} failed: ` + String(error && error.message ? error.message : error));
            } catch(_)
            {
                void _;
            }
        }
    }
    return loaded;
}

export {PLUGINS_ROOT};
