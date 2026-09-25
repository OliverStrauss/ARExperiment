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
  // A clean wall: a pair (blue over green, 2 x unit apart = 1/4 between
  // hits) plus a lone note far off to the side, top edge half way down the
  // wall: its ball falls half a bar, so its hits land on the pair's grid.
  const NOTE = 90; // px at 1600x900: 0.1 of the projector height
  const half = NOTE / 2 / 900;
  const S = await ctl.evaluate(() => window.stickyWall.state.settings);
  const targetTop = 0.2 + 2 * S.unit;
  await ctl.evaluate(({ half, targetTop, NOTE }) => {
    window.stickyWall.state.sim.setNotes([
      { cx: 0.4, cy: 0.15, color: 'blue', size: NOTE },
      { cx: 0.4, cy: targetTop + half, color: 'green', size: NOTE },
      { cx: 0.8, cy: 0.5 + half, color: 'red', size: NOTE },
    ]);
  }, { half, targetTop, NOTE });
  await ctl.waitForFunction(() => {
    const l = window.stickyWall.engine.lanes;
    return l.length === 2 && l[0].upperColor === 'blue' && l[0].color === 'green';
  }, null, { timeout: 15000 });
  const lane = await ctl.evaluate(() => window.stickyWall.engine.lanes[0]);
  check(lane.n === 8, `pair cycle is 8 16ths (d = ${lane.d.toFixed(3)})`);
  check(lane.color === 'green' && lane.upperColor === 'blue', `pair is blue over green (${lane.upperColor}/${lane.color})`);
  const lone = await ctl.evaluate(() => window.stickyWall.engine.lanes[1]);
  check(lone?.upperId == null && lone?.ceil === 0 && lone?.n === 16 && lone?.color === 'red', `the note off to the side is lone, dropped from the top (n = ${lone?.n})`);

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
  // the lone note hits together with the pair: drop its near-zero gaps
  const gaps = one.slice(1).map((t, i) => (t - one[i]) * 1000).filter((g) => g > 50);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - 625)));
  check(gaps.length >= 6, `${one.length} hits in 5 s`);
  check(worst <= 8, `ping-pong hits every 625 ms at 96 BPM (worst error ${worst.toFixed(1)} ms)`);
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
  const lastInst = await ctl.evaluate(() => window.stickyWall.state.hitLog.filter((h) => h.color === 'green').at(-1).instrument);
  check(lastInst === 'kick', `green hits now play the kick (${lastInst})`);

  console.log('keys, toasts, mute');
  await proj.keyboard.press('Digit3'); // green = 3rd colour
  await sleep(200);
  const toastText = await proj.evaluate(() => window.stickyWall.state.toast?.text);
  check(/Mute green/.test(toastText || ''), `3 mutes green, with a toast on the wall ("${toastText}")`);
  const tm = await ctl.evaluate(() => performance.timeOrigin / 1000 + performance.now() / 1000);
  await sleep(1500);
  const muted = await ctl.evaluate((tm) => window.stickyWall.state.hitLog.filter((h) => h.time > tm), tm);
  check(muted.length > 0 && muted.every((h) => h.color !== 'green'), `muted pitch is silent, the top note still plays (${muted.length} hits)`);
  await proj.keyboard.press('Digit3');
  await proj.keyboard.press('Shift+Slash');
  await sleep(300);
  check(await proj.evaluate(() => window.stickyWall.state.beat.overlay), '? shows the key overlay on the wall');
  await proj.screenshot({ path: path.join(OUT, '3-keys-projector.png') });
  await proj.keyboard.press('Shift+Slash');
  const bpm0 = await ctl.evaluate(() => window.stickyWall.engine.bpm);
  await proj.keyboard.press('BracketRight');
  await proj.keyboard.press('Shift+BracketRight');
  await sleep(200);
  const bpm1 = await ctl.evaluate(() => window.stickyWall.engine.bpm);
  check(bpm1 === bpm0 + 12, `] and ⇧] raise the tempo by 2 and 10 (${bpm0} -> ${bpm1})`);
  await proj.keyboard.press('Shift+BracketLeft');
  await proj.keyboard.press('BracketLeft');
  const laneRows = await ctl.$$eval('#lanesTable tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
  check(laneRows.length === 3 && /top D4/.test(laneRows[0]) && /1\/4/.test(laneRows[0]) && /bottom E4/.test(laneRows[1]), `Lanes panel: a row per note, pair's two notes separately: ${laneRows.join(' | ')}`);
  const focused = [];
  for (let i = 0; i < 3; i++) {
    await proj.keyboard.press('Tab');
    await sleep(100);
    focused.push(await ctl.evaluate(() => window.stickyWall.state.focus));
  }
  check(new Set(focused).size === 3, `Tab visits every note, both notes of a pair (${focused.join(',')})`);

  console.log('echo + keep');
  const rows = await proj.evaluate(() => window.stickyWall.state.echo?.rows?.map((r) => r.pitch) || []);
  check(rows.includes('E4'), `echo strip on the wall shows the target's pitch (${rows.join(',')})`);
  await proj.keyboard.press('k');
  await sleep(300);
  const layers = await ctl.evaluate(() => window.stickyWall.engine.layers.length);
  check(layers === 1, `K keeps a layer (${layers})`);
  await proj.screenshot({ path: path.join(OUT, '4-echo-projector.png') });
  await ctl.screenshot({ path: path.join(OUT, '4-echo-control.png') });
  // take the notes off the wall: their lanes go but the layer keeps playing
  await ctl.evaluate(() => {
    const sim = window.stickyWall.state.sim;
    sim.notes.length = 0;
    sim.dirty = true;
  });
  await ctl.waitForFunction(() => window.stickyWall.engine.lanes.length === 0, null, { timeout: 10000 });
  check(true, 'lanes go when their notes are removed');
  const ghost = await proj.evaluate(() => window.stickyWall.state.beat.ghosts?.[0]);
  check(ghost?.notes.length >= 2 && ghost?.lanes.length >= 1, `the kept layer's notes and balls stay on the wall as ghosts (${ghost?.notes.length} notes, ${ghost?.lanes.length} lanes)`);
  await sleep(500);
  await proj.screenshot({ path: path.join(OUT, '5-ghosts-projector.png') });
  const ghostNotes = await ctl.evaluate(() => window.stickyWall.state.proj.notes.length);
  check(ghostNotes === 0, `ghosts are never detected as notes (${ghostNotes})`);
  // skip live hits already scheduled (look-ahead is at most 0.35 s)
  const t0 = await ctl.evaluate(() => performance.timeOrigin / 1000 + performance.now() / 1000 + 0.4);
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
