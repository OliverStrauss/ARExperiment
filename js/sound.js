// Web Audio output. Browsers keep an AudioContext suspended until the page gets
// a click or key press, so unlock() is called on those.
//
// Hits are scheduled ahead on the epoch clock both windows share (beat.js
// epochNow); audioTime() converts that to AudioContext time so each note starts
// sample-accurately when it is *heard* at that epoch time.

import { epochNow } from './beat.js';

let ctx = null;
let offset = null; // AudioContext time - epoch time, smoothed

export function unlock() {
  ctx ??= new AudioContext();
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
 * Plucked-bell tone.
 * @param freq Hz  @param strength 0..1  @param when epoch s (default: now)
 */
export function playTone(freq, strength = 1, when = null) {
  if (!soundReady()) return;
  const t = when == null ? ctx.currentTime : audioTime(when);
  const peak = 0.05 + 0.25 * Math.min(1, Math.max(0, strength));
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
  gain.connect(ctx.destination);
  // fundamental + a quiet octave for a bit of shimmer
  for (const [mult, level] of [[1, 1], [2, 0.3]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq * mult;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(gain);
    osc.start(t);
    osc.stop(t + 1.25);
  }
}
