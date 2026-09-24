// Draws what the projector shows. Shared by projector.html and by the simulated
// camera (which "projects" the same picture onto its fake wall).
//
// All scene coordinates are projector-normalized (0..1).

// Calibration dot centres, numbered 1..4 clockwise from top-left.
export const CALIB_DOTS = [
  [0.05, 0.05],
  [0.95, 0.05],
  [0.95, 0.95],
  [0.05, 0.95],
];

/**
 * @param scene.calib     show white border + numbered corner dots
 * @param scene.cross     [x,y] test crosshair or null
 * @param scene.notes     [{ corners: [[x,y] x4] }]
 * @param scene.outlines  draw faint note outlines
 * @param scene.balls     [{ x, y, rx, held }]  rx = radius / width
 */
export function drawScene(ctx, w, h, scene) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const m = Math.min(w, h);

  if (scene.outlines && scene.notes) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, m * 0.003);
    for (const n of scene.notes) {
      ctx.beginPath();
      n.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      ctx.closePath();
      ctx.stroke();
    }
  }

  if (scene.calib) {
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

  if (scene.balls) {
    // aiming guide under a ball that is waiting to be dropped
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(1, m * 0.002);
    ctx.setLineDash([m * 0.01, m * 0.015]);
    for (const b of scene.balls) {
      if (!b.held) continue;
      ctx.beginPath();
      ctx.moveTo(b.x * w, b.y * h + b.rx * w * 2);
      ctx.lineTo(b.x * w, h);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    for (const b of scene.balls) {
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, Math.max(1, b.rx * w), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
