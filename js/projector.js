import { createChannel } from './channel.js';
import { drawScene } from './render.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const hudStatus = document.getElementById('hudStatus');

const state = {
  w: window.innerWidth,
  h: window.innerHeight,
  calib: false,
  cross: null,
  notes: [],
  lastControl: 0,
  lastMouse: Date.now(),
};

const channel = createChannel('projector', onMessage);

function onMessage(msg) {
  state.lastControl = Date.now();
  switch (msg.type) {
    case 'ping':
      sayHello();
      break;
    case 'calib':
      state.calib = !!msg.on;
      break;
    case 'cross':
      state.cross = msg.pt || null;
      break;
    case 'notes':
      state.notes = msg.notes || [];
      break;
    default:
      break;
  }
}

function sayHello() {
  channel.send('hello', { w: state.w, h: state.h });
}

// ---------------------------------------------------------------- sizing

function resize() {
  const dpr = window.devicePixelRatio || 1;
  state.w = window.innerWidth;
  state.h = window.innerHeight;
  canvas.width = Math.round(state.w * dpr);
  canvas.height = Math.round(state.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sayHello();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- fullscreen / HUD

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.getElementById('fullscreen').addEventListener('click', toggleFullscreen);

// The HUD is only shown when windowed and either the control window is missing
// or the mouse moved recently, so it is never projected during play.
document.addEventListener('fullscreenchange', updateHud);
window.addEventListener('mousemove', () => {
  state.lastMouse = Date.now();
  document.body.style.cursor = 'default';
  updateHud();
});
function updateHud() {
  const connected = Date.now() - state.lastControl < 3000;
  const idle = Date.now() - state.lastMouse > 3000;
  hud.hidden = !!document.fullscreenElement || (connected && idle);
  if (idle) document.body.style.cursor = '';
  hudStatus.textContent = connected ? 'Control window connected ✓' : 'Waiting for control window… (open control.html from the same address)';
}
setInterval(updateHud, 1000);

window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// ---------------------------------------------------------------- render loop

function frame() {
  drawScene(ctx, state.w, state.h, {
    calib: state.calib,
    cross: state.cross,
    notes: state.notes,
    outlines: true, // debug outlines; becomes a toggle with the physics stage
    balls: [],
  });
  requestAnimationFrame(frame);
}

// Heartbeat so the control window can show "projector connected".
setInterval(sayHello, 1000);

resize();
updateHud();
requestAnimationFrame(frame);
