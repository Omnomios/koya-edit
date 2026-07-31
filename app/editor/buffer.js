/** Document buffer helpers (plain string + caret/selection / multi-cursor). */
export function createDocument(path, text = '')
{
    const body = typeof text === 'string' ? text : '';
    return {
        path,
        text: body,
        /** Last saved (or disk-loaded) text — baseline for unsaved gutter marks. */
        savedText: body,
        /**
         * Multi-cursor list: [{ anchor, head, preferredColumn }, ...].
         * primaryIndex is the active cursor (last added), not “rightmost”.
         */
        cursors: [{anchor: 0, head: 0, preferredColumn: null}],
        primaryIndex: 0,
        /** @deprecated mirrors — synced from cursors by editor/cursors.js */
        caret: 0,
        selAnchor: null,
        extraSelections: [],
        scrollX: 0,
        scrollY: 0,
        dirty: false,
        preferredColumn: null,
        /** Soft-wrap caret bias at wrap boundaries: 'upstream' | 'downstream' | null. */
        caretAffinity: null,
        undoStack: [],
        redoStack: []
    };
}

export function splitLines(text)
{
    return text.split('\n');
}

export function rowColFromIndex(text, index)
{
    const i      = Math.max(0, Math.min(text.length, index));
    const before = text.slice(0, i);
    const parts  = before.split('\n');
    return {row: parts.length - 1, col: parts[parts.length - 1].length};
}

export function indexFromRowCol(lines, row, col)
{
    let idx    = 0;
    const rMax = Math.max(0, Math.min(lines.length - 1, row));
    for(let r = 0; r < rMax; r++)
        idx += lines[r].length + 1;
    const line = lines[rMax] || '';
    return idx + Math.max(0, Math.min(line.length, col));
}

export function basename(path)
{
    if(typeof path !== 'string' || !path) return 'untitled';
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

export function sanitizeTextInput(text)
{
    return [...String(text || '')]
        .filter((ch) => {
            const cp = ch.codePointAt(0);
            if(cp === undefined) return false;
            if(cp === 9 || cp === 10) return true;
            if(cp < 0x20) return false;
            if(cp === 0x7f) return false;
            if(cp >= 0x80 && cp <= 0x9f) return false;
            return true;
        })
        .join('');
}

const WORD_RE = /[A-Za-z0-9_]/;

/** Atom/Linux: move to beginning of word (ctrl-left). */
export function indexWordLeft(text, index)
{
    let i = Math.max(0, Math.min(text.length, index));
    if(i === 0) return 0;
    i--;
    while(i > 0 && /\s/.test(text[i]))
        i--;
    if(WORD_RE.test(text[i]))
    {
        while(i > 0 && WORD_RE.test(text[i - 1]))
            i--;
    } else
    {
        while(i > 0 && !WORD_RE.test(text[i - 1]) && !/\s/.test(text[i - 1]))
            i--;
    }
    return i;
}

/** Atom/Linux: move to end of word (ctrl-right). */
export function indexWordRight(text, index)
{
    let i   = Math.max(0, Math.min(text.length, index));
    const n = text.length;
    if(i >= n) return n;
    if(WORD_RE.test(text[i]))
    {
        while(i < n && WORD_RE.test(text[i]))
            i++;
    } else if(!/\s/.test(text[i]))
    {
        while(i < n && !WORD_RE.test(text[i]) && !/\s/.test(text[i]))
            i++;
    }
    while(i < n && /\s/.test(text[i]))
        i++;
    return i;
}

/**
 * Word (or punctuation / intra-line whitespace) range at a caret index.
 * Used by double-click select.
 * @returns {{ start: number, end: number }}
 */
export function wordRangeAt(text, index)
{
    const s = typeof text === 'string' ? text : '';
    const n = s.length;
    if(n === 0) return {start: 0, end: 0};
    let i = Math.max(0, Math.min(n, index | 0));
    // Caret at end of a word → select that word.
    if(i >= n)
        i = n - 1;
    else if(i > 0 && !WORD_RE.test(s[i]) && WORD_RE.test(s[i - 1]))
        i -= 1;
    else if(i > 0 && s[i] === '\n' && s[i - 1] !== '\n')
        i -= 1;

    if(s[i] === '\n') return {start: i, end: i};

    if(WORD_RE.test(s[i]))
    {
        let start = i;
        let end   = i + 1;
        while(start > 0 && WORD_RE.test(s[start - 1]))
            start -= 1;
        while(end < n && WORD_RE.test(s[end]))
            end += 1;
        return {start, end};
    }

    if(/\s/.test(s[i]))
    {
        let start = i;
        let end   = i + 1;
        while(start > 0 && /\s/.test(s[start - 1]) && s[start - 1] !== '\n')
            start -= 1;
        while(end < n && /\s/.test(s[end]) && s[end] !== '\n')
            end += 1;
        return {start, end};
    }

    let start = i;
    let end   = i + 1;
    while(start > 0 && !WORD_RE.test(s[start - 1]) && !/\s/.test(s[start - 1]))
        start -= 1;
    while(end < n && !WORD_RE.test(s[end]) && !/\s/.test(s[end]))
        end += 1;
    return {start, end};
}

/**
 * Next exact occurrence of `needle` at or after `from`, wrapping once.
 * Skips ranges already covered by `occupied` (merged [start,end) list).
 * @returns {{ start: number, end: number } | null}
 */
export function findNextOccurrence(text, needle, from, occupied = [])
{
    const s = typeof text === 'string' ? text : '';
    const n = String(needle || '');
    if(!n.length || !s.length) return null;
    const taken  = mergeSelectionRanges(occupied);
    const covers = (start, end) => taken.some((r) => !(end <= r.start || start >= r.end));
    const searchFrom             = Math.max(0, Math.min(s.length, from | 0));

    const scan = (begin, endLimit) => {
        let i = begin;
        while(i <= endLimit - n.length)
        {
            const at = s.indexOf(n, i);
            if(at < 0 || at > endLimit - n.length) return null;
            const end = at + n.length;
            if(!covers(at, end)) return {start: at, end};
            i = at + 1;
        }
        return null;
    };

    return scan(searchFrom, s.length) || (searchFrom > 0 ? scan(0, searchFrom) : null);
}

/**
 * Merge overlapping [start,end) ranges. Identical ranges are deduped.
 * Adjacent ranges (cur.start === prev.end) stay separate so multi-cursor
 * edits at neighbouring sites are not collapsed into one span.
 * @param {{ start: number, end: number }[]} ranges
 */
export function mergeSelectionRanges(ranges)
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
        // True overlap only — not mere adjacency (needed for multi-cursor edits).
        if(cur.start < prev.end)
            prev.end = Math.max(prev.end, cur.end);
        else
            out.push(cur);
    }
    return out;
}

/** Column of first non-whitespace on a line (Atom home). */
export function firstNonWhitespaceCol(line)
{
    const s = String(line || '');
    let col = 0;
    while(col < s.length && (s[col] === ' ' || s[col] === '\t'))
        col++;
    return col;
}

const UNDO_LIMIT = 100;

const cloneCursorState = (doc) => ({
    cursors: Array.isArray(doc.cursors) ?
        doc.cursors.map((c) => ({anchor: c.anchor | 0, head: c.head | 0, preferredColumn: (typeof c.preferredColumn === 'number') ? c.preferredColumn : null})) :
        [{anchor: doc.caret | 0, head: doc.caret | 0, preferredColumn: null}],
    primaryIndex: doc.primaryIndex | 0,
    // Legacy fields for older snapshots mid-session:
    caret: doc.caret,
    selAnchor: doc.selAnchor,
    extraSelections: Array.isArray(doc.extraSelections) ?
        doc.extraSelections.map((r) => ({
                                    start: r.start,
                                    end: r.end,
                                    ...(typeof r.anchor === 'number' ? {anchor: r.anchor} : {}),
                                    ...(typeof r.head === 'number' ? {head: r.head} : {}),
                                    ...(typeof r.preferredColumn === 'number' ? {preferredColumn: r.preferredColumn} : {})
                                })) :
        []
});

const restoreCursorState = (doc, snap) => {
    if(Array.isArray(snap.cursors) && snap.cursors.length)
    {
        doc.cursors =
            snap.cursors.map((c) => ({anchor: c.anchor | 0, head: c.head | 0, preferredColumn: (typeof c.preferredColumn === 'number') ? c.preferredColumn : null}));
        doc.primaryIndex    = Math.max(0, Math.min(doc.cursors.length - 1, snap.primaryIndex | 0));
        const p             = doc.cursors[doc.primaryIndex];
        doc.caret           = p.head;
        doc.selAnchor       = p.anchor === p.head ? null : p.anchor;
        doc.preferredColumn = p.preferredColumn;
        doc.extraSelections =
            doc.cursors.filter((_, i) => i !== doc.primaryIndex)
                .map(
                    (c) =>
                        ({start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head), anchor: c.anchor, head: c.head, preferredColumn: c.preferredColumn}));
        return;
    }
    // Pre-cursors snapshot
    doc.caret           = snap.caret;
    doc.selAnchor       = snap.selAnchor;
    doc.extraSelections = Array.isArray(snap.extraSelections) ? snap.extraSelections.map((r) => ({...r})) : [];
    doc.cursors         = null;  // ensureCursors will rebuild on next use
};

export function pushUndoSnapshot(doc)
{
    if(!doc) return;
    if(!Array.isArray(doc.undoStack)) doc.undoStack = [];
    if(!Array.isArray(doc.redoStack)) doc.redoStack = [];
    doc.undoStack.push({text: doc.text, ...cloneCursorState(doc)});
    if(doc.undoStack.length > UNDO_LIMIT) doc.undoStack.shift();
    doc.redoStack.length = 0;
}

export function applyUndo(doc)
{
    if(!doc || !doc.undoStack || doc.undoStack.length === 0) return false;
    if(!Array.isArray(doc.redoStack)) doc.redoStack = [];
    doc.redoStack.push({text: doc.text, ...cloneCursorState(doc)});
    const snap = doc.undoStack.pop();
    doc.text   = snap.text;
    restoreCursorState(doc, snap);
    doc.preferredColumn = null;
    return true;
}

export function applyRedo(doc)
{
    if(!doc || !doc.redoStack || doc.redoStack.length === 0) return false;
    if(!Array.isArray(doc.undoStack)) doc.undoStack = [];
    doc.undoStack.push({text: doc.text, ...cloneCursorState(doc)});
    const snap = doc.redoStack.pop();
    doc.text   = snap.text;
    restoreCursorState(doc, snap);
    doc.preferredColumn = null;
    return true;
}
