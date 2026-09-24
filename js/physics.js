// matter.js world for the projector: screen-edge walls, static note bodies and
// bouncing balls. Works in projector CSS pixels internally; notes come in and
// balls go out in projector-normalized coordinates.
//
// matter.js velocities are "pixels per 1000/60 ms"; multiply by 60 for px/s.

const { Engine, Bodies, Body, Composite, Vertices, Collision } = window.Matter;

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
const STATIC_OPTS = { isStatic: true, restitution: 1, friction: 0, frictionStatic: 0 };

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
    this.config = { gravity: false, ballRadius: 0.025, ballSpeed: 0.45 };
    this._buildWalls();
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
    const states = this.balls.map((b) => ({
      x: b.position.x * sx,
      y: b.position.y * sy,
      v: Body.getVelocity(b),
    }));
    this._replaceBalls(states);
  }

  // ---------------------------------------------------------------- notes

  /** @param notes [{ id, corners: [[x,y] x4] }] projector-normalized */
  setNotes(notes) {
    const seen = new Set();
    const touched = [];
    for (const n of notes) {
      seen.add(n.id);
      const key = JSON.stringify(n.corners);
      const old = this.notes.get(n.id);
      if (old && old.key === key) continue;
      if (old?.body) Composite.remove(this.world, old.body);
      const body = this._noteBody(n.corners);
      if (body) {
        Composite.add(this.world, body);
        touched.push(body);
      }
      this.notes.set(n.id, { key, corners: n.corners, body });
    }
    for (const [id, n] of this.notes) {
      if (seen.has(id)) continue;
      if (n.body) Composite.remove(this.world, n.body);
      this.notes.delete(id);
    }
    // A note that appears (or moves) on top of a ball pushes the ball out.
    if (touched.length) this.balls.forEach((b) => this._evict(b, touched));
  }

  _noteBody(corners) {
    const verts = corners.map(([x, y]) => ({ x: x * this.w, y: y * this.h }));
    if (Math.abs(Vertices.area(verts, true)) < 16) return null;
    const c = Vertices.centre(verts);
    return Bodies.fromVertices(c.x, c.y, [verts], STATIC_OPTS);
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

  addBall(pos) {
    const r = this.radiusPx();
    const p = pos || this._freeSpot();
    const ball = Bodies.circle(p.x, p.y, r, BALL_OPTS);
    Body.setVelocity(ball, this._randomVelocity());
    this.balls.push(ball);
    Composite.add(this.world, ball);
    return ball;
  }

  clearBalls() {
    Composite.remove(this.world, this.balls);
    this.balls = [];
  }

  resetBalls() {
    this.clearBalls();
    this.addBall();
  }

  _replaceBalls(states) {
    this.clearBalls();
    for (const s of states) {
      const r = this.radiusPx();
      const ball = Bodies.circle(
        Math.min(Math.max(s.x, r), this.w - r),
        Math.min(Math.max(s.y, r), this.h - r),
        r,
        BALL_OPTS,
      );
      Body.setVelocity(ball, s.v);
      this.balls.push(ball);
      Composite.add(this.world, ball);
    }
  }

  setConfig(cfg) {
    const radiusChanged = cfg.ballRadius !== undefined && cfg.ballRadius !== this.config.ballRadius;
    Object.assign(this.config, cfg);
    this.engine.gravity.y = this.config.gravity ? 1 : 0;
    if (radiusChanged) {
      this._replaceBalls(this.balls.map((b) => ({ x: b.position.x, y: b.position.y, v: Body.getVelocity(b) })));
    }
  }

  // ---------------------------------------------------------------- simulation

  step(dtMs) {
    const dt = Math.min(dtMs, 50); // after a stall, don't jump
    const n = Math.max(1, Math.ceil(dt / SUBSTEP_MS));
    for (let i = 0; i < n; i++) {
      Engine.update(this.engine, dt / n);
      this._regulateSpeed();
    }
    this._rescueEscapees();
  }

  // restitution 1 still bleeds a little energy in matter.js; without gravity
  // we pin every ball to the target speed. With gravity we only cap it.
  _regulateSpeed() {
    const target = this.speedUnits();
    for (const b of this.balls) {
      let v = Body.getVelocity(b);
      let mag = Math.hypot(v.x, v.y);
      if (this.config.gravity) {
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
        Body.setVelocity(b, this._randomVelocity());
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
      };
    });
  }
}
