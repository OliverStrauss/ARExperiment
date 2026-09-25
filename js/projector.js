import { createChannel } from './channel.js';
import { drawScene, HALO_MS } from './render.js';
import { epochNow } from './beat.js';
import { keyAction } from './keys.js';

// The projector only draws. The control window owns the notes, the beat engine
// and the sound; balls are drawn analytically from the shared clock in the
// 'beat' message, so no physics runs here.

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
  beat: null,
  echo: null,
  ring: null,
  toast: null,
  halos: [], // [{ noteId, color, at }]
  hitLog: [], // epoch s when each halo started (tests)
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
    case 'beat':
      state.beat = msg;
      break;
    case 'echo':
      state.echo = msg.rows ? msg : null;
      break;
    case 'ring':
      state.ring = msg.open ? msg : null;
      break;
    case 'toast':
      state.toast = { key: msg.key, text: msg.text, at: epochNow() };
      break;
    case 'hitFx': {
      // Sent ahead of time; start the halo when the hit is heard.
      const halo = { noteId: msg.noteId, color: msg.color, at: msg.at };
      setTimeout(() => {
        state.halos = state.halos.filter((h) => epochNow() - h.at < HALO_MS / 1000);
        state.halos.push(halo);
        state.hitLog.push(epochNow());
        if (state.hitLog.length > 500) state.hitLog.shift();
      }, Math.max(0, (msg.at - epochNow()) * 1000));
      break;
    }
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

// ---------------------------------------------------------------- input
// Keys are forwarded to the control window (it owns the beat engine); only
// F is handled here. A click on the wall opens the instrument ring there.

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = { key: e.key, code: e.code, shift: e.shiftKey, repeat: e.repeat };
  const a = keyAction(k);
  if (!a) return;
  e.preventDefault(); // Tab / Space must not move focus or scroll
  if (a.action === 'fullscreen') {
    if (!e.repeat) toggleFullscreen();
  } else {
    channel.send('key', k);
  }
});

canvas.addEventListener('click', (e) => {
  channel.send('click', { x: e.clientX / state.w, y: e.clientY / state.h });
});

// ---------------------------------------------------------------- render loop

function frame() {
  drawScene(ctx, state.w, state.h, {
    calib: state.calib,
    cross: state.cross,
    notes: state.notes,
    outlines: state.beat?.outlines,
    beat: state.beat,
    echo: state.echo,
    ring: state.ring,
    toast: state.toast,
    halos: state.halos,
    now: epochNow(),
  });
  requestAnimationFrame(frame);
}

// Heartbeat so the control window can show "projector connected".
setInterval(sayHello, 1000);

// Exposed for tests / debugging from the devtools console.
window.stickyWall = { state };

resize();
updateHud();
requestAnimationFrame(frame);
