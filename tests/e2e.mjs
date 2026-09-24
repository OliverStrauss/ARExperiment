// End-to-end test in headless Chromium using the simulated camera - no
// webcam or projector needed.
//
//   npm install          (once, installs playwright)
//   npx playwright install chromium   (once, if you don't have a browser)
//   node tests/e2e.mjs
//
// It serves this folder on a random port, opens projector.html and
// control.html in one browser context (so BroadcastChannel connects them),
// selects "Simulated wall", calibrates by clicking the projected dots, and
// checks detection, tracking, ball masking and live note updates.
// Screenshots land in tests/out/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // fall back to a globally installed copy
    const require = createRequire(import.meta.url);
    const { execSync } = await import('node:child_process');
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { chromium } = await loadPlaywright();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const proj = await ctx.newPage();
  await proj.setViewportSize({ width: 1280, height: 720 });
  await proj.goto(`${base}/projector.html`);
  const ctl = await ctx.newPage();
  for (const [name, pg] of [['control', ctl], ['projector', proj]]) {
    pg.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    pg.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  }
  await ctl.goto(`${base}/control.html`);
  await ctl.waitForFunction(() => document.getElementById('status').innerText.includes('ready'), null, { timeout: 60000 });

  console.log('camera');
  const options = await ctl.$$eval('#cameraSelect option', (os) => os.map((o) => o.value));
  check(options.includes('sim'), 'camera picker lists the simulated wall');
  check(options.length >= 2, 'camera picker lists real (fake-device) cameras too');
  await ctl.selectOption('#cameraSelect', 'sim');
  await ctl.waitForFunction(() => document.getElementById('video').videoWidth === 1280);
  check(true, 'simulated camera streams 1280x720');

  console.log('calibration');
  await ctl.click('#calibrate');
  await sleep(800);
  const dots = await ctl.evaluate(() => window.stickyWall.state.sim.calibDotsInCamera());
  const box = await ctl.$eval('#feed', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cw: e.width, ch: e.height };
  });
  const toPage = ([x, y]) => [box.x + (x / box.cw) * box.w, box.y + (y / box.ch) * box.h];
  for (const [x, y] of dots) {
    await ctl.mouse.click(...toPage([x + 4, y - 3])); // deliberately sloppy
    await sleep(150);
  }
  await ctl.screenshot({ path: path.join(OUT, '1-calibrating.png') });
  await proj.screenshot({ path: path.join(OUT, '1-projector-calibration.png') });
  const calErr = await ctl.evaluate(() => {
    const s = window.stickyWall.state;
    const H = s.calib.H;
    const ap = ([x, y]) => {
      const w = H[6] * x + H[7] * y + H[8];
      return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    };
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const q = [Math.random(), Math.random()];
      const back = ap(s.sim.projToCam(q));
      worst = Math.max(worst, Math.hypot(back[0] - q[0], back[1] - q[1]));
    }
    return worst;
  });
  check(calErr < 0.005, `calibration error ${(calErr * 100).toFixed(2)}% of projector (< 0.5%)`);
  const stored = await ctl.evaluate(() => !!localStorage.getItem('sticky-wall.calibration.v1'));
  check(stored, 'calibration saved to localStorage');
  await ctl.click('#calibDone');

  console.log('detection');
  await sleep(3000);
  const det = await ctl.evaluate(() => {
    const s = window.stickyWall.state;
    const c = (pts) => [pts.reduce((a, p) => a + p[0], 0) / 4, pts.reduce((a, p) => a + p[1], 0) / 4];
    const gt = s.sim.groundTruth();
    const errs = gt.map((g) => Math.min(...s.proj.notes.map((n) => Math.hypot(c(n.corners)[0] - g.center[0], c(n.corners)[1] - g.center[1]))));
    return { gt: gt.length, found: s.proj.notes.length, worst: Math.max(...errs) };
  });
  check(det.found === det.gt, `found ${det.found}/${det.gt} notes (note outside projection ignored)`);
  check(det.worst < 0.01, `note centre error ${(det.worst * 100).toFixed(2)}% (< 1%)`);
  const projNotes = await proj.evaluate(() => window.stickyWall.physics.notes.size);
  check(projNotes === det.gt, `projector built ${projNotes} static note bodies`);

  console.log('physics + ball mask');
  // Bounce mode for this part: balls fly everywhere, which stresses the mask.
  await ctl.click('#modeBtn');
  await sleep(400);
  check((await ctl.textContent('#modeBtn')) === 'Mode: Bounce', 'mode button switches to bounce');
  // Stress the ball mask: big balls whose projected light looks saturated.
  await ctl.check('#simTint');
  await ctl.evaluate(() => {
    window.stickyWall.state.settings.ballRadius = 0.06;
    window.stickyWall.channel.send('config', { ballRadius: 0.06 });
  });
  await ctl.click('#addBall');
  await ctl.click('#addBall');
  await sleep(1500);
  const counts = new Set();
  const start = await proj.evaluate(() => window.stickyWall.physics.ballsNormalized());
  let travelled = 0;
  let prev = start;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    counts.add(await ctl.evaluate(() => window.stickyWall.state.proj.notes.length));
    const now = await proj.evaluate(() => window.stickyWall.physics.ballsNormalized());
    travelled += Math.hypot(now[0].x - prev[0].x, now[0].y - prev[0].y);
    prev = now;
  }
  check(start.length === 3, `3 balls in play (got ${start.length})`);
  check(travelled > 1, `ball keeps moving (${travelled.toFixed(2)} screen widths in 12 s)`);
  check(counts.size === 1 && counts.has(det.gt), `balls never detected as notes (counts seen: ${[...counts]})`);
  await ctl.screenshot({ path: path.join(OUT, '2-playing-control.png') });
  await proj.screenshot({ path: path.join(OUT, '2-playing-projector.png') });

  console.log('live note updates');
  const ballIds = await proj.evaluate(() => window.stickyWall.physics.balls.map((b) => b.id).join(','));
  // drag the first simulated note to a new place, in the camera feed
  const [from, to] = await ctl.evaluate(() => {
    const sim = window.stickyWall.state.sim;
    const n = sim.notes[0];
    return [sim.projToCam([n.cx, n.cy]), sim.projToCam([0.85, 0.3])];
  });
  await ctl.mouse.move(...toPage(from));
  await ctl.mouse.down();
  await ctl.mouse.move(...toPage(to), { steps: 8 });
  await ctl.mouse.up();
  await sleep(4000);
  const moved = await proj.evaluate(() =>
    window.stickyWall.state.notes.some((n) => {
      const cx = n.corners.reduce((a, p) => a + p[0], 0) / 4;
      const cy = n.corners.reduce((a, p) => a + p[1], 0) / 4;
      return Math.hypot(cx - 0.85, cy - 0.3) < 0.02;
    }),
  );
  check(moved, 'dragged note shows up at its new position on the projector');
  const ballIdsAfter = await proj.evaluate(() => window.stickyWall.physics.balls.map((b) => b.id).join(','));
  check(ballIds === ballIdsAfter, 'balls were not reset by the note update');
  await ctl.evaluate(() => {
    const sim = window.stickyWall.state.sim;
    sim.notes.splice(1, 1);
    sim.dirty = true;
  });
  await sleep(4000);
  const afterRemove = await ctl.evaluate(() => window.stickyWall.state.proj.notes.length);
  check(afterRemove === det.gt - 1, `removed note disappears (${afterRemove} left)`);

  console.log('controls');
  await ctl.click('#runBtn');
  await sleep(400);
  const paused = await proj.evaluate(() => !window.stickyWall.prefs.running);
  check(paused && (await ctl.textContent('#runBtn')) === 'Start', 'Pause stops physics and the button shows Start');
  await ctl.click('#runBtn');
  await ctl.click('#gravityBtn');
  await sleep(400);
  check(await proj.evaluate(() => window.stickyWall.prefs.gravity), 'gravity toggles on');
  await ctl.click('#gravityBtn');
  await ctl.click('#resetBall');
  await sleep(400);
  check((await proj.evaluate(() => window.stickyWall.physics.balls.length)) === 1, 'Reset ball leaves one ball');

  console.log('drop mode (keyboard in the control window)');
  await ctl.click('#modeBtn');
  await sleep(400);
  const ball = () => proj.evaluate(() => window.stickyWall.physics.ballsNormalized()[0]);
  const b0 = await ball();
  check(b0.held && b0.y < 0.1, 'a ball waits at the top of the screen');
  await ctl.keyboard.down('ArrowRight');
  await sleep(500);
  await ctl.keyboard.up('ArrowRight');
  const b1 = await ball();
  check(b1.x > b0.x + 0.1 && b1.held, `→ moves it right (${b0.x.toFixed(2)} → ${b1.x.toFixed(2)})`);
  await ctl.keyboard.down('ArrowLeft');
  await sleep(300);
  await ctl.keyboard.up('ArrowLeft');
  check((await ball()).x < b1.x, '← moves it left');
  await ctl.keyboard.press(' ');
  await sleep(1200);
  const b2 = await ball();
  check(!b2.held && b2.y > 0.3, `Space drops it (now at y=${b2.y.toFixed(2)})`);
  await proj.screenshot({ path: path.join(OUT, '3-drop-projector.png') });
  await ctl.keyboard.press('r');
  await sleep(400);
  const b3 = await ball();
  check(b3.held && b3.y < 0.1, 'R puts a new ball back at the top');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
console.log(`screenshots: ${path.relative(process.cwd(), OUT)}/`);
process.exit(failures ? 1 : 0);
