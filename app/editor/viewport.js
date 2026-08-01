import {
    applyRedo,
    applyUndo,
    findNextOccurrence,
    firstNonWhitespaceCol,
    indexFromRowCol,
    indexWordLeft,
    indexWordRight,
    pushUndoSnapshot,
    rowColFromIndex,
    sanitizeTextInput,
    splitLines,
    wordRangeAt
} from '/rom/editor/buffer.js';
import {
    addCursor,
    applyCursorsEdit,
    applyMappedCursorsEdit,
    caretHeads,
    clearToPrimary,
    createCursor,
    editRanges as docEditRanges,
    ensureCursors,
    getCursors as readCursors,
    primaryCursor,
    selectionRanges as docSelectionRanges,
    setCursors as writeCursors
} from '/rom/editor/cursors.js';
import {highlight} from '/rom/editor/highlight.js';
import {createModifierTracker, KEY, keyIn} from '/rom/editor/keys.js';
import {editorSettings, expandTabs, indentString} from '/rom/editor/settings.js';
import {buildWrapLayout, visualRowForCaret} from '/rom/editor/wrap.js';
import {theme} from '/rom/theme.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';

const PAD_X        = 8;
const PAD_Y        = 16;
const GUTTER_PAD_L = 4;
const GUTTER_PAD_R = 12;
/** Match left screenshot density (tight leading). */
const LINE_SPACING = 1.0;
/** Gutter digits are smaller than code — nudge down to sit on the code baseline. */
const GUTTER_Y_OFF = 2;
/** libinput / Wayland conventional axis units per mouse-wheel detent. */
const WHEEL_AXIS_STEP = 15;
/** GTK default (`gtk-mouse-wheel-scroll-lines`); also the common desktop expectation. */
const WHEEL_LINES_PER_STEP = 3;
/**
 * Extra slots above/below the visible page. Zero for a tight window; raise
 * when a slide animation wants off-screen lead-in rows.
 */
const OVERSCAN = 0;

/**
 * Multiline editor: pooled row hosts (selection + text) at document Y.
 * Vertical scroll translates the host; only rows entering/leaving the
 * window are rebound — in-view rows (and their selection children) shift
 * with the scroll without recreate or remeasure.
 */
export async function createEditorViewport(win, parent, opts = {})
{
    const onDirty     = typeof opts.onDirty === 'function' ? opts.onDirty : () => {};
    const onStatus    = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
    const onFocus     = typeof opts.onFocus === 'function' ? opts.onFocus : () => {};
    let gutterW       = theme.gutterWidth;
    const gutterTextW = () => Math.max(1, gutterW - GUTTER_PAD_L - GUTTER_PAD_R);

    const frame = await UI.createElement(win, {
        renderable: {type: 'box', colour: theme.bg},
        layout: {type: 'row', gap: 0},
        item: {flexGrow: 1, flexShrink: 1, minHeight: 0},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, parent, frame);

    const gutterClip =
        await UI.createElement(win, {renderable: {type: 'box', colour: theme.bg}, clipToBounds: true, contentPositioning: 'raw', item: {size: {x: gutterW}}});
    await UI.attach(win, frame, gutterClip);

    const gutterHost = await UI.createElement(win, {contentPositioning: 'raw', item: {size: {x: gutterW, y: 1}, position: {x: 0, y: 0}}});
    await UI.attach(win, gutterClip, gutterHost);

    const editorClip = await UI.createElement(
        win, {renderable: {type: 'box', colour: theme.bg}, clipToBounds: true, contentPositioning: 'raw', item: {size: {x: 'auto', y: 'auto'}, flexGrow: 1}});
    await UI.attach(win, frame, editorClip);

    // Vertical scrollbar (track + thumb) — right of the text area.
    const scrollBarW     = theme.scrollbarWidth || 10;
    const scrollBarTrack = await UI.createElement(
        win, {renderable: {type: 'box', colour: theme.bg}, clipToBounds: true, contentPositioning: 'raw', item: {size: {x: scrollBarW}, flexGrow: 0, flexShrink: 0}});
    await UI.attach(win, frame, scrollBarTrack);
    const scrollBarThumb = await UI.createElement(win, {
        renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 1, y: 1}}, colour: theme.scrollbarThumb || [0.66, 0.66, 0.67, 0.52], cornerRadius: 3},
        item: {size: {x: Math.max(4, scrollBarW - 2), y: 48}, position: {x: 1, y: 0}},
        contentAlign: 'fill'
    });
    await UI.attach(win, scrollBarTrack, scrollBarThumb);
    await UI.setEnabled(win, scrollBarThumb, false);

    const scrollHost = await UI.createElement(win, {contentPositioning: 'raw', item: {size: {x: 1, y: 1}, position: {x: 0, y: 0}}});
    await UI.attach(win, editorClip, scrollHost);

    // Active-line band (behind text) + orange left accent (mockup).
    const activeLineBg = await UI.createElement(win, {
        renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 1, y: 1}}, colour: theme.activeLine || theme.panelAlt},
        item: {size: {x: 1, y: 18}, position: {x: 0, y: 0}},
        contentAlign: 'fill'
    });
    await UI.attach(win, scrollHost, activeLineBg);
    await UI.setEnabled(win, activeLineBg, false);

    const activeLineAccent = await UI.createElement(win, {
        renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 2, y: 1}}, colour: theme.primary},
        item: {size: {x: 2, y: 18}, position: {x: 0, y: 0}},
        contentAlign: 'fill'
    });
    await UI.attach(win, scrollHost, activeLineAccent);
    await UI.setEnabled(win, activeLineAccent, false);

    const activeGutterBg = await UI.createElement(win, {
        renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 1, y: 1}}, colour: theme.activeLine || theme.panelAlt},
        item: {size: {x: gutterW, y: 18}, position: {x: 0, y: 0}},
        contentAlign: 'fill'
    });
    await UI.attach(win, gutterHost, activeGutterBg);
    await UI.setEnabled(win, activeGutterBg, false);

    /** @type {number[]} */
    const caretEls = [];

    const makeCaretEl = async (withBlink) => {
        const el = await UI.createElement(win, {
            renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 2, y: 18}}, colour: theme.caret},
            item: {size: {x: 2, y: 18}, position: {x: PAD_X, y: PAD_Y}},
            contentAlign: 'fill'
        });
        await UI.attach(win, scrollHost, el);
        await UI.setEnabled(win, el, false);
        if(withBlink)
        {
            try
            {
                const blink = await UI.addAnimation(
                    win, el,
                    [{time: 0.0, opacity: 1.0}, {time: 0.45, opacity: 0.0, ease: 'inOutQuad'}, {time: 0.90, opacity: 1.0, ease: 'inOutQuad', looping: true}]);
                await UI.startAnimation(win, el, blink);
            } catch(e)
            {
                void e;
            }
        }
        return el;
    };

    // Only the primary caret blinks; extras stay solid so they cannot drift out of phase.
    caretEls.push(await makeCaretEl(true));

    const ensureCaretCount = async (n) => {
        const need = Math.max(1, n | 0);
        while(caretEls.length < need)
            caretEls.push(await makeCaretEl(false));
    };

    // Decorative minimap overlay (non-interactive); hidden until a file is open.
    // Mockup: 96×256, surface-container @30%, 4px bars @~20%, viewport band overlay.
    const minimapW = theme.minimapWidth || 96;
    const minimapH = 256;
    const minimapY = 36;
    const minimap  = await UI.createElement(win, {
        renderable: {type: 'box', colour: [...(theme.panelAlt || theme.panel).slice(0, 3), 0.3], cornerRadius: 2},
        layout: {type: 'column', gap: 4, padding: {l: 4, r: 4, t: 4, b: 4}},
        item: {size: {x: minimapW, y: minimapH}, position: {x: 0, y: minimapY}},
        contentAlign: 'fill',
        clipToBounds: true
    });
    await UI.attach(win, editorClip, minimap);
    for(const frac of [0.5, 0.75, 0.33, 0.67, 1.0, 0.8])
    {
        const bar = await UI.createElement(win, {
            renderable: {type: 'box', colour: Math.abs(frac - 0.67) < 0.02 ? [...theme.primary.slice(0, 3), 0.25] : [...theme.textDim.slice(0, 3), 0.2]},
            item: {size: {x: Math.max(8, Math.floor((minimapW - 8) * frac)), y: 4}}
        });
        await UI.attach(win, minimap, bar);
    }
    // Viewport indicator band (mockup: white/5 strip a third of the way down).
    const minimapBand =
        await UI.createElement(win, {renderable: {type: 'box', colour: [1, 1, 1, 0.05]}, item: {size: {x: minimapW, y: 48}, position: {x: 0, y: minimapY + 48}}});
    await UI.attach(win, editorClip, minimapBand);
    await Promise.all([UI.setEnabled(win, minimap, false), UI.setEnabled(win, minimapBand, false)]);

    /**
     * @type {Array<{ id: number, host: number, sel: number, text: string, width: number, row: number, areaIds: number[], rowHlEpoch: number, selOn: boolean, selKey:
     *     string }>}
     */
    const lineEls = [];
    /** @type {Array<{ id: number, text: string, row: number, width: number }>} */
    const gutterEls = [];

    let doc           = null;
    let focused       = true;
    let renderPending = false;
    let renderDirty   = false;
    /** Serialise all slot-pool mutations (render / syncLayout). */
    let paintLock       = Promise.resolve();
    const withPaintLock = (fn) => {
        const run = paintLock.then(fn, fn);
        paintLock = run.then(() => {}, () => {});
        return run;
    };
    /**
     * When false, paint keeps scrollY (wheel / drag-select). Stays false across
     * highlight/layout re-paints until caret navigates or the buffer is edited —
     * do not flip true at the end of every render or a dirty re-paint snaps back.
     */
    let followCaret    = true;
    let lineAdvance    = Math.ceil(theme.fontSizeCode * 1.2);
    let charWidth      = Math.ceil(theme.fontSizeCode * 0.6);
    let metricsReady   = false;
    let viewportWidth  = 1;
    let viewportHeight = 1;
    let localClipboard = '';
    let lastColourKey  = '';
    let lastStatus     = '';
    let lastHostW      = -1;
    let lastHostH      = -1;
    /** Cached highlight: base colour + per-line colour runs (line-local code points). */
    let hlCache = {
        source: null,
        /** Last text that was fully tree-sitter lexed (null until first successful run). */
        lexedSource: null,
        path: null,
        colour: null,
        spans: [],
        lineRuns: [],
        version: 0
    };
    /**
     * Line index cache — avoid text.split('\\n') / full run rebuilds on each key.
     * utf16Starts[i] / cpStarts[i] = document offset of lines[i][0].
     */
    let lineCache = {path: null, text: null, lines: null, utf16Starts: null, cpStarts: null};
    /**
     * Soft-wrap layout cache. Visual rows are what the viewport scrolls/paints;
     * buffer rows stay the source of truth for edits and highlights.
     */
    let wrapCache = {key: '', layout: null, text: null, path: null};
    /** Monotonic token so stale highlight jobs cannot clobber a newer doc. */
    let hlJobToken = 0;
    /** Coalesce full-file re-lex while typing. */
    let hlTimer    = null;
    let hlPending  = null;
    let hlInFlight = false;
    /** Typing settle time before kicking tree-sitter (ms). */
    const HL_DEBOUNCE_MS = 120;
    /** Coalesce undo snapshots while typing continuously on one line. */
    let undoCoalesce = null;
    /** First document row in the visible window (scroll-aligned). */
    let firstVisibleRow = 0;
    const mods          = createModifierTracker();

    /** Unicode code-point length. Fast path for typical source (no surrogates). */
    const codePointLength = (str) => {
        const s = String(str || '');
        for(let i = 0; i < s.length; i++)
        {
            const c = s.charCodeAt(i);
            if(c >= 0xd800 && c <= 0xdfff)
            {
                let n = 0;
                for(const _ of s)
                    n++;
                return n;
            }
        }
        return s.length;
    };

    /** Convert a UTF-16 index into a Unicode code-point offset. */
    const utf16ToCodePoint = (str, utf16Index) => {
        const s     = String(str || '');
        const limit = Math.max(0, Math.min(s.length, utf16Index | 0));
        let cp      = 0;
        let i       = 0;
        while(i < limit)
        {
            const code  = s.codePointAt(i);
            i          += code > 0xffff ? 2 : 1;
            cp++;
        }
        return cp;
    };

    /** Code-point offset of the start of each line (matching tree-sitter / colour-area indexing). */
    const lineStartCodePoints = (lines) => {
        const starts = new Array(lines.length);
        let acc      = 0;
        for(let i = 0; i < lines.length; i++)
        {
            starts[i]  = acc;
            acc       += codePointLength(lines[i]);
            if(i < lines.length - 1) acc += 1;
        }
        return starts;
    };

    const lineStartUtf16 = (lines) => {
        const starts = new Array(lines.length);
        let acc      = 0;
        for(let i = 0; i < lines.length; i++)
        {
            starts[i]  = acc;
            acc       += lines[i].length;
            if(i < lines.length - 1) acc += 1;
        }
        return starts;
    };

    const rebuildLineCache = (text, path) => {
        const lines = splitLines(text);
        lineCache   = {path, text, lines, utf16Starts: lineStartUtf16(lines), cpStarts: lineStartCodePoints(lines)};
        wrapCache   = {key: '', layout: null, text: null, path: null};
        return lines;
    };

    /** Lines for the active doc — O(1) when the cache matches. */
    const getDocLines = () => {
        if(!doc) return [''];
        if(lineCache.path === doc.path && lineCache.text === doc.text && lineCache.lines) return lineCache.lines;
        return rebuildLineCache(doc.text, doc.path);
    };

    /**
     * Soft-wrap helpers. Visual rows are what the viewport scrolls/paints;
     * buffer rows stay the source of truth for edits and highlights.
     */
    const wrapEnabled = () => editorSettings.wordWrap !== false;

    /** Columns that fit in the text clip (monospace estimate). */
    const wrapMaxCols = () => {
        const usable = Math.max(1, viewportWidth - PAD_X * 2);
        return Math.max(1, Math.floor(usable / Math.max(1, charWidth)));
    };

    const getWrapLayout = (lines) => {
        const list    = Array.isArray(lines) ? lines : getDocLines();
        const enabled = wrapEnabled();
        const maxCols = enabled ? wrapMaxCols() : 0;
        const key     = `${doc ? doc.path : ''}\0${doc ? doc.text.length : 0}\0${enabled ? 1 : 0}\0${maxCols}\0${list.length}`;
        if(wrapCache.key === key && wrapCache.layout && wrapCache.text === (doc ? doc.text : null) && wrapCache.path === (doc ? doc.path : null))
            return wrapCache.layout;
        const layout = buildWrapLayout(list, {enabled, maxCols});
        wrapCache    = {key, layout, text: doc ? doc.text : null, path: doc ? doc.path : null};
        return layout;
    };

    const invalidateWrap = () => { wrapCache = {key: '', layout: null, text: null, path: null}; };

    /** Clip highlight runs (code-point offsets on full line) into a wrap slice. */
    const sliceLineRuns = (runs, line, startCol, endCol) => {
        if(!Array.isArray(runs) || runs.length === 0) return [];
        const cp0 = utf16ToCodePoint(line, startCol);
        const cp1 = utf16ToCodePoint(line, endCol);
        if(cp1 <= cp0) return [];
        const out = [];
        for(let i = 0; i < runs.length; i++)
        {
            const run = runs[i];
            if(!run || run.end <= run.start) continue;
            const s = Math.max(run.start | 0, cp0);
            const e = Math.min(run.end | 0, cp1);
            if(e <= s) continue;
            out.push({start: s - cp0, end: e - cp0, colour: run.colour});
        }
        return out;
    };

    /** Binary search: row whose utf16 start is <= index. */
    const rowAtUtf16 = (utf16Starts, index) => {
        const starts = utf16Starts || [];
        if(starts.length === 0) return 0;
        let lo  = 0;
        let hi  = starts.length - 1;
        const i = Math.max(0, index | 0);
        while(lo < hi)
        {
            const mid = (lo + hi + 1) >> 1;
            if(starts[mid] <= i)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo;
    };

    const rowColFromCache = (utf16Index) => {
        if(!lineCache.utf16Starts || !lineCache.lines) return rowColFromIndex(doc ? doc.text : '', utf16Index);
        const row = rowAtUtf16(lineCache.utf16Starts, utf16Index);
        return {row, col: Math.max(0, (utf16Index | 0) - lineCache.utf16Starts[row])};
    };

    /** Patch one line's colour runs after a same-line edit (local code-point cols). */
    const patchLineRuns = (runs, localCpStart, localCpEnd, insertCp) => {
        const delta = insertCp - (localCpEnd - localCpStart);
        const prev  = runs || [];
        if(delta === 0 && localCpStart === localCpEnd) return prev;
        const next = [];
        for(let i = 0; i < prev.length; i++)
        {
            const run = prev[i];
            if(!run || run.end <= run.start) continue;
            if(run.end <= localCpStart)
                next.push(run);
            else if(run.start >= localCpEnd)
                next.push({start: run.start + delta, end: run.end + delta, colour: run.colour});
            else
            {
                if(run.start < localCpStart) next.push({start: run.start, end: localCpStart, colour: run.colour});
                if(run.end > localCpEnd) next.push({start: localCpEnd + delta, end: run.end + delta, colour: run.colour});
            }
        }
        return next;
    };

    /**
     * Merge spans into lineRuns for [fromRow, toRow).
     * Only replaces a row (and reports it) when the painted runs would change —
     * clearing-then-filling every chunk was flashing unchanged lines while typing.
     * @returns {number[]} rows that changed
     */
    const applySpansToLineRuns = (runs, lines, spans, fromRow, toRow, starts, lens) => {
        const lineCount = lines.length;
        const start     = Math.max(0, fromRow | 0);
        const end       = Math.min(lineCount, toRow | 0);
        const changed   = [];
        if(end <= start) return changed;

        const next = Array.from({length: end - start}, () => []);
        if(spans && spans.length)
        {
            const cpStarts = starts || lineStartCodePoints(lines);
            const cpLens   = lens || lines.map((line) => codePointLength(line));
            let row        = start;
            for(const span of spans)
            {
                if(!span || !span.colour || span.end <= span.start) continue;
                while(row + 1 < lineCount && cpStarts[row + 1] <= span.start)
                    row++;
                let r = Math.max(row, start);
                while(r < end && cpStarts[r] < span.end)
                {
                    const lineStart  = cpStarts[r];
                    const lineLen    = cpLens[r];
                    const localStart = Math.max(0, span.start - lineStart);
                    const localEnd   = Math.min(lineLen, span.end - lineStart);
                    if(localEnd > localStart) next[r - start].push({start: localStart, end: localEnd, colour: span.colour});
                    r++;
                }
            }
        }

        for(let r = start; r < end; r++)
        {
            const runsForRow = next[r - start];
            if(lineRunsEqual(runs[r], runsForRow)) continue;
            runs[r] = runsForRow;
            changed.push(r);
        }
        return changed;
    };

    /**
     * Slice buffer spans into per-line runs once on content change.
     * Scroll only indexes lineRuns[row] — no span walk on the hot path.
     */
    const buildLineRuns = (lines, spans) => {
        const lineCount = lines.length;
        const runs      = Array.from({length: lineCount}, () => []);
        const starts    = lineStartCodePoints(lines);
        const lens      = lines.map((line) => codePointLength(line));
        applySpansToLineRuns(runs, lines, spans, 0, lineCount, starts, lens);
        return runs;
    };

    /** Per-row paint generation — streaming chunks only dirty affected rows. */
    let rowHlEpoch     = [];
    const bumpRowEpoch = (fromRow, toRow) => {
        const end = Math.max(fromRow, toRow);
        while(rowHlEpoch.length < end)
            rowHlEpoch.push(0);
        for(let r = fromRow; r < toRow; r++)
            rowHlEpoch[r] = (rowHlEpoch[r] | 0) + 1;
    };

    const bumpRowEpochOne = (row) => {
        const r = row | 0;
        if(r < 0) return;
        while(rowHlEpoch.length <= r)
            rowHlEpoch.push(0);
        rowHlEpoch[r] = (rowHlEpoch[r] | 0) + 1;
    };

    /** True when two per-line colour-run lists paint identically. */
    const lineRunsEqual = (a, b) => {
        const aa = a || [];
        const bb = b || [];
        if(aa.length !== bb.length) return false;
        for(let i = 0; i < aa.length; i++)
        {
            const x = aa[i];
            const y = bb[i];
            if(!x || !y || x.start !== y.start || x.end !== y.end) return false;
            const xc = x.colour;
            const yc = y.colour;
            if(xc === yc) continue;
            if(!xc || !yc || xc.length !== yc.length) return false;
            for(let c = 0; c < xc.length; c++)
                if(xc[c] !== yc[c]) return false;
        }
        return true;
    };

    /** Bump epochs only for rows whose runs actually changed (avoids colour flicker). */
    const bumpRowsWhereRunsDiffer = (prevRuns, nextRuns) => {
        const n = Math.max(prevRuns?.length || 0, nextRuns?.length || 0);
        for(let r = 0; r < n; r++)
        {
            if(!lineRunsEqual(prevRuns?.[r], nextRuns?.[r])) bumpRowEpochOne(r);
        }
    };

    /**
     * Line chrome marks (e.g. git diff). source → Map(row → type).
     * Types: added | modified | deleted.
     */
    /** @type {Map<string, Map<number, string>>} */
    const lineMarksBySource = new Map();
    let lineMarkEpoch       = 0;
    const markColour = (type) => {
        if(type === 'added') return theme.diffAdded || [0.3, 0.7, 0.35, 1];
        if(type === 'deleted') return theme.diffDeleted || [0.9, 0.4, 0.4, 1];
        if(type === 'modified') return theme.diffModified || theme.primary;
        return null;
    };
    const markTypeForRow = (row) => {
        let best     = null;
        let bestRank = -1;
        for(const [source, map] of lineMarksBySource)
        {
            const t = map.get(row);
            if(!t) continue;
            // Unsaved buffer marks win over git on the same row; git still shows elsewhere.
            const srcRank  = source === 'editor.unsaved' ? 2 : 1;
            const typeRank = t === 'modified' ? 3 : t === 'deleted' ? 2 : 1;
            const rank     = srcRank * 10 + typeRank;
            if(rank > bestRank)
            {
                best     = t;
                bestRank = rank;
            }
        }
        return best;
    };
    const setLineMarks = (source, marks) => {
        const key = String(source || 'default');
        const map = new Map();
        if(Array.isArray(marks))
        {
            for(const m of marks)
            {
                if(!m || typeof m.row !== 'number') continue;
                const type = String(m.type || '');
                if(type !== 'added' && type !== 'modified' && type !== 'deleted') continue;
                map.set(m.row | 0, type);
            }
        }
        lineMarksBySource.set(key, map);
        lineMarkEpoch++;
        queueRender();
    };
    const clearLineMarks = (source) => {
        const key = String(source || 'default');
        if(!lineMarksBySource.has(key)) return;
        lineMarksBySource.delete(key);
        lineMarkEpoch++;
        queueRender();
    };

    const settled = (promise) => promise.then((value) => ({ok: true, value}), (error) => ({ok: false, error}));

    /** Remove colour areas from a pooled text node (retained mode — ids must match engine). */
    const clearEntryColourAreas = (entry) => {
        if(!entry) return Promise.resolve();
        const ids     = entry.areaIds || [];
        entry.areaIds = [];
        if(ids.length === 0) return Promise.resolve();
        return Promise.all(ids.map((id) => settled(UI.deleteColourArea(win, entry.id, id))));
    };

    const clearAllLineColourAreas = () => Promise.all(lineEls.map((e) => clearEntryColourAreas(e)));

    /**
     * Shift/trim cached spans after a text replace so colours stay usable until
     * the debounced tree-sitter pass corrects them.
     * beforeText / utf16 range are taken from the document *before* the edit.
     * Single-line edits patch one row only — no full-file split or run rebuild.
     *
     * IMPORTANT: This models a *single* contiguous replace. Multi-cursor edits
     * must call noteMultiHighlightEdit / rebuild instead — otherwise lineCache
     * claims to match doc.text while its lines only reflect one site, and the
     * display + caret geometry diverge (carets paint in the wrong places).
     */
    const noteHighlightEdit = (beforeText, utf16Start, utf16End, inserted) => {
        if(!doc) return;
        const start     = Math.max(0, Math.min(utf16Start, utf16End));
        const end       = Math.max(start, Math.max(utf16Start, utf16End));
        const ins       = String(inserted || '');
        const deleted   = beforeText.slice(start, end);
        const insertCp  = codePointLength(ins);
        const multiLine = deleted.includes('\n') || ins.includes('\n');

        // Ensure line cache matches pre-edit text so we can locate the row cheaply.
        if(lineCache.path !== doc.path || lineCache.text !== beforeText || !lineCache.lines) rebuildLineCache(beforeText, doc.path);

        let cpStart;
        let cpEnd;
        let editRow      = -1;
        let localCpStart = 0;
        let localCpEnd   = 0;

        if(!multiLine && lineCache.utf16Starts && lineCache.cpStarts)
        {
            editRow        = rowAtUtf16(lineCache.utf16Starts, start);
            const lineUtf0 = lineCache.utf16Starts[editRow];
            const oldLine  = lineCache.lines[editRow] || '';
            const colStart = start - lineUtf0;
            const colEnd   = end - lineUtf0;
            localCpStart   = utf16ToCodePoint(oldLine, colStart);
            localCpEnd     = utf16ToCodePoint(oldLine, colEnd);
            cpStart        = lineCache.cpStarts[editRow] + localCpStart;
            cpEnd          = lineCache.cpStarts[editRow] + localCpEnd;
        } else
        {
            cpStart = utf16ToCodePoint(beforeText, start);
            cpEnd   = utf16ToCodePoint(beforeText, end);
        }
        const delta = insertCp - (cpEnd - cpStart);

        // Mutate span offsets in place — rebuilding a 50k+ span array per key was a
        // major GC / alloc cost on large files. Display uses patched lineRuns.
        const spans = hlCache.spans || [];
        for(let i = 0; i < spans.length; i++)
        {
            const span = spans[i];
            if(!span || span.end <= span.start) continue;
            if(span.end <= cpStart) continue;
            if(span.start >= cpEnd)
            {
                span.start += delta;
                span.end   += delta;
            } else
                span.end = Math.max(span.start, span.end + delta);
        }

        if(!multiLine && editRow >= 0 && lineCache.lines)
        {
            const row        = editRow;
            const lineUtf0   = lineCache.utf16Starts[row];
            const oldLine    = lineCache.lines[row] || '';
            const colStart   = start - lineUtf0;
            const colEnd     = end - lineUtf0;
            const newLine    = oldLine.slice(0, colStart) + ins + oldLine.slice(colEnd);
            const trialLines = lineCache.lines.slice();
            trialLines[row]  = newLine;
            // Refuse to publish a cache that does not match the real document
            // (multi-cursor / overlapping edits land here).
            if(trialLines.join('\n') !== doc.text)
            {
                rebuildAfterMultiEdit(spans);
                return;
            }
            lineCache.lines[row] = newLine;
            lineCache.text       = doc.text;
            const utfDelta       = ins.length - (end - start);
            for(let r = row + 1; r < lineCache.utf16Starts.length; r++)
                lineCache.utf16Starts[r] += utfDelta;
            for(let r = row + 1; r < lineCache.cpStarts.length; r++)
                lineCache.cpStarts[r] += delta;

            let lineRuns = hlCache.lineRuns;
            if(!Array.isArray(lineRuns) || lineRuns.length !== lineCache.lines.length)
                lineRuns = Array.from({length: lineCache.lines.length}, () => []);
            else if(lineRuns === hlCache.lineRuns)
                lineRuns = lineRuns.slice();

            const nextRowRuns = patchLineRuns(hlCache.lineRuns?.[row], localCpStart, localCpEnd, insertCp);
            const prevRowRuns = hlCache.lineRuns?.[row];
            lineRuns[row]     = nextRowRuns;
            hlCache           = {
                source: doc.text,
                lexedSource: hlCache.lexedSource,
                path: doc.path,
                colour: hlCache.colour || theme.code || theme.text,
                spans,
                lineRuns,
                version: (hlCache.version | 0) + 1
            };
            if(!lineRunsEqual(prevRowRuns, nextRowRuns)) bumpRowEpochOne(row);
            scheduleHighlight(doc.text, doc.path, doc.language);
            return;
        }

        // Multi-line (or cache miss): full line rebuild + run rebuild.
        rebuildAfterMultiEdit(spans);
    };

    const rebuildAfterMultiEdit = (spans = hlCache.spans || []) => {
        if(!doc) return;
        const lines = rebuildLineCache(doc.text, doc.path);
        invalidateWrap();
        const prevRuns = hlCache.lineRuns || [];
        const lineRuns = buildLineRuns(lines, spans);
        hlCache        = {
            source: doc.text,
            lexedSource: null,
            path: doc.path,
            colour: hlCache.colour || theme.code || theme.text,
            spans,
            lineRuns,
            version: (hlCache.version | 0) + 1
        };
        bumpRowEpoch(0, lines.length);
        scheduleHighlight(doc.text, doc.path, doc.language);
    };

    /** Post-edit highlight bookkeeping — safe for one or many replace sites. */
    const noteEditSites = (beforeText, list, inserted) => {
        if(!doc || !list || !list.length) return;
        if(list.length === 1)
        {
            noteHighlightEdit(beforeText, list[0].start, list[0].end, inserted);
            return;
        }
        // Multi-cursor: skip the single-site line patch; rebuild from doc.text.
        rebuildAfterMultiEdit(hlCache.spans || []);
    };

    /**
     * Debounced highlight. Native parse runs once; query results stream back in
     * line blocks so visible rows colour before the rest of the file finishes.
     */
    const runHighlightJob = (text, path, language) => {
        if(hlCache.lexedSource === text && hlCache.path === path) return;
        hlInFlight          = true;
        const token         = ++hlJobToken;
        const lines         = splitLines(text);
        const lineStarts    = lineStartCodePoints(lines);
        const lineLens      = lines.map((line) => codePointLength(line));
        const preferFromRow = Math.max(0, firstVisibleRow);
        const preferToRow   = preferFromRow + Math.max(24, viewLineCount() + OVERSCAN * 2);
        // Highlight prefers buffer rows covering the visible visual window.
        let hlFrom = preferFromRow;
        let hlTo   = preferToRow;
        if(doc && wrapEnabled())
        {
            const layout = getWrapLayout(getDocLines());
            const a      = layout.segments[Math.min(preferFromRow, layout.visualCount - 1)];
            const b      = layout.segments[Math.min(preferToRow, layout.visualCount) - 1] || layout.segments[layout.visualCount - 1];
            if(a && b)
            {
                hlFrom = a.bufRow;
                hlTo   = b.bufRow + 1;
            }
        }

        // Never reuse another file's runs — leftover colour areas become noise.
        const sameDoc  = hlCache.path === path && Array.isArray(hlCache.lineRuns) && hlCache.lineRuns.length === lines.length;
        const lineRuns = sameDoc ? hlCache.lineRuns : Array.from({length: lines.length}, () => []);
        /** Spans kept for edit-shift; filled as chunks arrive (not rebuilt at resolve). */
        const collected       = [];
        let chunkRenderQueued = false;
        hlCache               = {
            source: text,
            lexedSource: null,
            path,
            colour: theme.code || theme.text,
            // Keep provisional spans for mid-flight edits; replaced when streaming finishes.
            spans: sameDoc ? (hlCache.spans || []) : [],
            lineRuns,
            version: (hlCache.version | 0) + 1
        };
        if(!sameDoc)
        {
            // Invalidate row paints; colour areas were already dropped in setDocument.
            bumpRowEpoch(0, lines.length);
        }

        const queueChunkRender = () => {
            if(chunkRenderQueued) return;
            chunkRenderQueued = true;
            setTimeout(() => {
                chunkRenderQueued = false;
                if(token !== hlJobToken) return;
                queueRender();
            }, 0);
        };

        const applyEmptyHighlight = () => {
            hlCache = {
                source: text,
                lexedSource: text,
                path,
                colour: theme.code || theme.text,
                spans: [],
                lineRuns: Array.from({length: lines.length}, () => []),
                version: (hlCache.version | 0) + 1
            };
            bumpRowEpoch(0, lines.length);
            void clearAllLineColourAreas().then(() => {
                if(token === hlJobToken) queueRender();
            });
        };

        const onChunk = (chunk) => {
            if(token !== hlJobToken) return;
            if(!doc || doc.text !== text || doc.path !== path) return;
            if(chunk.done)
            {
                hlCache.lexedSource = text;
                hlCache.spans       = collected;
                hlCache.lineRuns    = lineRuns;
                // Unsupported / empty grammar: streaming may only send done.
                if(collected.length === 0)
                    applyEmptyHighlight();
                else
                    queueChunkRender();
                return;
            }
            const fromRow = chunk.fromRow | 0;
            const toRow   = chunk.toRow | 0;
            const spans   = Array.isArray(chunk.spans) ? chunk.spans : [];
            for(let i = 0; i < spans.length; i++)
                collected.push(spans[i]);
            const changedRows = applySpansToLineRuns(lineRuns, lines, spans, fromRow, toRow, lineStarts, lineLens);
            hlCache.lineRuns  = lineRuns;
            // Defer assigning full spans until done — avoids O(chunks) array churn mid-stream.
            hlCache.colour = theme.code || theme.text;
            if(changedRows.length === 0) return;
            for(let i = 0; i < changedRows.length; i++)
                bumpRowEpochOne(changedRows[i]);
            queueChunkRender();
        };

        highlight(text, {path, language, onChunk, preferFromRow: hlFrom, preferToRow: hlTo, chunkLines: 128})
            .then((hl) => {
                if(token !== hlJobToken) return;
                if(!doc || doc.text !== text || doc.path !== path) return;
                const spans = Array.isArray(hl.spans) ? hl.spans : [];
                if(spans.length === 0 && collected.length === 0)
                {
                    applyEmptyHighlight();
                    return;
                }
                // Final aggregate — only needed if streaming was unavailable.
                if(hlCache.lexedSource !== text)
                {
                    const finalSpans = spans.length ? spans : collected;
                    hlCache          = {
                        source: text,
                        lexedSource: text,
                        path,
                        colour: hl.textColour || theme.code || theme.text,
                        spans: finalSpans,
                        lineRuns: buildLineRuns(lines, finalSpans),
                        version: (hlCache.version | 0) + 1
                    };
                    bumpRowEpoch(0, lines.length);
                    queueRender();
                } else
                {
                    if(hl.textColour) hlCache.colour = hl.textColour;
                    hlCache.spans = collected.length ? collected : spans;
                    // Chunks already painted rows whose runs changed — don't re-bump the
                    // visible window (that was flashing unchanged lines after each re-lex).
                }
            })
            .catch(() => {
                if(token !== hlJobToken) return;
                applyEmptyHighlight();
            })
            .finally(() => {
                // Only the active job may clear the in-flight flag (setDocument may
                // have started a newer token while this promise was still settling).
                if(token === hlJobToken) hlInFlight = false;
                if(token === hlJobToken && hlPending)
                {
                    const next = hlPending;
                    hlPending  = null;
                    if(!(hlCache.lexedSource === next.text && hlCache.path === next.path)) runHighlightJob(next.text, next.path, next.language);
                }
            });
    };

    const scheduleHighlight = (text, path, language) => {
        if(hlCache.lexedSource === text && hlCache.path === path) return;
        hlPending = {text, path, language};
        if(hlTimer) clearTimeout(hlTimer);
        // First paint for a file: run ASAP. While typing: debounce.
        const delay = (hlCache.path === path && hlCache.lexedSource != null) ? HL_DEBOUNCE_MS : 0;
        hlTimer     = setTimeout(() => {
            hlTimer   = null;
            const job = hlPending;
            if(!job) return;
            if(hlInFlight)
            {
                // Keep hlPending; active job's finally will pick it up. Re-arm in case
                // the in-flight job was orphaned by setDocument clearing the flag early.
                hlTimer = setTimeout(() => {
                    hlTimer = null;
                    if(hlInFlight || !hlPending) return;
                    const again = hlPending;
                    hlPending   = null;
                    runHighlightJob(again.text, again.path, again.language);
                }, HL_DEBOUNCE_MS);
                return;
            }
            hlPending = null;
            runHighlightJob(job.text, job.path, job.language);
        }, delay);
    };

    /**
     * Viewport-batched slot colouring.
     * When the text string is changing, setTextString MUST run before addColourArea —
     * otherwise areas are indexed into the placeholder/'old' string, fail, and the
     * row epoch is already advanced so colours stay missing until a scroll rebind.
     * Same-text span refresh keeps the anti-flash order (add → text colour → delete).
     */
    const paintDirtySlots = async (dirty) => {
        if(dirty.length === 0) return;

        for(const slot of dirty)
        {
            slot.prev   = slot.entry.areaIds ? slot.entry.areaIds.slice() : [];
            slot.newIds = [];
        }

        const textFirst = dirty.some((slot) => !!slot.textOp);
        if(textFirst)
        {
            const textOps = [];
            for(const slot of dirty)
            {
                if(slot.textOp) textOps.push(slot.textOp);
            }
            if(textOps.length) await Promise.all(textOps.map((p) => settled(p)));

            const deleteOps = [];
            for(const slot of dirty)
            {
                for(const id of slot.prev)
                    deleteOps.push(settled(UI.deleteColourArea(win, slot.entry.id, id)));
                slot.entry.areaIds = [];
            }
            if(deleteOps.length) await Promise.all(deleteOps);
            for(const slot of dirty)
                slot.prev = [];
        }

        const addOps = [];
        for(const slot of dirty)
        {
            const runs = slot.runs || [];
            for(let i = 0; i < runs.length; i++)
            {
                const run = runs[i];
                addOps.push({slot, promise: UI.addColourArea(win, slot.entry.id, run.start, run.end, run.colour)});
            }
        }

        if(addOps.length)
        {
            const results = await Promise.all(addOps.map((op) => settled(op.promise)));
            for(let i = 0; i < addOps.length; i++)
            {
                const result = results[i];
                if(result && result.ok && result.value) addOps[i].slot.newIds.push(result.value);
            }
        }

        if(!textFirst)
        {
            for(const slot of dirty)
                slot.entry.areaIds = slot.newIds.concat(slot.prev);

            const textOps = [];
            for(const slot of dirty)
            {
                if(slot.textOp) textOps.push(slot.textOp);
            }
            if(textOps.length) await Promise.all(textOps.map((p) => settled(p)));
        }

        for(const slot of dirty)
            slot.entry.areaIds = slot.newIds;

        if(!textFirst)
        {
            const deleteOps = [];
            for(const slot of dirty)
            {
                for(const id of slot.prev)
                    deleteOps.push(settled(UI.deleteColourArea(win, slot.entry.id, id)));
            }
            if(deleteOps.length) await Promise.all(deleteOps);
        }

        for(const slot of dirty)
        {
            if(typeof slot.rowEpoch !== 'number') continue;
            const painted  = slot.runs || [];
            const gotAreas = (slot.newIds || []).length > 0;
            // Highlight still running: empty paint must not consume the epoch or a
            // later chunk arrives with matching epoch and skips colouring (first open).
            const hlDone = !doc || (hlCache.lexedSource === doc.text && hlCache.path === doc.path);
            if(painted.length > 0 && !gotAreas && !hlDone) continue;
            if(painted.length === 0 && !hlDone && !gotAreas) continue;
            slot.entry.rowHlEpoch = slot.rowEpoch;
        }
    };

    const frameSize = (frame) => {
        const minX = frame?.min?.x;
        const minY = frame?.min?.y;
        const maxX = frame?.max?.x;
        const maxY = frame?.max?.y;
        if([minX, minY, maxX, maxY].some((v) => typeof v !== 'number')) return {x: 0, y: 0};
        return {x: Math.max(0, maxX - minX), y: Math.max(0, maxY - minY)};
    };

    const syncViewportFromLayout = async () => {
        const clip = await UI.getElementFrame(win, editorClip);
        const size = frameSize(clip);
        if(size.x < 1 && size.y < 1) return false;
        // Clamp to sane bounds — a bad frame must not spawn thousands of text nodes.
        const nextW    = Math.max(1, Math.min(8192, Math.floor(size.x)));
        const nextH    = Math.max(1, Math.min(8192, Math.floor(size.y)));
        const changed  = nextW !== viewportWidth || nextH !== viewportHeight;
        viewportWidth  = nextW;
        viewportHeight = nextH;
        if(changed) invalidateWrap();
        // Pin decorative minimap to the top-right of the editor clip.
        const mx = Math.max(0, nextW - minimapW - 24);
        await Promise.all([UI.setLayoutPosition(win, minimap, {x: mx, y: minimapY}), UI.setLayoutPosition(win, minimapBand, {x: mx, y: minimapY + 48})]);
        return changed;
    };

    /** Visible rows only; hard-capped so layout glitches cannot flood the UI. */
    const MAX_VIEW_LINES = 256;
    const viewLineCount = () => {
        // Top pad + one lineAdvance per row; don't count rows that sit past the clip.
        const usable = Math.max(1, viewportHeight - PAD_Y);
        return Math.max(1, Math.min(MAX_VIEW_LINES, Math.floor(usable / Math.max(1, lineAdvance))));
    };
    const slotCount = () => viewLineCount() + OVERSCAN * 2;

    /** Map document scrollY ↔ first visible row (line-aligned). */
    const rowFromScrollY = () => Math.max(0, Math.round((doc?.scrollY || 0) / Math.max(1, lineAdvance)));
    const scrollYFromRow = (row) => Math.max(0, row) * Math.max(1, lineAdvance);

    const markDirty = () => {
        if(!doc) return;
        // First edit pins a preview tab (VS Code).
        if(doc.preview) doc.preview = false;
        if(typeof doc.savedText === 'string' && doc.text === doc.savedText)
            doc.dirty = false;
        else
            doc.dirty = true;
        // Every content change — plugins (gutter marks) need more than clean→dirty.
        onDirty(doc);
    };

    const selectionRange = () => {
        if(!doc) return null;
        ensureCursors(doc);
        const p = primaryCursor(doc);
        if(p.anchor === p.head) return null;
        return {start: Math.min(p.anchor, p.head), end: Math.max(p.anchor, p.head)};
    };

    const clearExtraSelections = () => {
        if(!doc) return;
        clearToPrimary(doc);
    };

    const clampIndex = (i) => {
        if(!doc) return 0;
        return Math.max(0, Math.min(doc.text.length, i | 0));
    };

    const getCursors = () => (doc ? readCursors(doc) : []);

    /**
     * Sole cursor writer for the viewport. Preserves primaryIndex unless overridden.
     * @param {import('/rom/editor/cursors.js').Cursor[]|{anchor:number,head:number,preferredColumn?:number|null}[]} cursors
     * @param {string|null} [affinity]
     * @param {number} [primaryIndex]
     */
    const setCursors = (cursors, affinity = null, primaryIndex = undefined) => {
        if(!doc) return;
        const opts = {affinity};
        if(typeof primaryIndex === 'number')
            opts.primaryIndex = primaryIndex;
        else if(typeof doc.primaryIndex === 'number')
            opts.primaryIndex = doc.primaryIndex;
        writeCursors(doc, cursors, opts);
        followCaret = true;
    };

    const transformCursors = (fn, affinity = null) => {
        if(!doc) return;
        ensureCursors(doc);
        const pi = doc.primaryIndex;
        setCursors(getCursors().map(fn), affinity, pi);
    };

    /** Keep current primary and start a new primary at `next` (Ctrl multi-cursor). */
    const commitPrimaryAndFocus = (next) => {
        if(!doc) return;
        ensureCursors(doc);
        addCursor(doc, next);
        followCaret = true;
    };

    const selectionRanges = () => (doc ? docSelectionRanges(doc) : []);
    const editRanges = () => (doc ? docEditRanges(doc) : []);
    const caretPositions = () => (doc ? caretHeads(doc) : []);

    /** Delete every non-empty selection; if none, return false (caller handles carets). */
    const deleteSelection = () => {
        const ranges = selectionRanges();
        if(!ranges.length) return false;
        applyRangesEdit(ranges, '');
        return true;
    };

    /**
     * Replace ranges (default: all cursor edit sites) with `inserted`.
     * Always updates every cursor via applyCursorsEdit.
     */
    const applyRangesEdit = (ranges, inserted, opts = {}) => {
        if(!doc) return;
        const result = applyCursorsEdit(doc, inserted, {ranges, skipUndo: opts.skipUndo, pushUndo: pushUndoSnapshot, undoCoalesce});
        undoCoalesce = result.undoCoalesce;
        followCaret  = true;
        if(result.before != null) noteEditSites(result.before, result.list, result.inserted || '');
        markDirty();
    };

    /** Replace [utf16Start, utf16End) — clears multi-cursor to that single edit. */
    const replaceDocRange = (utf16Start, utf16End, inserted, opts = {}) => {
        if(!doc) return;
        ensureCursors(doc);
        // Single-range ops (indent, join, …) become a one-cursor edit.
        writeCursors(doc, [createCursor(utf16Start, utf16End)], {primaryIndex: 0});
        applyRangesEdit([{start: utf16Start, end: utf16End}], inserted, opts);
    };

    const insertText = (raw) => {
        if(!doc) return;
        const text   = expandTabs(sanitizeTextInput(raw));
        const ranges = editRanges();
        if(!text && ranges.length === 1 && ranges[0].start === ranges[0].end) return;
        applyRangesEdit(ranges, text);
    };

    const ensureMetrics = async () => {
        if(metricsReady) return;
        const probe = await UI.createElement(win, {
            renderable: {type: 'text', string: '0000000000', size: theme.fontSizeCode, font: theme.fontMono, colour: theme.text, metricsBasis: 'line'},
            item: {size: {x: 200, y: 24}}
        });
        try
        {
            const metrics = await UI.measureText(win, probe);
            if(metrics?.lineAdvance > 0)
                lineAdvance = Math.ceil(metrics.lineAdvance * LINE_SPACING);
            else if(metrics?.size?.y > 0)
                lineAdvance = Math.ceil(metrics.size.y * LINE_SPACING);
            // Prefer advance from caret at end of probe — measureText size can undershoot.
            let advance = 0;
            try
            {
                const pt = await UI.getTextCaretPosition(win, probe, 10);
                if(pt && typeof pt.x === 'number' && pt.x > 0) advance = pt.x / 10;
            } catch(e)
            {
                void e;
            }
            if(!(advance > 0) && metrics?.size?.x > 0) advance = metrics.size.x / 10;
            if(advance > 0) charWidth = Math.max(1, advance);
        } finally
        {
            try
            {
                await UI.destroyElement(win, probe);
            } catch(e)
            {
                void e;
            }
        }
        await Promise.all(caretEls.map((el) => UI.setLayoutSize(win, el, {x: 2, y: lineAdvance})));
        await Promise.all([
            UI.setLayoutSize(win, activeLineBg, {x: 1, y: lineAdvance}), UI.setLayoutSize(win, activeLineAccent, {x: 2, y: lineAdvance}),
            UI.setLayoutSize(win, activeGutterBg, {x: gutterW, y: lineAdvance})
        ]);
        metricsReady = true;
    };

    const estimateLineWidth = (text) => Math.max(12, Math.ceil(String(text || '').length * charWidth) + 8);

    /** Glyph X within a line text element; falls back to charWidth × col. */
    const glyphXAt = async (textId, line, col) => {
        const c = Math.max(0, Math.min(col | 0, (line || '').length));
        if(c <= 0) return 0;
        try
        {
            const pt = await UI.getTextCaretPosition(win, textId, c);
            if(pt && typeof pt.x === 'number' && Number.isFinite(pt.x)) return pt.x;
        } catch(e)
        {
            void e;
        }
        return c * charWidth;
    };

    const clearLinePool = async (pool) => {
        const entries = pool.splice(0, pool.length);
        if(entries.length === 0) return;
        // Prefer destroying the row host (selection + text); fall back to the leaf id.
        await Promise.all(entries.map((entry) => settled(UI.destroyElement(win, entry.host != null ? entry.host : entry.id))));
    };

    /** Document-space Y for a row (scrollHost / gutterHost children). */
    const rowY = (row) => PAD_Y + row * lineAdvance;

    /** Size gutter to digit count only — expand when needed, shrink when not. */
    const ensureGutterWidth = async (lineCount) => {
        const digits      = String(Math.max(lineCount, 1)).length;
        const nextGutterW = Math.max(theme.gutterWidth, digits * Math.ceil(charWidth) + GUTTER_PAD_L + GUTTER_PAD_R);
        if(nextGutterW === gutterW) return;
        gutterW = nextGutterW;
        await Promise.all([
            UI.setLayoutSize(win, gutterClip, {x: gutterW}), UI.setLayoutSize(win, gutterHost, {x: gutterW, y: lastHostH > 0 ? lastHostH : 1}),
            UI.setLayoutSize(win, activeGutterBg, {x: gutterW, y: lineAdvance})
        ]);
    };

    const createGutterEntry = async (tw) => {
        const id = await UI.createElement(win, {
            renderable:
                {type: 'text', string: ' ', size: theme.fontSizeCodeSm, font: theme.fontMono, colour: theme.textMuted, metricsBasis: 'line', justify: 'right'},
            item: {size: {x: tw, y: lineAdvance}, position: {x: GUTTER_PAD_L, y: 0}},
            contentAlign: {x: 'end', y: 'start'}
        });
        await UI.attach(win, gutterHost, id);
        return {id, text: '', row: -1, width: tw, y: null};
    };

    const makeSelBox = async () => {
        const sel = await UI.createElement(win, {
            renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 1, y: 1}}, colour: theme.selection},
            // contentAlign fill: box mesh tracks layout size (without it, aabb stays 1×1).
            item: {size: {x: 2, y: lineAdvance}, position: {x: PAD_X, y: 0}},
            contentAlign: 'fill'
        });
        return sel;
    };

    /** Grow selection sprites; keep them behind the text node. */
    const ensureLineSels = async (entry, n) => {
        if(!entry || !Array.isArray(entry.sels)) return;
        while(entry.sels.length < n)
        {
            if(typeof UI.detach === 'function') await settled(UI.detach(win, entry.host, entry.id));
            const sel = await makeSelBox();
            await UI.attach(win, entry.host, sel);
            await UI.setEnabled(win, sel, false);
            entry.sels.push(sel);
            await UI.attach(win, entry.host, entry.id);
        }
    };

    const createLineEntry = async (colour) => {
        // Row host: mark stripe + selection(s) (behind) + text. Lives at document Y.
        const host = await UI.createElement(win, {contentPositioning: 'raw', item: {size: {x: 12, y: lineAdvance}, position: {x: 0, y: 0}}});
        const mark = await UI.createElement(win, {
            renderable: {type: 'box', aabb: {min: {x: 0, y: 0}, max: {x: 1, y: 1}}, colour: theme.diffModified || theme.primary},
            item: {size: {x: 3, y: lineAdvance}, position: {x: 0, y: 0}},
            contentAlign: 'fill'
        });
        await UI.attach(win, host, mark);
        await UI.setEnabled(win, mark, false);
        const sel = await makeSelBox();
        await UI.attach(win, host, sel);
        await UI.setEnabled(win, sel, false);
        const textId = await UI.createElement(win, {
            renderable: {type: 'text', string: ' ', size: theme.fontSizeCode, font: theme.fontMono, colour: colour || theme.code || theme.text, metricsBasis: 'line'},
            item: {size: {x: 12, y: lineAdvance}, position: {x: PAD_X, y: 0}},
            contentAlign: {x: 'start', y: 'start'}
        });
        await UI.attach(win, host, textId);
        await UI.attach(win, scrollHost, host);
        return {
            id: textId,
            host,
            sels: [sel],
            mark,
            markType: null,
            markEpoch: -1,
            text: '',
            row: -1,
            bufRow: -1,
            colStart: 0,
            colEnd: 0,
            width: 12,
            y: null,
            areaIds: [],
            rowHlEpoch: -1,
            selOn: false,
            selKey: ''
        };
    };

    /**
     * Keep a pool of row hosts bound to the visible visual rows.
     * Rows keep document-space Y; scroll is a host translate. On scroll,
     * only rows that leave the window are recycled onto entering rows —
     * selection children move with their host for free.
     */
    const syncSlotPools = async (lines, colour, lineRuns = [], caretBufRow = -1) => {
        const layout        = getWrapLayout(lines);
        const segments      = layout.segments;
        const visualCount   = Math.max(1, segments.length);
        const need          = slotCount();
        const tw            = gutterTextW();
        const colourKey     = colour ? colour.join(',') : '';
        const colourChanged = colourKey !== lastColourKey;
        lastColourKey       = colourKey;
        const wrapping      = wrapEnabled();
        const contentW      = Math.max(12, viewportWidth - PAD_X * 2);

        const winStart = firstVisibleRow;
        const winEnd   = firstVisibleRow + need;  // exclusive
        const desired  = [];
        for(let vRow = winStart; vRow < winEnd; vRow++)
            desired.push(vRow);

        // Free entries whose visual row left the window (or were unbound).
        const freeLines   = [];
        const freeGutters = [];
        const lineByRow   = new Map();
        const gutterByRow = new Map();
        for(const entry of lineEls)
        {
            if(entry.row >= winStart && entry.row < winEnd && entry.row >= 0)
                lineByRow.set(entry.row, entry);
            else
            {
                entry.row = -1;
                freeLines.push(entry);
            }
        }
        for(const entry of gutterEls)
        {
            if(entry.row >= winStart && entry.row < winEnd && entry.row >= 0)
                gutterByRow.set(entry.row, entry);
            else
            {
                entry.row = -1;
                freeGutters.push(entry);
            }
        }

        // Grow pools to cover the window (never shrink mid-scroll — reuse free).
        while(lineEls.length < need)
        {
            const entry = await createLineEntry(colour);
            lineEls.push(entry);
            freeLines.push(entry);
        }
        while(gutterEls.length < need)
        {
            const entry = await createGutterEntry(tw);
            gutterEls.push(entry);
            freeGutters.push(entry);
        }

        // Selection by buffer row — one or more col ranges (Ctrl multi-select).
        /** @type {Map<number, Array<{ startCol: number, endCol: number }>>} */
        const selByBufRow = new Map();
        for(const range of selectionRanges())
        {
            const a = rowColFromIndex(doc.text, range.start);
            const b = rowColFromIndex(doc.text, range.end);
            for(let row = a.row; row <= b.row; row++)
            {
                const lineLen  = (lines[row] || '').length;
                const startCol = row === a.row ? a.col : 0;
                const endCol   = row === b.row ? b.col : Math.max(lineLen, 1);
                if(endCol <= startCol) continue;
                const piece = {startCol, endCol};
                const arr   = selByBufRow.get(row);
                if(arr)
                    arr.push(piece);
                else
                    selByBufRow.set(row, [piece]);
            }
        }

        let maxLineW     = 12;
        const layoutOps  = [];
        const dirtySlots = [];
        /** Selection size after text is committed — glyph metrics, not charWidth guesses. */
        const selJobs = [];

        for(const vRow of desired)
        {
            const inRange  = vRow >= 0 && vRow < visualCount;
            const seg      = inRange ? segments[vRow] : null;
            const bufRow   = seg ? seg.bufRow : -1;
            const startCol = seg ? seg.startCol : 0;
            const endCol   = seg ? seg.endCol : 0;
            const raw      = seg ? seg.text : '';
            const fullLine = bufRow >= 0 ? (lines[bufRow] ?? '') : '';
            const label    = (inRange && seg && startCol === 0) ? String(bufRow + 1) : '';
            const display  = raw.length === 0 ? ' ' : raw;
            const lw       = wrapping ? contentW : (inRange ? estimateLineWidth(raw) : 12);
            const y        = rowY(vRow);
            maxLineW       = Math.max(maxLineW, lw);

            let g = gutterByRow.get(vRow);
            if(!g)
            {
                g = freeGutters.pop();
                if(!g)
                {
                    g = await createGutterEntry(tw);
                    gutterEls.push(g);
                }
                gutterByRow.set(vRow, g);
            }
            if(g.y !== y)
            {
                g.y = y;
                layoutOps.push(UI.setLayoutPosition(win, g.id, {x: GUTTER_PAD_L, y: y + GUTTER_Y_OFF}));
            }
            if(g.width !== tw)
            {
                g.width = tw;
                layoutOps.push(UI.setLayoutSize(win, g.id, {x: tw, y: lineAdvance}));
            }
            if(g.text !== label || g.row !== vRow)
            {
                g.text = label;
                g.row  = vRow;
                layoutOps.push(UI.setTextString(win, g.id, label.length ? label : ' '));
            } else
                g.row = vRow;
            const gutterColour = (inRange && bufRow === caretBufRow) ? theme.primary : [...theme.textMuted.slice(0, 3), 0.3];
            layoutOps.push(UI.setTextColour(win, g.id, gutterColour));

            let entry        = lineByRow.get(vRow);
            const rowChanged = !entry || entry.row !== vRow || entry.bufRow !== bufRow || entry.colStart !== startCol || entry.colEnd !== endCol;
            if(!entry)
            {
                entry = freeLines.pop();
                if(!entry)
                {
                    entry = await createLineEntry(colour);
                    lineEls.push(entry);
                }
                lineByRow.set(vRow, entry);
            }

            const hostW = wrapping ? Math.max(viewportWidth, 12) : Math.max(lw + PAD_X * 2, viewportWidth, 12);
            if(entry.y !== y)
            {
                entry.y = y;
                layoutOps.push(UI.setLayoutPosition(win, entry.host, {x: 0, y}));
            }
            layoutOps.push(UI.setLayoutSize(win, entry.host, {x: hostW, y: lineAdvance}));
            layoutOps.push(UI.setLayoutPosition(win, entry.id, {x: PAD_X, y: 0}));
            if(entry.width !== lw || rowChanged)
            {
                entry.width = lw;
                layoutOps.push(UI.setLayoutSize(win, entry.id, {x: lw, y: lineAdvance}));
            }

            const contentChanged = entry.text !== raw || rowChanged;
            const rowEpoch       = bufRow >= 0 ? (rowHlEpoch[bufRow] | 0) : 0;
            const spansChanged   = entry.rowHlEpoch !== rowEpoch;
            let textOp           = null;
            if(contentChanged)
            {
                entry.text     = raw;
                entry.row      = vRow;
                entry.bufRow   = bufRow;
                entry.colStart = startCol;
                entry.colEnd   = endCol;
                textOp         = UI.setTextString(win, entry.id, inRange ? display : ' ');
            } else
            {
                entry.row      = vRow;
                entry.bufRow   = bufRow;
                entry.colStart = startCol;
                entry.colEnd   = endCol;
            }

            if(colourChanged && colour)
            {
                const colourOp = UI.setTextColour(win, entry.id, colour);
                textOp         = textOp ? Promise.all([textOp, colourOp]) : colourOp;
            }

            if(spansChanged || rowChanged)
            {
                const liveRuns = (doc && hlCache.path === doc.path && Array.isArray(hlCache.lineRuns)) ? (hlCache.lineRuns[bufRow] || []) : (lineRuns[bufRow] || []);
                const sliced   = wrapping ? sliceLineRuns(liveRuns, fullLine, startCol, endCol) : liveRuns;
                dirtySlots.push({entry, runs: inRange ? sliced : [], textOp, rowEpoch});
            } else if(textOp)
                layoutOps.push(textOp);

            // Diff / plugin line marks — every visual segment of the marked buffer row.
            const mType = inRange ? markTypeForRow(bufRow) : null;
            if(entry.mark && (entry.markType !== mType || rowChanged || entry.markEpoch !== lineMarkEpoch))
            {
                entry.markType  = mType;
                entry.markEpoch = lineMarkEpoch;
                const col       = markColour(mType);
                if(col)
                {
                    layoutOps.push(UI.setEnabled(win, entry.mark, true));
                    layoutOps.push(UI.setBoxColour(win, entry.mark, col));
                    layoutOps.push(UI.setLayoutSize(win, entry.mark, {x: 3, y: lineAdvance}));
                } else
                    layoutOps.push(UI.setEnabled(win, entry.mark, false));
            }

            // Selection: intersect all buffer-row ranges with this wrap segment.
            const bufSels = inRange ? (selByBufRow.get(bufRow) || []) : [];
            /** @type {Array<{ startCol: number, endCol: number }>} */
            const segSels = [];
            for(const bufSel of bufSels)
            {
                const s = Math.max(bufSel.startCol, startCol);
                const e = Math.min(bufSel.endCol, endCol);
                if(e > s) segSels.push({startCol: s - startCol, endCol: e - startCol});
            }
            const selKey = segSels.length ? `${vRow}:${segSels.map((s) => `${s.startCol}-${s.endCol}`).join(',')}:${raw}:${lineAdvance}` : '';
            if(!segSels.length)
            {
                if(entry.selOn)
                {
                    entry.selOn  = false;
                    entry.selKey = '';
                    for(const s of entry.sels || [])
                        layoutOps.push(UI.setEnabled(win, s, false));
                }
            } else if(!entry.selOn || entry.selKey !== selKey)
            {
                selJobs.push({entry, line: raw, segs: segSels, selKey});
            }
        }

        // Park unused free entries off-screen (kept for the next edge recycle).
        const parkY = -lineAdvance * 4;
        for(const entry of freeLines)
        {
            if(entry.selOn)
            {
                entry.selOn  = false;
                entry.selKey = '';
                for(const s of entry.sels || [])
                    layoutOps.push(UI.setEnabled(win, s, false));
            }
            if(entry.y !== parkY)
            {
                entry.y = parkY;
                layoutOps.push(UI.setLayoutPosition(win, entry.host, {x: 0, y: parkY}));
            }
        }
        for(const entry of freeGutters)
        {
            if(entry.y !== parkY)
            {
                entry.y = parkY;
                layoutOps.push(UI.setLayoutPosition(win, entry.id, {x: GUTTER_PAD_L, y: parkY}));
            }
        }

        if(layoutOps.length) await Promise.all(layoutOps.map((p) => settled(p)));
        await paintDirtySlots(dirtySlots);

        if(selJobs.length)
        {
            const selOps = [];
            for(const job of selJobs)
            {
                await ensureLineSels(job.entry, job.segs.length);
                let maxX = 0;
                for(let i = 0; i < job.entry.sels.length; i++)
                {
                    const box = job.entry.sels[i];
                    const seg = job.segs[i] || null;
                    if(!seg)
                    {
                        selOps.push(UI.setEnabled(win, box, false));
                        continue;
                    }
                    const x0   = await glyphXAt(job.entry.id, job.line, seg.startCol);
                    const x1   = await glyphXAt(job.entry.id, job.line, seg.endCol);
                    const selX = PAD_X + Math.min(x0, x1);
                    const selW = Math.max(Math.ceil(charWidth * 0.6), Math.abs(x1 - x0));
                    maxX       = Math.max(maxX, Math.max(x0, x1));
                    selOps.push(
                        UI.setEnabled(win, box, true), UI.setLayoutPosition(win, box, {x: selX, y: 0}), UI.setLayoutSize(win, box, {x: selW, y: lineAdvance}),
                        UI.setPosition(win, box, {x: 0, y: 0}), UI.setScale(win, box, {x: 1, y: 1}));
                }
                const needW = Math.ceil(maxX + 4);
                if(!wrapping && job.entry.width < needW)
                {
                    job.entry.width = needW;
                    selOps.push(
                        UI.setLayoutSize(win, job.entry.id, {x: needW, y: lineAdvance}),
                        UI.setLayoutSize(win, job.entry.host, {x: Math.max(needW + PAD_X * 2, viewportWidth, 12), y: lineAdvance}));
                }
                job.entry.selOn  = true;
                job.entry.selKey = job.selKey;
            }
            await Promise.all(selOps.map((p) => settled(p)));
        }

        // Host covers the document band we may position into (windowed rows).
        const colH = Math.max(PAD_Y * 2 + need * lineAdvance, rowY(winEnd - 1) + lineAdvance + PAD_Y);
        const colW = wrapping ? Math.max(viewportWidth, 12) : Math.max(viewportWidth, maxLineW + PAD_X * 2);
        if(colW !== lastHostW || colH !== lastHostH)
        {
            lastHostW = colW;
            lastHostH = colH;
            await Promise.all([UI.setLayoutSize(win, scrollHost, {x: colW, y: colH}), UI.setLayoutSize(win, gutterHost, {x: gutterW, y: colH})]);
        }
    };

    /** Caret position in scroll-host (document) space. */
    const caretContentPos = async (lines, bufRow, col) => {
        const layout   = getWrapLayout(lines);
        const vRow     = visualRowAt(layout, bufRow, col);
        const seg      = layout.segments[vRow] || {startCol: 0, text: ''};
        const localCol = Math.max(0, (col | 0) - (seg.startCol | 0));
        const lineEl   = lineEls.find((entry) => entry.row === vRow);
        let glyphX     = 0;
        if(lineEl && localCol > 0)
        {
            try
            {
                const pt = await UI.getTextCaretPosition(win, lineEl.id, Math.min(localCol, (seg.text || '').length));
                if(pt && typeof pt.x === 'number' && Number.isFinite(pt.x))
                    glyphX = pt.x;
                else
                    glyphX = localCol * charWidth;
            } catch(e)
            {
                void e;
                glyphX = localCol * charWidth;
            }
        } else if(localCol > 0)
            glyphX = localCol * charWidth;
        return {x: PAD_X + glyphX, y: rowY(vRow), vRow};
    };

    const maxScrollRow = () => {
        if(!doc) return 0;
        const visual  = Math.max(1, getWrapLayout(getDocLines()).visualCount);
        const visible = viewLineCount();
        return Math.max(0, visual - Math.min(visible, visual));
    };

    const maxScrollY = () => scrollYFromRow(maxScrollRow());

    /** Last laid-out scrollbar geometry (for hit-testing / drag). */
    let scrollBarGeom          = {trackH: 1, thumbY: 0, thumbH: 0, visible: false};
    let scrollBarDragging      = false;
    let scrollBarDragOriginY   = 0;
    let scrollBarDragOriginRow = 0;

    const syncScrollbar = async () => {
        if(!doc)
        {
            scrollBarGeom.visible = false;
            await UI.setEnabled(win, scrollBarThumb, false);
            return;
        }
        const trackH    = Math.max(1, viewportHeight);
        const totalRows = Math.max(1, getWrapLayout(getDocLines()).visualCount);
        const visible   = Math.max(1, viewLineCount());
        const maxRow    = maxScrollRow();
        if(maxRow <= 0)
        {
            scrollBarGeom = {trackH, thumbY: 0, thumbH: trackH, visible: false};
            await UI.setEnabled(win, scrollBarThumb, false);
            return;
        }
        const thumbH  = Math.max(24, Math.min(trackH, Math.floor((trackH * visible) / totalRows)));
        const travel  = Math.max(1, trackH - thumbH);
        const row     = Math.max(0, Math.min(maxRow, rowFromScrollY()));
        const thumbY  = Math.floor((row / maxRow) * travel);
        scrollBarGeom = {trackH, thumbY, thumbH, visible: true};
        await Promise.all([
            UI.setEnabled(win, scrollBarThumb, true), UI.setLayoutSize(win, scrollBarThumb, {x: Math.max(4, scrollBarW - 2), y: thumbH}),
            UI.setLayoutPosition(win, scrollBarThumb, {x: 1, y: thumbY}),
            UI.setBoxColour(
                win, scrollBarThumb, scrollBarDragging ? (theme.scrollbarThumbActive || theme.scrollbarThumb) : (theme.scrollbarThumb || [0.66, 0.66, 0.67, 0.52]))
        ]);
    };

    /** Map a Y on the track to a first-visible row. */
    const rowFromTrackY = (localY, thumbH) => {
        const maxRow = maxScrollRow();
        if(maxRow <= 0) return 0;
        const h      = thumbH || scrollBarGeom.thumbH || 24;
        const travel = Math.max(1, scrollBarGeom.trackH - h);
        const y      = Math.max(0, Math.min(travel, (localY | 0) - h / 2));
        return Math.max(0, Math.min(maxRow, Math.round((y / travel) * maxRow)));
    };

    const scrollToRow = (row) => {
        if(!doc) return;
        const maxRow    = maxScrollRow();
        firstVisibleRow = Math.max(0, Math.min(maxRow, row | 0));
        doc.scrollY     = scrollYFromRow(firstVisibleRow);
        followCaret     = false;
    };

    const clampScroll = () => {
        if(!doc) return;
        if(wrapEnabled())
            doc.scrollX = 0;
        else
        {
            const maxX  = Math.max(0, 8000 - viewportWidth);
            doc.scrollX = Math.max(0, Math.min(maxX, doc.scrollX));
        }
        const maxRow = maxScrollRow();
        let row      = rowFromScrollY();
        row          = Math.max(0, Math.min(maxRow, row));
        doc.scrollY  = scrollYFromRow(row);
    };

    const ensureCaretRowVisible = (vRow) => {
        if(!doc) return;
        const visible = viewLineCount();
        if(vRow < firstVisibleRow)
            firstVisibleRow = vRow;
        else if(vRow >= firstVisibleRow + visible)
            firstVisibleRow = vRow - visible + 1;
        firstVisibleRow = Math.max(0, Math.min(maxScrollRow(), firstVisibleRow));
        doc.scrollY     = scrollYFromRow(firstVisibleRow);
    };

    const ensureCaretXVisible = (cx) => {
        if(!doc || wrapEnabled()) return;
        const viewW = Math.max(40, viewportWidth - 24);
        if(cx - doc.scrollX > viewW) doc.scrollX = cx - viewW;
        if(cx - doc.scrollX < PAD_X) doc.scrollX = Math.max(0, cx - PAD_X);
        const maxX  = Math.max(0, 8000 - viewportWidth);
        doc.scrollX = Math.max(0, Math.min(maxX, doc.scrollX));
    };

    /** Pan content: rows live in document space; this shifts the whole band. */
    const applyScroll = async () => {
        const x = -Math.round(doc ? doc.scrollX : 0);
        const y = -Math.round(doc ? doc.scrollY : 0);
        await Promise.all([UI.setLayoutPosition(win, scrollHost, {x, y}), UI.setLayoutPosition(win, gutterHost, {x: 0, y})]);
    };

    /**
     * Align the window to doc.scrollY, recycle edge rows, translate the band.
     */
    const syncWindowToScroll = async (lines, colour, lineRuns = [], caretRow = -1) => {
        clampScroll();
        firstVisibleRow = rowFromScrollY();
        doc.scrollY     = scrollYFromRow(firstVisibleRow);
        await syncSlotPools(lines, colour, lineRuns, caretRow);
        await applyScroll();
    };

    const render = async () => {
        await ensureMetrics();
        await syncViewportFromLayout();

        if(!doc)
        {
            await Promise.all([clearLinePool(lineEls), clearLinePool(gutterEls)]);
            await ensureCaretCount(1);
            await Promise.all([
                ...caretEls.map((el) => UI.setEnabled(win, el, false)), UI.setEnabled(win, activeLineBg, false), UI.setEnabled(win, activeLineAccent, false),
                UI.setEnabled(win, activeGutterBg, false), UI.setEnabled(win, minimap, false), UI.setEnabled(win, minimapBand, false),
                UI.setEnabled(win, scrollBarThumb, false)
            ]);
            scrollBarGeom.visible = false;
            if(lastStatus !== 'No file open')
            {
                lastStatus = 'No file open';
                onStatus({empty: true});
            }
            return;
        }

        const lines  = getDocLines();
        let colour   = theme.code || theme.text;
        let lineRuns = [];
        if(hlCache.source === doc.text && hlCache.path === doc.path)
        {
            colour   = hlCache.colour || theme.code || theme.text;
            lineRuns = hlCache.lineRuns || [];
        } else
        {
            // Never block scroll/paint on tree-sitter — use cache if any, refresh async.
            colour   = hlCache.colour || theme.code || theme.text;
            lineRuns = hlCache.path === doc.path ? (hlCache.lineRuns || []) : [];
            scheduleHighlight(doc.text, doc.path, doc.language);
        }

        const rc           = (lineCache.path === doc.path && lineCache.text === doc.text) ? rowColFromCache(doc.caret) : rowColFromIndex(doc.text, doc.caret);
        const layout       = getWrapLayout(lines);
        const caretVRow    = visualRowAt(layout, rc.row, rc.col);
        const shouldFollow = followCaret;
        if(shouldFollow)
            ensureCaretRowVisible(caretVRow);
        else
            clampScroll();

        await ensureGutterWidth(lines.length);
        // Re-read after awaits — highlight chunks may have filled the cache while
        // we were measuring layout on the first open.
        if(hlCache.path === doc.path && (hlCache.source === doc.text || hlCache.lexedSource === doc.text))
        {
            colour   = hlCache.colour || colour;
            lineRuns = hlCache.lineRuns || lineRuns;
        }
        await syncWindowToScroll(lines, colour, lineRuns, rc.row);

        const orderedPts = caretPositions();
        await ensureCaretCount(Math.max(1, orderedPts.length));
        /** @type {{ x: number, y: number, vRow: number }[]} */
        const caretLayouts = [];
        for(const idx of orderedPts)
        {
            const at = rowColFromIndex(doc.text, idx);
            caretLayouts.push(await caretContentPos(lines, at.row, at.col));
        }
        const primaryPt = caretLayouts[0] || await caretContentPos(lines, rc.row, rc.col);
        if(shouldFollow) ensureCaretXVisible(primaryPt.x);
        await applyScroll();
        await syncScrollbar();

        const lineBandW = Math.max(viewportWidth + Math.round(doc.scrollX || 0), lastHostW, 64);
        const caretOps  = [];
        for(let i = 0; i < caretEls.length; i++)
        {
            const el = caretEls[i];
            const pt = caretLayouts[i] || null;
            if(pt && focused)
            {
                caretOps.push(
                    UI.setLayoutSize(win, el, {x: 2, y: lineAdvance}), UI.setLayoutPosition(win, el, {x: pt.x, y: pt.y}), UI.setPosition(win, el, {x: 0, y: 0}),
                    UI.setEnabled(win, el, true));
            } else
                caretOps.push(UI.setEnabled(win, el, false));
        }
        await Promise.all([
            ...caretOps, UI.setLayoutSize(win, activeLineBg, {x: lineBandW, y: lineAdvance}), UI.setLayoutPosition(win, activeLineBg, {x: 0, y: primaryPt.y}),
            UI.setEnabled(win, activeLineBg, true), UI.setLayoutSize(win, activeLineAccent, {x: 2, y: lineAdvance}),
            UI.setLayoutPosition(win, activeLineAccent, {x: 0, y: primaryPt.y}), UI.setEnabled(win, activeLineAccent, true),
            UI.setLayoutSize(win, activeGutterBg, {x: gutterW, y: lineAdvance}), UI.setLayoutPosition(win, activeGutterBg, {x: 0, y: primaryPt.y}),
            UI.setEnabled(win, activeGutterBg, true), UI.setEnabled(win, minimap, true), UI.setEnabled(win, minimapBand, true)
        ]);

        const statusKey = `${doc.path}:${rc.row}:${rc.col}:${doc.dirty}:${doc.language || ''}`;
        if(statusKey !== lastStatus)
        {
            lastStatus = statusKey;
            onStatus({row: rc.row, col: rc.col, language: doc.language, dirty: !!doc.dirty, path: doc.path});
        }
    };

    const queueRender = () => {
        if(renderPending)
        {
            renderDirty = true;
            return;
        }
        renderPending = true;
        setTimeout(() => {
            void withPaintLock(async () => {
                try
                {
                    await render();
                } finally
                {
                    renderPending = false;
                    if(renderDirty)
                    {
                        renderDirty = false;
                        queueRender();
                    }
                }
            });
        }, 0);
    };

    const moveCaret = (next, extend, affinity = null) => {
        if(!doc) return;
        const at = clampIndex(next);
        // Absolute destination for every cursor (Ctrl+Home/End).
        transformCursors((c) => {
            if(extend) return {anchor: c.anchor, head: at, preferredColumn: null};
            return {anchor: at, head: at, preferredColumn: null};
        }, affinity);
    };

    /** Move each collapsed caret via mapHead; with a selection, collapse first (no move). */
    const moveCursorsBy = (mapHead, extend, affinity = null, collapseTo = null) => {
        if(!doc) return;
        transformCursors((c) => {
            if(extend)
            {
                const head = clampIndex(mapHead(c.head, c));
                return {anchor: c.anchor, head, preferredColumn: null};
            }
            if(c.anchor !== c.head)
            {
                const at = collapseTo === 'start' ? Math.min(c.anchor, c.head) : (collapseTo === 'end' ? Math.max(c.anchor, c.head) : c.head);
                return {anchor: at, head: at, preferredColumn: null};
            }
            const head = clampIndex(mapHead(c.head, c));
            return {anchor: head, head, preferredColumn: null};
        }, affinity);
    };

    /** Replace the whole cursor list with a single cursor. */
    const setSingleCursor = (anchor, head, affinity = null) => { setCursors([createCursor(anchor, head, null)], affinity, 0); };

    /** Update only the primary cursor; keep others. */
    const updatePrimary = (fn, affinity = null) => {
        if(!doc) return;
        ensureCursors(doc);
        const cursors = getCursors();
        const pi      = doc.primaryIndex;
        cursors[pi]   = fn(cursors[pi]);
        setCursors(cursors, affinity, pi);
    };

    /** Visual row for a buffer caret, honouring wrap-boundary affinity. */
    const visualRowAt = (layout, bufRow, col) => visualRowForCaret(layout, bufRow, col, doc ? doc.caretAffinity : null);

    const indentUnit = () => indentString();
    const outdentPrefix = () => {
        const n = Math.max(1, editorSettings.tabSize | 0);
        return new RegExp(`^ {1,${n}}`);
    };

    const selectedLineRange = () => {
        const lines    = splitLines(doc.text);
        const sel      = selectionRange();
        const a        = rowColFromIndex(doc.text, sel ? sel.start : doc.caret);
        const b        = rowColFromIndex(doc.text, sel ? sel.end : doc.caret);
        const rowStart = Math.min(a.row, b.row);
        const rowEnd   = Math.max(a.row, b.row);
        // If selection ends at col 0 of a line, that line is not included (Atom).
        const endRow = (sel && b.col === 0 && b.row > a.row) ? b.row - 1 : rowEnd;
        return {lines, rowStart, rowEnd: Math.max(rowStart, endRow)};
    };

    /** Inclusive end index covering full lines [rowStart, rowEnd]. */
    const lineBlockEnd = (lines, rowStart, rowEnd) => {
        let end = indexFromRowCol(lines, rowEnd, (lines[rowEnd] || '').length);
        if(rowEnd < lines.length - 1) end += 1;  // include trailing newline
        return end;
    };

    const handleKey = async (key) => {
        const ctrl  = mods.hasCtrl();
        const shift = mods.hasShift();
        const alt   = mods.hasAlt();

        // --- Application / pane (Atom linux.cson) — work even with no buffer ---
        if(ctrl && shift && !alt && keyIn(key, KEY.S)) return 'save-as';
        if(ctrl && !alt && keyIn(key, KEY.S)) return 'save';
        if(ctrl && !shift && !alt && keyIn(key, KEY.N)) return 'new';
        if(ctrl && shift && !alt && keyIn(key, KEY.P)) return 'command-palette';
        if(ctrl && !shift && !alt && (keyIn(key, KEY.W) || keyIn(key, KEY.F4))) return 'close';
        if(ctrl && shift && !alt && keyIn(key, KEY.W)) return 'close-window';
        if(ctrl && !shift && !alt && keyIn(key, KEY.Q)) return 'quit';
        if(ctrl && !alt && keyIn(key, KEY.PAGEDOWN)) return shift ? 'tab-prev' : 'tab-next';
        if(ctrl && !alt && keyIn(key, KEY.PAGEUP)) return shift ? 'tab-next' : 'tab-prev';
        if(ctrl && !alt && keyIn(key, KEY.TAB)) return shift ? 'tab-prev' : 'tab-next';

        if(!doc || !focused) return false;

        // Escape — single caret at primary head
        if(keyIn(key, KEY.ESCAPE))
        {
            ensureCursors(doc);
            const multi = doc.cursors.length > 1;
            const p     = primaryCursor(doc);
            if(multi || p.anchor !== p.head)
            {
                clearToPrimary(doc);
                followCaret = true;
                queueRender();
                return true;
            }
            return false;
        }

        // Undo / redo
        if(ctrl && !alt && keyIn(key, KEY.Z) && !shift)
        {
            if(applyUndo(doc))
            {
                undoCoalesce = null;
                followCaret  = true;
                rebuildLineCache(doc.text, doc.path);
                hlCache = {
                    source: null,
                    lexedSource: null,
                    path: doc.path,
                    colour: hlCache.colour || theme.code || theme.text,
                    spans: [],
                    lineRuns: Array.from({length: lineCache.lines.length}, () => []),
                    version: (hlCache.version | 0) + 1
                };
                bumpRowEpoch(0, lineCache.lines.length);
                markDirty();
                scheduleHighlight(doc.text, doc.path, doc.language);
                queueRender();
            }
            return true;
        }
        if(ctrl && !alt && ((keyIn(key, KEY.Y) && !shift) || (keyIn(key, KEY.Z) && shift)))
        {
            if(applyRedo(doc))
            {
                undoCoalesce = null;
                followCaret  = true;
                rebuildLineCache(doc.text, doc.path);
                hlCache = {
                    source: null,
                    lexedSource: null,
                    path: doc.path,
                    colour: hlCache.colour || theme.code || theme.text,
                    spans: [],
                    lineRuns: Array.from({length: lineCache.lines.length}, () => []),
                    version: (hlCache.version | 0) + 1
                };
                bumpRowEpoch(0, lineCache.lines.length);
                markDirty();
                scheduleHighlight(doc.text, doc.path, doc.language);
                queueRender();
            }
            return true;
        }

        if(ctrl && !alt && keyIn(key, KEY.A))
        {
            setSingleCursor(0, doc.text.length);
            queueRender();
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.C))
        {
            const ranges   = selectionRanges();
            const text     = ranges.length ? ranges.map((r) => doc.text.slice(r.start, r.end)).join('\n') : doc.text;
            localClipboard = text;
            try
            {
                await Compositor.setClipboardText(text);
            } catch(e)
            {
                void e;
            }
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.X))
        {
            const ranges   = selectionRanges();
            const text     = ranges.length ? ranges.map((r) => doc.text.slice(r.start, r.end)).join('\n') : doc.text;
            localClipboard = text;
            try
            {
                await Compositor.setClipboardText(text);
            } catch(e)
            {
                void e;
            }
            if(ranges.length)
                applyRangesEdit(ranges, '');
            else
                replaceDocRange(0, doc.text.length, '');
            queueRender();
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.V))
        {
            let clip = localClipboard;
            try
            {
                const systemClip = await Compositor.getClipboardText();
                if(typeof systemClip === 'string') clip = systemClip;
            } catch(e)
            {
                void e;
            }
            insertText(String(clip || '').replace(/\r\n/g, '\n'));
            queueRender();
            return true;
        }

        // Ctrl+L — select line
        if(ctrl && !shift && !alt && keyIn(key, KEY.L))
        {
            const lines = splitLines(doc.text);
            const rc    = rowColFromIndex(doc.text, doc.caret);
            const a     = indexFromRowCol(lines, rc.row, 0);
            const b     = rc.row < lines.length - 1 ? indexFromRowCol(lines, rc.row + 1, 0) : indexFromRowCol(lines, rc.row, (lines[rc.row] || '').length);
            setSingleCursor(a, b);
            queueRender();
            return true;
        }

        // Ctrl+Shift+K — delete line
        if(ctrl && shift && !alt && keyIn(key, KEY.K))
        {
            const {lines, rowStart, rowEnd} = selectedLineRange();
            const start                     = indexFromRowCol(lines, rowStart, 0);
            let end                         = lineBlockEnd(lines, rowStart, rowEnd);
            // If deleting the last line without a trailing newline after prior lines,
            // also eat the newline before it when possible.
            if(rowEnd === lines.length - 1 && rowStart > 0 && end === doc.text.length)
                replaceDocRange(start - 1, end, '');
            else
                replaceDocRange(start, end, '');
            queueRender();
            return true;
        }

        // Ctrl+D — select next occurrence (Atom find-and-replace:select-next)
        if(ctrl && !shift && !alt && keyIn(key, KEY.D))
        {
            ensureCursors(doc);
            const ranges = selectionRanges();
            if(!ranges.length)
            {
                // Expand each caret to its word (VS Code); if single caret, select that word.
                const nextCursors = getCursors().map((c) => {
                    if(c.anchor !== c.head) return c;
                    const word = wordRangeAt(doc.text, c.head);
                    if(word.end > word.start) return createCursor(word.start, word.end, null);
                    return c;
                });
                setCursors(nextCursors, null, doc.primaryIndex);
                queueRender();
                return true;
            }
            const primary = primaryCursor(doc);
            const needle  = doc.text.slice(Math.min(primary.anchor, primary.head), Math.max(primary.anchor, primary.head));
            if(!needle)
            {
                queueRender();
                return true;
            }
            const occupied = selectionRanges();
            const from     = Math.max(primary.anchor, primary.head);
            const next     = findNextOccurrence(doc.text, needle, from, occupied);
            if(next) commitPrimaryAndFocus({anchor: next.start, head: next.end});
            queueRender();
            return true;
        }

        // Ctrl+Shift+D — duplicate lines
        if(ctrl && shift && !alt && keyIn(key, KEY.D))
        {
            const {lines, rowStart, rowEnd} = selectedLineRange();
            const start                     = indexFromRowCol(lines, rowStart, 0);
            const end                       = lineBlockEnd(lines, rowStart, rowEnd);
            const block                     = doc.text.slice(start, end);
            const insertAt                  = end;
            const needsNl                   = rowEnd === lines.length - 1 && !block.endsWith('\n');
            replaceDocRange(insertAt, insertAt, (needsNl ? '\n' : '') + block);
            queueRender();
            return true;
        }

        // Ctrl+J — join lines
        if(ctrl && !shift && !alt && keyIn(key, KEY.J))
        {
            const lines = splitLines(doc.text);
            const rc    = rowColFromIndex(doc.text, doc.caret);
            if(rc.row >= lines.length - 1) return true;
            const a        = lines[rc.row] || '';
            const b        = (lines[rc.row + 1] || '').replace(/^\s+/, '');
            const start    = indexFromRowCol(lines, rc.row, 0);
            const end      = lineBlockEnd(lines, rc.row, rc.row + 1);
            const joined   = a.replace(/\s+$/, '') + (a.length && b.length ? ' ' : '') + b;
            const caretCol = a.replace(/\s+$/, '').length + (a.length && b.length ? 1 : 0);
            replaceDocRange(start, end, joined + (rc.row + 1 < lines.length - 1 ? '\n' : ''));
            // replaceDocRange leaves caret at end of insert; place at join point.
            setSingleCursor(start + caretCol, start + caretCol);
            queueRender();
            return true;
        }

        // Ctrl+] / Ctrl+[ — indent / outdent selected rows
        if(ctrl && !alt && (keyIn(key, KEY.BRACKET_RIGHT) || keyIn(key, KEY.BRACKET_LEFT)))
        {
            const indenting                 = keyIn(key, KEY.BRACKET_RIGHT);
            const {lines, rowStart, rowEnd} = selectedLineRange();
            const start                     = indexFromRowCol(lines, rowStart, 0);
            const end                       = lineBlockEnd(lines, rowStart, rowEnd);
            const chunk                     = doc.text.slice(start, end);
            const next                      = chunk.split('\n')
                                                  .map((line, i, arr) => {
                                 // Preserve trailing empty piece from final newline
                                 if(i === arr.length - 1 && line === '' && chunk.endsWith('\n')) return line;
                                 if(indenting) return indentUnit() + line;
                                 if(line.startsWith(indentUnit())) return line.slice(indentUnit().length);
                                 if(line.startsWith('\t')) return line.slice(1);
                                 if(line.startsWith(' ')) return line.replace(outdentPrefix(), '');
                                 return line;
                                                  })
                                                  .join('\n');
            replaceDocRange(start, end, next);
            setSingleCursor(start, start + next.length);
            queueRender();
            return true;
        }

        // Ctrl+Enter / Ctrl+Shift+Enter — newline below / above
        if(ctrl && !alt && keyIn(key, KEY.ENTER))
        {
            const lines = splitLines(doc.text);
            const rc    = rowColFromIndex(doc.text, doc.caret);
            if(shift)
            {
                const at = indexFromRowCol(lines, rc.row, 0);
                replaceDocRange(at, at, '\n');
                setSingleCursor(at, at);
            } else
            {
                const at = indexFromRowCol(lines, rc.row, (lines[rc.row] || '').length);
                replaceDocRange(at, at, '\n');
            }
            queueRender();
            return true;
        }

        // Alt+Up / Alt+Down — move line(s) (Atom Linux). Not Ctrl: that left
        // sticky-Ctrl looking like bare arrows were shuffling + selecting lines.
        if(alt && !ctrl && (keyIn(key, KEY.UP) || keyIn(key, KEY.DOWN)))
        {
            const down                      = keyIn(key, KEY.DOWN);
            const {lines, rowStart, rowEnd} = selectedLineRange();
            if(down && rowEnd >= lines.length - 1) return true;
            if(!down && rowStart <= 0) return true;
            const blockLines = lines.slice(rowStart, rowEnd + 1);
            const without    = lines.slice(0, rowStart).concat(lines.slice(rowEnd + 1));
            const at         = down ? rowStart + 1 : rowStart - 1;
            without.splice(at, 0, ...blockLines);
            pushUndoSnapshot(doc);
            const before = doc.text;
            doc.text     = without.join('\n');
            noteHighlightEdit(before, 0, before.length, doc.text);
            const span = rowEnd - rowStart;
            const a    = indexFromRowCol(without, at, 0);
            const b    = lineBlockEnd(without, at, at + span);
            setSingleCursor(a, b);
            followCaret = true;
            markDirty();
            queueRender();
            return true;
        }

        // Word motion / delete (ctrl-left/right/backspace/delete)
        if(ctrl && !alt && keyIn(key, KEY.LEFT))
        {
            moveCursorsBy((h) => indexWordLeft(doc.text, h), shift, null, 'start');
            queueRender();
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.RIGHT))
        {
            moveCursorsBy((h) => indexWordRight(doc.text, h), shift, null, 'end');
            queueRender();
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.BACKSPACE))
        {
            const result = applyMappedCursorsEdit(doc, (c) => {
                if(c.anchor !== c.head) return {start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head)};
                const from = indexWordLeft(doc.text, c.head);
                if(from >= c.head) return null;
                return {start: from, end: c.head};
            }, '', {pushUndo: pushUndoSnapshot, undoCoalesce});
            undoCoalesce = result.undoCoalesce;
            if(result.before != null)
            {
                followCaret = true;
                noteEditSites(result.before, result.list, '');
                markDirty();
            }
            queueRender();
            return true;
        }
        if(ctrl && !alt && keyIn(key, KEY.DELETE))
        {
            const result = applyMappedCursorsEdit(doc, (c) => {
                if(c.anchor !== c.head) return {start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head)};
                const to = indexWordRight(doc.text, c.head);
                if(to <= c.head) return null;
                return {start: c.head, end: to};
            }, '', {pushUndo: pushUndoSnapshot, undoCoalesce});
            undoCoalesce = result.undoCoalesce;
            if(result.before != null)
            {
                followCaret = true;
                noteEditSites(result.before, result.list, '');
                markDirty();
            }
            queueRender();
            return true;
        }

        if(keyIn(key, KEY.BACKSPACE))
        {
            const result = applyMappedCursorsEdit(doc, (c) => {
                if(c.anchor !== c.head) return {start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head)};
                if(c.head <= 0) return null;
                return {start: c.head - 1, end: c.head};
            }, '', {pushUndo: pushUndoSnapshot, undoCoalesce});
            undoCoalesce = result.undoCoalesce;
            if(result.before != null)
            {
                followCaret = true;
                noteEditSites(result.before, result.list, '');
                markDirty();
            }
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.DELETE))
        {
            const result = applyMappedCursorsEdit(doc, (c) => {
                if(c.anchor !== c.head) return {start: Math.min(c.anchor, c.head), end: Math.max(c.anchor, c.head)};
                if(c.head >= doc.text.length) return null;
                return {start: c.head, end: c.head + 1};
            }, '', {pushUndo: pushUndoSnapshot, undoCoalesce});
            undoCoalesce = result.undoCoalesce;
            if(result.before != null)
            {
                followCaret = true;
                noteEditSites(result.before, result.list, '');
                markDirty();
            }
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.ENTER) && !ctrl)
        {
            insertText('\n');
            queueRender();
            return true;
        }
        // Tab / Shift+Tab — insert soft-tab spaces, or indent/outdent lines
        if(keyIn(key, KEY.TAB) && !ctrl && !alt)
        {
            const unit   = indentUnit();
            const hasSel = !!selectionRange() || getCursors().some((c) => c.anchor !== c.head);
            if(shift || hasSel)
            {
                const indenting                 = !shift;
                const {lines, rowStart, rowEnd} = selectedLineRange();
                const start                     = indexFromRowCol(lines, rowStart, 0);
                const end                       = lineBlockEnd(lines, rowStart, rowEnd);
                const chunk                     = doc.text.slice(start, end);
                const next                      = chunk.split('\n')
                                                      .map((line, i, arr) => {
                                     if(i === arr.length - 1 && line === '' && chunk.endsWith('\n')) return line;
                                     if(indenting) return unit + line;
                                     if(line.startsWith(unit)) return line.slice(unit.length);
                                     if(line.startsWith('\t')) return line.slice(1);
                                     if(line.startsWith(' ')) return line.replace(outdentPrefix(), '');
                                     return line;
                                                      })
                                                      .join('\n');
                replaceDocRange(start, end, next);
                if(hasSel) setSingleCursor(start, start + next.length);
            } else
                insertText(unit);
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.LEFT) && !ctrl)
        {
            moveCursorsBy((h) => h - 1, shift, 'upstream', 'start');
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.RIGHT) && !ctrl)
        {
            moveCursorsBy((h) => h + 1, shift, 'downstream', 'end');
            queueRender();
            return true;
        }
        if((keyIn(key, KEY.UP) || keyIn(key, KEY.DOWN)) && !alt)
        {
            const lines  = getDocLines();
            const layout = getWrapLayout(lines);
            const dir    = keyIn(key, KEY.UP) ? -1 : 1;
            let affinity = null;
            transformCursors((c) => {
                const rc   = rowColFromIndex(doc.text, c.head);
                const vRow = visualRowAt(layout, rc.row, rc.col);
                const seg  = layout.segments[vRow] || {startCol: 0};
                let pref   = c.preferredColumn;
                if(pref === null) pref = Math.max(0, rc.col - (seg.startCol | 0));
                const nextV     = Math.max(0, Math.min(layout.visualCount - 1, vRow + dir));
                const nextSeg   = layout.segments[nextV];
                const targetCol = Math.max(nextSeg.startCol, Math.min(nextSeg.endCol, nextSeg.startCol + pref));
                affinity        = targetCol === nextSeg.startCol && nextSeg.startCol > 0 ?
                    'downstream' :
                    (targetCol === nextSeg.endCol && nextSeg.endCol < (lines[nextSeg.bufRow] || '').length ? 'upstream' : null);
                const head      = indexFromRowCol(lines, nextSeg.bufRow, targetCol);
                if(shift) return {anchor: c.anchor, head, preferredColumn: pref};
                return {anchor: head, head, preferredColumn: pref};
            }, affinity);
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.HOME))
        {
            if(ctrl)
                moveCaret(0, shift);
            else
            {
                const lines    = getDocLines();
                const wrapping = wrapEnabled();
                const layout   = wrapping ? getWrapLayout(lines) : null;
                transformCursors((c) => {
                    const rc = rowColFromIndex(doc.text, c.head);
                    let targetCol;
                    let aff = null;
                    if(wrapping && layout)
                    {
                        const vRow      = visualRowAt(layout, rc.row, rc.col);
                        const seg       = layout.segments[vRow] || {startCol: 0};
                        const wrapStart = seg.startCol | 0;
                        if(rc.col !== wrapStart)
                            targetCol = wrapStart;
                        else if(rc.col !== 0)
                            targetCol = 0;
                        else
                        {
                            const first = firstNonWhitespaceCol(lines[rc.row] || '');
                            targetCol   = first > 0 ? first : 0;
                        }
                        aff = 'downstream';
                    } else
                    {
                        const first = firstNonWhitespaceCol(lines[rc.row] || '');
                        targetCol   = rc.col === first ? 0 : first;
                    }
                    const head = indexFromRowCol(lines, rc.row, targetCol);
                    if(shift) return {anchor: c.anchor, head, preferredColumn: null};
                    return {anchor: head, head, preferredColumn: null};
                }, wrapping ? 'downstream' : null);
            }
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.END))
        {
            if(ctrl)
                moveCaret(doc.text.length, shift);
            else
            {
                const lines    = getDocLines();
                const wrapping = wrapEnabled();
                const layout   = wrapping ? getWrapLayout(lines) : null;
                let affinity   = null;
                transformCursors((c) => {
                    const rc      = rowColFromIndex(doc.text, c.head);
                    const lineLen = (lines[rc.row] || '').length;
                    let targetCol = lineLen;
                    if(wrapping && layout)
                    {
                        const vRow      = visualRowAt(layout, rc.row, rc.col);
                        const seg       = layout.segments[vRow] || {startCol: 0, endCol: lineLen};
                        const isLastSeg = vRow + 1 >= layout.visualCount || layout.segments[vRow + 1].bufRow !== rc.row;
                        const wrapEnd   = isLastSeg ? lineLen : (seg.endCol | 0);
                        targetCol       = rc.col !== wrapEnd ? wrapEnd : lineLen;
                        affinity        = (!isLastSeg && targetCol === wrapEnd) ? 'upstream' : null;
                    }
                    const head = indexFromRowCol(lines, rc.row, targetCol);
                    if(shift) return {anchor: c.anchor, head, preferredColumn: null};
                    return {anchor: head, head, preferredColumn: null};
                }, affinity);
            }
            queueRender();
            return true;
        }
        if(keyIn(key, KEY.PAGEUP) || keyIn(key, KEY.PAGEDOWN))
        {
            if(ctrl) return false;  // handled above as tab switch
            const pageLines = Math.max(1, Math.floor(viewportHeight / lineAdvance) - 1);
            const lines     = getDocLines();
            const layout    = getWrapLayout(lines);
            const delta     = keyIn(key, KEY.PAGEUP) ? -pageLines : pageLines;
            transformCursors((c) => {
                const rc   = rowColFromIndex(doc.text, c.head);
                const vRow = visualRowAt(layout, rc.row, rc.col);
                const seg  = layout.segments[vRow] || {startCol: 0};
                let pref   = c.preferredColumn;
                if(pref === null) pref = Math.max(0, rc.col - (seg.startCol | 0));
                const nextV     = Math.max(0, Math.min(layout.visualCount - 1, vRow + delta));
                const nextSeg   = layout.segments[nextV];
                const targetCol = Math.max(nextSeg.startCol, Math.min(nextSeg.endCol, nextSeg.startCol + pref));
                const head      = indexFromRowCol(lines, nextSeg.bufRow, targetCol);
                if(shift) return {anchor: c.anchor, head, preferredColumn: pref};
                return {anchor: head, head, preferredColumn: pref};
            }, 'downstream');
            queueRender();
            return true;
        }
        return false;
    };

    /** Map a point in editorClip-local space to a document UTF-16 index. */
    const hitIndexAtLocal = async (local) => {
        if(!doc || !local) return 0;
        const lines  = getDocLines();
        const layout = getWrapLayout(lines);
        const y      = (local.y || 0) + (doc.scrollY || 0);
        const vRow   = Math.max(0, Math.min(layout.visualCount - 1, Math.floor((y - PAD_Y) / Math.max(1, lineAdvance))));
        const seg    = layout.segments[vRow] || {bufRow: 0, startCol: 0, endCol: 0, text: ''};
        const lineEl = lineEls.find((entry) => entry.row === vRow);
        let localCol = 0;
        const x      = Math.max(0, (local.x || 0) + (doc.scrollX || 0) - PAD_X);
        const segLen = (seg.text || '').length;
        if(lineEl)
        {
            try
            {
                const hit = await UI.hitTestText(win, lineEl.id, {x, y: lineAdvance * 0.5});
                if(typeof hit === 'number' && !Number.isNaN(hit))
                    localCol = Math.max(0, Math.min(segLen, hit));
                else
                    localCol = Math.max(0, Math.min(segLen, Math.round(x / charWidth)));
            } catch(e)
            {
                void e;
                localCol = Math.max(0, Math.min(segLen, Math.round(x / charWidth)));
            }
        } else
            localCol = Math.max(0, Math.min(segLen, Math.round(x / charWidth)));

        const col       = (seg.startCol | 0) + localCol;
        const lineLen   = (lines[seg.bufRow] || '').length;
        const isLastSeg = vRow + 1 >= layout.visualCount || layout.segments[vRow + 1].bufRow !== seg.bufRow;
        // Bias affinity toward the visual row that was clicked.
        if((seg.startCol | 0) > 0 && localCol === 0)
            doc.caretAffinity = 'downstream';
        else if(!isLastSeg && col === (seg.endCol | 0))
            doc.caretAffinity = 'upstream';
        else
            doc.caretAffinity = localCol === 0 ? 'downstream' : null;

        return indexFromRowCol(lines, seg.bufRow, col);
    };

    /** editorClip-local point from a canvas/window point. */
    const localFromWindow = async (wp) => {
        if(!wp) return null;
        try
        {
            const clip = await UI.getElementFrame(win, editorClip);
            const minX = clip?.min?.x;
            const minY = clip?.min?.y;
            if(typeof minX !== 'number' || typeof minY !== 'number') return null;
            return {x: (wp.x || 0) - minX, y: (wp.y || 0) - minY};
        } catch(e)
        {
            void e;
            return null;
        }
    };

    let selecting = false;
    /** Double-click word select (no Helix double-click event). */
    let lastClick      = {time: 0, index: -1};
    const DBL_CLICK_MS = 400;

    // Bind move/up only while selecting. A permanent frame move/up handler would
    // steal events from the tree splitter (Helix walks to the nearest handler).
    const endMouseSelect = async () => {
        if(!selecting) return;
        selecting = false;
        await Promise.all([settled(UI.setOnMouseMove(win, frame, null)), settled(UI.setOnMouseUp(win, frame, null))]);
        if(doc) ensureCursors(doc);
        queueRender();
    };

    const endScrollBarDrag = async () => {
        if(!scrollBarDragging) return;
        scrollBarDragging = false;
        await Promise.all([settled(UI.setOnMouseMove(win, frame, null)), settled(UI.setOnMouseUp(win, frame, null))]);
        try
        {
            await UI.setBoxColour(win, scrollBarThumb, theme.scrollbarThumb || [0.66, 0.66, 0.67, 0.52]);
        } catch(e)
        {
            void e;
        }
    };

    await UI.setOnMouseDown(win, scrollBarTrack, async (wp, local) => {
        if(!doc || !scrollBarGeom.visible) return;
        const y                = local?.y || 0;
        const {thumbY, thumbH} = scrollBarGeom;
        if(y >= thumbY && y < thumbY + thumbH)
        {
            scrollBarDragging      = true;
            scrollBarDragOriginY   = wp?.y || 0;
            scrollBarDragOriginRow = rowFromScrollY();
            try
            {
                await UI.setBoxColour(win, scrollBarThumb, theme.scrollbarThumbActive || theme.scrollbarThumb);
            } catch(e)
            {
                void e;
            }
            await UI.setOnMouseMove(win, frame, async (moveWp) => {
                if(!scrollBarDragging || !doc) return;
                const maxRow = maxScrollRow();
                if(maxRow <= 0) return;
                const travel = Math.max(1, scrollBarGeom.trackH - scrollBarGeom.thumbH);
                const dy     = (moveWp?.y || 0) - scrollBarDragOriginY;
                const next   = scrollBarDragOriginRow + Math.round((dy / travel) * maxRow);
                if(next === rowFromScrollY()) return;
                scrollToRow(next);
                clampScroll();
                queueRender();
            });
            await UI.setOnMouseUp(win, frame, endScrollBarDrag);
            return;
        }
        // Click in track: jump so the thumb centers on the click.
        scrollToRow(rowFromTrackY(y, thumbH));
        clampScroll();
        queueRender();
    });

    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, scrollBarTrack, async () => {
            try
            {
                await Compositor.setCursor(win, 'default');
            } catch(e)
            {
                void e;
            }
            if(scrollBarGeom.visible && !scrollBarDragging)
            {
                try
                {
                    await UI.setBoxColour(win, scrollBarThumb, theme.scrollbarThumbHover || theme.scrollbarThumb);
                } catch(e)
                {
                    void e;
                }
            }
        });
    }
    if(typeof UI.setOnMouseExit === 'function')
    {
        await UI.setOnMouseExit(win, scrollBarTrack, async () => {
            if(scrollBarDragging) return;
            try
            {
                await UI.setBoxColour(win, scrollBarThumb, theme.scrollbarThumb || [0.66, 0.66, 0.67, 0.52]);
            } catch(e)
            {
                void e;
            }
        });
    }

    await UI.setOnMouseDown(win, editorClip, async (_wp, local) => {
        focused = true;
        try { onFocus(); } catch(e) { void e; }
        if(!doc || !local) return;
        ensureCursors(doc);
        const extend   = mods.hasShift();
        const add      = mods.hasCtrl() && !extend;
        const next     = await hitIndexAtLocal(local);
        const now      = Date.now();
        const isDouble = !extend && (now - lastClick.time) <= DBL_CLICK_MS && lastClick.index >= 0 && Math.abs(next - lastClick.index) <= 1;
        lastClick      = {time: now, index: next};

        if(isDouble)
        {
            const range = wordRangeAt(doc.text, next);
            if(add)
                commitPrimaryAndFocus({anchor: range.start, head: range.end});
            else
                setSingleCursor(range.start, range.end);
            lastClick   = {time: 0, index: -1};
            selecting   = true;
            followCaret = false;
            queueRender();
            await UI.setOnMouseMove(win, frame, async (wp) => {
                if(!selecting || !doc) return;
                const localPt = await localFromWindow(wp);
                if(!localPt) return;
                const at = await hitIndexAtLocal(localPt);
                updatePrimary((c) => {
                    if(at === c.head) return c;
                    return createCursor(c.anchor, at, null);
                });
                followCaret = false;
                queueRender();
            });
            await UI.setOnMouseUp(win, frame, endMouseSelect);
            return;
        }

        if(add)
        {
            // Keep existing cursors (including collapsed) and start a new primary.
            commitPrimaryAndFocus({anchor: next, head: next});
        } else if(extend)
        {
            updatePrimary((c) => createCursor(c.anchor === c.head ? c.head : c.anchor, next, null));
        } else
            setSingleCursor(next, next);

        selecting   = true;
        followCaret = false;
        queueRender();

        await UI.setOnMouseMove(win, frame, async (wp) => {
            if(!selecting || !doc) return;
            const localPt = await localFromWindow(wp);
            if(!localPt) return;
            const at = await hitIndexAtLocal(localPt);
            updatePrimary((c) => {
                if(at === c.head) return c;
                return createCursor(c.anchor, at, null);
            });
            followCaret = false;
            queueRender();
        });
        await UI.setOnMouseUp(win, frame, endMouseSelect);
    });

    // Wayland axis delta → whole lines. Paint only via queueRender so scroll
    // never races a document paint against the same slot pools (that SEGV'd).
    await UI.setOnMouseScroll(win, frame, async (_wp, _lp, delta) => {
        if(!doc) return;
        const dy = typeof delta === 'number' ? delta : (delta?.y || 0);
        if(!dy) return;
        const beforeRow = rowFromScrollY();
        const lineDelta = Math.round((dy / WHEEL_AXIS_STEP) * WHEEL_LINES_PER_STEP);
        if(!lineDelta) return;
        doc.scrollY = scrollYFromRow(beforeRow + lineDelta);
        clampScroll();
        if(rowFromScrollY() === beforeRow) return;
        followCaret = false;
        queueRender();
    });

    try
    {
        await Compositor.setCursor(win, 'text');
    } catch(e)
    {
        void e;
    }
    if(typeof UI.setOnMouseEnter === 'function')
    {
        await UI.setOnMouseEnter(win, frame, async () => {
            try
            {
                await Compositor.setCursor(win, 'text');
            } catch(e)
            {
                void e;
            }
        });
    }

    return {
        root: frame,
        mods,
        setViewportSize(size) {
            if(size?.x) viewportWidth = Math.max(1, size.x);
            if(size?.y) viewportHeight = Math.max(1, size.y);
        },
        async syncLayout() {
            const changed = await syncViewportFromLayout();
            if(changed) queueRender();
            return changed;
        },
        setDocument(next) {
            // Same buffer already bound — do not wipe highlight cache / colour areas.
            if(next === doc)
            {
                if(next) focused = true;
                return;
            }
            if(selecting)
            {
                selecting = false;
                void Promise.all([UI.setOnMouseMove(win, frame, null), UI.setOnMouseUp(win, frame, null)]);
            }
            doc     = next;
            focused = true;
            if(doc) ensureCursors(doc);
            lastColourKey = '';
            lastStatus    = '';
            lastHostW     = -1;
            lastHostH     = -1;
            undoCoalesce  = null;
            hlJobToken++;
            hlInFlight = false;
            hlPending  = null;
            if(hlTimer)
            {
                clearTimeout(hlTimer);
                hlTimer = null;
            }
            hlCache   = {source: null, lexedSource: null, path: null, colour: null, spans: [], lineRuns: [], version: 0};
            lineCache = {path: null, text: null, lines: null, utf16Starts: null, cpStarts: null};
            if(doc) rebuildLineCache(doc.text, doc.path);
            invalidateWrap();
            rowHlEpoch = [];
            // Drop previous file's colour areas on pooled rows — clearing areaIds alone
            // left engine areas attached and painted as noise on unsupported files.
            void clearAllLineColourAreas();
            for(const entry of lineEls)
            {
                entry.rowHlEpoch = -1;
                entry.row        = -1;
                entry.text       = '';
            }
            lineMarksBySource.clear();
            lineMarkEpoch++;
            firstVisibleRow = doc ? rowFromScrollY() : 0;
            followCaret     = true;
            queueRender();
        },
        getDocument() {
            return doc;
        },
        setLineMarks,
        clearLineMarks,
        getWordWrap() {
            return wrapEnabled();
        },
        setWordWrap(on) {
            const next = !!on;
            if(editorSettings.wordWrap === next) return;
            editorSettings.wordWrap = next;
            invalidateWrap();
            if(next && doc) doc.scrollX = 0;
            lastHostW   = -1;
            lastHostH   = -1;
            followCaret = true;
            queueRender();
        },
        toggleWordWrap() {
            this.setWordWrap(!wrapEnabled());
        },
        focus() {
            if(focused) return;
            focused = true;
            mods.clear();
            queueRender();
        },
        blur() {
            if(!focused) return;
            focused = false;
            mods.clear();
            queueRender();
        },
        async reapplyTheme() {
            lastColourKey = '';
            await clearAllLineColourAreas();
            for(const entry of lineEls)
            {
                entry.rowHlEpoch = -1;
                entry.selKey = '';
            }
            try
            {
                await Promise.all([
                    settled(UI.setBoxColour(win, frame, theme.bg)),
                    settled(UI.setBoxColour(win, editorClip, theme.bg)),
                    settled(UI.setBoxColour(win, gutterClip, theme.bg)),
                    settled(UI.setBoxColour(win, activeLineBg, theme.activeLine || theme.panelAlt)),
                    settled(UI.setBoxColour(win, activeLineAccent, theme.primary)),
                    settled(UI.setBoxColour(win, activeGutterBg, theme.activeLine || theme.panelAlt))
                ]);
            }
            catch(e) { void e; }
            for(const el of caretEls)
            {
                try { await settled(UI.setBoxColour(win, el, theme.caret)); }
                catch(e) { void e; }
            }
            if(doc)
            {
                hlJobToken++;
                hlInFlight = false;
                hlPending = null;
                if(hlTimer)
                {
                    clearTimeout(hlTimer);
                    hlTimer = null;
                }
                hlCache = {source: null, lexedSource: null, path: null, colour: null, spans: [], lineRuns: [], version: 0};
                scheduleHighlight(doc.text, doc.path, doc.language);
            }
            queueRender();
        },
        queueRender,
        dispose() {},
        async onTextInput(text) {
            if(!focused || !doc) return;
            // Ctrl/Alt chords (e.g. Atom Ctrl+A) must not insert characters.
            if(mods.hasCtrl() || mods.hasAlt()) return;
            // Tab key is handled in onKey (soft-tab spaces). Ignore bare \\t from
            // textInput so we do not double-indent when both events fire.
            if(text === '\t') return;
            insertText(text);
            queueRender();
        },
        async onKey(key) {
            return handleKey(key);
        }
    };
}
