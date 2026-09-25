// The six sticky-note colours, lowest to highest pitch (C major pentatonic),
// and how to tell them apart. Pure JS (no DOM/OpenCV).
//
// `rgb` is the default reference colour of each note as seen by the camera.
// Real cameras/projectors shift colours, so the control window lets you
// "teach" each colour by clicking a real note; that palette replaces these.

export const NOTE_COLORS = [
  { name: 'purple', rgb: [150, 90, 220], freq: 261.63 }, // C4
  { name: 'blue', rgb: [80, 190, 245], freq: 293.66 }, // D4
  { name: 'green', rgb: [120, 225, 90], freq: 329.63 }, // E4
  { name: 'yellow', rgb: [250, 228, 70], freq: 392.0 }, // G4
  { name: 'orange', rgb: [255, 150, 60], freq: 440.0 }, // A4
  { name: 'red', rgb: [240, 60, 70], freq: 523.25 }, // C5
];

export const DEFAULT_PALETTE = Object.fromEntries(NOTE_COLORS.map((c) => [c.name, c.rgb]));

export function freqOf(name) {
  return NOTE_COLORS.find((c) => c.name === name)?.freq;
}

// Hue in degrees [0, 360).
export function hueOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// Name of the palette colour with the nearest hue. Hue ignores brightness, so
// shadows and projector light change it much less than raw RGB.
export function classifyColor(rgb, palette = DEFAULT_PALETTE) {
  const h = hueOf(rgb);
  let best = null;
  let bestD = Infinity;
  for (const [name, ref] of Object.entries(palette)) {
    const d = Math.abs(h - hueOf(ref));
    const circ = Math.min(d, 360 - d);
    if (circ < bestD) {
      bestD = circ;
      best = name;
    }
  }
  return best;
}
