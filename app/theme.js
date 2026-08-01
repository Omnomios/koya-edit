/**
 * Live theme object + plugin-filled registry.
 * Packs call registerTheme(); setTheme() mutates `theme` in place and notifies listeners.
 */
import * as Editor from 'Module/editor';

/** Colour helper for theme definitions (core + packs). */
export function hex(h, a = 1)
{
    const n = parseInt(String(h).replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

/** Geometry / fonts — always reapplied so chrome does not jump between themes. */
export const sharedLayout = {
    fontUi: 'Inter',
    fontMono: 'Hack',
    fontIcon: 'Symbola',
    fontSizeUi: 14,
    fontSizeUiSm: 11,
    fontSizeCode: 14,
    fontSizeCodeSm: 12,
    treeWidth: 260,
    treeRowHeight: 26,
    tabHeight: 36,
    menuHeight: 36,
    breadcrumbHeight: 24,
    gutterWidth: 48,
    statusHeight: 24,
    titleBarHeight: 36,
    searchWidth: 192,
    minimapWidth: 96,
    scrollbarWidth: 10,
    windowSize: {x: 1320, y: 1084}
};

/** Minimal shell colours so the window can open before any theme pack loads. */
const FALLBACK_COLOURS = {
    bg: hex('#121314'),
    shell: hex('#191a1b'),
    panel: hex('#191a1b'),
    panelAlt: hex('#202122'),
    panelHigh: hex('#2c2d2e'),
    panelHighest: hex('#333536'),
    border: hex('#2a2b2c'),
    borderStrong: hex('#333536'),
    text: hex('#bfbfbf'),
    textDim: hex('#8c8c8c'),
    textMuted: hex('#858889'),
    primary: hex('#ffb599'),
    primaryContainer: hex('#e96b34'),
    onPrimaryContainer: hex('#4f1700'),
    tertiary: hex('#d0c5b5'),
    tertiaryContainer: hex('#998f81'),
    secondary: hex('#ccc6b3'),
    accent: hex('#ffb599'),
    tabActive: hex('#0e0e0e'),
    tabInactive: hex('#1c1b1b'),
    selection: hex('#e96b34', 0.28),
    caret: hex('#e96b34'),
    activeLine: hex('#201f1f'),
    treeHover: hex('#353534'),
    treeActive: hex('#2a2a2a'),
    dirty: hex('#ffb599'),
    statusBg: hex('#e96b34'),
    statusFg: hex('#4f1700'),
    statusChip: hex('#ffb599'),
    diffAdded: hex('#4caf50'),
    diffModified: hex('#e96b34'),
    diffDeleted: hex('#e57373'),
    code: hex('#bbbebf'),
    syntax: {
        keyword: hex('#ffb599'),
        string: hex('#bfbfbf'),
        comment: hex('#8c8c8c'),
        function: hex('#bfbfbf'),
        type: hex('#bfbfbf'),
        number: hex('#bfbfbf'),
        constant: hex('#bfbfbf'),
        boolean: hex('#bfbfbf'),
        operator: hex('#bfbfbf'),
        punctuation: hex('#bfbfbf'),
        variable: hex('#bfbfbf'),
        support: hex('#bfbfbf'),
        parameter: hex('#bfbfbf'),
        member: hex('#bfbfbf'),
        property: hex('#bfbfbf'),
        attribute: hex('#bfbfbf'),
        label: hex('#bfbfbf'),
        module: hex('#bfbfbf'),
        constructor: hex('#bfbfbf'),
        embedded: hex('#bfbfbf'),
        heading: hex('#bfbfbf'),
        strong: hex('#bfbfbf'),
        emphasis: hex('#bfbfbf'),
        link: hex('#bfbfbf'),
        tag: hex('#bfbfbf')
    },
    scrollbarThumb: hex('#a8a9aa', 0.52),
    scrollbarThumbHover: hex('#a8a9aa', 0.72),
    scrollbarThumbActive: hex('#a8a9aa', 0.85),
    ...sharedLayout
};

/** @type {Map<string, { id: string, label: string, colours: object }>} */
const byId = new Map();

/** @type {Set<Function>} */
const listeners = new Set();

let currentId = null;

function cloneColour(c)
{
    if(Array.isArray(c)) return c.slice();
    if(c && typeof c === 'object')
    {
        const out = {};
        for(const k of Object.keys(c))
            out[k] = cloneColour(c[k]);
        return out;
    }
    return c;
}

/**
 * Assign definition onto the live theme object.
 * Colour arrays are mutated in place when length matches so retained references stay valid.
 */
function applyColours(def)
{
    for(const key of Object.keys(def))
    {
        const next = def[key];
        if(key === 'syntax' && next && typeof next === 'object')
        {
            theme.syntax = cloneColour(next);
            continue;
        }
        if(Array.isArray(next) && Array.isArray(theme[key]) && theme[key].length === next.length)
        {
            for(let i = 0; i < next.length; i++)
                theme[key][i] = next[i];
            continue;
        }
        if(next && typeof next === 'object' && !Array.isArray(next) && theme[key] && typeof theme[key] === 'object' && !Array.isArray(theme[key]))
        {
            for(const k of Object.keys(next))
                theme[key][k] = next[k];
            continue;
        }
        theme[key] = cloneColour(next);
    }
    for(const key of Object.keys(sharedLayout))
        theme[key] = cloneColour(sharedLayout[key]);
}

function notify(id)
{
    for(const fn of listeners)
    {
        try { fn({id}); }
        catch(e) { void e; }
    }
}

/** Live tokens — mutated by setTheme. Seeded with fallback until a pack applies a theme. */
export const theme = cloneColour(FALLBACK_COLOURS);

/**
 * Register a theme contributed by a plugin pack.
 * @param {{ id: string, label: string, colours: object }} spec
 * @returns {{ unregister: () => void }}
 */
export function registerTheme(spec)
{
    const id = String(spec && spec.id || '').trim();
    const label = String(spec && spec.label || id).trim();
    const colours = spec && spec.colours;
    if(!id || !colours || typeof colours !== 'object')
        return {unregister() {}};

    const entry = {id, label, colours: cloneColour(colours)};
    byId.set(id, entry);
    return {
        unregister() {
            if(byId.get(id) === entry) byId.delete(id);
        }
    };
}

export function listThemes()
{
    return [...byId.values()]
        .map((t) => ({id: t.id, label: t.label}))
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export function getThemeId()
{
    return currentId;
}

/**
 * @param {string} id
 * @param {{ persist?: boolean, silent?: boolean }} [opts]
 * @returns {boolean}
 */
export function setTheme(id, opts = {})
{
    const entry = byId.get(String(id || ''));
    if(!entry) return false;
    const persist = opts.persist !== false;
    const silent = !!opts.silent;
    currentId = entry.id;
    applyColours(entry.colours);
    if(persist) void saveThemePreference(entry.id);
    if(!silent) notify(entry.id);
    return true;
}

export function onThemeChange(fn)
{
    if(typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

async function resolveHome()
{
    try
    {
        const result = await Editor.runCommand({cmd: 'printenv', args: ['HOME']});
        const home = String(result && result.stdout || '').trim().split('\n')[0];
        if(home) return home;
    }
    catch(e) { void e; }
    try
    {
        const result = await Editor.runCommand({cmd: 'sh', args: ['-c', 'printf %s "$HOME"']});
        const home = String(result && result.stdout || '').trim();
        if(home) return home;
    }
    catch(e) { void e; }
    return null;
}

function settingsPath(home)
{
    return `${home.replace(/\/+$/, '')}/.config/koyaedit/settings.json`;
}

function applyDefaultThemeSilent()
{
    if(byId.has('koya-dark'))
        return setTheme('koya-dark', {persist: false, silent: true});
    const first = byId.keys().next();
    if(!first.done)
        return setTheme(first.value, {persist: false, silent: true});
    return false;
}

export async function loadThemePreference()
{
    try
    {
        const home = await resolveHome();
        if(home)
        {
            const text = await Editor.readText(settingsPath(home));
            const data = JSON.parse(text);
            const id = data && data.themeId;
            if(id && byId.has(id))
            {
                setTheme(id, {persist: false, silent: true});
                return id;
            }
        }
    }
    catch(e) { void e; }
    applyDefaultThemeSilent();
    return getThemeId();
}

export async function saveThemePreference(id = currentId)
{
    if(!id) return false;
    try
    {
        const home = await resolveHome();
        if(!home) return false;
        const dir = `${home.replace(/\/+$/, '')}/.config/koyaedit`;
        try { await Editor.mkdir(dir); }
        catch(e) { void e; }
        const payload = JSON.stringify({themeId: id}, null, 2) + '\n';
        await Editor.writeText(settingsPath(home), payload);
        return true;
    }
    catch(e)
    {
        void e;
        return false;
    }
}
