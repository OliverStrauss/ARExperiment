// Web Audio output. Browsers keep an AudioContext suspended until the page gets
// a click or key press, so unlock() is called on those.
//
// Hits are scheduled ahead on the epoch clock both windows share (beat.js
// epochNow); audioTime() converts that to AudioContext time so each note starts
// sample-accurately when it is *heard* at that epoch time.

import { epochNow } from './beat.js';
import { playVoice } from './instruments.js';

let ctx = null;
let out = null; // master bus: a compressor so stacked hits don't clip
let offset = null; // AudioContext time - epoch time, smoothed

export function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createDynamicsCompressor();
    out.threshold.value = -12;
    out.ratio.value = 6;
    out.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function soundReady() {
  return ctx?.state === 'running';
}

/** AudioContext time at which a sound is heard at epoch time `t` (s). */
export function audioTime(t) {
  const ts = ctx.getOutputTimestamp?.();
  let est;
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
    // contextTime is being heard at performanceTime
    est = ts.contextTime - (performance.timeOrigin + ts.performanceTime) / 1000;
  } else {
    est = ctx.currentTime - epochNow() - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  // the estimate jitters by a few ms per call; smooth it unless it jumped
  offset = offset == null || Math.abs(est - offset) > 0.05 ? est : offset + (est - offset) * 0.1;
  return Math.max(ctx.currentTime, t + offset);
}

/**
 * @param instrument id from instruments.js  @param freq Hz
 * @param velocity 0..1  @param when epoch s (default: now)
 */
export function playNote(instrument, freq, velocity = 1, when = null) {
  if (!soundReady()) return;
  playVoice(ctx, out, instrument, freq, when == null ? ctx.currentTime : audioTime(when), velocity);
}

/** The default bell, e.g. to preview a colour's pitch. */
export function playTone(freq, velocity = 1, when = null) {
  playNote('bell', freq, velocity, when);
}
