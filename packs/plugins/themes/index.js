/**
 * Built-in colour themes contributed as a feature pack.
 * Other packs can call host.registerTheme({ id, label, colours }) the same way.
 */
import * as dark from '/rom/plugins/themes/koya-dark.js';
import * as light from '/rom/plugins/themes/koya-light.js';
import * as slate from '/rom/plugins/themes/koya-slate.js';

const defs = [dark, light, slate];

/**
 * Register all themes from this pack (usable before the full plugin host exists).
 * @param {(spec: { id: string, label: string, colours: object }) => { unregister?: Function }} registerTheme
 */
export function registerThemes(registerTheme)
{
    if(typeof registerTheme !== 'function') return;
    for(const t of defs)
        registerTheme({id: t.id, label: t.label, colours: t.colours});
}

/**
 * @param {{ registerTheme?: Function }} host
 */
export async function init(host)
{
    if(host && typeof host.registerTheme === 'function')
        registerThemes(host.registerTheme);
    return {};
}
