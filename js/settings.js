// Persistent settings (localStorage). Both windows share the same origin, so
// they also share this storage.

// v3: adds localChroma (lighting-tolerant detection); v2 was far-away walls / smaller ball
const KEY = 'sticky-wall.settings.v3';
const CALIB_KEY = 'sticky-wall.calibration.v1';

// Slider schema: drives both the defaults and the generated UI in control.html.
// Areas are a percentage of the camera frame so they survive resolution changes.
export const SLIDERS = [
  { key: 'hMin', group: 'HSV threshold', label: 'Hue min', min: 0, max: 179, step: 1, def: 0 },
  { key: 'hMax', group: 'HSV threshold', label: 'Hue max', min: 0, max: 179, step: 1, def: 179 },
  { key: 'sMin', group: 'HSV threshold', label: 'Sat min', min: 0, max: 255, step: 1, def: 70 },
  { key: 'sMax', group: 'HSV threshold', label: 'Sat max', min: 0, max: 255, step: 1, def: 255 },
  { key: 'vMin', group: 'HSV threshold', label: 'Val min', min: 0, max: 255, step: 1, def: 70 },
  { key: 'vMax', group: 'HSV threshold', label: 'Val max', min: 0, max: 255, step: 1, def: 255 },
  { key: 'localChroma', group: 'HSV threshold', label: 'Local chroma (0 = off, ignores Sat/Val min)', min: 0, max: 60, step: 1, def: 14 },
  { key: 'morph', group: 'Mask cleanup', label: 'Morph kernel px', min: 1, max: 21, step: 2, def: 5 },
  { key: 'procWidth', group: 'Mask cleanup', label: 'Process width px', min: 320, max: 1280, step: 160, def: 960 },
  { key: 'minArea', group: 'Note filter', label: 'Min area % of frame', min: 0.005, max: 2, step: 0.005, def: 0.02 },
  { key: 'maxArea', group: 'Note filter', label: 'Max area % of frame', min: 0.5, max: 30, step: 0.1, def: 8 },
  { key: 'minRect', group: 'Note filter', label: 'Min rectangularity', min: 0, max: 1, step: 0.05, def: 0.6 },
  { key: 'rate', group: 'Detection', label: 'Detection rate Hz', min: 0.5, max: 10, step: 0.5, def: 3 },
  { key: 'seenN', group: 'Tracking (anti-flicker)', label: 'Frames to add', min: 1, max: 10, step: 1, def: 3 },
  { key: 'missM', group: 'Tracking (anti-flicker)', label: 'Frames to remove', min: 1, max: 15, step: 1, def: 5 },
  { key: 'smooth', group: 'Tracking (anti-flicker)', label: 'Smoothing', min: 0, max: 0.9, step: 0.05, def: 0.5 },
  { key: 'matchDist', group: 'Tracking (anti-flicker)', label: 'Match distance', min: 0.01, max: 0.2, step: 0.01, def: 0.06 },
  { key: 'ballRadius', group: 'Ball', label: 'Ball size', min: 0.003, max: 0.05, step: 0.001, def: 0.012 },
  { key: 'ballSpeed', group: 'Ball', label: 'Ball speed (bounce)', min: 0.05, max: 1.5, step: 0.05, def: 0.45 },
  { key: 'ballPad', group: 'Ball mask', label: 'Radius multiplier', min: 1, max: 4, step: 0.1, def: 1.8 },
  { key: 'ballLag', group: 'Ball mask', label: 'Camera lag s', min: 0, max: 0.6, step: 0.05, def: 0.25 },
];

export const DEFAULTS = {
  ...Object.fromEntries(SLIDERS.map((s) => [s.key, s.def])),
  deviceId: '',
  roiOnly: true, // only detect inside the calibrated projection area
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private window) - settings just won't persist */
  }
}

export function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveCalibration(calib) {
  try {
    if (calib) localStorage.setItem(CALIB_KEY, JSON.stringify(calib));
    else localStorage.removeItem(CALIB_KEY);
  } catch {
    /* ignore */
  }
}
