import {basename, createDocument} from '/rom/editor/buffer.js';
import {languageFromPath} from '/rom/editor/highlight.js';
import * as Fs from '/rom/workspace/fs.js';

/**
 * Insert `path → doc` into a Map, optionally replacing `replacePath` in-order
 * (VS Code preview: new file takes the preview tab’s slot).
 */
function mapSetReplacing(map, path, doc, replacePath)
{
    if(!replacePath || replacePath === path || !map.has(replacePath))
    {
        map.set(path, doc);
        return;
    }
    const ordered = [...map.entries()];
    map.clear();
    for(const [p, d] of ordered)
    {
        if(p === replacePath)
            map.set(path, doc);
        else
            map.set(p, d);
    }
    if(!map.has(path)) map.set(path, doc);
}

export function isUntitledPath(path)
{
    return typeof path === 'string' && path.startsWith('untitled:');
}

/** Non-text custom editor document (image viewer, etc.). */
export function isCustomDoc(doc)
{
    return !!(doc && doc.kind && doc.kind !== 'text');
}

function extLabel(path)
{
    const base = basename(path || '');
    const i    = base.lastIndexOf('.');
    if(i <= 0 || i === base.length - 1) return 'file';
    return base.slice(i + 1).toUpperCase();
}

export function createDocumentStore()
{
    const docs      = new Map();
    let activePath  = null;
    let untitledSeq = 0;

    const findPreviewPath = () => {
        for(const [path, doc] of docs)
        {
            // Preview tabs stay replaceable until edited (or explicitly pinned).
            if(doc.preview && !doc.dirty) return path;
        }
        return null;
    };

    return {
        list() {
            return [...docs.values()];
        },
        get(path) {
            return docs.get(path) || null;
        },
        active() {
            return activePath ? docs.get(activePath) || null : null;
        },
        activePath() {
            return activePath;
        },
        /** Path of the replaceable preview tab, if any. */
        previewPath() {
            return findPreviewPath();
        },
        /** Pin a tab so later opens no longer replace it (VS Code double-click). */
        pin(path = activePath) {
            const doc = path ? docs.get(path) : null;
            if(!doc) return null;
            doc.preview = false;
            return doc;
        },
        /**
         * Create an untitled buffer (not yet on disk).
         * @returns {object} doc
         */
        createUntitled() {
            untitledSeq  += 1;
            const id      = untitledSeq;
            const path    = `untitled:${id}`;
            const doc     = createDocument(path, '');
            doc.kind      = 'text';
            doc.language  = 'text';
            doc.title     = id === 1 ? 'Untitled' : `Untitled-${id}`;
            doc.untitled  = true;
            doc.preview   = false;
            doc.dirty     = false;
            docs.set(path, doc);
            activePath = path;
            return doc;
        },
        /**
         * Open a path as a text document.
         * @param {string} path
         * @param {{ preview?: boolean }} [opts] — default preview:true (VS Code).
         *   Preview tabs without edits are replaced by the next preview open.
         */
        async open(path, opts = {}) {
            const asPreview = opts.preview !== false;

            if(docs.has(path))
            {
                activePath = path;
                if(!asPreview) docs.get(path).preview = false;
                return docs.get(path);
            }

            // Full text — the editor viewport virtualises paint; no open-size truncate.
            const text   = await Fs.readText(path);
            const doc    = createDocument(path, text);
            doc.kind     = 'text';
            doc.language = languageFromPath(path);
            doc.title    = basename(path);
            doc.untitled = false;
            doc.preview  = asPreview;
            doc.dirty    = false;

            // One preview slot: replace the existing clean preview tab in place.
            const replacePath = asPreview ? findPreviewPath() : null;
            mapSetReplacing(docs, path, doc, replacePath);
            activePath = path;
            return doc;
        },
        /**
         * Open a path as a custom editor document (no text read).
         * @param {string} path
         * @param {string} providerId
         * @param {{ preview?: boolean }} [opts]
         */
        async openCustom(path, providerId, opts = {}) {
            const asPreview = opts.preview !== false;
            const kind      = String(providerId || '');

            if(docs.has(path))
            {
                const existing = docs.get(path);
                activePath     = path;
                if(!asPreview) existing.preview = false;
                // Already open as a different kind — keep the tab; caller re-activates.
                return existing;
            }

            const doc      = createDocument(path, '');
            doc.kind       = kind || 'custom';
            doc.language   = opts.language || extLabel(path).toLowerCase();
            doc.title      = opts.title || basename(path);
            doc.sourcePath = opts.sourcePath || null;
            doc.untitled   = false;
            doc.preview    = asPreview;
            doc.dirty      = false;

            const replacePath = asPreview ? findPreviewPath() : null;
            mapSetReplacing(docs, path, doc, replacePath);
            activePath = path;
            return doc;
        },
        setActive(path) {
            if(!docs.has(path)) return null;
            activePath = path;
            return docs.get(path);
        },
        /** Atom ctrl-pageup/pagedown / ctrl-tab: cycle open buffers. */
        cycleActive(delta) {
            const list = [...docs.keys()];
            if(list.length === 0) return null;
            const i    = Math.max(0, list.indexOf(activePath));
            const next = list[(i + delta + list.length * 8) % list.length];
            activePath = next;
            return docs.get(next);
        },
        /**
         * Save buffer to disk. Untitled buffers must use saveAs.
         * Custom (non-text) docs are read-only — no-op.
         * @returns {Promise<boolean>}
         */
        async save(path = activePath) {
            const doc = path ? docs.get(path) : null;
            if(!doc) return false;
            if(isCustomDoc(doc)) return false;
            if(doc.untitled || isUntitledPath(doc.path)) throw new Error('SAVE_AS_REQUIRED');
            await Fs.writeText(doc.path, doc.text);
            doc.dirty     = false;
            doc.savedText = doc.text;
            doc.preview   = false;
            return true;
        },
        /**
         * Write buffer to `newPath` and rebind the tab (Save As).
         * @param {string} fromPath
         * @param {string} newPath
         */
        async saveAs(fromPath, newPath) {
            const doc = fromPath ? docs.get(fromPath) : null;
            if(!doc || !newPath) return false;
            if(isCustomDoc(doc)) return false;
            await Fs.writeText(newPath, doc.text);

            if(docs.has(newPath) && newPath !== fromPath)
            {
                const other     = docs.get(newPath);
                other.text      = doc.text;
                other.savedText = doc.text;
                other.dirty     = false;
                other.untitled  = false;
                other.preview   = false;
                other.kind      = 'text';
                other.language  = languageFromPath(newPath);
                other.title     = basename(newPath);
                docs.delete(fromPath);
                activePath = newPath;
                return true;
            }

            if(fromPath !== newPath)
            {
                docs.delete(fromPath);
                doc.path = newPath;
                docs.set(newPath, doc);
                if(activePath === fromPath) activePath = newPath;
            }
            doc.path      = newPath;
            doc.title     = basename(newPath);
            doc.language  = languageFromPath(newPath);
            doc.kind      = 'text';
            doc.untitled  = false;
            doc.dirty     = false;
            doc.savedText = doc.text;
            doc.preview   = false;
            activePath    = newPath;
            return true;
        },
        close(path) {
            if(!docs.has(path)) return;
            docs.delete(path);
            if(activePath === path)
            {
                const remaining = [...docs.keys()];
                activePath      = remaining.length ? remaining[remaining.length - 1] : null;
            }
        },
        replaceFromDisk(path, text) {
            const doc = docs.get(path);
            if(!doc || doc.dirty || isCustomDoc(doc)) return false;
            const next    = typeof text === 'string' ? text : '';
            doc.text      = next;
            doc.savedText = next;
            doc.caret     = Math.min(doc.caret, next.length);
            if(doc.selAnchor !== null) doc.selAnchor = Math.min(doc.selAnchor, next.length);
            if(Array.isArray(doc.cursors) && doc.cursors.length)
            {
                doc.cursors = doc.cursors.map(
                    (c) => ({anchor: Math.min(c.anchor | 0, next.length), head: Math.min(c.head | 0, next.length), preferredColumn: c.preferredColumn ?? null}));
                doc.primaryIndex = Math.max(0, Math.min(doc.cursors.length - 1, doc.primaryIndex | 0));
            }
            if(Array.isArray(doc.extraSelections))
            {
                doc.extraSelections = doc.extraSelections
                                          .map((r) => ({
                                                   start: Math.min(r.start, next.length),
                                                   end: Math.min(r.end, next.length),
                                                   ...(typeof r.anchor === 'number' ? {anchor: Math.min(r.anchor, next.length)} : {}),
                                                   ...(typeof r.head === 'number' ? {head: Math.min(r.head, next.length)} : {})
                                               }))
                                          .filter((r) => r.end >= r.start);
            }
            return true;
        }
    };
}
