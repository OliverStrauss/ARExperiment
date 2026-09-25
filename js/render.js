// Draws what the projector shows. Shared by projector.html and by the simulated
// camera (which "projects" the same picture onto its fake wall).
//
// Scene coordinates are projector-normalized (0..1). Pixel sizes are given at a
// 1600x900 reference and scaled by min(w/1600, h/900). Black background;
// white is the only UI colour apart from note-coloured hit halos, and nothing
// but halos, rings and tags is drawn near the notes, so vision stays clean.

import { clockPos, ballY } from './beat.js';
import { rateLabel } from './lanes.js';
import { centroid } from './tracker.js';
import { rgbOf, pitchOf } from './colors.js';
import { KEY_HELP } from './keys.js';

// Calibration dot centres, numbered 1..4 clockwise from top-left.
export const CALIB_DOTS = [
  [0.05, 0.05],
  [0.95, 0.05],
  [0.95, 0.95],
  [0.05, 0.95],
];

export const BALL_R = 15; // ball radius, px at the reference size
// The ball turns round this far above the target. Projected light must never
// touch the paper: the ball mask would cut into the note, the note would be
// detected smaller, the lane longer, and the mask would follow it in.
export const BALL_GAP = 8;
export const HALO_MS = 250;
export const HALO_PAD = 14; // halo polygon inflation, px at the reference size
export const HALO_MASK = [8, 32]; // band around a haloed note blanked for vision, px
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

export function refScale(w, h) {
  return Math.min(w / 1600, h / 900);
}

/** Ball radius and turn-round gap as fractions of the projector height. */
export function ballRadiusN(w, h) {
  return (BALL_R * refScale(w, h)) / h;
}
export function ballGapN(w, h) {
  return (BALL_GAP * refScale(w, h)) / h;
}

const white = (a) => `rgba(255,255,255,${a})`;

/**
 * @param scene.calib     show white border + numbered corner dots
 * @param scene.cross     [x,y] test crosshair or null
 * @param scene.notes     [{ id, corners: [[x,y] x4], color }]
 * @param scene.outlines  draw faint note outlines
 * @param scene.beat      'beat' message (see channel.js) or null
 * @param scene.halos     [{ noteId, color, at }] hit halos (at = s, epoch clock)
 * @param scene.ring      'ring' message or null
 * @param scene.echo      'echo' message or null
 * @param scene.toast     { key, text, at } or null
 * @param scene.now       s, epoch clock (see beat.js epochNow)
 */
export function drawScene(ctx, w, h, scene) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const m = Math.min(w, h);

  if (scene.outlines && scene.notes) {
    ctx.strokeStyle = white(0.35);
    ctx.lineWidth = Math.max(1, m * 0.003);
    for (const n of scene.notes) {
      poly(ctx, n.corners.map(([x, y]) => [x * w, y * h]));
      ctx.stroke();
    }
  }

  if (scene.calib) {
    drawCalibration(ctx, w, h);
  } else if (scene.beat) {
    drawBeat(ctx, w, h, scene);
  }

  if (scene.cross) {
    const [cx, cy] = [scene.cross[0] * w, scene.cross[1] * h];
    const L = m * 0.05;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, m * 0.004);
    ctx.beginPath();
    ctx.moveTo(cx - L, cy);
    ctx.lineTo(cx + L, cy);
    ctx.moveTo(cx, cy - L);
    ctx.lineTo(cx, cy + L);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, L * 0.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawCalibration(ctx, w, h) {
  const m = Math.min(w, h);
  const bw = Math.max(6, m * 0.012);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = bw;
  ctx.strokeRect(bw / 2, bw / 2, w - bw, h - bw);

  const r = Math.max(6, m * 0.014);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(m * 0.06)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  CALIB_DOTS.forEach(([x, y], i) => {
    const px = x * w;
    const py = y * h;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    // number sits diagonally towards the centre so it never covers the dot
    const dx = x < 0.5 ? 1 : -1;
    const dy = y < 0.5 ? 1 : -1;
    ctx.fillText(String(i + 1), px + dx * m * 0.07, py + dy * m * 0.07);
  });
  ctx.font = `${Math.round(m * 0.025)}px sans-serif`;
  ctx.fillStyle = '#aaa';
  ctx.fillText('Calibrating: click dots 1-4 in the control window', w / 2, h / 2);
}

// ---------------------------------------------------------------- beat layers

function drawBeat(ctx, w, h, scene) {
  const b = scene.beat;
  const s = refScale(w, h);
  const now = scene.now;
  const pos = clockPos(b.clock, now);
  const notes = new Map((scene.notes || []).map((n) => [n.id, n]));
  const px = (p) => [p[0] * w, p[1] * h];
  const railY = b.railBottom * h;

  // ruler: one line per 1/16 below the rail
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let k = 1; k <= 6; k++) {
    const y = Math.round((b.railBottom + k * b.unit) * h) + 0.5;
    if (y > h) break;
    const major = k % 2 === 0;
    ctx.fillStyle = white(major ? 0.09 : 0.04);
    ctx.fillRect(0, y - 0.5, w, 1);
    ctx.fillStyle = white(major ? 0.6 : 0.35);
    ctx.font = `${Math.round((major ? 15 : 12) * s)}px ${MONO}`;
    ctx.fillText(rateLabel(k), 10 * s, y - 10 * s);
  }

  // rail
  ctx.strokeStyle = white(0.22);
  ctx.lineWidth = Math.max(1, 1.5 * s);
  ctx.setLineDash([8 * s, 8 * s]);
  roundRect(ctx, 24 * s, 16 * s, w - 48 * s, Math.max(10, railY - 32 * s), 14 * s);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = white(0.45);
  ctx.font = `${Math.round(13 * s)}px ${MONO}`;
  ctx.fillText('RAIL · A NOTE HERE OPENS A LANE BELOW IT', 40 * s, railY - 30 * s);

  const rN = ballRadiusN(w, h);
  const gN = ballGapN(w, h);
  const lanes = b.lanes || [];

  // lane bands + dashed centre lines
  for (const lane of lanes) {
    const hi = lane.id === b.highlight;
    const x = lane.x * w;
    const lw = lane.w * w;
    const y0 = Math.max(railY, (lane.railNoteBottom ?? 0) * h + 6 * s);
    const y1 = lane.top != null ? lane.top * h : h;
    if (y1 > y0) {
      ctx.fillStyle = white(lane.top != null ? (hi ? 0.07 : 0.03) : hi ? 0.04 : 0.015);
      ctx.fillRect(x - lw / 2, y0, lw, y1 - y0);
      ctx.strokeStyle = white(lane.top != null ? 0.22 : 0.1);
      ctx.lineWidth = Math.max(1, s);
      ctx.setLineDash([2 * s, 12 * s]);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // rail note rings + rate labels, highlight box
  for (const lane of lanes) {
    const rail = notes.get(lane.id);
    if (!rail) continue;
    const pts = rail.corners.map(px);
    const [cx, cy] = centroid(pts);
    const reach = Math.max(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const R = Math.max(46 * s, reach + 8 * s);
    ctx.lineWidth = Math.max(1.5, 3 * s);
    ctx.strokeStyle = white(0.2);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    const first = lane.balls?.[0];
    if (first && lane.n != null) {
      // cycle progress of ball 1, 0 = just hit
      const u = ((((pos - first.phase) / lane.n) % 1) + 1) % 1;
      ctx.strokeStyle = white(0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + u * Math.PI * 2);
      ctx.stroke();
    }
    const count = lane.balls?.length || 0;
    const label = lane.n == null ? '—' : `${rateLabel(lane.n, b.snap)}${count > 1 ? ` ×${count}` : ''}`;
    ctx.fillStyle = white(lane.n == null ? 0.4 : 0.85);
    ctx.font = `${Math.round(15 * s)}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText(label, cx + R + 10 * s, cy);
    if (lane.id === b.highlight) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const side = Math.max(116 * s, Math.max(...xs) - Math.min(...xs) + 24 * s, Math.max(...ys) - Math.min(...ys) + 24 * s);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, 2.5 * s);
      roundRect(ctx, cx - side / 2, cy - side / 2, side, side, 18 * s);
      ctx.stroke();
    }
  }

  // note tags under targets: "C4 · KICK"
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(15 * s)}px ${MONO}`;
  const tagged = new Set();
  for (const lane of lanes) {
    if (lane.targetId == null || tagged.has(lane.targetId)) continue;
    tagged.add(lane.targetId);
    const note = notes.get(lane.targetId);
    if (!note) continue;
    const pts = note.corners.map(px);
    const [cx] = centroid(pts);
    const bottom = Math.max(...pts.map((p) => p[1]));
    const muted = b.solo ? lane.color !== b.solo : (b.mutes || []).includes(lane.color);
    ctx.fillStyle = white(muted ? 0.35 : 0.8);
    const tag = `${pitchOf(lane.color) ?? '?'} · ${(lane.instrument || 'bell').toUpperCase()}${muted ? ' · MUTE' : ''}`;
    ctx.fillText(tag, cx, bottom + 22 * s);
  }

  // balls (+ a short trail on the side they came from)
  const trailDt = 0.035 * (b.clock.bpm / 15); // 35 ms in 16ths
  for (const lane of lanes) {
    const x = lane.x * w;
    for (const ball of lane.balls || []) {
      if (b.clock.running && lane.n != null) {
        [12, 9, 6].forEach((r, i) => {
          ctx.fillStyle = white([0.35, 0.18, 0.08][i]);
          ctx.beginPath();
          ctx.arc(x, ballY(lane, ball.phase, pos - trailDt * (i + 1), b.railBottom, rN, gN) * h, r * s, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.save();
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = 24 * s;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, ballY(lane, ball.phase, pos, b.railBottom, rN, gN) * h, BALL_R * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // hit halos
  for (const halo of scene.halos || []) {
    const age = (now - halo.at) * 1000;
    const note = notes.get(halo.noteId);
    if (!note || age < 0 || age > HALO_MS) continue;
    const pts = inflate(note.corners.map(px), HALO_PAD * s);
    const [r, g, bl] = rgbOf(halo.color);
    ctx.save();
    ctx.globalAlpha = 1 - age / HALO_MS;
    ctx.strokeStyle = `rgb(${r},${g},${bl})`;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 60 * s;
    ctx.lineWidth = 4 * s;
    ctx.lineJoin = 'round';
    poly(ctx, pts);
    ctx.stroke();
    ctx.restore();
  }

  if (scene.ring?.open) drawRing(ctx, w, h, scene.ring, notes.get(scene.ring.noteId), now);
  if (scene.echo) drawEcho(ctx, w, h, scene.echo, b, pos);
  if (scene.toast && now - scene.toast.at < 1) drawToast(ctx, w, h, scene.toast);
  if (b.overlay) drawHelp(ctx, w, h);
}

/** Polygon grown outwards by `d` px (corners pushed along their bisector). */
export function inflate(pts, d) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  if (area < 0) d = -d; // anticlockwise on screen: the normals below point inwards
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n];
    const c = pts[(i + 1) % n];
    const u1 = unit([p[0] - a[0], p[1] - a[1]]);
    const u2 = unit([c[0] - p[0], c[1] - p[1]]);
    // outward normals of both edges (clockwise on screen, y down)
    const n1 = [u1[1], -u1[0]];
    const n2 = [u2[1], -u2[0]];
    const bis = unit([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.3, bis[0] * n1[0] + bis[1] * n1[1]);
    return [p[0] + (bis[0] * d) / cos, p[1] + (bis[1] * d) / cos];
  });
}

function unit([x, y]) {
  const L = Math.hypot(x, y) || 1;
  return [x / L, y / L];
}

// ---------------------------------------------------------------- instrument ring

function drawRing(ctx, w, h, ring, note, now) {
  if (!note) return;
  const s = refScale(w, h);
  const [cx, cy] = centroid(note.corners.map((p) => [p[0] * w, p[1] * h]));
  const N = ring.choices.length;
  const R = 135 * s;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(15 * s)}px ${MONO}`;
  ring.choices.forEach((name, i) => {
    let d = (((i - ring.index) % N) + N) % N;
    const a = -Math.PI / 2 + (d * 2 * Math.PI) / N;
    d = Math.min(d, N - d);
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    const label = name.toUpperCase();
    if (d === 0) {
      const tw = ctx.measureText(label).width + 24 * s;
      ctx.fillStyle = '#fff';
      roundRect(ctx, x - tw / 2, y - 15 * s, tw, 30 * s, 15 * s);
      ctx.fill();
      ctx.fillStyle = '#000';
    } else {
      ctx.fillStyle = white([1, 0.75, 0.5, 0.3][Math.min(3, d)]);
    }
    ctx.fillText(label, x, y);
  });
  // countdown to the automatic commit
  const left = Math.max(0, Math.min(1, (ring.deadline - now) / (ring.timeout || 4)));
  ctx.lineWidth = Math.max(1.5, 3 * s);
  ctx.strokeStyle = white(0.2);
  ctx.beginPath();
  ctx.arc(cx, cy, 96 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = white(0.8);
  ctx.beginPath();
  ctx.arc(cx, cy, 96 * s, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = white(0.55);
  ctx.font = `${Math.round(13 * s)}px ${MONO}`;
  ctx.fillText('← → spin · ↵ or click to keep', cx, cy + R + 36 * s);
  ctx.restore();
}

// ---------------------------------------------------------------- echo strip

function drawEcho(ctx, w, h, echo, beat, pos) {
  const s = refScale(w, h);
  const x0 = 190 * s;
  const x1 = w - 190 * s;
  const steps = echo.bars * 16;
  const rows = echo.rows || [];
  const rowH = 6 * s;
  const gap = 4 * s;
  const bottom = h - 28 * s;
  const top = bottom - Math.max(1, rows.length) * (rowH + gap);
  const play = ((pos % steps) + steps) % steps;
  const xOf = (step) => x0 + (step / steps) * (x1 - x0);

  ctx.save();
  ctx.font = `${Math.round(12 * s)}px ${MONO}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = white(0.55);
  ctx.textAlign = 'left';
  ctx.fillText(`ECHO · LAST ${echo.bars} BARS`, x0, top - 10 * s);
  ctx.textAlign = 'right';
  ctx.fillText(`${beat.bpm} BPM · BAR ${Math.floor(play / 16) + 1}/${echo.bars}`, x1, top - 10 * s);
  // bar lines
  ctx.fillStyle = white(0.12);
  for (let bar = 0; bar <= echo.bars; bar++) ctx.fillRect(Math.round(xOf(bar * 16)), top, 1, bottom - top);
  rows.forEach((row, r) => {
    const y = top + r * (rowH + gap);
    for (const hit of row.hits) {
      const ahead = !hit.kept && hit.step > play;
      ctx.fillStyle = white(hit.kept ? 0.95 : ahead ? 0.18 : 0.45);
      roundRect(ctx, xOf(hit.step) - 5 * s, y, 10 * s, rowH, 2 * s);
      ctx.fill();
    }
  });
  ctx.fillStyle = '#fff';
  ctx.fillRect(xOf(play) - 1.5 * s, top - 4 * s, 3 * s, bottom - top + 8 * s);
  ctx.restore();
}

// ---------------------------------------------------------------- toast + help

function drawToast(ctx, w, h, toast) {
  const s = refScale(w, h);
  ctx.save();
  ctx.font = `${Math.round(15 * s)}px ${MONO}`;
  ctx.textBaseline = 'middle';
  const capW = ctx.measureText(toast.key).width + 16 * s;
  const textW = ctx.measureText(toast.text).width;
  const bw = capW + textW + 40 * s;
  const bh = 44 * s;
  const x = w - 24 * s - bw;
  const y = 24 * s;
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * s;
  roundRect(ctx, x, y, bw, bh, 10 * s);
  ctx.fill();
  ctx.stroke();
  roundRect(ctx, x + 12 * s, y + 9 * s, capW, bh - 18 * s, 5 * s);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(toast.key, x + 12 * s + capW / 2, y + bh / 2);
  ctx.textAlign = 'left';
  ctx.fillText(toast.text, x + capW + 28 * s, y + bh / 2);
  ctx.restore();
}

function drawHelp(ctx, w, h) {
  const s = refScale(w, h);
  const lineH = 30 * s;
  const bw = 620 * s;
  const bh = (KEY_HELP.length + 2) * lineH;
  const x = (w - bw) / 2;
  const y = (h - bh) / 2;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * s;
  roundRect(ctx, x, y, bw, bh, 16 * s);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `${Math.round(15 * s)}px ${MONO}`;
  ctx.fillStyle = white(0.6);
  ctx.fillText('KEYS · ? TO CLOSE', x + 28 * s, y + lineH);
  KEY_HELP.forEach(([k, what], i) => {
    const ly = y + (i + 2) * lineH;
    ctx.fillStyle = '#fff';
    ctx.fillText(k, x + 28 * s, ly);
    ctx.fillStyle = white(0.7);
    ctx.fillText(what, x + 230 * s, ly);
  });
  ctx.restore();
}
