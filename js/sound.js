// Plucked-bell tones via Web Audio. Browsers keep an AudioContext suspended
// until the page gets a click or key press, so unlock() is called on those.

let ctx = null;

export function unlock() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

export function soundReady() {
  return ctx?.state === 'running';
}

/** @param freq Hz  @param strength 0..1 (impact speed) */
export function playTone(freq, strength = 1) {
  if (!soundReady()) return;
  const t = ctx.currentTime;
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
