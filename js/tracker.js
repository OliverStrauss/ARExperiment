// Temporal smoothing of detected notes (pure JS, no DOM/OpenCV).
//
// Detections arrive a few times per second as quads in projector-normalized
// coordinates. A track is only reported ("confirmed") after it was seen in
// `seenN` consecutive detection rounds, and only dropped after it was missing
// for `missM` rounds, so a hand passing by or a noisy frame doesn't make notes
// flicker in and out of the physics world.
//
// Reported corners only change when they moved more than `deadband`, so tiny
// detection jitter doesn't make the projector rebuild note bodies constantly.

export const TRACKER_DEFAULTS = {
  seenN: 3, // rounds a new note must be seen before it is added
  missM: 5, // rounds a confirmed note may be missing before it is removed
  smooth: 0.5, // 0 = follow detections instantly, 0.9 = very smooth
  matchDist: 0.06, // max centre distance (projector-normalized) to match
  deadband: 0.004, // min corner movement before reporting a change
};

export function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// Clockwise on screen (y down), starting from the corner nearest top-left.
export function canonicalCorners(pts) {
  let c = pts.map((p) => [p[0], p[1]]);
  if (signedArea(c) < 0) c.reverse();
  let start = 0;
  for (let i = 1; i < c.length; i++) if (c[i][0] + c[i][1] < c[start][0] + c[start][1]) start = i;
  return c.slice(start).concat(c.slice(0, start));
}

// Rotate `pts` (already canonical winding) to best line up with `ref`.
function alignCorners(pts, ref) {
  let best = pts;
  let bestD = Infinity;
  for (let s = 0; s < pts.length; s++) {
    const r = pts.slice(s).concat(pts.slice(0, s));
    let d = 0;
    for (let i = 0; i < r.length; i++) d += (r[i][0] - ref[i][0]) ** 2 + (r[i][1] - ref[i][1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function maxCornerDelta(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

export class NoteTracker {
  constructor(opts = {}) {
    this.opts = { ...TRACKER_DEFAULTS, ...opts };
    this.tracks = [];
    this.nextId = 1;
  }

  setOptions(opts) {
    Object.assign(this.opts, opts);
  }

  reset() {
    this.tracks = [];
  }

  /**
   * @param detections [{ corners: [[x,y] x4] }] in projector-normalized coords
   * @returns { notes: [{id, corners}], changed: bool }
   */
  update(detections) {
    const { seenN, missM, smooth, matchDist, deadband } = this.opts;
    const dets = detections.map((d) => {
      const corners = canonicalCorners(d.corners);
      return { corners, center: centroid(corners) };
    });
    const before = this._signature();

    // Greedy nearest-centre matching.
    const pairs = [];
    this.tracks.forEach((t, ti) => {
      dets.forEach((d, di) => {
        const dist = Math.hypot(t.center[0] - d.center[0], t.center[1] - d.center[1]);
        if (dist < matchDist) pairs.push([dist, ti, di]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set();
    const usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti);
      usedD.add(di);
      const t = this.tracks[ti];
      const aligned = alignCorners(dets[di].corners, t.corners);
      const k = 1 - smooth;
      t.corners = t.corners.map((p, i) => [p[0] + (aligned[i][0] - p[0]) * k, p[1] + (aligned[i][1] - p[1]) * k]);
      t.center = centroid(t.corners);
      t.seen++;
      t.missed = 0;
      if (!t.confirmed && t.seen >= seenN) t.confirmed = true;
      if (t.confirmed && (!t.emitted || maxCornerDelta(t.emitted, t.corners) > deadband)) {
        t.emitted = t.corners.map((p) => [...p]);
      }
    }

    // Unmatched tracks age; tentative ones are dropped quickly.
    this.tracks = this.tracks.filter((t, ti) => {
      if (usedT.has(ti)) return true;
      t.missed++;
      t.seen = t.confirmed ? t.seen : 0;
      return t.confirmed ? t.missed < missM : t.missed < 2;
    });

    // New detections start tentative tracks.
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const t = {
        id: this.nextId++,
        corners: d.corners,
        center: d.center,
        seen: 1,
        missed: 0,
        confirmed: seenN <= 1,
        emitted: null,
      };
      if (t.confirmed) t.emitted = t.corners.map((p) => [...p]);
      this.tracks.push(t);
    });

    return { notes: this.notes(), changed: this._signature() !== before };
  }

  notes() {
    return this.tracks.filter((t) => t.confirmed).map((t) => ({ id: t.id, corners: t.emitted }));
  }

  tentative() {
    return this.tracks.filter((t) => !t.confirmed).map((t) => ({ id: t.id, corners: t.corners }));
  }

  _signature() {
    return JSON.stringify(this.notes());
  }
}
