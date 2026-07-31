/** Linux evdev key codes used by the editor (Atom-compatible bindings). */
export const KEY = {
    ESCAPE: new Set([1]),
    BACKSPACE: new Set([14]),
    ENTER: new Set([28, 96]),
    TAB: new Set([15]),
    LEFT: new Set([105]),
    RIGHT: new Set([106]),
    UP: new Set([103]),
    DOWN: new Set([108]),
    HOME: new Set([102]),
    END: new Set([107]),
    DELETE: new Set([111]),
    PAGEUP: new Set([104]),
    PAGEDOWN: new Set([109]),
    LEFT_CTRL: new Set([29]),
    RIGHT_CTRL: new Set([97]),
    LEFT_SHIFT: new Set([42]),
    RIGHT_SHIFT: new Set([54]),
    LEFT_ALT: new Set([56]),
    RIGHT_ALT: new Set([100]),
    LEFT_META: new Set([125]),
    RIGHT_META: new Set([126]),
    A: new Set([30]),
    C: new Set([46]),
    D: new Set([32]),
    J: new Set([36]),
    K: new Set([37]),
    L: new Set([38]),
    N: new Set([49]),
    S: new Set([31]),
    V: new Set([47]),
    W: new Set([17]),
    X: new Set([45]),
    Y: new Set([21]),
    Z: new Set([44]),
    P: new Set([25]),
    /** `[` */
    BRACKET_LEFT: new Set([26]),
    /** `]` */
    BRACKET_RIGHT: new Set([27]),
    SLASH: new Set([53]),
    F4: new Set([62]),
    Q: new Set([16])
};

const CTRL_CODES     = [...KEY.LEFT_CTRL, ...KEY.RIGHT_CTRL];
const SHIFT_CODES    = [...KEY.LEFT_SHIFT, ...KEY.RIGHT_SHIFT];
const ALT_CODES      = [...KEY.LEFT_ALT, ...KEY.RIGHT_ALT];
const META_CODES     = [...KEY.LEFT_META, ...KEY.RIGHT_META];
const MODIFIER_CODES = new Set([...CTRL_CODES, ...SHIFT_CODES, ...ALT_CODES, ...META_CODES]);

export function keyIn(key, set)
{
    return set.has(key);
}

/**
 * Tracks modifier keys only. Non-modifier keyDowns must not enter the set —
 * and Meta is not treated as Ctrl (unlike some macOS-oriented trackers).
 */
export function createModifierTracker()
{
    const pressed = new Set();
    return {
        down(key) {
            if(MODIFIER_CODES.has(key)) pressed.add(key);
        },
        up(key) {
            pressed.delete(key);
        },
        clear() {
            pressed.clear();
        },
        hasCtrl() {
            return CTRL_CODES.some((code) => pressed.has(code));
        },
        hasShift() {
            return SHIFT_CODES.some((code) => pressed.has(code));
        },
        hasAlt() {
            return ALT_CODES.some((code) => pressed.has(code));
        },
        hasMeta() {
            return META_CODES.some((code) => pressed.has(code));
        }
    };
}
