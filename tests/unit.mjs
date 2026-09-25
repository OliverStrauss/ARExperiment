// Unit tests for the pure-JS parts (no browser needed):  node tests/unit.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { NoteTracker, canonicalCorners, centroid } from '../js/tracker.js';
import { solveHomography, applyH, invertH, isConvexQuad } from '../js/homography.js';
import { snapToDot } from '../js/calibration.js';
import { NOTE_COLORS, classifyColor } from '../js/colors.js';
import { buildLanes, spanAt, rateLabel, noteAt } from '../js/lanes.js';
import { InstrumentRing } from '../js/ring.js';
import { INSTRUMENTS } from '../js/instruments.js';
import { BeatEngine, ballProgress, ballY, clockPos } from '../js/beat.js';

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

test('tracker: note colour is the majority of recent labels', () => {
  const t = new NoteTracker({ seenN: 1 });
  const det = (color) => [{ corners: square(0.5, 0.5), color }];
  assert.equal(t.update(det('red')).notes[0].color, 'red');
  t.update(det('red'));
  const r = t.update(det('orange')); // one misread doesn't flip it
  assert.equal(r.notes[0].color, 'red');
  assert.equal(r.changed, false);
  for (let i = 0; i < 4; i++) t.update(det('orange'));
  assert.equal(t.notes()[0].color, 'orange', 'a real change wins eventually');
});

// ------------------------------------------------------------------ colours

test('colours: each reference colour classifies as itself', () => {
  for (const c of NOTE_COLORS) assert.equal(classifyColor(c.rgb), c.name);
});

test('colours: darker / washed-out notes keep their colour', () => {
  assert.equal(classifyColor([120, 30, 35]), 'red'); // shadowed red
  assert.equal(classifyColor([200, 190, 110]), 'yellow'); // pale yellow
  assert.equal(classifyColor([90, 50, 130]), 'purple');
  assert.equal(classifyColor([250, 5, 20]), 'red', 'hue wraps around 0/360');
});

test('colours: a taught palette overrides the defaults', () => {
  const palette = { red: [200, 40, 120], orange: [255, 150, 60] }; // camera sees red as pinkish
  assert.equal(classifyColor([210, 50, 130], palette), 'red');
});

test('pitches: purple lowest ... red highest', () => {
  const f = NOTE_COLORS.map((c) => c.freq);
  assert.deepEqual(NOTE_COLORS.map((c) => c.name), ['purple', 'blue', 'green', 'yellow', 'orange', 'red']);
  assert.ok(f.every((x, i) => i === 0 || x > f[i - 1]));
});

// ------------------------------------------------------------------ lanes

// A note as a box: centre x, top y, half-size (so the top edge is exact).
const box = (id, cx, top, color = 'green', s = 0.03) => ({ id, color, corners: square(cx, top + s, s) });

test('lanes: a note inside the rail opens a lane, others do not', () => {
  const lanes = buildLanes([box(1, 0.3, 0.02), box(2, 0.6, 0.4)], { railBottom: 0.15 });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].id, 1);
  close(lanes[0].x, 0.3, 1e-9, 'lane x = rail note centre');
});

test('lanes: target is the first note below the rail on the centre line', () => {
  const notes = [box(1, 0.5, 0.02), box(2, 0.5, 0.6), box(3, 0.51, 0.35), box(4, 0.8, 0.2)];
  const [lane] = buildLanes(notes, { railBottom: 0.15, unit: 0.1 });
  assert.equal(lane.targetId, 3);
  close(lane.top, 0.35, 1e-9, 'top edge');
  close(lane.d, 0.2, 1e-9, 'd');
  assert.deepEqual(lane.shadowed, [2], 'lower note in the lane is shadowed');
});

test('lanes: no note under the rail note -> idle lane', () => {
  const [lane] = buildLanes([box(1, 0.2, 0.02), box(2, 0.7, 0.5)]);
  assert.equal(lane.targetId, null);
  assert.equal(lane.n, null);
});

test('lanes: tilted target uses the top edge where it crosses the centre line', () => {
  const tilted = { id: 2, color: 'red', corners: [[0.4, 0.5], [0.6, 0.6], [0.6, 0.65], [0.4, 0.55]] };
  const [lane] = buildLanes([box(1, 0.5, 0.02), tilted], { railBottom: 0.15 });
  close(lane.top, 0.55, 1e-9, 'top at x=0.5');
  close(spanAt(tilted.corners, 0.5)[1], 0.6, 1e-9, 'bottom at x=0.5');
});

test('lanes: n rounds with Snap on, stays fractional with Snap off, min 1', () => {
  const notes = (top) => [box(1, 0.5, 0.02), box(2, 0.5, top)];
  const at = (top, snap) => buildLanes(notes(top), { railBottom: 0.15, unit: 0.1, snap })[0].n;
  assert.equal(at(0.15 + 0.37, true), 4);
  assert.equal(at(0.15 + 0.33, true), 3);
  close(at(0.15 + 0.37, false), 3.7, 1e-9, 'snap off');
  assert.equal(at(0.16, true), 1, 'very small d clamps to 1');
});

test('lanes: width is the rail note width, clamped to 2 ball diameters', () => {
  const wide = buildLanes([box(1, 0.5, 0.02, 'blue', 0.05)], { minWidth: 0.04 })[0];
  close(wide.w, 0.1, 1e-9, 'rail note width');
  const narrow = buildLanes([box(1, 0.5, 0.02, 'blue', 0.01)], { minWidth: 0.04 })[0];
  close(narrow.w, 0.04, 1e-9, 'clamped');
});

test('lanes: sorted left to right, overlapping lanes allowed, nudge offsets x', () => {
  const notes = [box(7, 0.6, 0.02), box(8, 0.3, 0.02), box(9, 0.61, 0.03), box(2, 0.6, 0.5)];
  const lanes = buildLanes(notes, { offsets: { 8: 0.005 } });
  assert.deepEqual(lanes.map((l) => l.id), [8, 7, 9]);
  close(lanes[0].x, 0.305, 1e-9, 'nudged');
  assert.equal(lanes[1].targetId, 2);
  assert.equal(lanes[2].targetId, 2, 'two lanes can share a target');
});

test('lanes: rate labels', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 8, 16, 32].map((n) => rateLabel(n)), ['1/16', '1/8', '3/16', '1/4', '3/8', '1/2', '1', '2']);
  assert.equal(rateLabel(5.9, false), '≈0.37');
  assert.equal(rateLabel(null), '—');
});

// ------------------------------------------------------------------ beat engine

// One lane with a target n 16ths below the rail.
function laneN(n, id = 1, color = 'green', targetId = 10) {
  return { id, x: 0.5, w: 0.05, railNoteBottom: 0.1, targetId, color, top: 0.15 + n * 0.1, d: n * 0.1, n, shadowed: [] };
}

// Run the scheduler for `secs` with 25 ms ticks; returns all hits.
function run(engine, t0, secs) {
  const hits = [];
  for (let t = t0; t < t0 + secs; t += 0.025) hits.push(...engine.tick(t));
  return hits;
}

test('beat: at 96 BPM a lane with n = 4 hits exactly 0.625 s apart, each hit once', () => {
  const e = new BeatEngine({ bpm: 96 });
  e.setLanes([laneN(4)]);
  e.start(100);
  const hits = run(e, 100, 5);
  assert.ok(hits.length >= 7, `hits: ${hits.length}`);
  close(hits[0].time, 100, 1e-9, 'first hit on the downbeat');
  hits.slice(1).forEach((h, i) => close(h.time - hits[i].time, 0.625, 1e-9, 'interval'));
  assert.equal(new Set(hits.map((h) => h.pos)).size, hits.length, 'no duplicates');
  assert.equal(hits[0].noteId, 10);
  assert.equal(hits[0].instrument, 'bell');
});

test('beat: two balls give the union of both phase grids', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes([laneN(4)]);
  e.start(0);
  e.tick(0);
  // at pos 1 (1/16 in), drop a second ball: it hits n/2 = 2 16ths later, at pos 3
  const t1 = e.timeAt(1);
  const b = e.addBall(1, t1);
  assert.equal(b.phase, 3);
  const hits = run(e, t1, 4).map((h) => h.pos);
  const grid = hits.filter((p) => p % 4 === 0);
  const off = hits.filter((p) => p % 4 === 3);
  assert.equal(grid.length + off.length, hits.length);
  assert.ok(grid.length >= 7 && off.length >= 7, `${grid.length} + ${off.length}`);
  assert.equal(e.removeBall(1), true);
  assert.equal(e.removeBall(1), false, 'a lane keeps at least one ball');
});

test('beat: max balls per lane, reset brings one ball back on the downbeat', () => {
  const e = new BeatEngine({ maxBallsPerLane: 3 });
  e.setLanes([laneN(4)]);
  assert.ok(e.addBall(1, 0.3));
  assert.ok(e.addBall(1, 0.7));
  assert.equal(e.addBall(1, 0.9), null);
  e.resetBalls();
  assert.equal(e.ballsOf(1).length, 1);
  assert.equal(e.ballsOf(1)[0].phase, 0);
});

test('beat: tempo change keeps phase continuity', () => {
  const e = new BeatEngine({ bpm: 96 });
  e.setLanes([laneN(2)]);
  e.start(10);
  const before = run(e, 10, 2);
  const t = 12.01;
  const p = e.pos(t);
  e.setBpm(120, t);
  close(e.pos(t), p, 1e-9, 'pos continuous across the change');
  const after = run(e, t, 2);
  assert.ok(after[0].pos > before.at(-1).pos, 'no hit repeated or lost');
  close(after[0].pos - before.at(-1).pos, 2, 1e-9, 'next hit one lane length later');
  after.slice(1).forEach((h, i) => close(h.time - after[i].time, 2 * (60 / 120 / 4), 1e-9, 'new interval'));
});

test('beat: stopped clock schedules nothing and holds its position', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.start(0);
  run(e, 0, 1);
  e.stop(1);
  const p = e.pos(1);
  assert.equal(e.tick(1.5).length, 0);
  close(e.pos(9), p, 1e-9, 'frozen');
  e.start(9);
  close(e.pos(9), p, 1e-9, 'resumes where it stopped');
});

test('beat: mute and solo filter hits by colour', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes([laneN(4, 1, 'green', 10), laneN(4, 2, 'red', 11)]);
  e.start(0);
  let t = 0;
  const colors = () => new Set(run(e, (t += 1) - 1, 1).map((h) => h.color));
  assert.deepEqual([...colors()].sort(), ['green', 'red']);
  e.toggleMute('red');
  assert.deepEqual([...colors()], ['green']);
  e.toggleSolo('red');
  assert.deepEqual([...colors()], ['red'], 'solo wins over mute');
  e.toggleSolo('red');
  e.toggleMute('red');
  assert.equal(colors().size, 2);
});

test('beat: idle lanes are silent; lanes keep balls until their rail note goes', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.addBall(1, 0.5);
  e.setLanes([{ ...laneN(4), targetId: null, n: null, top: null, d: null }]);
  e.start(0);
  assert.equal(run(e, 0, 2).length, 0);
  assert.equal(e.ballsOf(1).length, 2, 'balls kept while idle');
  e.setLanes([laneN(4)]);
  assert.ok(run(e, 2, 2).length > 0, 'resumes when a target appears');
  e.setLanes([]);
  assert.equal(e.ballsOf(1).length, 0, 'rail note removed -> balls gone');
});

test('beat: instruments stored by note id, forgotten when the note goes', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.setInstrument(10, 'kick');
  e.start(0);
  assert.equal(e.tick(0)[0].instrument, 'kick');
  e.pruneInstruments([1, 2]);
  assert.equal(e.instrumentOf(10), 'bell');
});

test('beat: ball goes rail -> target -> rail, touching the target on a hit', () => {
  const lane = laneN(4);
  assert.equal(ballProgress(0, 0, 4), 1);
  assert.equal(ballProgress(2, 0, 4), 0);
  close(ballProgress(1, 0, 4), 0.5, 1e-9, 'halfway');
  close(ballY(lane, 0, 8, 0.15, 0.02), lane.top - 0.02, 1e-9, 'touches the top edge');
  close(ballY(lane, 0, 10, 0.15, 0.02), 0.15, 1e-9, 'back at the rail');
  const idle = { ...lane, n: null, top: null };
  close(ballY(idle, 0, 3, 0.15, 0.02), 0.15, 1e-9, 'idle: waits at the rail');
  const clock = { running: true, bpm: 60, anchor: 5, pos0: 8 };
  close(clockPos(clock, 6), 12, 1e-9, '60 bpm = 4 16ths per second');
});

// ------------------------------------------------------------------ instrument ring

test('ring: spin wraps around both ways', () => {
  const r = new InstrumentRing(INSTRUMENTS, 4);
  r.open(5, 'bell', 0);
  assert.equal(r.spin(-1, 1), 'tom');
  assert.equal(r.spin(1, 1), 'bell');
  for (let i = 0; i < INSTRUMENTS.length; i++) r.spin(1, 1);
  assert.equal(r.current, 'bell', 'a full turn comes back');
});

test('ring: commit stores the instrument by note id; Esc leaves it unchanged', () => {
  const e = new BeatEngine();
  const r = new InstrumentRing();
  r.open(7, e.instrumentOf(7), 0);
  r.spin(1, 0);
  r.spin(1, 0);
  const res = r.commit();
  e.setInstrument(res.noteId, res.instrument);
  assert.equal(e.instrumentOf(7), 'marimba');
  assert.equal(r.isOpen, false);
  r.open(7, e.instrumentOf(7), 0);
  assert.equal(r.current, 'marimba', 'opens on the current choice');
  r.spin(1, 0);
  r.cancel();
  assert.equal(r.commit(), null);
  assert.equal(e.instrumentOf(7), 'marimba');
});

test('ring: commits by itself after 4 s idle; spinning restarts the countdown', () => {
  const r = new InstrumentRing(INSTRUMENTS, 4);
  r.open(1, 'bell', 10);
  assert.equal(r.expired(13.9), false);
  r.spin(1, 13);
  assert.equal(r.expired(16.9), false);
  assert.equal(r.expired(17), true);
});

test('ring: clicks hit notes but never rail notes', () => {
  const notes = [box(1, 0.5, 0.02), box(2, 0.5, 0.5)];
  assert.equal(noteAt(notes, [0.5, 0.52], 0.15)?.id, 2);
  assert.equal(noteAt(notes, [0.5, 0.05], 0.15), null, 'rail note');
  assert.equal(noteAt(notes, [0.9, 0.9], 0.15), null, 'empty wall');
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
