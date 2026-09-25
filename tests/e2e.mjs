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
    const dist = (n, g) => Math.hypot(c(n.corners)[0] - g.center[0], c(n.corners)[1] - g.center[1]);
    const errs = gt.map((g) => Math.min(...s.proj.notes.map((n) => dist(n, g))));
    const nearest = (g) => s.proj.notes.reduce((a, n) => (dist(n, g) < dist(a, g) ? n : a));
    const wrongColor = gt.filter((g) => nearest(g).color !== g.color).map((g) => `${g.color}->${nearest(g).color}`);
    return { gt: gt.length, found: s.proj.notes.length, worst: Math.max(...errs), wrongColor };
  });
  check(det.found === det.gt, `found ${det.found}/${det.gt} notes (note outside projection ignored)`);
  check(det.worst < 0.01, `note centre error ${(det.worst * 100).toFixed(2)}% (< 1%)`);
  check(det.wrongColor.length === 0, `note colours recognised (${det.wrongColor.join(', ') || 'all correct'})`);
  const projNotes = await proj.evaluate(() => window.stickyWall.state.notes.length);
  check(projNotes === det.gt, `projector received ${projNotes} notes`);

  console.log('live note updates');
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
  await ctl.evaluate(() => {
    const sim = window.stickyWall.state.sim;
    sim.notes.splice(1, 1);
    sim.dirty = true;
  });
  await sleep(4000);
  const afterRemove = await ctl.evaluate(() => window.stickyWall.state.proj.notes.length);
  check(afterRemove === det.gt - 1, `removed note disappears (${afterRemove} left)`);


  console.log('beat: lanes, balls, rhythm');
  // A clean wall: one rail note and a target whose top edge is 4 x unit below
  // the rail, plus a note far off to the side.
  const NOTE = 90; // px at 1600x900: 0.1 of the projector height
  const half = NOTE / 2 / 900;
  const S = await ctl.evaluate(() => window.stickyWall.state.settings);
  const targetTop = S.railBottom + 4 * S.unit;
  await ctl.evaluate(({ half, targetTop, NOTE }) => {
    window.stickyWall.state.sim.setNotes([
      { cx: 0.4, cy: 0.075, color: 'blue', size: NOTE },
      { cx: 0.4, cy: targetTop + half, color: 'green', size: NOTE },
      { cx: 0.8, cy: 0.5, color: 'red', size: NOTE },
    ]);
  }, { half, targetTop, NOTE });
  await ctl.waitForFunction(() => window.stickyWall.engine.lanes.some((l) => l.targetId != null), null, { timeout: 15000 });
  const lane = await ctl.evaluate(() => window.stickyWall.engine.lanes[0]);
  check(lane.n === 4, `lane length is 4 16ths (d = ${lane.d.toFixed(3)})`);
  check(lane.color === 'green', `target colour is green (${lane.color})`);

  // Start the clock from the projector window (keys are forwarded).
  await proj.bringToFront();
  await proj.keyboard.press(' ');
  await ctl.waitForFunction(() => window.stickyWall.engine.running, null, { timeout: 3000 });
  check(true, 'Space on the projector starts the clock');
  const hitsIn = async (secs) => {
    const t0 = await proj.evaluate(() => performance.timeOrigin + performance.now());
    await sleep(secs * 1000);
    return proj.evaluate((t0) => window.stickyWall.state.hitLog.filter((t) => t * 1000 >= t0), t0);
  };
  await sleep(700);
  const one = await hitsIn(5);
  const gaps = one.slice(1).map((t, i) => (t - one[i]) * 1000);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - 625)));
  check(gaps.length >= 6, `${one.length} hits in 5 s`);
  check(worst <= 8, `hits every 625 ms at 96 BPM (worst error ${worst.toFixed(1)} ms)`);
  await proj.screenshot({ path: path.join(OUT, '2-beat-projector.png') });

  await proj.keyboard.press('b');
  await sleep(300);
  const balls = await ctl.evaluate(() => window.stickyWall.engine.ballsOf(window.stickyWall.engine.lanes[0].id).length);
  check(balls === 2, `B adds a ball (${balls})`);
  const two = await hitsIn(5);
  check(Math.abs(two.length - 2 * one.length) <= 2, `hit count doubles (${one.length} -> ${two.length})`);

  // The balls must never be detected as notes.
  const counts = new Set();
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    counts.add(await ctl.evaluate(() => window.stickyWall.state.proj.notes.length));
  }
  check(counts.size === 1 && counts.has(3), `balls and halos never detected as notes (counts seen: ${[...counts]})`);
  await ctl.screenshot({ path: path.join(OUT, '2-beat-control.png') });

  console.log('instrument ring');
  const tgt = await ctl.evaluate(() => {
    const s = window.stickyWall.state;
    const id = window.stickyWall.engine.lanes[0].targetId;
    const n = s.proj.notes.find((m) => m.id === id);
    return { id, c: [n.corners.reduce((a, p) => a + p[0], 0) / 4, n.corners.reduce((a, p) => a + p[1], 0) / 4] };
  });
  const vp = proj.viewportSize();
  await proj.mouse.click(tgt.c[0] * vp.width, tgt.c[1] * vp.height);
  await sleep(300);
  check(await proj.evaluate((id) => window.stickyWall.state.ring?.noteId === id, tgt.id), 'clicking the target on the wall opens the ring on it');
  await proj.keyboard.press('ArrowLeft');
  await proj.keyboard.press('ArrowLeft');
  await sleep(300);
  await proj.screenshot({ path: path.join(OUT, '3-ring-projector.png') });
  await proj.keyboard.press('Enter');
  await sleep(300);
  const inst = await ctl.evaluate(() => window.stickyWall.engine.lanes.map((l) => window.stickyWall.engine.instrumentOf(l.targetId))[0]);
  check(inst === 'kick', `← ← ↵ sets the lane's instrument to kick (${inst})`);
  check(await proj.evaluate(() => !window.stickyWall.state.ring), 'ring closes on ↵');
  await sleep(1000);
  const lastInst = await ctl.evaluate(() => window.stickyWall.state.hitLog.at(-1).instrument);
  check(lastInst === 'kick', `hits now play the kick (${lastInst})`);

  console.log('echo + keep');
  const rows = await proj.evaluate(() => window.stickyWall.state.echo?.rows?.map((r) => r.pitch) || []);
  check(rows.includes('E4'), `echo strip on the wall shows the target's pitch (${rows.join(',')})`);
  await proj.keyboard.press('k');
  await sleep(300);
  const layers = await ctl.evaluate(() => window.stickyWall.engine.layers.length);
  check(layers === 1, `K keeps a layer (${layers})`);
  await proj.screenshot({ path: path.join(OUT, '4-echo-projector.png') });
  await ctl.screenshot({ path: path.join(OUT, '4-echo-control.png') });
  // take the target off the wall: its lane goes idle but the layer keeps playing
  await ctl.evaluate(() => {
    const sim = window.stickyWall.state.sim;
    sim.notes.splice(1, 1);
    sim.dirty = true;
  });
  await ctl.waitForFunction(() => window.stickyWall.engine.lanes[0]?.targetId == null, null, { timeout: 10000 });
  check(true, 'lane goes idle when its target is removed');
  const t0 = await ctl.evaluate(() => performance.timeOrigin / 1000 + performance.now() / 1000);
  await sleep(3000);
  const after = await ctl.evaluate((t0) => window.stickyWall.state.hitLog.filter((h) => h.time > t0), t0);
  check(after.length >= 6 && after.every((h) => h.kept), `the kept layer still plays (${after.length} hits, all kept)`);
  await ctl.click('#undoBtn');
  await sleep(200);
  check((await ctl.evaluate(() => window.stickyWall.engine.layers.length)) === 0, 'Undo keep button removes it');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
console.log(`screenshots: ${path.relative(process.cwd(), OUT)}/`);
process.exit(failures ? 1 : 0);
