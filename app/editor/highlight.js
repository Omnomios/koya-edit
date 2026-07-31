/**
 * Highlight provider: tree-sitter packs under /rom/plugins/highlight/<lang>/.
 *
 * Packs register via manifest.json; Module/editor runs parse + query.
 * Spans use Unicode code-point offsets for UI.addColourArea.
 *
 * Large files stream via onChunk so the viewport can paint line blocks as
 * each range is coloured (visible range first when prefer bytes are set).
 */
import {theme} from '/rom/theme.js';
import * as Assets from 'Koya/Assets';
import * as Editor from 'Module/editor';

/**
 * @type {Map<string, {
 *   id: string,
 *   query: string,
 *   extensions: string[],
 *   injectionLanguage?: string,
 *   injectionQuery?: string
 * }>}
 */
const languages = new Map();
/** Extra extension → language id from packs. */
const extensionMap = Object.create(null);

const BASE_EXT = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    h: 'c',
    c: 'c',
    py: 'python',
    rs: 'rust',
    go: 'go',
    css: 'css',
    html: 'html',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    toml: 'toml',
    yaml: 'yaml',
    yml: 'yaml'
};

let ready          = false;
let readyPromise   = null;
let customProvider = null;

function colourForScope(scope)
{
    if(!scope || !theme.syntax) return null;
    const map  = theme.syntax;
    const full = String(scope);
    if(map[full]) return map[full];

    // Dotted captures from upstream-style queries (function.method, type.builtin, …).
    const parts = full.split('.');
    const base  = parts[0];
    const leaf  = parts[parts.length - 1];

    if(base === 'type' || base === 'constructor') return map.type || null;
    if(base === 'function')
    {
        // parseInt / require stay with call colour (purple), not ctor green.
        return map.function || null;
    }
    if(base === 'constant')
    {
        // null / undefined — keyword red
        return map.constant || map.keyword || null;
    }
    if(base === 'boolean') return map.boolean || map.number || null;
    if(base === 'variable')
    {
        if(leaf === 'parameter') return map.parameter || map.variable || null;
        // Math / JSON / console — theme support.* blue
        if(leaf === 'builtin') return map.support || map.variable || null;
        return map.variable || null;
    }
    if(base === 'member') return map.member || map.punctuation || null;
    if(base === 'module') return map.module || map.variable || null;
    if(base === 'keyword') return map.keyword || null;
    if(base === 'string')
    {
        // CSS #hex / named colours
        if(leaf === 'special') return map.constant || map.string || null;
        return map.string || null;
    }
    if(base === 'comment') return map.comment || null;
    if(base === 'number') return map.number || null;
    if(base === 'operator') return map.operator || null;
    if(base === 'punctuation' || base === 'embedded') return map.punctuation || map.operator || null;
    if(base === 'property' || base === 'attribute') return map.property || map.attribute || null;
    if(base === 'label') return map.keyword || null;
    if(base === 'tag')
    {
        if(leaf === 'error') return map.keyword || map.tag || null;
        return map.tag || map.constant || null;
    }

    // Markdown / markup scopes from tree-sitter-markdown queries.
    if(base === 'text' || base === 'markup')
    {
        if(leaf === 'title' || leaf === 'heading') return map.heading || map.constant || null;
        if(leaf === 'literal' || leaf === 'raw' || leaf === 'code') return map.string || null;
        if(leaf === 'emphasis') return map.emphasis || map.variable || null;
        if(leaf === 'strong') return map.strong || map.constant || null;
        if(leaf === 'strike' || leaf === 'strikethrough') return map.comment || null;
        if(leaf === 'uri' || leaf === 'url' || leaf === 'link') return map.link || map.support || null;
        if(leaf === 'reference') return map.property || null;
    }
    if(base === 'string' && leaf === 'escape') return map.string || null;

    if(map[base]) return map[base];
    return null;
}

function colourSpans(raw)
{
    const spans = [];
    if(!Array.isArray(raw)) return spans;
    for(const s of raw)
    {
        const colour = colourForScope(s.scope);
        if(!colour) continue;
        const start = s.start | 0;
        const end   = s.end | 0;
        if(end <= start) continue;
        spans.push({start, end, colour, scope: s.scope});
    }
    return spans;
}

function parseManifest(text, packDir)
{
    let data;
    try
    {
        data = JSON.parse(text);
    } catch(e)
    {
        return null;
    }
    if(!data || typeof data.id !== 'string') return null;
    return {
        id: data.id,
        extensions: Array.isArray(data.extensions) ? data.extensions.map(String) : [],
        grammar: typeof data.grammar === 'string' ? data.grammar : 'builtin',
        grammarSymbol: typeof data.grammarSymbol === 'string' ? data.grammarSymbol : `tree_sitter_${data.id}`,
        highlights: typeof data.highlights === 'string' ? data.highlights : 'highlights.scm',
        highlightsInline: typeof data.highlightsInline === 'string' ? data.highlightsInline : '',
        injectionLanguage: typeof data.injectionLanguage === 'string' ? data.injectionLanguage : '',
        packDir
    };
}

function romPath(p)
{
    if(typeof p !== 'string' || !p) return '';
    if(p.startsWith('/rom/')) return p;
    if(p.startsWith('plugins/')) return `/rom/${p}`;
    if(p.startsWith('/')) return p;
    return `/rom/plugins/highlight/${p}`;
}

async function loadPackGrammar(manifest)
{
    if(!manifest.grammar || manifest.grammar === 'builtin') return;
    const romSo = `${manifest.packDir}/${manifest.grammar}`;
    const bytes = await Assets.getBinary(romSo);
    const tmp   = `/tmp/koyaedit-grammar-${manifest.id}.so`;
    await Editor.writeBinary(tmp, bytes);
    await Editor.loadGrammar(tmp, manifest.grammarSymbol, manifest.id);
}

async function discoverPackDirs()
{
    const dirs = new Set();
    try
    {
        const files = await Assets.readDir('/rom/plugins/highlight');
        for(const file of files || [])
        {
            const full = romPath(file);
            const m    = full.match(/^(\/rom\/plugins\/highlight\/[^/]+)\//);
            if(m) dirs.add(m[1]);
        }
    } catch(e)
    {
        void e;
    }

    if(dirs.size === 0)
    {
        for(const id of ['javascript', 'c', 'cpp', 'json', 'markdown', 'html', 'css'])
        {
            const packDir = `/rom/plugins/highlight/${id}`;
            try
            {
                await Assets.getText(`${packDir}/manifest.json`);
                dirs.add(packDir);
            } catch(e)
            {
                void e;
            }
        }
    }
    return [...dirs];
}

/**
 * Discover highlight packs and load queries (and optional grammar .so files).
 */
export async function initHighlightPacks()
{
    if(ready) return;
    if(readyPromise) return readyPromise;
    readyPromise = (async () => {
        const packDirs = await discoverPackDirs();
        for(const packDir of packDirs)
        {
            let manifestText;
            try
            {
                manifestText = await Assets.getText(`${packDir}/manifest.json`);
            } catch(e)
            {
                continue;
            }
            const manifest = parseManifest(manifestText, packDir);
            if(!manifest) continue;

            let query = '';
            try
            {
                query = await Assets.getText(`${packDir}/${manifest.highlights}`);
            } catch(e)
            {
                continue;
            }

            let injectionQuery = '';
            if(manifest.highlightsInline)
            {
                try
                {
                    injectionQuery = await Assets.getText(`${packDir}/${manifest.highlightsInline}`);
                } catch(e)
                {
                    void e;
                }
            }

            try
            {
                await loadPackGrammar(manifest);
            } catch(e)
            {
                void e;
            }

            languages.set(
                manifest.id, {id: manifest.id, query, extensions: manifest.extensions, injectionLanguage: manifest.injectionLanguage || '', injectionQuery});
            for(const ext of manifest.extensions)
                extensionMap[String(ext).toLowerCase()] = manifest.id;
        }
        ready = true;
    })();
    return readyPromise;
}

export function languageFromPath(path)
{
    if(typeof path !== 'string') return 'text';
    const lower = path.toLowerCase();
    const dot   = lower.lastIndexOf('.');
    if(dot < 0) return 'text';
    const ext = lower.slice(dot + 1);
    if(extensionMap[ext]) return extensionMap[ext];
    return BASE_EXT[ext] || ext || 'text';
}

/** Resolve a doc language id to a loaded highlight pack id. */
function resolveHighlightLanguage(language)
{
    const id = String(language || '');
    if(languages.has(id)) return id;
    // No TS grammar pack yet — reuse JavaScript highlighting.
    if(id === 'typescript' && languages.has('javascript')) return 'javascript';
    return id;
}

export function getHighlightProvider()
{
    return treeSitterProvider;
}

export function setHighlightProvider(fn)
{
    if(typeof fn === 'function') customProvider = fn;
}

/**
 * @param {string} source
 * @param {{
 *   path?: string,
 *   language?: string,
 *   onChunk?: (chunk: { spans: object[], fromRow: number, toRow: number, done: boolean }) => void,
 *   preferStartByte?: number,
 *   preferEndByte?: number,
 *   preferFromRow?: number,
 *   preferToRow?: number,
 *   chunkLines?: number
 * }} [meta]
 */
async function treeSitterProvider(source, meta = {})
{
    await initHighlightPacks();
    const language = meta.language || languageFromPath(meta.path || '');
    const packId   = resolveHighlightLanguage(language);
    const pack     = languages.get(packId);
    if(!pack || !pack.query)
    {
        if(customProvider) return customProvider(source, meta);
        if(typeof meta.onChunk === 'function')
        {
            try
            {
                meta.onChunk({spans: [], fromRow: 0, toRow: 0, done: true});
            } catch(e)
            {
                void e;
            }
        }
        return {spans: [], textColour: theme.code || theme.text};
    }

    const userChunk = typeof meta.onChunk === 'function' ? meta.onChunk : null;

    try
    {
        const opts = {source: String(source ?? ''), language: pack.id, query: pack.query, chunkLines: meta.chunkLines | 0 || 64};
        if(pack.injectionLanguage && pack.injectionQuery)
        {
            opts.injectionLanguage = pack.injectionLanguage;
            opts.injectionQuery    = pack.injectionQuery;
        }
        if((meta.preferToRow | 0) > (meta.preferFromRow | 0))
        {
            opts.preferFromRow = meta.preferFromRow | 0;
            opts.preferToRow   = meta.preferToRow | 0;
        } else if((meta.preferEndByte | 0) > (meta.preferStartByte | 0))
        {
            opts.preferStartByte = meta.preferStartByte | 0;
            opts.preferEndByte   = meta.preferEndByte | 0;
        }
        if(userChunk)
        {
            opts.onChunk = (chunk) => {
                try
                {
                    userChunk({spans: colourSpans(chunk?.spans), fromRow: chunk?.fromRow | 0, toRow: chunk?.toRow | 0, done: !!chunk?.done});
                } catch(e)
                {
                    void e;
                }
            };
        }

        const result = await Editor.highlight(opts);
        const spans  = colourSpans(result?.spans);
        return {spans, textColour: theme.code || theme.text};
    } catch(error)
    {
        return {spans: [], textColour: theme.code || theme.text, error: String(error)};
    }
}

/**
 * @param {string} source
 * @param {object} [meta] same as treeSitterProvider
 */
export async function highlight(source, meta = {})
{
    try
    {
        const result = await treeSitterProvider(source, meta);
        if(!result || typeof result !== 'object') return {spans: [], textColour: null};
        return {spans: Array.isArray(result.spans) ? result.spans : [], textColour: result.textColour || null, error: result.error};
    } catch(error)
    {
        return {spans: [], textColour: null, error: String(error)};
    }
}
