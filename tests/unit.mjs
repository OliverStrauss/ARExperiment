// Unit tests for the pure-JS parts (no browser needed):  node tests/unit.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { NoteTracker, canonicalCorners, centroid } from '../js/tracker.js';
import { solveHomography, applyH, invertH, isConvexQuad } from '../js/homography.js';
import { snapToDot } from '../js/calibration.js';
import { NOTE_COLORS, classifyColor } from '../js/colors.js';
import { buildLanes, spanAt, rateLabel, noteAt, oneWay } from '../js/lanes.js';
import { InstrumentRing } from '../js/ring.js';
import { INSTRUMENTS } from '../js/instruments.js';
import { BeatEngine, ballProgress, ballY, clockPos, ghostPos } from '../js/beat.js';

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

test('lanes: a lone ball drops from the top of the wall, 1 wall height per bar', () => {
  const lanes = buildLanes([box(1, 0.3, 0.5), box(2, 0.6, 0.25)], { barH: 1 });
  assert.deepEqual(lanes.map((l) => l.id), [1, 2]);
  assert.ok(lanes.every((l) => l.upperId == null && l.targetId === l.id && l.ceil === 0));
  close(lanes[0].top, 0.5, 1e-9, 'top edge');
  assert.equal(lanes[0].n, 16, 'half a bar down + half a bar up');
  assert.equal(lanes[1].n, 8, 'higher note: shorter drop');
  assert.equal(oneWay(lanes[0]), 8, 'falls 1/2 bar');
  assert.equal(buildLanes([box(1, 0.3, 0.5)], { barH: 0.5 })[0].n, 32, 'barH scales the speed');
  const fall = (top, snap = true) => oneWay(buildLanes([box(1, 0.3, top)], { snap })[0]);
  assert.equal(fall(0.2), 4, 'snaps to 1/8s: 0.2 -> 2/8');
  assert.equal(fall(0.01), 2, 'shortest fall 1/8');
  assert.equal(fall(0.4), 8, '6.4/16 snaps to 1/2 bar, never 3/8');
  assert.equal(buildLanes([box(1, 0.3, 0.9)], { barH: 0.5 })[0].n, 32, 'longest fall 1 bar');
  close(fall(0.2, false), 3.2, 1e-9, 'snap off');
});

test('lanes: stacked notes pair up, gap sets 1/8s, 3 stacked chain', () => {
  const notes = [box(1, 0.5, 0.1), box(2, 0.5, 0.6), box(3, 0.51, 0.36), box(4, 0.8, 0.2)];
  const lanes = buildLanes(notes, { unit: 0.1 });
  const pair = lanes.find((l) => l.id === 1);
  assert.equal(pair.upperId, 1);
  assert.equal(pair.targetId, 3);
  close(pair.ceil, 0.16, 1e-9, 'upper note bottom');
  close(pair.d, 0.2, 1e-9, 'd');
  assert.equal(pair.n, 8, '2 x 1/8 each way');
  assert.equal(oneWay(pair), 4);
  const chain = lanes.find((l) => l.id === 3);
  assert.equal(chain.targetId, 2, 'middle note pairs with the one below');
  assert.equal(lanes.find((l) => l.id === 4).upperId, null, 'off to the side: lone');
  assert.equal(lanes.length, 3, 'paired notes get no lone lane');
});

test('lanes: tilted lower note uses the top edge where it crosses the centre line', () => {
  const tilted = { id: 2, color: 'red', corners: [[0.4, 0.5], [0.6, 0.6], [0.6, 0.65], [0.4, 0.55]] };
  const [lane] = buildLanes([box(1, 0.5, 0.02), tilted]);
  close(lane.top, 0.55, 1e-9, 'top at x=0.5');
  close(spanAt(tilted.corners, 0.5)[1], 0.6, 1e-9, 'bottom at x=0.5');
});

test('lanes: pair n rounds with Snap on, stays fractional with Snap off, min 1/8', () => {
  const notes = (top) => [box(1, 0.5, 0.02), box(2, 0.5, top)];
  const at = (top, snap) => buildLanes(notes(top), { unit: 0.1, snap })[0].n;
  assert.equal(at(0.08 + 0.37, true), 16);
  assert.equal(at(0.08 + 0.33, true), 16, '3.3/8 snaps to 4/8: cycles divide the bar');
  assert.equal(at(0.08 + 0.25, true), 8, '2.5/8 snaps to 2/8');
  close(at(0.08 + 0.37, false), 14.8, 1e-9, 'snap off');
  assert.equal(at(0.09, true), 4, 'very small d clamps to 1/8');
});

test('lanes: width is the note width, clamped to 2 ball diameters', () => {
  const wide = buildLanes([box(1, 0.5, 0.02, 'blue', 0.05)], { minWidth: 0.04 })[0];
  close(wide.w, 0.1, 1e-9, 'note width');
  const narrow = buildLanes([box(1, 0.5, 0.02, 'blue', 0.01)], { minWidth: 0.04 })[0];
  close(narrow.w, 0.04, 1e-9, 'clamped');
});

test('lanes: sorted left to right, two uppers can share a lower note, nudge offsets x', () => {
  const notes = [box(7, 0.58, 0.02), box(8, 0.3, 0.02), box(9, 0.64, 0.03), box(2, 0.6, 0.5, 'green', 0.05)];
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

// One single-note lane hitting every n 16ths.
function laneN(n, id = 1, color = 'green', targetId = 10) {
  return { id, x: 0.5, w: 0.05, upperId: null, upperColor: null, ceil: 0.1, targetId, color, top: 0.5, d: 0.4, n };
}

// Put every ball's first hit on the downbeat (call after start(), which sends balls to the top).
function onBeat(e) {
  for (const list of e.balls.values()) for (const b of list) b.phase = 0;
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
  onBeat(e);
  const hits = run(e, 100, 5);
  assert.ok(hits.length >= 7, `hits: ${hits.length}`);
  close(hits[0].time, 100, 1e-9, 'first hit on the downbeat');
  hits.slice(1).forEach((h, i) => close(h.time - hits[i].time, 0.625, 1e-9, 'interval'));
  assert.equal(new Set(hits.map((h) => h.pos)).size, hits.length, 'no duplicates');
  assert.equal(hits[0].noteId, 10);
  assert.equal(hits[0].instrument, 'bell');
});

test('beat: a second ball is spaced evenly, quarters become 8ths', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes([laneN(4)]);
  e.start(0);
  onBeat(e);
  e.tick(0);
  // added at pos 1, the second ball still lands half a cycle from the first
  const t1 = e.timeAt(1);
  const b = e.addBall(1);
  assert.equal((b.phase - e.ballsOf(1)[0].phase) % 4, 2);
  const hits = run(e, t1, 4).map((h) => h.pos);
  assert.ok(hits.length >= 14, `${hits.length}`);
  assert.ok(hits.every((p) => p % 2 === 0), 'every hit on an 8th');
  hits.slice(1).forEach((p, i) => assert.equal(p - hits[i], 2, 'even 8ths'));
  assert.equal(e.removeBall(1), true);
  assert.equal(e.removeBall(1), false, 'a lane keeps at least one ball');
});

test('beat: 3 and 4 balls spread evenly (triplets, 16ths); removing respaces', () => {
  for (const [k, gap] of [[3, 4 / 3], [4, 1]]) {
    const e = new BeatEngine({ bpm: 120 });
    e.setLanes([laneN(4)]);
    e.start(0);
    onBeat(e);
    e.tick(0);
    for (let i = 1; i < k; i++) e.addBall(1);
    const hits = run(e, 0, 4).map((h) => h.pos).sort((x, y) => x - y);
    assert.ok(hits.length >= 7 * k, `${hits.length}`);
    hits.slice(1).forEach((p, i) => close(p - hits[i], gap, 1e-9, `${k} balls even`));
  }
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.addBall(1);
  e.addBall(1);
  e.removeBall(1);
  const [a, b] = e.ballsOf(1);
  assert.equal(b.phase - a.phase, 2, 'back to 8ths');
});

test('beat: max balls per lane, reset brings one ball back to the top', () => {
  const e = new BeatEngine({ maxBallsPerLane: 3 });
  e.setLanes([laneN(4)]);
  assert.ok(e.addBall(1));
  assert.ok(e.addBall(1));
  assert.equal(e.addBall(1), null);
  e.resetBalls();
  assert.equal(e.ballsOf(1).length, 1);
  assert.equal(e.ballsOf(1)[0].phase, 2, 'starts at the top, hits half a cycle in');
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

test('beat: start and stop send the first ball of each lane back to the top, the rest stay even', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes([laneN(4), laneN(8, 2, 'red', 11)]);
  e.start(0);
  e.addBall(1);
  e.stop(0.7);
  assert.equal(e.pos0, Math.ceil(0.7 * 8), 'stops on the grid');
  for (const l of e.lanes) close(ballProgress(e.pos0, e.ballsOf(l.id)[0].phase, l.n), 0, 1e-9, 'at the top');
  const [x, y] = e.ballsOf(1);
  assert.equal(y.phase - x.phase, 2, 'second ball half a cycle behind');
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

test('beat: pair ping-pongs, bottom and top note alternate every n/2', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes([{ ...laneN(8, 1, 'green', 10), upperId: 1, upperColor: 'red', ceil: 0.2 }]);
  e.start(0);
  const hits = run(e, 0, 2);
  assert.deepEqual(hits.slice(0, 4).map((h) => [h.pos, h.noteId, h.color]), [[0, 1, 'red'], [4, 10, 'green'], [8, 1, 'red'], [12, 10, 'green']]);
  e.toggleMute('red');
  assert.ok(run(e, 2, 2).every((h) => h.color === 'green'), 'muting the top note keeps the bottom');
});

test('beat: lone notes hit together only at the same height', () => {
  const e = new BeatEngine({ bpm: 120 });
  e.setLanes(buildLanes([box(1, 0.2, 0.5), box(2, 0.5, 0.5), box(3, 0.8, 0.25)]));
  e.start(0);
  const first = new Map();
  for (const h of run(e, 0, 3)) if (!first.has(h.noteId)) first.set(h.noteId, h.pos);
  assert.equal(first.get(1), first.get(2), 'same height: same moment');
  assert.equal(first.get(1), 8, 'drops from the top on the downbeat, lands half a cycle later');
  assert.equal(first.get(3), 4, 'higher note is hit sooner');
});

test('beat: lanes keep balls until their note goes', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.addBall(1);
  e.setLanes([laneN(8)]);
  assert.equal(e.ballsOf(1).length, 2, 'balls kept when the lane changes');
  e.setLanes([]);
  assert.equal(e.ballsOf(1).length, 0, 'note removed -> balls gone');
});

test('beat: a lane whose cycle changes is put back in step with the bar', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(16)]);
  assert.equal(e.ballsOf(1)[0].phase, 8);
  e.setLanes([laneN(8)]);
  assert.equal(e.ballsOf(1)[0].phase % 8, 4, 'same phase as a fresh n = 8 lane');
  e.ballsOf(1)[0].phase = 5;
  e.setLanes([laneN(8)]);
  assert.equal(e.ballsOf(1)[0].phase, 5, 'same cycle: phase untouched');
});

test('beat: instruments stored by note id, forgotten when the note goes', () => {
  const e = new BeatEngine();
  e.setLanes([laneN(4)]);
  e.setInstrument(10, 'kick');
  e.start(0);
  assert.equal(run(e, 0, 1)[0].instrument, 'kick');
  e.syncNotes([], 1);
  assert.equal(e.instrumentOf(10), 'bell');
});

test('beat: a moved note (new id, same colour) keeps its instrument', () => {
  const e = new BeatEngine();
  const g = (id) => ({ id, color: 'green', corners: [] });
  const r = (id) => ({ id, color: 'red', corners: [] });
  e.syncNotes([g(1), r(2)], 0);
  e.setInstrument(1, 'kick');
  // new note shows up first, the old one is dropped a moment later
  e.syncNotes([g(1), r(2), g(3)], 1);
  e.syncNotes([r(2), g(3)], 2);
  assert.equal(e.instrumentOf(3), 'kick', 'new green inherits');
  assert.equal(e.instrumentOf(2), 'bell', 'other colours untouched');
  // removed first, placed again later (within MOVE_S)
  e.syncNotes([r(2)], 3);
  e.syncNotes([r(2), g(4)], 8);
  assert.equal(e.instrumentOf(4), 'kick');
  // too late: forgotten
  e.syncNotes([r(2)], 9);
  e.syncNotes([r(2), g(5)], 30);
  assert.equal(e.instrumentOf(5), 'bell');
});

test('beat: ghost of a kept layer replays its window in a loop', () => {
  const g = { from: 40, L: 16 };
  assert.equal(ghostPos(g, 40), 40);
  assert.equal(ghostPos(g, 60), 44);
  assert.equal(ghostPos(g, 20), 52);
});

test('beat: ball goes top -> target -> top, touching the target on a hit', () => {
  const lane = laneN(4);
  assert.equal(ballProgress(0, 0, 4), 1);
  assert.equal(ballProgress(2, 0, 4), 0);
  close(ballProgress(1, 0, 4), 0.5, 1e-9, 'halfway');
  close(ballY(lane, 0, 8, 0.02), lane.top - 0.02, 1e-9, 'touches the top edge');
  close(ballY(lane, 0, 10, 0.02), 0.1, 1e-9, 'lone: back at the ceiling');
  const pair = { ...lane, upperId: 1 };
  close(ballY(pair, 0, 10, 0.02, 0.01), 0.13, 1e-9, 'pair: turns just below the upper note');
  const clock = { running: true, bpm: 60, anchor: 5, pos0: 8 };
  close(clockPos(clock, 6), 12, 1e-9, '60 bpm = 4 16ths per second');
});

// ------------------------------------------------------------------ echo + layers

test('echo: hits land on the correct 1/16 step, highest pitch first', () => {
  const e = new BeatEngine({ bpm: 120, echoBars: 4 });
  e.setLanes([laneN(4, 1, 'green', 10), laneN(3, 2, 'red', 11)]);
  e.start(0);
  onBeat(e);
  run(e, 0, 2); // 2 s at 120 BPM = 16 16ths
  const v = e.echoView(2);
  assert.equal(v.bars, 4);
  assert.equal(v.playheadStep, 16);
  assert.deepEqual(v.rows.map((r) => r.pitch), ['C5', 'E4']);
  assert.deepEqual(v.rows[1].hits.map((h) => h.step), [0, 4, 8, 12, 16]);
  assert.deepEqual(v.rows[0].hits.map((h) => h.step), [0, 3, 6, 9, 12, 15]);
  assert.ok(v.rows.every((r) => r.hits.every((h) => !h.kept)));
});

test('echo: Keep snapshots, layers replay on the next loop, Undo pops, Clear empties', () => {
  const e = new BeatEngine({ bpm: 120, echoBars: 1 }); // 16-step loop = 2 s
  e.setLanes([laneN(4, 1, 'green', 10)]);
  e.start(0);
  onBeat(e);
  run(e, 0, 2.05);
  const layer = e.keep();
  assert.ok(layer, 'kept');
  assert.equal(layer.L, 16);
  assert.deepEqual(layer.events.map((ev) => ev.step).sort((a, b) => a - b), [0, 4, 8, 12]);
  // the wall's note goes away: only the layer plays now
  e.setLanes([]);
  const replay = run(e, 2.05, 4);
  assert.ok(replay.length >= 7 && replay.every((h) => h.kept), `${replay.length} kept hits`);
  assert.deepEqual([...new Set(replay.map((h) => ((h.pos % 16) + 16) % 16))].sort((a, b) => a - b), [0, 4, 8, 12]);
  assert.equal(new Set(replay.map((h) => h.pos)).size, replay.length, 'each step once per loop');
  assert.ok(e.echoView(6).rows[0].hits.every((h) => h.kept), 'echo shows kept hits');
  e.setLanes([laneN(2, 1, 'red', 11)]);
  onBeat(e);
  run(e, 6.05, 2);
  assert.ok(e.keep());
  assert.equal(e.layers.length, 2);
  e.undoKeep();
  assert.equal(e.layers.length, 1);
  assert.equal(e.clearLayers(), 1);
  assert.equal(e.layers.length, 0);
  e.setLanes([]);
  assert.equal(run(e, 8.1, 2).length, 0, 'nothing left to play');
});

test('echo: Keep with nothing played keeps nothing; muted hits are not recorded', () => {
  const e = new BeatEngine({ bpm: 120, echoBars: 1 });
  e.setLanes([laneN(4, 1, 'green', 10)]);
  assert.equal(e.keep(), null);
  e.toggleMute('green');
  e.start(0);
  run(e, 0, 2);
  assert.equal(e.keep(), null);
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

test('ring: clicks hit any note', () => {
  const notes = [box(1, 0.5, 0.02), box(2, 0.5, 0.5)];
  assert.equal(noteAt(notes, [0.5, 0.52])?.id, 2);
  assert.equal(noteAt(notes, [0.5, 0.05])?.id, 1, 'top of the wall too');
  assert.equal(noteAt(notes, [0.9, 0.9]), null, 'empty wall');
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
