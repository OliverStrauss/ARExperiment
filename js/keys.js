// Keyboard map shared by both windows (pure JS). The projector forwards its key
// presses to the control window, which owns the beat engine, so both behave
// the same. F (fullscreen) is handled by the projector itself.

import { NOTE_COLORS } from './colors.js';

/**
 * @param k { key, code, shift } as in a KeyboardEvent
 * @returns { action, arg?, cap } or null. `cap` is the keycap shown in the toast.
 */
export function keyAction({ key, code, shift }) {
  const digit = /^Digit([1-6])$/.exec(code || '');
  if (digit) {
    const color = NOTE_COLORS[Number(digit[1]) - 1].name;
    return { action: shift ? 'solo' : 'mute', arg: color, cap: `${shift ? '⇧' : ''}${digit[1]}` };
  }
  if (code === 'BracketLeft' || code === 'BracketRight') {
    const up = code === 'BracketRight';
    return { action: 'tempo', arg: (up ? 1 : -1) * (shift ? 10 : 2), cap: `${shift ? '⇧' : ''}${up ? ']' : '['}` };
  }
  if (key === '?' || (code === 'Slash' && shift)) return { action: 'help', cap: '?' };
  const k = (key || '').length === 1 ? key.toLowerCase() : key;
  const cap = (c) => `${shift ? '⇧' : ''}${c}`;
  switch (k) {
    case ' ': return { action: 'toggleRun', cap: 'Space' };
    case 's': return { action: 'snap', cap: 'S' };
    case 'Tab': return { action: 'lane', arg: shift ? -1 : 1, cap: cap('Tab') };
    case 'b': return { action: shift ? 'removeBall' : 'addBall', cap: cap('B') };
    case 'a': return { action: 'nudge', arg: -1, cap: 'A' };
    case 'd': return { action: 'nudge', arg: 1, cap: 'D' };
    case 'ArrowLeft': return { action: 'spin', arg: -1, cap: '←' };
    case 'ArrowRight': return { action: 'spin', arg: 1, cap: '→' };
    case 'Enter': return { action: 'ringCommit', cap: '↵' };
    case 'Escape': return { action: 'ringCancel', cap: 'Esc' };
    case 'e': return { action: 'openRing', cap: 'E' };
    case 'k': return { action: 'keep', cap: 'K' };
    case 'x': return { action: 'clearLayers', cap: 'X' };
    case 'z': return { action: 'undoKeep', cap: 'Z' };
    case 'r': return { action: 'reset', cap: 'R' };
    case 'f': return { action: 'fullscreen', cap: 'F' };
    default: return null;
  }
}

// Shown by the ? overlay on the wall and in the control window.
export const KEY_HELP = [
  ['Space', 'start / stop clock'],
  ['[ ]', 'tempo −/+ 2 (⇧ ±10)'],
  ['S', 'snap on / off'],
  ['Tab ⇧Tab', 'next / previous lane'],
  ['B ⇧B', 'add / remove ball'],
  ['A D', 'nudge lane left / right'],
  ['E', 'instrument ring on the lane target'],
  ['← →  ↵  Esc', 'ring: spin · keep · cancel'],
  ['K X Z', 'keep 4 bars · clear · undo keep'],
  ['1–6 ⇧1–6', 'mute / solo a colour'],
  ['R', 'reset balls'],
  ['F', 'fullscreen (projector)'],
  ['?', 'this help'],
];
