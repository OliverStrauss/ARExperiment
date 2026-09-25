// Web Audio synth voices. Every voice is pitched by the note's colour; the
// drums sit two octaves (kick) or one octave (tom) below it so they sound like
// drums rather than blips.
//
// playVoice() only builds nodes on the context it is given, so this module can
// be imported without a browser (the list is used by the ring and the tests).

export const INSTRUMENTS = ['bell', 'pluck', 'marimba', 'pad', 'bass', 'kick', 'tom'];

/**
 * @param ac   AudioContext   @param out destination node
 * @param id   instrument id  @param freq Hz  @param t start (context time)
 * @param velocity 0..1
 */
export function playVoice(ac, out, id, freq, t, velocity = 1) {
  const v = 0.05 + 0.3 * Math.min(1, Math.max(0, velocity));
  (VOICES[id] || VOICES.bell)(ac, out, freq, t, v);
}

function env(ac, out, t, peak, decay, attack = 0.002) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function osc(ac, type, freq, t, dur, dest) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

let satCurve = null;
function saturation() {
  if (!satCurve) {
    satCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) satCurve[i] = Math.tanh(2.5 * ((i / 1023) * 2 - 1));
  }
  return satCurve;
}

const VOICES = {
  // triangle + a quiet octave
  bell(ac, out, f, t, v) {
    const g = env(ac, out, t, v, 1.2);
    osc(ac, 'triangle', f, t, 1.2, g);
    const o2 = ac.createGain();
    o2.gain.value = 0.3;
    o2.connect(g);
    osc(ac, 'triangle', f * 2, t, 1.2, o2);
  },
  // saw through a lowpass that closes fast
  pluck(ac, out, f, t, v) {
    const g = env(ac, out, t, v * 0.8, 0.45);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(Math.min(12000, f * 12), t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.2, t + 0.18);
    lp.connect(g);
    osc(ac, 'sawtooth', f, t, 0.5, lp);
  },
  // sine + a short 4x partial
  marimba(ac, out, f, t, v) {
    osc(ac, 'sine', f, t, 0.45, env(ac, out, t, v, 0.4));
    osc(ac, 'sine', f * 4, t, 0.12, env(ac, out, t, v * 0.25, 0.08));
  },
  // two detuned saws, slow attack, long release
  pad(ac, out, f, t, v) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v * 0.5, t + 0.08);
    g.gain.setValueAtTime(v * 0.5, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    g.connect(out);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(8000, f * 5);
    lp.connect(g);
    for (const cents of [-8, 8]) osc(ac, 'sawtooth', f, t, 1.4, lp).detune.setValueAtTime(cents, t);
  },
  // sine an octave down, a little saturation
  bass(ac, out, f, t, v) {
    const g = env(ac, out, t, v, 0.6, 0.005);
    const sh = ac.createWaveShaper();
    sh.curve = saturation();
    sh.connect(g);
    const pre = ac.createGain();
    pre.gain.value = 0.8;
    pre.connect(sh);
    osc(ac, 'sine', f / 2, t, 0.6, pre);
  },
  // sine, pitch sweep 4x -> 1x over 60 ms
  kick(ac, out, f, t, v) {
    const base = f / 4;
    const o = osc(ac, 'sine', base * 4, t, 0.35, env(ac, out, t, v * 1.4, 0.35, 0.001));
    o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
  },
  // as kick, sweep 2x -> 1x
  tom(ac, out, f, t, v) {
    const base = f / 2;
    const o = osc(ac, 'sine', base * 2, t, 0.25, env(ac, out, t, v * 1.2, 0.25, 0.001));
    o.frequency.exponentialRampToValueAtTime(base, t + 0.06);
  },
};
