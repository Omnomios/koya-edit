/**
 * Custom editor providers — packs register to own the center pane for matched paths.
 *
 * Provider: { id, match(path), create(doc, ctx) }
 * Instance: { mount(parent), unmount(), activate(), deactivate(), reload?() }
 */

export function createEditorRegistry()
{
    /** @type {{ id: string, match: Function, create: Function }[]} */
    const providers = [];

    return {
        /**
         * @param {{ id: string, match: (path: string) => boolean, create: Function }} spec
         */
        register(spec) {
            if(!spec || typeof spec.id !== 'string' || typeof spec.match !== 'function' || typeof spec.create !== 'function') return {unregister() {}};
            const entry = {id: spec.id, match: spec.match, create: spec.create};
            providers.push(entry);
            return {
                unregister() {
                    const i = providers.indexOf(entry);
                    if(i >= 0) providers.splice(i, 1);
                }
            };
        },

        /** First provider whose match(path) is truthy. */
        match(path) {
            const p = String(path || '');
            if(!p) return null;
            for(const entry of providers)
            {
                try
                {
                    if(entry.match(p)) return entry;
                } catch(e)
                {
                    void e;
                }
            }
            return null;
        },

        get(id) {
            const want = String(id || '');
            return providers.find((e) => e.id === want) || null;
        },

        list() {
            return providers.map((e) => e.id);
        }
    };
}

export function isCustomDoc(doc)
{
    return !!(doc && doc.kind && doc.kind !== 'text');
}
