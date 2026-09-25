// Lanes from sticky notes (pure JS, no DOM).
//
// The top band of the projection (y < railBottom) is the *rail*. A note whose
// centre is in the rail is a rail note: it never sounds, it opens a lane
// straight down from it. The first non-rail note below that crosses the lane's
// centre line is the lane's *target*; its distance below the rail sets the
// rhythm (see beat.js). Notes further down the same lane are shadowed.
//
// Everything is in projector-normalized coordinates (0..1).

import { centroid } from './tracker.js';

export const LANE_DEFAULTS = {
  railBottom: 0.15, // bottom of the rail band
  unit: 0.1, // normalized distance per 1/16 note
  snap: true, // round the length to whole 16ths
  minWidth: 0.0375, // lane width clamp: 2x ball diameter (30 px at 1600 wide)
  minN: 0.25, // shortest un-snapped length, in 16ths
  offsets: {}, // { railNoteId: dx } fine-tune nudges (A / D)
};

// Where the vertical line at `x` crosses the polygon: [top y, bottom y], or null.
export function spanAt(poly, x) {
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    if ((x0 - x) * (x1 - x) > 0) continue; // edge entirely on one side
    let ys;
    if (x0 === x1) ys = [y0, y1];
    else ys = [y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)];
    for (const y of ys) {
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return top === Infinity ? null : [top, bottom];
}

export function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The non-rail note under a point (for clicks on the wall), or null. */
export function noteAt(notes, pt, railBottom = LANE_DEFAULTS.railBottom) {
  return notes.find((n) => centroid(n.corners)[1] >= railBottom && pointInPoly(pt, n.corners)) ?? null;
}

/**
 * @param notes [{ id, corners: [[x,y] x4], color }] tracked notes
 * @param opts  see LANE_DEFAULTS
 * @returns lanes sorted left to right:
 *   { id, x, w, railCorners, railNoteBottom, targetId, color, top, d, n, shadowed: [ids] }
 *   Idle lanes (no target) have targetId = null and top/d/n = null.
 */
export function buildLanes(notes, opts = {}) {
  const o = { ...LANE_DEFAULTS, ...opts };
  const rail = [];
  const field = [];
  for (const n of notes) (centroid(n.corners)[1] < o.railBottom ? rail : field).push(n);

  const lanes = rail.map((r) => {
    const xs = r.corners.map((p) => p[0]);
    const x = centroid(r.corners)[0] + (o.offsets[r.id] || 0);
    const railSpan = spanAt(r.corners, x);
    const lane = {
      id: r.id,
      x,
      w: Math.max(Math.max(...xs) - Math.min(...xs), o.minWidth),
      railCorners: r.corners,
      railNoteBottom: railSpan ? railSpan[1] : Math.max(...r.corners.map((p) => p[1])),
      targetId: null,
      color: null,
      top: null,
      d: null,
      n: null,
      shadowed: [],
    };
    const hits = [];
    for (const f of field) {
      const s = spanAt(f.corners, x);
      if (s) hits.push({ note: f, top: s[0] });
    }
    hits.sort((a, b) => a.top - b.top);
    if (hits.length) {
      const t = hits[0];
      lane.targetId = t.note.id;
      lane.color = t.note.color ?? null;
      lane.top = t.top;
      lane.d = Math.max(0, t.top - o.railBottom);
      lane.n = lengthIn16ths(lane.d, o);
      lane.shadowed = hits.slice(1).map((h) => h.note.id);
    }
    return lane;
  });
  return lanes.sort((a, b) => a.x - b.x || a.id - b.id);
}

// Drop distance -> time between hits, in 16th notes.
export function lengthIn16ths(d, opts = {}) {
  const o = { ...LANE_DEFAULTS, ...opts };
  const n = d / o.unit;
  return o.snap ? Math.max(1, Math.round(n)) : Math.max(o.minN, n);
}

// "1/4", "3/16", "1", "≈0.37" ... for n 16ths.
export function rateLabel(n, snap = true) {
  if (n == null) return '—';
  if (!snap || !Number.isInteger(n)) return `≈${(n / 16).toFixed(2)}`;
  let num = n;
  let den = 16;
  while (num % 2 === 0 && den > 1) {
    num /= 2;
    den /= 2;
  }
  return den === 1 ? String(num) : `${num}/${den}`;
}
