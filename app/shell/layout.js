import * as UI from 'Helix/UserInterface';

const MAX_UI_TEXT_W = 480;
const MAX_UI_TEXT_H = 64;

function finitePositive(n, fallback)
{
    const v = Number(n);
    if(!Number.isFinite(v) || v <= 0) return fallback;
    return v;
}

/**
 * Koya flow layout only uses numeric item.size for slot dimensions.
 * Clamp all measured sizes — unbounded atlas/layout sizes can wedge the GPU.
 */
export async function sizeTextElement(win, textId, fallback = {
    x: 8,
    y: 16
})
{
    let w = fallback.x;
    let h = fallback.y;
    try
    {
        const metrics = await UI.measureText(win, textId);
        w             = finitePositive(metrics && metrics.size && metrics.size.x, fallback.x);
        h             = finitePositive((metrics && metrics.size && metrics.size.y) || (metrics && metrics.lineAdvance), fallback.y);
    } catch(error)
    {
        void error;
    }

    w = Math.min(MAX_UI_TEXT_W, Math.max(1, Math.ceil(w)));
    h = Math.min(MAX_UI_TEXT_H, Math.max(1, Math.ceil(h)));
    await UI.setLayoutSize(win, textId, {x: w, y: h});
    return {x: w, y: h};
}

/** Cheap width estimate for monospace/UI labels — avoids measureText storms. */
export function estimateLabelSize(text, fontSize, maxWidth)
{
    const chars = String(text || '').length;
    const w     = Math.min(maxWidth, Math.max(8, Math.ceil(chars * fontSize * 0.62)));
    const h     = Math.max(14, Math.ceil(fontSize + 4));
    return {x: w, y: h};
}

/** Normalize getElementFrame / Rect into { x, y } pixel size. */
export function frameSize(frame)
{
    if(!frame) return {x: 0, y: 0};
    if(frame.size && typeof frame.size.x === 'number')
        return {x: Math.max(0, frame.size.x || 0), y: Math.max(0, frame.size.y || 0)};
    if(frame.max && frame.min)
    {
        return {
            x: Math.max(0, (frame.max.x || 0) - (frame.min.x || 0)),
            y: Math.max(0, (frame.max.y || 0) - (frame.min.y || 0))
        };
    }
    return {
        x: Math.max(0, frame.width || frame.x || 0),
        y: Math.max(0, frame.height || frame.y || 0)
    };
}
