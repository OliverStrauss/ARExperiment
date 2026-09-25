// Beat engine: clock, balls and the look-ahead scheduler (pure JS, no DOM).
//
// Musical time is counted in 16th notes ("pos"). The clock maps seconds to pos:
//   pos(t) = pos0 + (t - anchor) * bpm / 15        (bpm / 15 = 16ths per second)
// A tempo change re-anchors the clock at the current pos, so everything stays
// continuous and all lanes speed up or slow down together.
//
// A ball in a lane of length n (16ths, see lanes.js) is defined by its phase:
// the pos at which it hits the target. It hits at phase + k*n and is back at
// the rail halfway between hits. Its position is analytic (ballProgress), so
// the projector draws it from the same clock without any physics.
//
// Times passed in (`now`) are seconds on a clock shared by both windows:
// epochNow() = (performance.timeOrigin + performance.now()) / 1000.

export const BEAT_DEFAULTS = {
  bpm: 96,
  snap: true,
  maxBallsPerLane: 4,
  echoBars: 4, // 4/4 bars kept in the echo buffer
  lookahead: 0.1, // s scheduled ahead of now
  grace: 0.05, // s: a late tick still schedules hits this far in the past
  velocity: 0.8,
};
export const MIN_BPM = 30;
export const MAX_BPM = 240;

export function epochNow() {
  return (performance.timeOrigin + performance.now()) / 1000;
}

export function sixteenthSec(bpm) {
  return 60 / bpm / 4;
}

/** Clock state as sent to the projector -> pos at `now` (s). */
export function clockPos(clock, now) {
  return clock.running ? clock.pos0 + ((now - clock.anchor) * clock.bpm) / 15 : clock.pos0;
}

/** 0 at the rail, 1 when touching the target. Hits when pos = phase (mod n). */
export function ballProgress(pos, phase, n) {
  const u = ((((pos - phase) / n + 0.5) % 1) + 1) % 1;
  return 1 - Math.abs(1 - 2 * u);
}

/**
 * Normalized y of a ball's centre. It turns round just below the rail note
 * (so it never lights the paper) and touches the target's top edge on a hit.
 * @param rN ball radius as a fraction of the projector height
 */
export function ballY(lane, phase, pos, railBottom, rN) {
  const y0 = Math.max(railBottom, (lane.railNoteBottom ?? railBottom) + rN * 1.5);
  if (lane.n == null || lane.top == null) return y0;
  const y1 = Math.max(y0, lane.top - rN);
  return y0 + (y1 - y0) * ballProgress(pos, phase, lane.n);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class BeatEngine {
  constructor(opts = {}) {
    this.o = { ...BEAT_DEFAULTS, ...opts };
    this.bpm = this.o.bpm;
    this.snap = this.o.snap;
    this.running = false;
    this.anchor = 0; // s: when pos was pos0
    this.pos0 = 0;
    this.horizon = 0; // pos up to which hits have been scheduled
    this.lanes = []; // from buildLanes()
    this.balls = new Map(); // laneId -> [{ id, phase }] in the order added
    this.nextBall = 1;
    this.instruments = new Map(); // noteId -> instrument id
    this.mutes = new Set(); // colour names
    this.solo = null; // colour name or null
  }

  setOptions(opts) {
    Object.assign(this.o, opts);
  }

  // ---------------------------------------------------------------- clock

  pos(now) {
    return clockPos(this, now);
  }

  /** Seconds at which the clock reaches `pos` (while running). */
  timeAt(pos) {
    return this.anchor + ((pos - this.pos0) * 15) / this.bpm;
  }

  clock() {
    return { running: this.running, bpm: this.bpm, anchor: this.anchor, pos0: this.pos0 };
  }

  start(now) {
    if (this.running) return;
    this.anchor = now;
    this.running = true;
    this.horizon = this.pos0;
  }

  stop(now) {
    if (!this.running) return;
    this.pos0 = this.pos(now);
    this.anchor = now;
    this.running = false;
  }

  toggle(now) {
    if (this.running) this.stop(now);
    else this.start(now);
    return this.running;
  }

  setBpm(bpm, now) {
    this.pos0 = this.pos(now);
    this.anchor = now;
    this.bpm = clamp(Math.round(bpm), MIN_BPM, MAX_BPM);
    return this.bpm;
  }

  // ---------------------------------------------------------------- lanes + balls

  /** Lanes from buildLanes(). New lanes get one ball; vanished lanes lose theirs. */
  setLanes(lanes) {
    const ids = new Set(lanes.map((l) => l.id));
    for (const id of [...this.balls.keys()]) if (!ids.has(id)) this.balls.delete(id);
    for (const l of lanes) if (!this.balls.has(l.id)) this.balls.set(l.id, [this._ball(0)]);
    this.lanes = lanes;
  }

  lane(id) {
    return this.lanes.find((l) => l.id === id);
  }

  ballsOf(laneId) {
    return this.balls.get(laneId) || [];
  }

  _ball(phase) {
    return { id: this.nextBall++, phase };
  }

  /** Drop a ball now: it leaves the rail now and hits n/2 later (on the grid with Snap). */
  addBall(laneId, now) {
    const list = this.balls.get(laneId);
    if (!list || list.length >= this.o.maxBallsPerLane) return null;
    const n = this.lane(laneId)?.n ?? 4;
    const hit = this.pos(now) + n / 2;
    const ball = this._ball(this.snap ? Math.round(hit) : hit);
    list.push(ball);
    return ball;
  }

  /** Remove the most recently added ball (a lane keeps at least one). */
  removeBall(laneId) {
    const list = this.balls.get(laneId);
    if (!list || list.length <= 1) return false;
    list.pop();
    return true;
  }

  /** One ball per lane, hitting on the downbeat. */
  resetBalls() {
    for (const id of this.balls.keys()) this.balls.set(id, [this._ball(0)]);
  }

  // ---------------------------------------------------------------- instruments

  instrumentOf(noteId) {
    return this.instruments.get(noteId) ?? 'bell';
  }

  setInstrument(noteId, id) {
    this.instruments.set(noteId, id);
  }

  /** Forget instruments of notes that are no longer tracked. */
  pruneInstruments(noteIds) {
    const keep = new Set(noteIds);
    for (const id of [...this.instruments.keys()]) if (!keep.has(id)) this.instruments.delete(id);
  }

  // ---------------------------------------------------------------- mute / solo

  audible(color) {
    return this.solo ? color === this.solo : !this.mutes.has(color);
  }

  toggleMute(color) {
    if (this.mutes.has(color)) this.mutes.delete(color);
    else this.mutes.add(color);
    return this.mutes.has(color);
  }

  toggleSolo(color) {
    this.solo = this.solo === color ? null : color;
    return this.solo;
  }

  // ---------------------------------------------------------------- scheduler

  /**
   * Call every ~25 ms. Returns the hits that fall between the last call and
   * now + lookahead, each once, with its exact time:
   *   [{ time, pos, laneId, ballId, noteId, color, instrument, velocity }]
   */
  tick(now) {
    if (!this.running) return [];
    const from = Math.max(this.horizon, this.pos(now - this.o.grace));
    const to = this.pos(now + this.o.lookahead);
    if (to <= from) return [];
    const hits = [];
    for (const lane of this.lanes) {
      if (lane.n == null || !this.audible(lane.color)) continue;
      for (const ball of this.ballsOf(lane.id)) {
        for (let p = ball.phase + Math.ceil((from - ball.phase) / lane.n) * lane.n; p < to; p += lane.n) {
          if (p < from) continue;
          hits.push({
            time: this.timeAt(p),
            pos: p,
            laneId: lane.id,
            ballId: ball.id,
            noteId: lane.targetId,
            color: lane.color,
            instrument: this.instrumentOf(lane.targetId),
            velocity: this.o.velocity,
          });
        }
      }
    }
    this.horizon = to;
    return hits.sort((a, b) => a.time - b.time);
  }
}
