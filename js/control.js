import { SLIDERS, DEFAULTS, loadSettings, saveSettings } from './settings.js';
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
  // Mirror of what the projector is showing (drives the simulated camera).
  proj: { w: 1920, h: 1080, calib: false, cross: null, notes: [], outlines: false, balls: [] },
};

function projectorScene() {
  const p = state.proj;
  return { ...p, aspect: p.w / p.h };
}

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

let simDrag = -1;
els.feed.addEventListener('pointerdown', (ev) => {
  if (!state.sim || ev.button !== 0) return;
  simDrag = state.sim.noteIndexAtCam(feedPoint(ev));
  if (simDrag >= 0) els.feed.setPointerCapture(ev.pointerId);
});
els.feed.addEventListener('pointermove', (ev) => {
  if (state.sim && simDrag >= 0) state.sim.moveNote(simDrag, feedPoint(ev));
});
els.feed.addEventListener('pointerup', () => { simDrag = -1; });

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

function renderStatus() {
  const [w, h] = videoSize();
  const d = state.lastDetect;
  const lines = [
    `OpenCV:     ${state.cv ? '<span class="ok">ready</span>' : '<span class="warn">loading…</span>'}`,
    `Camera:     ${w ? `${w}×${h} @ ${state.fps.toFixed(0)} fps` : '<span class="warn">no video</span>'}`,
    `Detection:  ${d ? `${d.ms.toFixed(1)} ms @ ${state.settings.rate} Hz (proc ${d.procSize.join('×')})` : '-'}`,
  ];
  els.status.innerHTML = lines.join('\n');
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
