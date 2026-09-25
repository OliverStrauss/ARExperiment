// matter.js world for the projector: screen-edge walls, static note bodies and
// balls. Two modes:
//   drop   - a ball waits at the top, is steered left/right, then dropped and
//            falls under gravity, bouncing off notes until it settles.
//            With dropGravity off, the dropped ball is a metronome: it stays in
//            its column and bounces straight up and down at a constant speed
//            (note below <-> top wall), so it hits the note on a steady beat.
//   bounce - balls fly around at a constant speed with no gravity.
// Works in projector CSS pixels internally; notes come in and
// balls go out in projector-normalized coordinates.
//
// matter.js velocities are "pixels per 1000/60 ms"; multiply by 60 for px/s.

const { Engine, Events, Bodies, Body, Composite, Vertices, Collision } = window.Matter;

const WALL = 1000; // wall thickness in px: thick enough that nothing tunnels
const SUBSTEP_MS = 1000 / 120;
const BALL_OPTS = {
  restitution: 1,
  friction: 0,
  frictionAir: 0,
  frictionStatic: 0,
  inertia: Infinity, // no spin, so bounces stay "billiard"-like
  slop: 0.01,
  label: 'ball',
};
// Drop mode: a livelier-than-real ball that still comes to rest.
const DROP_OPTS = {
  restitution: 0.6,
  friction: 0.02,
  frictionAir: 0.004,
  frictionStatic: 0.05,
  inertia: Infinity,
  slop: 0.01,
  label: 'ball',
};
const STEER_SPEED = 0.5; // screen widths per second while an arrow key is held
const STATIC_OPTS = { isStatic: true, restitution: 1, friction: 0, frictionStatic: 0 };
const HIT_MIN = 0.04; // impacts slower than this fraction of ball speed are silent (rolling, settling)
const HIT_COOLDOWN_MS = 120; // same ball + same note can't retrigger faster than this

export class PhysicsWorld {
  constructor(w, h) {
    this.engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0.001 } });
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 8;
    this.world = this.engine.world;
    this.w = w;
    this.h = h;
    this.walls = [];
    this.balls = [];
    this.notes = new Map(); // id -> { key, corners (normalized), body }
    this.config = { mode: 'bounce', gravity: false, dropGravity: true, ballRadius: 0.012, ballSpeed: 0.45 };
    this.steerDir = 0; // -1 left, 0, +1 right (drop mode)
    this.onHit = null; // ({ id, color, strength 0..1 }) => void, when a ball hits a note
    this._buildWalls();
    Events.on(this.engine, 'collisionStart', (e) => this._onCollisions(e.pairs));
  }

  // ---------------------------------------------------------------- geometry

  radiusPx() {
    return Math.max(3, this.config.ballRadius * Math.min(this.w, this.h));
  }

  // target speed in matter units (px per 1000/60 ms)
  speedUnits() {
    return (this.config.ballSpeed * this.w) / 60;
  }

  _buildWalls() {
    if (this.walls.length) Composite.remove(this.world, this.walls);
    const { w, h } = this;
    const T = WALL;
    this.walls = [
      Bodies.rectangle(w / 2, -T / 2, w + 2 * T, T, STATIC_OPTS),
      Bodies.rectangle(w / 2, h + T / 2, w + 2 * T, T, STATIC_OPTS),
      Bodies.rectangle(-T / 2, h / 2, T, h + 2 * T, STATIC_OPTS),
      Bodies.rectangle(w + T / 2, h / 2, T, h + 2 * T, STATIC_OPTS),
    ];
    Composite.add(this.world, this.walls);
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const sx = w / this.w;
    const sy = h / this.h;
    this.w = w;
    this.h = h;
    this._buildWalls();
    const notes = [...this.notes.entries()].map(([id, n]) => ({ id, corners: n.corners }));
    this.setNotes([]);
    this.setNotes(notes);
    this._replaceBalls(this._ballStates(sx, sy));
  }

  _ballStates(sx = 1, sy = 1) {
    return this.balls.map((b) => ({
      x: b.position.x * sx,
      y: b.position.y * sy,
      v: Body.getVelocity(b),
      held: !!b.plugin.held,
    }));
  }

  // ---------------------------------------------------------------- notes

  /** @param notes [{ id, corners: [[x,y] x4], color? }] projector-normalized */
  setNotes(notes) {
    const seen = new Set();
    const touched = [];
    for (const n of notes) {
      seen.add(n.id);
      const key = JSON.stringify(n.corners);
      const old = this.notes.get(n.id);
      if (old && old.key === key) {
        old.color = n.color;
        continue;
      }
      if (old?.body) Composite.remove(this.world, old.body);
      const body = this._noteBody(n.corners);
      if (body) {
        body.plugin.noteId = n.id;
        Composite.add(this.world, body);
        touched.push(body);
      }
      this.notes.set(n.id, { key, corners: n.corners, body, color: n.color });
    }
    for (const [id, n] of this.notes) {
      if (seen.has(id)) continue;
      if (n.body) Composite.remove(this.world, n.body);
      this.notes.delete(id);
    }
    // A note that appears (or moves) on top of a ball pushes the ball out.
    if (touched.length) this.balls.forEach((b) => !b.plugin.held && this._evict(b, touched));
  }

  _noteBody(corners) {
    const verts = corners.map(([x, y]) => ({ x: x * this.w, y: y * this.h }));
    if (Math.abs(Vertices.area(verts, true)) < 16) return null;
    const c = Vertices.centre(verts);
    return Bodies.fromVertices(c.x, c.y, [verts], STATIC_OPTS);
  }

  // collisionStart fires before the solver, so the ball's velocity is still
  // the incoming one: its component along the contact normal is the impact.
  _onCollisions(pairs) {
    if (!this.onHit) return;
    const now = this.engine.timing.timestamp;
    for (const pair of pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const ball = a.label === 'ball' ? a : b.label === 'ball' ? b : null;
      const other = ball === a ? b : a;
      const id = other.plugin?.noteId;
      if (!ball || ball.plugin.held || id === undefined) continue;
      const v = Body.getVelocity(ball);
      const n = pair.collision.normal;
      const strength = Math.min(1, Math.abs(v.x * n.x + v.y * n.y) / this.speedUnits());
      if (strength < HIT_MIN) continue;
      const last = ball.plugin.lastHit;
      if (last && last.id === id && now - last.t < HIT_COOLDOWN_MS) continue;
      ball.plugin.lastHit = { id, t: now };
      this.onHit({ id, color: this.notes.get(id)?.color, strength });
    }
  }

  // Push a ball out of any overlapping bodies; respawn it if it is deep inside.
  _evict(ball, bodies) {
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const body of bodies) {
        if (Vertices.contains(body.vertices, ball.position)) {
          const p = this._freeSpot();
          Body.setPosition(ball, p);
          return;
        }
        const col = Collision.collides(ball, body);
        if (!col || !col.collided) continue;
        const d = col.depth + 1;
        const n = col.normal;
        // normal direction convention varies: try one way, else the other
        Body.setPosition(ball, { x: ball.position.x + n.x * d, y: ball.position.y + n.y * d });
        const again = Collision.collides(ball, body);
        if (again && again.collided) {
          Body.setPosition(ball, { x: ball.position.x - 2 * n.x * d, y: ball.position.y - 2 * n.y * d });
        }
        moved = true;
      }
      if (!moved) return;
    }
  }

  _overlapsAnything(x, y, r) {
    const probe = Bodies.circle(x, y, r);
    const bodies = [...this.notes.values()].map((n) => n.body).filter(Boolean);
    return bodies.some((b) => {
      const c = Collision.collides(probe, b);
      return c && c.collided;
    });
  }

  _freeSpot() {
    const r = this.radiusPx();
    for (let i = 0; i < 200; i++) {
      const x = r * 2 + Math.random() * (this.w - r * 4);
      const y = r * 2 + Math.random() * (this.h - r * 4);
      if (!this._overlapsAnything(x, y, r * 1.5)) return { x, y };
    }
    return { x: this.w / 2, y: this.h / 2 };
  }

  // ---------------------------------------------------------------- balls

  _randomVelocity() {
    // avoid near-horizontal/vertical directions that make boring bounces
    const quadrant = Math.floor(Math.random() * 4);
    const a = (quadrant * Math.PI) / 2 + Math.PI / 8 + Math.random() * (Math.PI / 4);
    const s = this.speedUnits();
    return { x: Math.cos(a) * s, y: Math.sin(a) * s };
  }

  _makeBall(x, y) {
    const opts = this.config.mode === 'drop' ? DROP_OPTS : BALL_OPTS;
    const ball = Bodies.circle(x, y, this.radiusPx(), { ...opts, plugin: {} });
    this.balls.push(ball);
    Composite.add(this.world, ball);
    return ball;
  }

  // Bounce mode: a flying ball at a free spot. Drop mode: a new held ball.
  addBall(pos) {
    if (this.config.mode === 'drop') return this.spawnHeld();
    const p = pos || this._freeSpot();
    const ball = this._makeBall(p.x, p.y);
    Body.setVelocity(ball, this._randomVelocity());
    return ball;
  }

  // ---- drop mode

  heldY() {
    return this.radiusPx() * 1.5 + 2;
  }

  // A ball parked at the top. It is a sensor (no collisions) until dropped.
  spawnHeld(x) {
    const held = this.balls.find((b) => b.plugin.held);
    if (held) return held;
    const ball = this._makeBall(x ?? this.lastHeldX ?? this.w / 2, this.heldY());
    ball.isSensor = true;
    ball.plugin.held = true;
    return ball;
  }

  steer(dir) {
    this.steerDir = Math.sign(dir) || 0;
  }

  // Release the held ball. Returns true if something was dropped.
  drop() {
    const held = this.balls.filter((b) => b.plugin.held);
    for (const b of held) {
      b.plugin.held = false;
      b.isSensor = false;
      b.plugin.lockX = b.position.x;
      Body.setVelocity(b, { x: 0, y: this.hasGravity() ? 0 : this.speedUnits() });
      const notes = [...this.notes.values()].map((n) => n.body).filter(Boolean);
      this._evict(b, notes);
    }
    return held.length > 0;
  }

  _updateHeld(dtMs) {
    const r = this.radiusPx();
    for (const b of this.balls) {
      if (!b.plugin.held) continue;
      let x = b.position.x + (this.steerDir * STEER_SPEED * this.w * dtMs) / 1000;
      x = Math.min(Math.max(x, r), this.w - r);
      this.lastHeldX = x;
      Body.setPosition(b, { x, y: this.heldY() });
      Body.setVelocity(b, { x: 0, y: 0 });
    }
  }

  clearBalls() {
    Composite.remove(this.world, this.balls);
    this.balls = [];
  }

  resetBalls() {
    this.clearBalls();
    if (this.config.mode === 'drop') this.spawnHeld();
    else this.addBall();
  }

  _replaceBalls(states) {
    this.clearBalls();
    for (const s of states) {
      const r = this.radiusPx();
      const ball = this._makeBall(Math.min(Math.max(s.x, r), this.w - r), Math.min(Math.max(s.y, r), this.h - r));
      Body.setVelocity(ball, s.v);
      if (s.held) {
        ball.isSensor = true;
        ball.plugin.held = true;
      }
    }
  }

  // Drop mode has its own gravity toggle (on by default); bounce uses `gravity`.
  hasGravity() {
    return this.config.mode === 'drop' ? this.config.dropGravity : this.config.gravity;
  }

  setConfig(cfg) {
    const radiusChanged = cfg.ballRadius !== undefined && cfg.ballRadius !== this.config.ballRadius;
    const modeChanged = cfg.mode !== undefined && cfg.mode !== this.config.mode;
    Object.assign(this.config, cfg);
    this.engine.gravity.y = this.hasGravity() ? 1 : 0;
    if (modeChanged) this.resetBalls();
    else if (radiusChanged) this._replaceBalls(this._ballStates());
  }

  // ---------------------------------------------------------------- simulation

  step(dtMs) {
    const dt = Math.min(dtMs, 50); // after a stall, don't jump
    const n = Math.max(1, Math.ceil(dt / SUBSTEP_MS));
    for (let i = 0; i < n; i++) {
      this._updateHeld(dt / n);
      Engine.update(this.engine, dt / n);
      this._updateHeld(0);
      this._regulateSpeed();
    }
    this._rescueEscapees();
  }

  // restitution 1 still bleeds a little energy in matter.js; without gravity
  // we pin every ball to the target speed. With gravity we only cap it.
  _regulateSpeed() {
    const target = this.speedUnits();
    for (const b of this.balls) {
      if (b.plugin.held) continue;
      let v = Body.getVelocity(b);
      let mag = Math.hypot(v.x, v.y);
      // Zero-g drop: lock the ball to its column so tilted notes can't
      // deflect it; only the vertical direction survives a collision.
      if (this.config.mode === 'drop' && !this.config.dropGravity) {
        b.plugin.lockX ??= b.position.x; // balls rebuilt on resize/toggle have none
        if (Math.abs(b.position.x - b.plugin.lockX) > 1e-6) Body.setPosition(b, { x: b.plugin.lockX, y: b.position.y });
        Body.setVelocity(b, { x: 0, y: (v.y < 0 ? -1 : 1) * target });
        continue;
      }
      b.plugin.lockX = undefined; // re-lock at the current x if zero-g comes back
      if (this.hasGravity()) {
        const cap = target * 2.5;
        if (mag > cap) Body.setVelocity(b, { x: (v.x / mag) * cap, y: (v.y / mag) * cap });
        continue;
      }
      if (mag < 1e-6) {
        v = this._randomVelocity();
        mag = target;
      }
      let vx = v.x / mag;
      let vy = v.y / mag;
      // nudge away from perfectly axis-aligned motion (endless ping-pong)
      const minComp = 0.15;
      if (Math.abs(vx) < minComp) vx = Math.sign(vx || 1) * minComp;
      if (Math.abs(vy) < minComp) vy = Math.sign(vy || 1) * minComp;
      const m = Math.hypot(vx, vy);
      Body.setVelocity(b, { x: (vx / m) * target, y: (vy / m) * target });
    }
  }

  // If a ball somehow ends up outside the screen, bring it back.
  _rescueEscapees() {
    for (const b of this.balls) {
      const { x, y } = b.position;
      if (x < -5 || y < -5 || x > this.w + 5 || y > this.h + 5 || !Number.isFinite(x + y)) {
        Body.setPosition(b, this._freeSpot());
        Body.setVelocity(b, this.config.mode === 'drop' ? { x: 0, y: 0 } : this._randomVelocity());
      }
    }
  }

  // ---------------------------------------------------------------- output

  /** Balls in projector-normalized units; velocities per second. */
  ballsNormalized() {
    const r = this.radiusPx();
    return this.balls.map((b) => {
      const v = Body.getVelocity(b);
      return {
        x: b.position.x / this.w,
        y: b.position.y / this.h,
        rx: r / this.w,
        ry: r / this.h,
        vx: (v.x * 60) / this.w,
        vy: (v.y * 60) / this.h,
        held: !!b.plugin.held,
      };
    });
  }
}
