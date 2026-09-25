// Simulated camera: a fake wall with sticky notes, seen at an angle, onto which
// the projector's current picture is "projected". It produces a real
// MediaStream (canvas.captureStream) so the rest of the app cannot tell it
// apart from a webcam. Used to develop and test without the hardware.
//
// Coordinate spaces:
//   proj-norm  0..1 over the projector image
//   cam px     0..W x 0..H over the simulated camera frame

import { solveHomography, applyH, invertH, multiplyH } from './homography.js';
import { drawScene, CALIB_DOTS } from './render.js';
import { NOTE_COLORS } from './colors.js';

const W = 1280;
const H = 720;

// Where the projector's image lands in the camera frame (a keystoned quad:
// camera sits a little off-axis from the projector).
const PROJ_QUAD = [
  [250, 105],
  [1065, 140],
  [1020, 610],
  [215, 575],
];

const COLORS = NOTE_COLORS.map((c) => c.rgb);

// Virtual projector size used to keep notes square-ish on a 16:9 projector.
const VW = 1600;
const VH = 900;

function makeNote(cx, cy, angleDeg, colorIdx, size = 125) {
  return { cx, cy, angle: (angleDeg * Math.PI) / 180, size, color: COLORS[colorIdx % COLORS.length] };
}

function defaultNotes() {
  return [
    makeNote(0.28, 0.32, 8, 0),
    makeNote(0.62, 0.25, -12, 1),
    makeNote(0.45, 0.62, 3, 2),
    makeNote(0.78, 0.7, 20, 3),
    makeNote(0.18, 0.75, -5, 4),
    // Off the projected area: should be ignored once calibrated.
    makeNote(-0.12, 0.45, 10, 1),
  ];
}

// Corners of a note in proj-norm, clockwise starting top-left.
export function noteCorners(n) {
  const s = n.size / 2;
  const c = Math.cos(n.angle);
  const si = Math.sin(n.angle);
  return [
    [-s, -s],
    [s, -s],
    [s, s],
    [-s, s],
  ].map(([x, y]) => [(n.cx * VW + x * c - y * si) / VW, (n.cy * VH + x * si + y * c) / VH]);
}

function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class SimCamera {
  /**
   * @param cv            ready OpenCV module
   * @param getScene      () => current projector scene (see render.js) + aspect
   */
  constructor(cv, getScene) {
    this.cv = cv;
    this.getScene = getScene;
    this.width = W;
    this.height = H;
    this.H = solveHomography(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      PROJ_QUAD,
    ); // proj-norm -> cam px
    this.Hinv = invertH(this.H);
    this.notes = defaultNotes();
    this.dirty = true;
    this.noise = true;
    // Tint projected light (a projector/camera white-balance mismatch). Makes
    // the ball look saturated, so only the ball mask keeps it from being
    // detected as a note - a good stress test.
    this.tint = false;

    this.base = document.createElement('canvas');
    this.base.width = W;
    this.base.height = H;
    this.base.getContext('2d', { willReadFrequently: true });
    this.proj = document.createElement('canvas');
    this.proj.getContext('2d', { willReadFrequently: true });
    this.out = document.createElement('canvas');
    this.out.width = W;
    this.out.height = H;
    this.stream = this.out.captureStream(30);
    this.baseMat = null;
    this.timer = setInterval(() => this.render(), 1000 / 30);
    this.render();
  }

  stop() {
    clearInterval(this.timer);
    this.stream.getTracks().forEach((t) => t.stop());
    this.baseMat?.delete();
    this.baseMat = null;
  }

  // ---- ground truth helpers (used by tests and the UI)

  projToCam(p) {
    return applyH(this.H, p);
  }

  camToProj(p) {
    return applyH(this.Hinv, p);
  }

  calibDotsInCamera() {
    return CALIB_DOTS.map((p) => this.projToCam(p));
  }

  // Notes whose centre is on the projected area, in proj-norm.
  groundTruth() {
    return this.notes
      .filter((n) => n.cx > 0 && n.cx < 1 && n.cy > 0 && n.cy < 1)
      .map((n) => ({ center: [n.cx, n.cy], corners: noteCorners(n), color: NOTE_COLORS.find((c) => c.rgb === n.color)?.name }));
  }

  // ---- editing (drag in the feed, buttons in the sim panel)

  noteIndexAtCam(camPt) {
    const p = this.camToProj(camPt);
    for (let i = this.notes.length - 1; i >= 0; i--) {
      if (pointInPoly(p, noteCorners(this.notes[i]))) return i;
    }
    return -1;
  }

  moveNote(i, camPt) {
    const [x, y] = this.camToProj(camPt);
    this.notes[i].cx = x;
    this.notes[i].cy = y;
    this.dirty = true;
  }

  addNote() {
    const i = this.notes.length;
    this.notes.push(makeNote(0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7, (Math.random() - 0.5) * 40, i));
    this.dirty = true;
  }

  removeNote() {
    this.notes.pop();
    this.dirty = true;
  }

  shuffle() {
    this.notes.forEach((n) => {
      if (n.cx < 0) return;
      n.cx = 0.12 + Math.random() * 0.76;
      n.cy = 0.15 + Math.random() * 0.7;
      n.angle = ((Math.random() - 0.5) * 40 * Math.PI) / 180;
    });
    this.dirty = true;
  }

  // ---- rendering

  _drawBase() {
    const ctx = this.base.getContext('2d');
    // dim wall, slightly brighter towards the top (room light)
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgb(78,74,68)');
    g.addColorStop(1, 'rgb(52,50,46)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // a bit of wall texture so thresholds are not trivially clean
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},0.04)`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 30, 2 + Math.random() * 30);
    }
    // projector black level: the "black" projected area is slightly lit
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    PROJ_QUAD.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    // notes
    for (const n of this.notes) {
      const cam = noteCorners(n).map((p) => this.projToCam(p));
      const [r, gg, b] = n.color;
      ctx.fillStyle = `rgb(${r * 0.8},${gg * 0.8},${b * 0.8})`; // under dim room light
      ctx.beginPath();
      cam.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      // slight shadow on the bottom edge like a real note
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...cam[3]);
      ctx.lineTo(...cam[2]);
      ctx.stroke();
    }
    this.baseMat?.delete();
    this.baseMat = this.cv.imread(this.base);
    this.dirty = false;
  }

  render() {
    const cv = this.cv;
    if (this.dirty) this._drawBase();

    const scene = this.getScene() || {};
    const aspect = scene.aspect || 16 / 9;
    const pw = 640;
    const ph = Math.round(pw / aspect);
    if (this.proj.width !== pw || this.proj.height !== ph) {
      this.proj.width = pw;
      this.proj.height = ph;
    }
    const pctx = this.proj.getContext('2d');
    drawScene(pctx, pw, ph, scene);
    if (this.tint) {
      pctx.save();
      pctx.globalCompositeOperation = 'multiply';
      pctx.fillStyle = 'rgb(40,230,255)';
      pctx.fillRect(0, 0, pw, ph);
      pctx.restore();
    }

    // proj px -> proj-norm -> cam px
    const S = [1 / pw, 0, 0, 0, 1 / ph, 0, 0, 0, 1];
    const M = multiplyH(this.H, S);

    const mats = [];
    const t = (m) => { mats.push(m); return m; };
    try {
      const src = t(cv.imread(this.proj));
      const Mm = t(cv.matFromArray(3, 3, cv.CV_64F, M));
      const warped = t(new cv.Mat());
      cv.warpPerspective(src, warped, Mm, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      const out = t(new cv.Mat());
      // projector light adds to the wall; 0.8 = not quite full white on camera
      cv.addWeighted(this.baseMat, 1, warped, 0.8, 0, out);
      if (this.noise) {
        const n = t(new cv.Mat(H, W, cv.CV_8UC4));
        const lo = t(cv.matFromArray(1, 4, cv.CV_64F, [0, 0, 0, 0]));
        const hi = t(cv.matFromArray(1, 4, cv.CV_64F, [12, 12, 12, 0]));
        cv.randu(n, lo, hi); // randu only accepts Mat bounds in opencv.js
        cv.add(out, n, out);
      }
      cv.imshow(this.out, out);
    } finally {
      mats.forEach((m) => m.delete());
    }
  }
}
