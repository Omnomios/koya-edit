/**
 * Track the last pointer button for the window.
 * Element mouse handlers only receive coordinates; button comes from Event.pointerDown
 * (Linux evdev: 272 left / 273 right / 274 middle).
 */
import * as Event from 'Helix/Event';

export const BTN_LEFT = 272;
export const BTN_RIGHT = 273;
export const BTN_MIDDLE = 274;

/**
 * @param {number} win
 * @returns {{ last: () => number, isLeft: () => boolean, isRight: () => boolean, isMiddle: () => boolean }}
 */
export function installPointerButtonTracker(win)
{
    let last = BTN_LEFT;
    Event.on('pointerDown', ({button, id}) => {
        if(id !== undefined && id !== win) return;
        last = button | 0;
    });
    return {
        last: () => last,
        isLeft: () => last === BTN_LEFT,
        isRight: () => last === BTN_RIGHT,
        isMiddle: () => last === BTN_MIDDLE
    };
}
