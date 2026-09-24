// Unit tests for the pure-JS parts (no browser needed):  node tests/unit.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { NoteTracker, canonicalCorners, centroid } from '../js/tracker.js';
import { solveHomography, applyH, invertH, isConvexQuad } from '../js/homography.js';
import { snapToDot } from '../js/calibration.js';

const require = createRequire(import.meta.url);
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------ helpers

function square(cx, cy, s = 0.05, angle = 0) {
  const c = Math.cos(angle);
  const si = Math.sin(angle);
  return [
    [-s, -s],
    [s, -s],
    [s, s],
    [-s, s],
  ].map(([x, y]) => [cx + x * c - y * si, cy + x * si + y * c]);
}

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// ------------------------------------------------------------------ tracker

test('tracker: note appears only after seenN rounds', () => {
  const t = new NoteTracker({ seenN: 3, missM: 5 });
  const det = [{ corners: square(0.5, 0.5) }];
  assert.equal(t.update(det).notes.length, 0);
  assert.equal(t.update(det).notes.length, 0);
  const r = t.update(det);
  assert.equal(r.notes.length, 1);
  assert.equal(r.changed, true);
});

test('tracker: a single missed round does not remove a note (no flicker)', () => {
  const t = new NoteTracker({ seenN: 2, missM: 3 });
  const det = [{ corners: square(0.3, 0.3) }];
  t.update(det);
  t.update(det);
  assert.equal(t.update([]).notes.length, 1, 'kept after 1 miss');
  assert.equal(t.update(det).notes.length, 1);
  t.update([]);
  t.update([]);
  assert.equal(t.update([]).notes.length, 0, 'removed after missM misses');
});

test('tracker: one-off false positives never become notes', () => {
  const t = new NoteTracker({ seenN: 3 });
  for (let i = 0; i < 10; i++) {
    const x = 0.1 + i * 0.08; // a blob at a different place every round
    assert.equal(t.update([{ corners: square(x, 0.5, 0.02) }]).notes.length, 0);
  }
});

test('tracker: ids stay stable while notes jitter and get reordered', () => {
  const t = new NoteTracker({ seenN: 1 });
  const a = square(0.2, 0.2);
  const b = square(0.7, 0.6);
  const first = t.update([{ corners: a }, { corners: b }]).notes;
  const idA = first.find((n) => centroid(n.corners)[0] < 0.5).id;
  for (let i = 0; i < 20; i++) {
    const j = () => (Math.random() - 0.5) * 0.004;
    const dets = [{ corners: square(0.7 + j(), 0.6 + j()) }, { corners: square(0.2 + j(), 0.2 + j()) }];
    const notes = t.update(dets).notes;
    assert.equal(notes.length, 2);
    assert.equal(notes.find((n) => centroid(n.corners)[0] < 0.5).id, idA);
  }
});

test('tracker: sub-deadband jitter does not report a change', () => {
  const t = new NoteTracker({ seenN: 1, smooth: 0, deadband: 0.004 });
  t.update([{ corners: square(0.5, 0.5) }]);
  const r = t.update([{ corners: square(0.501, 0.5) }]);
  assert.equal(r.changed, false);
  const r2 = t.update([{ corners: square(0.52, 0.5) }]);
  assert.equal(r2.changed, true);
});

test('tracker: corner order from minAreaRect rotation does not twist the note', () => {
  const t = new NoteTracker({ seenN: 1, smooth: 0.5 });
  const sq = square(0.5, 0.5, 0.05, 0.1);
  t.update([{ corners: sq }]);
  // same square, corners listed starting at a different corner and reversed
  const shuffled = [sq[2], sq[1], sq[0], sq[3]];
  const n = t.update([{ corners: shuffled }]).notes[0];
  const canon = canonicalCorners(sq);
  n.corners.forEach((p, i) => {
    close(p[0], canon[i][0], 1e-9, 'x');
    close(p[1], canon[i][1], 1e-9, 'y');
  });
});

test('tracker: an occluded note keeps its shape and does not age', () => {
  const t = new NoteTracker({ seenN: 1, missM: 2, smooth: 0 });
  t.update([{ corners: square(0.5, 0.5) }]);
  const shape = JSON.stringify(t.notes()[0].corners);
  const occluded = () => true;
  // ball mask cuts the note in half: detection shrinks
  t.update([{ corners: square(0.5, 0.5, 0.02) }], occluded);
  assert.equal(JSON.stringify(t.notes()[0].corners), shape);
  // fully hidden for many rounds: still there
  for (let i = 0; i < 10; i++) t.update([], occluded);
  assert.equal(t.notes().length, 1);
});

// ------------------------------------------------------------------ homography

const QUAD = [
  [250, 105],
  [1065, 140],
  [1020, 610],
  [215, 575],
];
const UNIT = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

test('homography: maps the 4 source points onto the 4 targets', () => {
  const H = solveHomography(UNIT, QUAD);
  UNIT.forEach((p, i) => {
    const q = applyH(H, p);
    close(q[0], QUAD[i][0], 1e-6, 'x');
    close(q[1], QUAD[i][1], 1e-6, 'y');
  });
});

test('homography: inverse round-trips within 1e-6', () => {
  const H = solveHomography(UNIT, QUAD);
  const Hi = invertH(H);
  for (let i = 0; i < 100; i++) {
    const p = [Math.random(), Math.random()];
    const back = applyH(Hi, applyH(H, p));
    close(back[0], p[0], 1e-6, 'x');
    close(back[1], p[1], 1e-6, 'y');
  }
});

test('homography: convexity check rejects clicks in the wrong order', () => {
  assert.equal(isConvexQuad(QUAD), true);
  assert.equal(isConvexQuad([QUAD[0], QUAD[2], QUAD[1], QUAD[3]]), false);
});

test('homography: matches cv.getPerspectiveTransform', async () => {
  const cv = await loadOpenCV();
  const cam = QUAD;
  const dots = [
    [0.05, 0.05],
    [0.95, 0.05],
    [0.95, 0.95],
    [0.05, 0.95],
  ];
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, cam.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, dots.flat());
  const M = cv.getPerspectiveTransform(src, dst);
  const Hcv = Array.from(M.data64F);
  [src, dst, M].forEach((m) => m.delete());
  const Hjs = solveHomography(cam, dots);
  for (let i = 0; i < 20; i++) {
    const p = [200 + Math.random() * 900, 100 + Math.random() * 500];
    const a = applyH(Hcv, p);
    const b = applyH(Hjs, p);
    close(a[0], b[0], 1e-5, 'x');
    close(a[1], b[1], 1e-5, 'y');
  }
});

// ------------------------------------------------------------------ snap to dot

function fakeImage(w, h, draw) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = draw(x + 0.5, y + 0.5);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

test('snapToDot: finds the centre of a dot next to a sloppy click', () => {
  const img = fakeImage(60, 60, (x, y) => (Math.hypot(x - 33.2, y - 27.6) < 5 ? 240 : 30));
  const p = snapToDot(img, 100, 200, [100 + 38, 200 + 24], 400);
  close(p[0], 133.2, 0.3, 'x');
  close(p[1], 227.6, 0.3, 'y');
});

test('snapToDot: ignores the calibration border (too big / touches edge)', () => {
  const img = fakeImage(60, 60, (x) => (x < 8 ? 240 : 30));
  assert.equal(snapToDot(img, 0, 0, [10, 30], 400), null);
});

test('snapToDot: no contrast -> null', () => {
  const img = fakeImage(40, 40, () => 90);
  assert.equal(snapToDot(img, 0, 0, [20, 20], 400), null);
});

// ------------------------------------------------------------------ physics

async function physicsWorld(w, h) {
  globalThis.window = { Matter: require('../vendor/matter.min.js') };
  const { PhysicsWorld } = await import('../js/physics.js');
  return new PhysicsWorld(w, h);
}

const NOTE = { id: 1, corners: [[0.4, 0.4], [0.5, 0.4], [0.5, 0.55], [0.4, 0.55]] };

test('physics: ball keeps a constant speed and never enters a note', async () => {
  const pw = await physicsWorld(1920, 1080);
  pw.setNotes([NOTE]);
  pw.addBall({ x: 200, y: 200 });
  const target = 0.45 * 1920;
  for (let i = 0; i < 60 * 60; i++) {
    pw.step(1000 / 60);
    const [b] = pw.ballsNormalized();
    assert.ok(!(b.x > 0.4 && b.x < 0.5 && b.y > 0.4 && b.y < 0.55), 'ball inside note');
    assert.ok(b.x > 0 && b.x < 1 && b.y > 0 && b.y < 1, 'ball left the screen');
    if (i % 100 === 0) close(Math.hypot(b.vx * 1920, b.vy * 1080), target, 1, 'speed');
  }
});

test('physics: updating notes keeps the ball; a note spawned on it evicts it', async () => {
  const pw = await physicsWorld(1600, 900);
  pw.setNotes([NOTE]);
  const ball = pw.addBall({ x: 800, y: 200 });
  const bx = 0.5;
  const by = 200 / 900;
  pw.setNotes([NOTE, { id: 2, corners: square(bx, by, 0.06) }]);
  assert.equal(pw.balls[0], ball, 'same ball body');
  const [b] = pw.ballsNormalized();
  const inside = Math.abs(b.x - bx) < 0.06 && Math.abs(b.y - by) < 0.06;
  assert.equal(inside, false, 'ball evicted from the new note');
  pw.setNotes([]);
  assert.equal(pw.notes.size, 0);
  assert.equal(pw.balls[0], ball);
});

test('physics: resize keeps balls and notes', async () => {
  const pw = await physicsWorld(1920, 1080);
  pw.setNotes([NOTE]);
  pw.addBall();
  pw.addBall();
  pw.resize(1280, 720);
  assert.equal(pw.balls.length, 2);
  assert.equal(pw.notes.size, 1);
});

test('physics: drop mode - ball waits at the top, steers, drops, resets', async () => {
  const pw = await physicsWorld(1600, 900);
  pw.setConfig({ mode: 'drop' });
  assert.equal(pw.balls.length, 1);
  let [b] = pw.ballsNormalized();
  assert.equal(b.held, true);
  const y0 = b.y;
  for (let i = 0; i < 60; i++) pw.step(1000 / 60); // 1 s: gravity must not pull it down
  [b] = pw.ballsNormalized();
  close(b.y, y0, 1e-9, 'held ball stays put');
  pw.steer(1);
  for (let i = 0; i < 30; i++) pw.step(1000 / 60);
  pw.steer(0);
  const [moved] = pw.ballsNormalized();
  assert.ok(moved.x > b.x + 0.2, `steered right (${b.x.toFixed(2)} -> ${moved.x.toFixed(2)})`);
  assert.equal(pw.drop(), true);
  for (let i = 0; i < 60; i++) pw.step(1000 / 60);
  const [fallen] = pw.ballsNormalized();
  assert.equal(fallen.held, false);
  assert.ok(fallen.y > 0.5, 'ball fell');
  pw.resetBalls();
  assert.equal(pw.balls.length, 1);
  assert.equal(pw.ballsNormalized()[0].held, true);
});

test('physics: dropped ball lands on a note instead of falling through', async () => {
  const pw = await physicsWorld(1600, 900);
  pw.setConfig({ mode: 'drop' });
  pw.setNotes([{ id: 1, corners: [[0.4, 0.6], [0.6, 0.6], [0.6, 0.62], [0.4, 0.62]] }]); // a shelf
  pw.drop(); // held ball starts at x = 0.5
  let minVy = Infinity;
  for (let i = 0; i < 240; i++) {
    pw.step(1000 / 60);
    minVy = Math.min(minVy, pw.ballsNormalized()[0].vy);
  }
  const [b] = pw.ballsNormalized();
  assert.ok(b.y < 0.6, `ball rests on the shelf (y=${b.y.toFixed(3)})`);
  assert.ok(minVy < 0, 'ball bounced up at least once');
});

// ------------------------------------------------------------------ runner

let cvPromise = null;
function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve) => {
      const cv = require('../vendor/opencv.js');
      const done = () => {
        delete cv.then; // the Module is a self-resolving thenable
        resolve(cv);
      };
      if (cv.Mat) done();
      else cv.onRuntimeInitialized = done;
    });
  }
  return cvPromise;
}

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
