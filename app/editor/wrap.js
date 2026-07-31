/**
 * Soft word-wrap layout: buffer lines → visual segments.
 * Uses monospace column estimates (charWidth); breaks prefer whitespace.
 */

/**
 * @param {string} line
 * @param {number} maxCols
 * @returns {{ start: number, end: number }[]} UTF-16 column ranges into `line`
 */
export function wrapLineSegments(line, maxCols)
{
    const text  = String(line ?? '');
    const width = Math.max(1, maxCols | 0);
    if(text.length === 0) return [{start: 0, end: 0}];
    if(text.length <= width) return [{start: 0, end: text.length}];

    const segs = [];
    let i      = 0;
    while(i < text.length)
    {
        let end = Math.min(text.length, i + width);
        if(end < text.length)
        {
            let br = -1;
            for(let j = end; j > i; j--)
            {
                const ch = text[j - 1];
                if(ch === ' ' || ch === '\t')
                {
                    br = j;
                    break;
                }
            }
            // Only soft-break if we found whitespace past the segment start.
            if(br > i) end = br;
        }
        if(end <= i) end = Math.min(text.length, i + 1);
        segs.push({start: i, end});
        i = end;
    }
    return segs;
}

/**
 * @param {string[]} lines buffer lines (from splitLines)
 * @param {{
 *   enabled?: boolean,
 *   maxCols?: number,
 *   path?: string,
 *   text?: string
 * }} opts
 * @returns {{
 *   segments: { bufRow: number, startCol: number, endCol: number, text: string }[],
 *   firstVisual: number[],
 *   visualCount: number
 * }}
 */
export function buildWrapLayout(lines, opts = {})
{
    const list    = Array.isArray(lines) ? lines : [''];
    const enabled = opts.enabled !== false;
    const maxCols = Math.max(1, opts.maxCols | 0 || 80);
    /** @type {{ bufRow: number, startCol: number, endCol: number, text: string }[]} */
    const segments = [];
    /** First visual index for each buffer row. */
    const firstVisual = new Array(list.length);

    for(let bufRow = 0; bufRow < list.length; bufRow++)
    {
        const line          = list[bufRow] ?? '';
        firstVisual[bufRow] = segments.length;
        if(!enabled)
        {
            segments.push({bufRow, startCol: 0, endCol: line.length, text: line});
            continue;
        }
        const parts = wrapLineSegments(line, maxCols);
        for(const part of parts)
        {
            segments.push({bufRow, startCol: part.start, endCol: part.end, text: line.slice(part.start, part.end)});
        }
    }

    if(segments.length === 0)
    {
        segments.push({bufRow: 0, startCol: 0, endCol: 0, text: ''});
        if(firstVisual.length === 0) firstVisual.push(0);
    }

    return {segments, firstVisual, visualCount: segments.length};
}

/**
 * Visual row index containing buffer (row, col).
 * At a soft-wrap boundary the same column is both endCol of one segment and
 * startCol of the next. `affinity` chooses which visual row owns the caret:
 *   - 'upstream'   → earlier segment (End)
 *   - 'downstream' → later segment (Home) — after the wrap break
 * @param {{ segments: { bufRow: number, startCol: number, endCol: number }[], firstVisual: number[] }} layout
 * @param {number} bufRow
 * @param {number} col
 * @param {'upstream'|'downstream'|null|undefined} [affinity]
 */
export function visualRowForCaret(layout, bufRow, col, affinity)
{
    if(!layout || !layout.segments.length) return 0;
    const row              = Math.max(0, Math.min(layout.firstVisual.length - 1, bufRow | 0));
    const c                = Math.max(0, col | 0);
    let v                  = layout.firstVisual[row] | 0;
    const preferDownstream = affinity !== 'upstream';

    while(v < layout.segments.length && layout.segments[v].bufRow === row)
    {
        const seg    = layout.segments[v];
        const isLast = v + 1 >= layout.segments.length || layout.segments[v + 1].bufRow !== row;

        if(c < seg.endCol) return v;

        if(c === seg.endCol)
        {
            // Soft-wrap boundary (non-last): end of this visual line == start of next.
            if(!isLast && preferDownstream)
            {
                v += 1;
                continue;
            }
            return v;
        }
        v += 1;
    }
    return Math.max(0, Math.min(layout.segments.length - 1, layout.firstVisual[row] | 0));
}
