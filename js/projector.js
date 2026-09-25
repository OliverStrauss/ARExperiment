import { createChannel } from './channel.js';
import { drawScene } from './render.js';
import { PhysicsWorld } from './physics.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const hudStatus = document.getElementById('hudStatus');

// Runtime toggles owned by the projector (so its keyboard shortcuts work too);
// reported to the control window in every heartbeat.
const PREFS_KEY = 'sticky-wall.projector.v1';
const PREF_DEFAULTS = { running: true, gravity: false, dropGravity: true, outlines: false, mode: 'drop' };
function loadPrefs() {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
const prefs = loadPrefs();

const state = {
  w: window.innerWidth,
  h: window.innerHeight,
  calib: false,
  cross: null,
  notes: [],
  lastControl: 0,
  lastMouse: Date.now(),
};

const physics = new PhysicsWorld(state.w, state.h);
physics.setConfig({ gravity: prefs.gravity, dropGravity: prefs.dropGravity, mode: prefs.mode });
physics.resetBalls();

const channel = createChannel('projector', onMessage);

// Sound plays in the control window: it gets the clicks/keys browsers require
// before audio may start, and the projector window usually never does.
physics.onHit = (hit) => channel.send('hit', hit);

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
      physics.setNotes(state.notes); // balls keep flying; only note bodies change
      break;
    case 'config': {
      const cfg = {};
      if (msg.ballRadius !== undefined) cfg.ballRadius = msg.ballRadius;
      if (msg.ballSpeed !== undefined) cfg.ballSpeed = msg.ballSpeed;
      physics.setConfig(cfg);
      break;
    }
    case 'cmd':
      runCommand(msg.cmd);
      break;
    case 'steer':
      physics.steer(msg.dir);
      break;
    default:
      break;
  }
}

function runCommand(cmd) {
  switch (cmd) {
    case 'start': prefs.running = true; break;
    case 'pause': prefs.running = false; break;
    case 'toggleRun': prefs.running = !prefs.running; break;
    case 'resetBall': physics.resetBalls(); break;
    case 'addBall': physics.addBall(); break;
    case 'clearBalls': physics.clearBalls(); break;
    // Gravity toggles the current mode's setting (drop and bounce each keep one).
    case 'toggleGravity':
      if (prefs.mode === 'drop') prefs.dropGravity = !prefs.dropGravity;
      else prefs.gravity = !prefs.gravity;
      physics.setConfig({ gravity: prefs.gravity, dropGravity: prefs.dropGravity });
      break;
    case 'toggleOutlines': prefs.outlines = !prefs.outlines; break;
    // Space: drop the waiting ball (or bring a new one up) in drop mode,
    // start/pause in bounce mode.
    case 'action':
      if (prefs.mode === 'drop') {
        prefs.running = true;
        if (!physics.drop()) physics.spawnHeld();
      } else {
        prefs.running = !prefs.running;
      }
      break;
    case 'toggleMode':
      prefs.mode = prefs.mode === 'drop' ? 'bounce' : 'drop';
      physics.setConfig({ mode: prefs.mode });
      break;
    default: return;
  }
  savePrefs();
  sendBalls();
}

function sayHello() {
  channel.send('hello', { w: state.w, h: state.h });
}

// ~10 Hz: ball positions (so control can mask them out of detection) + toggles.
function sendBalls() {
  channel.send('balls', {
    balls: state.calib ? [] : physics.ballsNormalized(),
    t: Date.now(),
    running: prefs.running,
    gravity: prefs.mode === 'drop' ? prefs.dropGravity : prefs.gravity,
    outlines: prefs.outlines,
    mode: prefs.mode,
  });
}
setInterval(sendBalls, 100);

// ---------------------------------------------------------------- sizing

function resize() {
  const dpr = window.devicePixelRatio || 1;
  state.w = window.innerWidth;
  state.h = window.innerHeight;
  canvas.width = Math.round(state.w * dpr);
  canvas.height = Math.round(state.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  physics.resize(state.w, state.h);
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

// Arrow keys steer the waiting ball (drop mode) while held down.
const arrows = { left: false, right: false };
function updateSteer() {
  physics.steer((arrows.right ? 1 : 0) - (arrows.left ? 1 : 0));
}
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft') arrows.left = true;
  else if (k === 'arrowright') arrows.right = true;
  else if (e.repeat) return;
  else if (k === 'f') toggleFullscreen();
  else if (k === ' ') runCommand('action');
  else if (k === 'o') runCommand('toggleOutlines');
  else if (k === 'g') runCommand('toggleGravity');
  else if (k === 'b') runCommand('addBall');
  else if (k === 'r') runCommand('resetBall');
  else if (k === 'm') runCommand('toggleMode');
  else return;
  updateSteer();
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft') arrows.left = false;
  else if (k === 'arrowright') arrows.right = false;
  else return;
  updateSteer();
});
window.addEventListener('blur', () => {
  arrows.left = arrows.right = false;
  updateSteer();
});

// ---------------------------------------------------------------- render loop

let last = performance.now();

function frame(now) {
  const dt = now - last;
  last = now;
  // Physics is frozen while calibrating so a ball can't cover a dot.
  if (prefs.running && !state.calib) physics.step(dt);
  drawScene(ctx, state.w, state.h, {
    calib: state.calib,
    cross: state.cross,
    notes: state.notes,
    outlines: prefs.outlines,
    balls: state.calib ? [] : physics.ballsNormalized(),
  });
  requestAnimationFrame(frame);
}

// Heartbeat so the control window can show "projector connected".
setInterval(sayHello, 1000);

// Exposed for tests / debugging from the devtools console.
window.stickyWall = { state, prefs, physics };

resize();
updateHud();
requestAnimationFrame(frame);
