/**
 * Shared command registry for the palette and plugins.
 */
export function createCommandRegistry()
{
    /** @type {Map<string, { id: string, title: string, category?: string, when?: Function, run: Function }>} */
    const commands = new Map();

    return {
        register(spec) {
            const id = String(spec && spec.id || '');
            if(!id || typeof spec.run !== 'function') return {unregister() {}};
            const entry = {
                id,
                title: String(spec.title || id),
                category: spec.category ? String(spec.category) : '',
                when: typeof spec.when === 'function' ? spec.when : null,
                run: spec.run
            };
            commands.set(id, entry);
            return {
                unregister() {
                    if(commands.get(id) === entry) commands.delete(id);
                }
            };
        },
        unregister(id) {
            commands.delete(String(id || ''));
        },
        list() {
            return [...commands.values()].map((c) => ({id: c.id, title: c.title, category: c.category}));
        },
        /** Filtered + sorted for the palette. */
        query(filter) {
            const q   = String(filter || '').trim().toLowerCase();
            const out = [];
            for(const c of commands.values())
            {
                if(c.when)
                {
                    try
                    {
                        if(!c.when()) continue;
                    } catch(e)
                    {
                        continue;
                    }
                }
                const hay = `${c.category} ${c.title} ${c.id}`.toLowerCase();
                if(q && !hay.includes(q)) continue;
                out.push(c);
            }
            out.sort((a, b) => {
                const ca = a.category || 'zzz';
                const cb = b.category || 'zzz';
                if(ca !== cb) return ca < cb ? -1 : 1;
                return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
            });
            return out;
        },
        async run(id) {
            const c = commands.get(String(id || ''));
            if(!c) return false;
            await c.run();
            return true;
        }
    };
}
