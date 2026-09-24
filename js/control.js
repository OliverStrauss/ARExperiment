import { SLIDERS, DEFAULTS, loadSettings, saveSettings, loadCalibration, saveCalibration } from './settings.js';
import { createChannel } from './channel.js';
import { computeCalibration, camToProj, projectionQuadInCamera, snapToDot, CALIB_DOTS } from './calibration.js';
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
  // Mirror of what the projector is showing (drives the simulated camera).
  proj: { w: 1920, h: 1080, calib: false, cross: null, notes: [], outlines: false, balls: [] },
};

function projectorScene() {
  const p = state.proj;
  return { ...p, aspect: p.w / p.h };
}

// ---------------------------------------------------------------- projector link

const channel = createChannel('control', onMessage);

function onMessage(msg) {
  if (msg.type === 'hello') {
    const reconnect = Date.now() - state.projSeen > 3000;
    state.projSeen = Date.now();
    state.proj.w = msg.w;
    state.proj.h = msg.h;
    if (reconnect) syncProjector();
  }
}

// Push everything the projector should be showing (after it (re)connects).
function syncProjector() {
  channel.send('calib', { on: state.calibrating });
  channel.send('cross', { pt: state.proj.cross });
  channel.send('notes', { notes: state.proj.notes });
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
    });
    groups.get(s.group).appendChild(row);
  }
}

els.resetSettings.addEventListener('click', () => {
  state.settings = { ...DEFAULTS, deviceId: state.settings.deviceId };
  saveSettings(state.settings);
  buildSliders();
  restartDetectionLoop();
});

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
  saveCalibration(null);
  showBanner('');
});

function onCalibPointsChanged() {
  if (state.calibPts.length === 4 && state.cv) {
    try {
      state.calib = computeCalibration(state.cv, state.calibPts, videoSize());
      saveCalibration(state.calib);
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

function detectOnce() {
  if (!state.detector) return;
  const [w, h] = videoSize();
  if (!w || !h || els.video.readyState < 2) return;
  try {
    state.lastDetect = state.detector.process(els.video, w, h, state.settings, {
      maskCanvas: els.mask,
    });
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

  if (state.calibrating) {
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
  restartDetectionLoop();
  renderStatus();
}

boot().catch((err) => {
  console.error(err);
  showBanner(`Startup failed: ${err.message || err}`);
});
