import { SLIDERS, DEFAULTS, loadSettings, saveSettings, loadCalibration, saveCalibration } from './settings.js';
import { createChannel } from './channel.js';
import { computeCalibration, camToProj, projToCam, projectionQuadInCamera, snapToDot } from './calibration.js';
import { NoteTracker, centroid } from './tracker.js';
import { listCameras, openCamera, stopStream, SIM_DEVICE_ID } from './camera.js';
import { SimCamera } from './simcam.js';
import { cvReady } from './cvload.js';
import { Detector } from './vision.js';

const $ = (id) => document.getElementById(id);
const els = {
  cameraSelect: $('cameraSelect'),
  refreshCams: $('refreshCams'),
  feed: $('feed'),
  mask: $('mask'),
  video: $('video'),
  status: $('status'),
  banner: $('banner'),
  sliders: $('sliders'),
  resetSettings: $('resetSettings'),
  simPanel: $('simPanel'),
  calibrate: $('calibrate'),
  calibPanel: $('calibPanel'),
  calibMsg: $('calibMsg'),
  calibSnap: $('calibSnap'),
  crossTest: $('crossTest'),
  magnifier: $('magnifier'),
  roiOnly: $('roiOnly'),
  freezeNotes: $('freezeNotes'),
  runBtn: $('runBtn'),
  gravityBtn: $('gravityBtn'),
  outlinesBtn: $('outlinesBtn'),
  modeBtn: $('modeBtn'),
};
const feedCtx = els.feed.getContext('2d');

const state = {
  settings: loadSettings(),
  stream: null,
  cv: null,
  detector: null,
  lastDetect: null, // { ms, procSize, notes }
  detectTimer: null,
  fps: 0,
  sim: null, // SimCamera when the simulated camera is selected
  calib: loadCalibration(), // { camPts, camSize, H, Hinv } or null
  calibrating: false,
  calibPts: [], // camera px, in dot order
  projSeen: 0, // last time we heard from the projector (ms)
  tracker: null, // NoteTracker (projector-normalized)
  blockers: [], // ball mask capsules used in the last detection (camera px)
  // Mirror of what the projector is showing (drives the simulated camera).
  proj: {
    w: 1920,
    h: 1080,
    calib: false,
    cross: null,
    notes: [],
    outlines: false,
    balls: [], // [{x,y,rx,ry,vx,vy,t}] from the projector heartbeat
    running: true,
    gravity: false,
    mode: 'drop',
  },
};

function projectorScene() {
  const p = state.proj;
  return { ...p, aspect: p.w / p.h };
}

// ---------------------------------------------------------------- projector link

const channel = createChannel('control', onMessage);

function onMessage(msg) {
  if (msg.type !== 'hello' && msg.type !== 'balls') return;
  // A projector that (re)appears gets the full current state pushed to it.
  const reconnect = Date.now() - state.projSeen > 3000;
  state.projSeen = Date.now();
  if (reconnect) setTimeout(syncProjector, 0);
  if (msg.type === 'hello') {
    state.proj.w = msg.w;
    state.proj.h = msg.h;
  } else {
    state.proj.balls = msg.balls.map((b) => ({ ...b, t: msg.t }));
    state.proj.running = msg.running;
    state.proj.gravity = msg.gravity;
    state.proj.outlines = msg.outlines;
    state.proj.mode = msg.mode;
    updateGameButtons();
  }
}

function sendBallConfig() {
  channel.send('config', { ballRadius: state.settings.ballRadius, ballSpeed: state.settings.ballSpeed });
}

function updateGameButtons() {
  els.runBtn.textContent = state.proj.running ? 'Pause' : 'Start';
  els.gravityBtn.classList.toggle('active', state.proj.gravity);
  els.outlinesBtn.classList.toggle('active', state.proj.outlines);
  els.modeBtn.textContent = `Mode: ${state.proj.mode === 'bounce' ? 'Bounce' : 'Drop'}`;
  els.gravityBtn.disabled = state.proj.mode === 'drop'; // drop mode always has gravity
}

const cmd = (name) => () => channel.send('cmd', { cmd: name });
els.runBtn.addEventListener('click', cmd('toggleRun'));
$('resetBall').addEventListener('click', cmd('resetBall'));
$('addBall').addEventListener('click', cmd('addBall'));
els.gravityBtn.addEventListener('click', cmd('toggleGravity'));
els.outlinesBtn.addEventListener('click', cmd('toggleOutlines'));
els.modeBtn.addEventListener('click', cmd('toggleMode'));

// Game keys work from this window too (so you don't need to focus the
// projector): arrows steer the waiting ball, Space drops it, R resets.
const arrows = { left: false, right: false };
function sendSteer() {
  channel.send('steer', { dir: (arrows.right ? 1 : 0) - (arrows.left ? 1 : 0) });
}
function isTyping(el) {
  return el?.tagName === 'SELECT' || el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && el.type === 'text');
}
window.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'arrowleft') arrows.left = true;
  else if (k === 'arrowright') arrows.right = true;
  else if (k === ' ') { if (!e.repeat) channel.send('cmd', { cmd: 'action' }); }
  else if (k === 'r') { if (!e.repeat) channel.send('cmd', { cmd: 'resetBall' }); }
  else if (k === 'm') { if (!e.repeat) channel.send('cmd', { cmd: 'toggleMode' }); }
  else return;
  if (k.startsWith('arrow')) sendSteer();
  e.preventDefault(); // no page scrolling / slider nudging / button presses
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft') arrows.left = false;
  else if (k === 'arrowright') arrows.right = false;
  else if (k === ' ') { e.preventDefault(); return; }
  else return;
  sendSteer();
});
window.addEventListener('blur', () => {
  arrows.left = arrows.right = false;
  sendSteer();
});
// Clicked buttons/checkboxes keep focus, and Space would press them again.
document.addEventListener('click', (e) => {
  if (e.target.matches?.('button, input[type=checkbox]')) e.target.blur();
});

// Push everything the projector should be showing (after it (re)connects).
function syncProjector() {
  channel.send('calib', { on: state.calibrating });
  channel.send('cross', { pt: state.proj.cross });
  channel.send('notes', { notes: state.proj.notes });
  sendBallConfig();
}

setInterval(() => channel.send('ping'), 1000);

$('openProjector').addEventListener('click', () => {
  window.open('projector.html', 'sticky-wall-projector', 'popup,width=960,height=540');
});

// For tests / debugging from the devtools console.
window.stickyWall = { state, channel };

// ---------------------------------------------------------------- UI helpers

function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = !text;
}

function buildSliders() {
  els.sliders.innerHTML = '';
  const groups = new Map();
  for (const s of SLIDERS) {
    if (!groups.has(s.group)) {
      const fs = document.createElement('fieldset');
      fs.innerHTML = `<legend>${s.group}</legend>`;
      els.sliders.appendChild(fs);
      groups.set(s.group, fs);
    }
    const row = document.createElement('label');
    row.className = 'slider';
    row.innerHTML = `<span>${s.label}</span>
      <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-key="${s.key}">
      <output></output>`;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.value = state.settings[s.key];
    out.textContent = input.value;
    input.addEventListener('input', () => {
      state.settings[s.key] = Number(input.value);
      out.textContent = input.value;
      saveSettings(state.settings);
      if (s.key === 'rate') restartDetectionLoop();
      state.tracker?.setOptions(trackerOptions());
      if (s.key === 'ballRadius' || s.key === 'ballSpeed') sendBallConfig();
    });
    groups.get(s.group).appendChild(row);
  }
}

els.resetSettings.addEventListener('click', () => {
  state.settings = { ...DEFAULTS, deviceId: state.settings.deviceId };
  saveSettings(state.settings);
  buildSliders();
  els.roiOnly.checked = state.settings.roiOnly;
  state.tracker?.setOptions(trackerOptions());
  sendBallConfig();
  restartDetectionLoop();
});

els.roiOnly.checked = state.settings.roiOnly;
els.roiOnly.addEventListener('change', () => {
  state.settings.roiOnly = els.roiOnly.checked;
  saveSettings(state.settings);
});

function trackerOptions() {
  const s = state.settings;
  return { seenN: s.seenN, missM: s.missM, smooth: s.smooth, matchDist: s.matchDist };
}

// ---------------------------------------------------------------- camera

async function refreshCameraList() {
  const sel = els.cameraSelect;
  let cams = [];
  try {
    cams = await listCameras();
    showBanner('');
  } catch (err) {
    showBanner(`Camera access failed: ${err.message}. On a Mac check System Settings → Privacy & Security → Camera for your browser.`);
  }
  sel.innerHTML = '';
  cams.push({ deviceId: SIM_DEVICE_ID, label: 'Simulated wall (test, no hardware)' });
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  const wanted = state.settings.deviceId;
  if (wanted && [...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
  return sel.value;
}

async function selectCamera(deviceId) {
  stopStream(state.stream);
  state.stream = null;
  state.sim?.stop();
  state.sim = null;
  els.video.srcObject = null;
  els.simPanel.hidden = deviceId !== SIM_DEVICE_ID;
  if (!deviceId) return;
  try {
    if (deviceId === SIM_DEVICE_ID) {
      const cv = await cvReady();
      state.sim = new SimCamera(cv, projectorScene);
      state.sim.noise = $('simNoise').checked;
      state.sim.tint = $('simTint').checked;
      state.stream = state.sim.stream;
    } else {
      state.stream = await openCamera(deviceId);
    }
    els.video.srcObject = state.stream;
    await els.video.play();
    state.settings.deviceId = deviceId;
    saveSettings(state.settings);
    showBanner('');
  } catch (err) {
    showBanner(`Could not open camera: ${err.message}`);
  }
}

els.cameraSelect.addEventListener('change', () => selectCamera(els.cameraSelect.value));
els.refreshCams.addEventListener('click', async () => selectCamera(await refreshCameraList()));
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshCameraList());

// ---------------------------------------------------------------- simulated wall panel

$('simAdd').addEventListener('click', () => state.sim?.addNote());
$('simRemove').addEventListener('click', () => state.sim?.removeNote());
$('simShuffle').addEventListener('click', () => state.sim?.shuffle());
$('simNoise').addEventListener('change', (e) => { if (state.sim) state.sim.noise = e.target.checked; });
$('simTint').addEventListener('change', (e) => { if (state.sim) state.sim.tint = e.target.checked; });

// Mouse position over the feed canvas, in camera (video) pixels.
function feedPoint(ev) {
  const r = els.feed.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * els.feed.width, ((ev.clientY - r.top) / r.height) * els.feed.height];
}

// Size of one on-screen pixel in camera pixels (the feed is scaled to fit).
function camPxPerScreenPx() {
  return els.feed.width / Math.max(1, els.feed.getBoundingClientRect().width);
}

// Pointer handling on the feed, by priority:
//   calibrating  -> place / drag calibration points
//   crosshair    -> send crosshair position to the projector
//   simulator    -> drag simulated notes
let calibDrag = -1;
let simDrag = -1;

els.feed.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const p = feedPoint(ev);
  if (state.calibrating) {
    const hit = 14 * camPxPerScreenPx();
    calibDrag = state.calibPts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < hit);
    if (calibDrag < 0 && state.calibPts.length < 4) {
      state.calibPts.push(snapPoint(p));
      calibDrag = -1;
      onCalibPointsChanged();
    }
    if (calibDrag >= 0) els.feed.setPointerCapture(ev.pointerId);
    return;
  }
  if (state.sim) {
    simDrag = state.sim.noteIndexAtCam(p);
    if (simDrag >= 0) els.feed.setPointerCapture(ev.pointerId);
  }
});

els.feed.addEventListener('pointermove', (ev) => {
  const p = feedPoint(ev);
  if (state.calibrating) {
    drawMagnifier(ev, p);
    if (calibDrag >= 0) {
      state.calibPts[calibDrag] = p;
      onCalibPointsChanged();
    }
    return;
  }
  if (els.crossTest.checked && state.calib) {
    setCrosshair(camToProj(state.calib, p));
  }
  if (state.sim && simDrag >= 0) state.sim.moveNote(simDrag, p);
});

els.feed.addEventListener('pointerup', (ev) => {
  if (state.calibrating && calibDrag >= 0) {
    state.calibPts[calibDrag] = snapPoint(feedPoint(ev));
    onCalibPointsChanged();
  }
  calibDrag = -1;
  simDrag = -1;
});

els.feed.addEventListener('pointerleave', () => {
  els.magnifier.style.display = 'none';
  if (els.crossTest.checked) setCrosshair(null);
});

// ---------------------------------------------------------------- calibration

function setCrosshair(pt) {
  state.proj.cross = pt;
  channel.send('cross', { pt });
}

els.crossTest.addEventListener('change', () => { if (!els.crossTest.checked) setCrosshair(null); });

function setCalibrating(on) {
  state.calibrating = on;
  state.proj.calib = on;
  channel.send('calib', { on });
  els.calibPanel.hidden = !on;
  els.feed.classList.toggle('calibrating', on);
  els.calibrate.classList.toggle('active', on);
  if (!on) els.magnifier.style.display = 'none';
  if (on) {
    // Start from the previous points so small bumps can be fixed by dragging.
    const [w, h] = videoSize();
    const c = state.calib;
    state.calibPts = c && c.camSize[0] === w && c.camSize[1] === h ? c.camPts.map((p) => [...p]) : [];
  }
  updateCalibMsg();
}

els.calibrate.addEventListener('click', () => setCalibrating(!state.calibrating));
$('calibDone').addEventListener('click', () => setCalibrating(false));
$('calibUndo').addEventListener('click', () => { state.calibPts.pop(); onCalibPointsChanged(); });
$('calibClear').addEventListener('click', () => { state.calibPts = []; onCalibPointsChanged(); });
$('forgetCalib').addEventListener('click', () => {
  state.calib = null;
  state.tracker?.reset();
  publishNotes([]);
  saveCalibration(null);
  showBanner('');
});

function onCalibPointsChanged() {
  if (state.calibPts.length === 4 && state.cv) {
    try {
      state.calib = computeCalibration(state.cv, state.calibPts, videoSize());
      saveCalibration(state.calib);
      state.tracker?.reset();
      showBanner('');
    } catch (err) {
      showBanner(`Calibration: ${err.message}`);
    }
  }
  updateCalibMsg();
}

const DOT_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
function updateCalibMsg() {
  const n = state.calibPts.length;
  els.calibMsg.textContent = n < 4
    ? `Click dot ${n + 1} (${DOT_NAMES[n]}) in the camera view. A magnifier follows the mouse.`
    : 'All 4 points set and saved. Drag a point to fine-tune, then press Done. Use "Crosshair test" to verify.';
}

// Scratch canvas for reading raw camera pixels (the feed canvas has overlays).
const grab = document.createElement('canvas');
const grabCtx = grab.getContext('2d', { willReadFrequently: true });

function snapPoint(p) {
  if (!els.calibSnap.checked) return p;
  const [w, h] = videoSize();
  const R = Math.max(8, Math.round(w * 0.025));
  const x0 = Math.max(0, Math.round(p[0] - R));
  const y0 = Math.max(0, Math.round(p[1] - R));
  const sw = Math.min(w - x0, 2 * R);
  const sh = Math.min(h - y0, 2 * R);
  if (sw < 4 || sh < 4) return p;
  grab.width = sw;
  grab.height = sh;
  grabCtx.drawImage(els.video, x0, y0, sw, sh, 0, 0, sw, sh);
  const snapped = snapToDot(grabCtx.getImageData(0, 0, sw, sh), x0, y0, p, Math.PI * (R * 0.5) ** 2);
  // only accept a snap that stays close to where the user clicked
  if (snapped && Math.hypot(snapped[0] - p[0], snapped[1] - p[1]) < R * 0.8) return snapped;
  return p;
}

function drawMagnifier(ev, p) {
  const m = els.magnifier;
  const wrap = m.parentElement.getBoundingClientRect();
  const size = m.width;
  const zoom = 4;
  const src = size / zoom;
  let left = ev.clientX - wrap.left + 20;
  let top = ev.clientY - wrap.top + 20;
  if (left + size > wrap.width) left -= size + 40;
  if (top + size > wrap.height) top -= size + 40;
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  m.style.display = 'block';
  const c = m.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#000';
  c.fillRect(0, 0, size, size);
  c.drawImage(els.video, p[0] - src / 2, p[1] - src / 2, src, src, 0, 0, size, size);
  c.strokeStyle = '#4fc3f7';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(size / 2, 0);
  c.lineTo(size / 2, size);
  c.moveTo(0, size / 2);
  c.lineTo(size, size / 2);
  c.stroke();
}

function videoSize() {
  return [els.video.videoWidth || 0, els.video.videoHeight || 0];
}

// ---------------------------------------------------------------- detection loop
// Runs on setInterval at settings.rate Hz, independently of the display loop.

function restartDetectionLoop() {
  clearInterval(state.detectTimer);
  const hz = Math.max(0.1, state.settings.rate);
  state.detectTimer = setInterval(detectOnce, 1000 / hz);
}

// Calibration that matches the current camera resolution, or null.
function activeCalib() {
  const c = state.calib;
  const [w, h] = videoSize();
  return c && c.camSize[0] === w && c.camSize[1] === h ? c : null;
}

function publishNotes(notes) {
  state.proj.notes = notes;
  channel.send('notes', { notes });
}

// Capsules (camera px) covering where each ball is, or recently was, so the
// ball itself can never be detected as a note. The camera image lags behind
// the projector, so the capsule reaches back along the ball's velocity.
function ballBlockers(calib) {
  const s = state.settings;
  const now = Date.now();
  const out = [];
  for (const b of state.proj.balls) {
    const age = Math.min(0.5, Math.max(0, (now - (b.t || now)) / 1000));
    const px = b.x + b.vx * age;
    const py = b.y + b.vy * age;
    const back = [px - b.vx * s.ballLag, py - b.vy * s.ballLag];
    const ahead = [px + b.vx * 0.05, py + b.vy * 0.05];
    const c = projToCam(calib, [px, py]);
    const ex = projToCam(calib, [px + b.rx, py]);
    const ey = projToCam(calib, [px, py + b.ry]);
    const r = Math.max(Math.hypot(ex[0] - c[0], ex[1] - c[1]), Math.hypot(ey[0] - c[0], ey[1] - c[1]));
    out.push({ a: projToCam(calib, back), b: projToCam(calib, ahead), r: r * s.ballPad + 4 });
  }
  return out;
}

// Is a note (projector-normalized corners) touched by any ball's mask capsule?
// Measured in projector pixels so the ball stays round.
function noteOccludedByBall(corners) {
  const { w, h } = state.proj;
  const s = state.settings;
  const pts = corners.map(([x, y]) => [x * w, y * h]);
  const c = centroid(pts);
  const noteR = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
  const now = Date.now();
  return state.proj.balls.some((b) => {
    const age = Math.min(0.5, Math.max(0, (now - (b.t || now)) / 1000));
    const px = (b.x + b.vx * age) * w;
    const py = (b.y + b.vy * age) * h;
    const ax = px - b.vx * w * s.ballLag;
    const ay = py - b.vy * h * s.ballLag;
    const r = b.rx * w * s.ballPad + noteR;
    return distToSegment(c, [ax, ay], [px, py]) < r;
  });
}

function distToSegment([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function detectOnce() {
  if (!state.detector) return;
  const [w, h] = videoSize();
  if (!w || !h || els.video.readyState < 2) return;
  const calib = activeCalib();
  try {
    state.blockers = calib ? ballBlockers(calib) : [];
    const res = state.detector.process(els.video, w, h, state.settings, {
      maskCanvas: els.mask,
      roi: calib && state.settings.roiOnly ? projectionQuadInCamera(calib) : null,
      blockers: state.blockers,
    });
    state.lastDetect = res;
    if (!calib || state.calibrating || els.freezeNotes.checked) return;
    const dets = res.notes
      .map((n) => ({ corners: n.corners.map((p) => camToProj(calib, p)) }))
      .filter((d) => {
        const [x, y] = centroid(d.corners);
        return x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05;
      });
    const { notes, changed } = state.tracker.update(dets, noteOccludedByBall);
    if (changed) publishNotes(notes);
  } catch (err) {
    console.error(err);
    showBanner(`Detection error: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------- display loop

let frames = 0;
let fpsT = performance.now();

function draw() {
  const [w, h] = videoSize();
  if (w && h) {
    if (els.feed.width !== w || els.feed.height !== h) {
      els.feed.width = w;
      els.feed.height = h;
    }
    feedCtx.drawImage(els.video, 0, 0, w, h);
    drawOverlays(w, h);
    frames++;
  }
  const now = performance.now();
  if (now - fpsT > 1000) {
    state.fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    renderStatus();
  }
  requestAnimationFrame(draw);
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function drawOverlays(w, h) {
  const ctx = feedCtx;
  const k = camPxPerScreenPx();
  ctx.save();
  ctx.lineWidth = 2 * k;

  if (state.calib && !state.calibrating) {
    ctx.setLineDash([8 * k, 6 * k]);
    ctx.strokeStyle = 'rgba(79,195,247,0.9)';
    poly(ctx, projectionQuadInCamera(state.calib));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const d = state.lastDetect;
  if (d && !state.calibrating) {
    ctx.setLineDash([4 * k, 4 * k]);
    ctx.strokeStyle = 'rgba(255,107,107,0.8)';
    ctx.fillStyle = 'rgba(255,107,107,0.9)';
    ctx.font = `${Math.round(11 * k)}px sans-serif`;
    for (const r of d.rejected) {
      poly(ctx, r.corners);
      ctx.stroke();
      ctx.fillText(r.reason, r.corners[0][0], r.corners[0][1] - 4 * k);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,213,79,0.9)';
    for (const n of d.notes) {
      poly(ctx, n.corners);
      ctx.stroke();
    }
  }
  const calib = activeCalib();
  if (calib && !state.calibrating) {
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = '#7be35b';
    ctx.fillStyle = '#7be35b';
    ctx.font = `bold ${Math.round(14 * k)}px sans-serif`;
    for (const n of state.proj.notes) {
      const cam = n.corners.map((p) => projToCam(calib, p));
      poly(ctx, cam);
      ctx.stroke();
      const [cx, cy] = centroid(cam);
      ctx.fillText(`#${n.id}`, cx - 8 * k, cy + 5 * k);
    }
    ctx.fillStyle = 'rgba(255,107,107,0.35)';
    for (const b of state.blockers) {
      ctx.beginPath();
      ctx.lineCap = 'round';
      ctx.lineWidth = 2 * b.r;
      ctx.strokeStyle = 'rgba(255,107,107,0.35)';
      ctx.moveTo(b.a[0], b.a[1]);
      ctx.lineTo(b.b[0] + 0.01, b.b[1]);
      ctx.stroke();
    }
  }

  if (state.calibrating) {
    ctx.lineWidth = 2 * k;
    if (state.calibPts.length === 4) {
      ctx.strokeStyle = 'rgba(123,227,91,0.9)';
      poly(ctx, state.calibPts);
      ctx.stroke();
    }
    ctx.font = `bold ${Math.round(18 * k)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    state.calibPts.forEach(([x, y], i) => {
      ctx.strokeStyle = '#ff4081';
      ctx.beginPath();
      ctx.arc(x, y, 9 * k, 0, Math.PI * 2);
      ctx.moveTo(x - 14 * k, y);
      ctx.lineTo(x + 14 * k, y);
      ctx.moveTo(x, y - 14 * k);
      ctx.lineTo(x, y + 14 * k);
      ctx.stroke();
      ctx.fillStyle = '#ff4081';
      ctx.fillText(String(i + 1), x + 20 * k, y - 20 * k);
    });
  }
  ctx.restore();
}

function renderStatus() {
  const [w, h] = videoSize();
  const d = state.lastDetect;
  const lines = [
    `OpenCV:     ${state.cv ? '<span class="ok">ready</span>' : '<span class="warn">loading…</span>'}`,
    `Camera:     ${w ? `${w}×${h} @ ${state.fps.toFixed(0)} fps` : '<span class="warn">no video</span>'}`,
    `Detection:  ${d ? `${d.ms.toFixed(1)} ms @ ${state.settings.rate} Hz (proc ${d.procSize.join('×')})` : '-'}`,
    `Projector:  ${Date.now() - state.projSeen < 3000 ? `<span class="ok">connected</span> (${state.proj.w}×${state.proj.h})` : '<span class="warn">not connected</span> - open projector.html'}`,
    `Calibrated: ${calibStatus(w, h)}`,
    `Notes:      ${state.proj.notes.length} in play, ${state.tracker ? state.tracker.tentative().length : 0} pending, ${d ? d.notes.length : 0} detected this frame${els.freezeNotes.checked ? ' <span class="warn">(frozen)</span>' : ''}`,
  ];
  els.status.innerHTML = lines.join('\n');
}

function calibStatus(w, h) {
  const c = state.calib;
  if (!c) return '<span class="warn">no</span> - press Calibrate';
  if (w && (c.camSize[0] !== w || c.camSize[1] !== h)) {
    return `<span class="bad">made at ${c.camSize.join('×')}, camera is ${w}×${h}: recalibrate</span>`;
  }
  return `<span class="ok">yes</span> (${new Date(c.created).toLocaleString()})`;
}

// ---------------------------------------------------------------- boot

async function boot() {
  buildSliders();
  requestAnimationFrame(draw);
  const id = await refreshCameraList();
  await selectCamera(id);
  state.cv = await cvReady();
  state.detector = new Detector(state.cv);
  state.tracker = new NoteTracker(trackerOptions());
  restartDetectionLoop();
  renderStatus();
}

boot().catch((err) => {
  console.error(err);
  showBanner(`Startup failed: ${err.message || err}`);
});
