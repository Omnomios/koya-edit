/**
 * Multi-cursor model: one ordered list of { anchor, head, preferredColumn }.
 * primaryIndex is the stable “active” cursor (last added / last interacted) —
 * never “rightmost head”.
 *
 * Legacy mirrors (caret / selAnchor / extraSelections / preferredColumn) are
 * kept in sync for code that still reads them.
 */

/** @typedef {{ anchor: number, head: number, preferredColumn: number|null }} Cursor */

/** Overlap-only merge (adjacent ranges stay separate for multi-cursor edits). */
function mergeEditRanges(ranges)
{
    const list = (ranges || [])
                     .map((r) => ({start: Math.min(r.start, r.end) | 0, end: Math.max(r.start, r.end) | 0}))
                     .filter((r) => r.start >= 0 && r.end >= r.start)
                     .sort((a, b) => a.start - b.start || a.end - b.end);
    if(list.length <= 1) return list;
    const out = [list[0]];
    for(let i = 1; i < list.length; i++)
    {
        const prev = out[out.length - 1];
        const cur  = list[i];
        if(cur.start === prev.start && cur.end === prev.end) continue;
        if(cur.start < prev.end)
            prev.end = Math.max(prev.end, cur.end);
        else
            out.push(cur);
    }
    return out;
}

export function createCursor(anchor = 0, head = 0, preferredColumn = null)
{
    return {anchor: anchor | 0, head: head | 0, preferredColumn: (typeof preferredColumn === 'number') ? preferredColumn : null};
}

export function cloneCursors(cursors)
{
    return (cursors || []).map((c) => createCursor(c.anchor, c.head, c.preferredColumn));
}

const clamp = (i, n) => Math.max(0, Math.min(n | 0, i | 0));

/**
 * Ensure doc.cursors / primaryIndex exist (migrates legacy caret/extras once).
 */
export function ensureCursors(doc)
{
    if(!doc) return;
    const n = (doc.text || '').length;

    if(Array.isArray(doc.cursors) && doc.cursors.length)
    {
        doc.cursors      = doc.cursors.map((c) => createCursor(clamp(c.anchor, n), clamp(c.head, n), c.preferredColumn));
        doc.primaryIndex = Math.max(0, Math.min(doc.cursors.length - 1, doc.primaryIndex | 0));
        syncMirrors(doc);
        return;
    }

    /** @type {Cursor[]} */
    const cursors = [];
    if(Array.isArray(doc.extraSelections))
    {
        for(const r of doc.extraSelections)
        {
            if(!r) continue;
            const hasHead   = typeof r.head === 'number';
            const hasAnchor = typeof r.anchor === 'number';
            const a         = hasAnchor ? r.anchor : Math.min(r.start, r.end);
            const h         = hasHead ? r.head : Math.max(r.start, r.end);
            cursors.push(createCursor(clamp(a, n), clamp(h, n), r.preferredColumn));
        }
    }
    const head   = clamp(typeof doc.caret === 'number' ? doc.caret : 0, n);
    const anchor = doc.selAnchor == null ? head : clamp(doc.selAnchor, n);
    cursors.push(createCursor(anchor, head, doc.preferredColumn));
    doc.cursors      = cursors;
    doc.primaryIndex = cursors.length - 1;
    syncMirrors(doc);
}

/** Keep legacy fields aligned with cursors[primaryIndex] + the rest. */
export function syncMirrors(doc)
{
    if(!doc || !Array.isArray(doc.cursors) || !doc.cursors.length) return;
    const pi            = Math.max(0, Math.min(doc.cursors.length - 1, doc.primaryIndex | 0));
    doc.primaryIndex    = pi;
    const primary       = doc.cursors[pi];
    doc.caret           = primary.head;
    doc.selAnchor       = primary.anchor === primary.head ? null : primary.anchor;
    doc.preferredColumn = primary.preferredColumn;
    doc.extraSelections =
        doc.cursors.filter((_, i) => i !== pi)
            .map((c) => ({start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head), anchor: c.anchor, head: c.head, preferredColumn: c.preferredColumn}));
}

/**
 * Normalize: clamp, drop identical (anchor,head) duplicates, keep primary by match.
 * @returns {{ cursors: Cursor[], primaryIndex: number }}
 */
export function normalizeCursors(cursors, textLen, primaryIndex = 0)
{
    const n   = textLen | 0;
    const raw = (cursors || []).map((c) => createCursor(clamp(c.anchor, n), clamp(c.head, n), c.preferredColumn));
    if(!raw.length) return {cursors: [createCursor(0, 0)], primaryIndex: 0};

    const want       = Math.max(0, Math.min(raw.length - 1, primaryIndex | 0));
    const primaryKey = `${raw[want].anchor}:${raw[want].head}`;

    const indexed = raw.map((c, i) => ({c, i}));
    indexed.sort((a, b) => a.c.head - b.c.head || a.c.anchor - b.c.anchor || a.i - b.i);

    const seen = new Set();
    /** @type {Cursor[]} */
    const out      = [];
    let newPrimary = 0;
    let primarySet = false;
    for(const {c, i} of indexed)
    {
        const key = `${c.anchor}:${c.head}`;
        if(seen.has(key)) continue;
        seen.add(key);
        if(!primarySet && (key === primaryKey || i === want))
        {
            newPrimary = out.length;
            primarySet = true;
        }
        out.push(c);
    }
    if(!primarySet) newPrimary = Math.min(out.length - 1, want);
    return {cursors: out, primaryIndex: newPrimary};
}

/**
 * Sole writer for cursor state.
 * @param {object} doc
 * @param {Cursor[]} cursors
 * @param {{ primaryIndex?: number, affinity?: string|null }} [opts]
 */
export function setCursors(doc, cursors, opts = {})
{
    if(!doc) return;
    const n          = (doc.text || '').length;
    const pi         = typeof opts.primaryIndex === 'number' ? opts.primaryIndex : (typeof doc.primaryIndex === 'number' ? doc.primaryIndex : 0);
    const norm       = normalizeCursors(cursors, n, pi);
    doc.cursors      = norm.cursors;
    doc.primaryIndex = norm.primaryIndex;
    if(opts.affinity !== undefined) doc.caretAffinity = opts.affinity;
    syncMirrors(doc);
}

export function getCursors(doc)
{
    ensureCursors(doc);
    return cloneCursors(doc.cursors);
}

export function primaryCursor(doc)
{
    ensureCursors(doc);
    return createCursor(doc.cursors[doc.primaryIndex].anchor, doc.cursors[doc.primaryIndex].head, doc.cursors[doc.primaryIndex].preferredColumn);
}

/** Escape: keep only the primary cursor, collapsed at its head. */
export function clearToPrimary(doc)
{
    ensureCursors(doc);
    const p = doc.cursors[doc.primaryIndex];
    setCursors(doc, [createCursor(p.head, p.head, null)], {primaryIndex: 0, affinity: null});
}

/** Collapse every cursor (clear selections, keep heads). */
export function collapseAllCursors(doc)
{
    ensureCursors(doc);
    setCursors(doc, doc.cursors.map((c) => createCursor(c.head, c.head, c.preferredColumn)), {primaryIndex: doc.primaryIndex});
}

/**
 * Push current primary into the list and make `next` the new primary
 * (Ctrl+click / Ctrl+D). Works for collapsed carets too.
 */
export function addCursor(doc, next)
{
    ensureCursors(doc);
    const cursors = cloneCursors(doc.cursors);
    const n       = (doc.text || '').length;
    cursors.push(createCursor(clamp(next.anchor, n), clamp(next.head != null ? next.head : next.anchor, n), next.preferredColumn));
    setCursors(doc, cursors, {primaryIndex: cursors.length - 1});
}

/** Non-empty selection spans (for paint / copy). */
export function selectionRanges(doc)
{
    ensureCursors(doc);
    const ranges = [];
    for(const c of doc.cursors)
    {
        const a = Math.min(c.anchor, c.head);
        const b = Math.max(c.anchor, c.head);
        if(b > a) ranges.push({start: a, end: b});
    }
    return mergeEditRanges(ranges);
}

/**
 * Edit sites: every cursor as [min,max] (collapsed ⇒ caret insert point).
 */
export function editRanges(doc)
{
    ensureCursors(doc);
    return mergeEditRanges(doc.cursors.map((c) => ({start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head)})));
}

export function caretHeads(doc)
{
    ensureCursors(doc);
    const out  = [];
    const seen = new Set();
    // Primary first for paint (blinking caret).
    const order = [doc.cursors[doc.primaryIndex], ...doc.cursors.filter((_, i) => i !== doc.primaryIndex)];
    for(const c of order)
    {
        const h = c.head | 0;
        if(seen.has(h)) continue;
        seen.add(h);
        out.push(h);
    }
    return out;
}

/**
 * Replace each edit site with `inserted`. Leaves one collapsed caret per site.
 * Preserves primaryIndex by mapping the primary’s old site → new caret.
 *
 * @param {object} doc
 * @param {string} inserted
 * @param {{ ranges?: {start:number,end:number}[], skipUndo?: boolean, pushUndo?: function, undoCoalesce?: object|null }} [opts]
 * @returns {{ undoCoalesce: object|null }}
 */
export function applyCursorsEdit(doc, inserted, opts = {})
{
    if(!doc) return {undoCoalesce: null};
    ensureCursors(doc);
    const ins  = String(inserted || '');
    const list = mergeEditRanges(opts.ranges || editRanges(doc)).slice().sort((a, b) => a.start - b.start);
    if(!list.length) return {undoCoalesce: opts.undoCoalesce || null};

    let undoCoalesce = opts.undoCoalesce || null;
    if(!opts.skipUndo && typeof opts.pushUndo === 'function')
    {
        const now         = Date.now();
        const multiInsert = list.every((r) => r.start === r.end) && ins.length > 0 && !ins.includes('\n');
        const starts      = list.map((r) => r.start);
        const coalesce    = multiInsert && undoCoalesce && undoCoalesce.path === doc.path && Array.isArray(undoCoalesce.nextCarets) &&
            undoCoalesce.nextCarets.length === starts.length && undoCoalesce.nextCarets.every((c, i) => c === starts[i]) && (now - undoCoalesce.at) < 2000;
        if(!coalesce) opts.pushUndo(doc);
        if(!multiInsert)
            undoCoalesce = null;
        else
            undoCoalesce = {path: doc.path, nextCarets: null, at: now, pending: true};
    }

    const before    = doc.text;
    const primary   = doc.cursors[doc.primaryIndex];
    const primaryLo = Math.min(primary.anchor, primary.head);
    const primaryHi = Math.max(primary.anchor, primary.head);

    let out = '';
    let pos = 0;
    /** @type {number[]} */
    const carets = [];
    /** Which new-caret index the old primary maps to. */
    let primarySite = list.length - 1;
    for(let i = 0; i < list.length; i++)
    {
        const r      = list[i];
        const start  = clamp(r.start, before.length);
        const end    = clamp(r.end, before.length);
        out         += before.slice(pos, start);
        out         += ins;
        carets.push(out.length);
        pos = end;
        // Primary belonged to this site if its span overlapped the replaced range.
        if((primaryLo < end && primaryHi > start) || (primaryLo === primaryHi && primaryLo >= start && primaryLo <= end)) primarySite = i;
    }
    out      += before.slice(pos);
    doc.text  = out;

    const newCursors = carets.map((h) => createCursor(h, h, null));
    const pi         = Math.max(0, Math.min(newCursors.length - 1, primarySite));
    setCursors(doc, newCursors, {primaryIndex: pi, affinity: null});

    if(undoCoalesce && undoCoalesce.pending)
    {
        undoCoalesce.nextCarets = carets.slice();
        undoCoalesce.pending    = false;
    }
    return {undoCoalesce, before, list, inserted: ins};
}

/**
 * Build a replace range per cursor (Backspace/Delete), then apply.
 * Empty returns from mapFn are skipped.
 */
export function applyMappedCursorsEdit(doc, mapFn, inserted, opts = {})
{
    if(!doc) return {undoCoalesce: null};
    ensureCursors(doc);
    const ranges = [];
    for(const c of doc.cursors)
    {
        const r = mapFn(c);
        if(!r) continue;
        const a = Math.min(r.start, r.end) | 0;
        const b = Math.max(r.start, r.end) | 0;
        if(b > a) ranges.push({start: a, end: b});
    }
    if(!ranges.length) return {undoCoalesce: opts.undoCoalesce || null};
    return applyCursorsEdit(doc, inserted, {...opts, ranges});
}
