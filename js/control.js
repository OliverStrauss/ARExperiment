import { SLIDERS, DEFAULTS, loadSettings, saveSettings, loadCalibration, saveCalibration, loadPalette, savePalette } from './settings.js';
import { createChannel } from './channel.js';
import { computeCalibration, camToProj, projToCam, snapToDot } from './calibration.js';
import { NoteTracker, centroid } from './tracker.js';
import { listCameras, openCamera, stopStream, SIM_DEVICE_ID } from './camera.js';
import { SimCamera } from './simcam.js';
import { cvReady } from './cvload.js';
import { Detector } from './vision.js';
import { NOTE_COLORS, DEFAULT_PALETTE, classifyColor, freqOf, pitchOf } from './colors.js';
import { unlock, soundReady, playTone, playNote } from './sound.js';
import { buildLanes, rateLabel, noteAt, oneWay } from './lanes.js';
import { InstrumentRing } from './ring.js';
import { INSTRUMENTS } from './instruments.js';
import { BeatEngine, epochNow, clockPos, ballY, ghostPos } from './beat.js';
import { ballRadiusN, ballGapN, refScale, inflate, HALO_MS, HALO_MASK, BALL_R, BALL_GAP, gridLevel } from './render.js';
import { keyAction } from './keys.js';

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
  bpmOut: $('bpmOut'),
  snapBtn: $('snapBtn'),
  outlines: $('outlines'),
  colorButtons: $('colorButtons'),
  colorMsg: $('colorMsg'),
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
  tracker: null, // NoteTracker (projector-normalized, before the shift slider)
  rawNotes: [], // tracker output, before the shift slider
  blockers: [], // ball mask capsules used in the last detection (camera px)
  palette: loadPalette(DEFAULT_PALETTE), // { colour name: [r,g,b] as the camera sees it }
  teaching: null, // colour name waiting for a click on a note in the feed
  // Beat UI state owned by this window (the projector only draws it).
  highlight: null, // highlighted lane id
  focus: null, // selected note id in that lane (a pair has two: Tab visits both)
  offsets: {}, // { laneId: dx } lane nudges (A / D)
  overlay: false, // ? key overlay on the wall
  halos: [], // [{ noteId, color, at }] hits in flight (drawn + masked out of detection)
  hitLog: [], // recent hits (tests / debugging)
  // Mirror of what the projector is showing (drives the simulated camera).
  proj: {
    w: 1920,
    h: 1080,
    calib: false,
    cross: null,
    notes: [],
    beat: null,
    echo: null,
    ring: null,
    toast: null,
  },
};

const ring = new InstrumentRing();
const engine = new BeatEngine({
  bpm: state.settings.bpm,
  snap: state.settings.snap,
  echoBars: state.settings.echoBars,
  maxBallsPerLane: state.settings.maxBallsPerLane,
});

function projectorScene() {
  const p = state.proj;
  const now = epochNow();
  return { ...p, outlines: state.settings.outlines, halos: state.halos, now, aspect: p.w / p.h };
}

// ---------------------------------------------------------------- projector link

const channel = createChannel('control', onMessage);

function onMessage(msg) {
  if (msg.type === 'key') {
    handleKey(msg);
    return;
  }
  if (msg.type === 'click') {
    clickWall([msg.x, msg.y]);
    return;
  }
  if (msg.type !== 'hello') return;
  // A projector that (re)appears gets the full current state pushed to it.
  const reconnect = Date.now() - state.projSeen > 3000;
  state.projSeen = Date.now();
  if (reconnect) setTimeout(syncProjector, 0);
  state.proj.w = msg.w;
  state.proj.h = msg.h;
}

// ---------------------------------------------------------------- beat engine
// This window owns the beat: lanes come from the tracked notes, the engine
// schedules hits on the audio clock, and the projector draws from 'beat'.

function laneOptions() {
  const s = state.settings;
  return { unit: s.unit, barH: s.barH, snap: engine.snap, offsets: state.offsets };
}

function rebuildLanes() {
  const lanes = buildLanes(state.proj.notes, laneOptions());
  engine.setLanes(lanes);
  engine.syncNotes(state.proj.notes, epochNow());
  if (ring.isOpen && !state.proj.notes.some((n) => n.id === ring.noteId)) {
    ring.cancel();
    sendRing();
  }
  const ids = lanes.map((l) => l.id);
  for (const id of Object.keys(state.offsets)) if (!ids.includes(Number(id))) delete state.offsets[id];
  const all = stops();
  if (!all.some((t) => t.laneId === state.highlight && t.noteId === state.focus)) {
    const t = all.find((t) => t.laneId === state.highlight) ?? all[0];
    state.highlight = t?.laneId ?? null;
    state.focus = t?.noteId ?? null;
  }
  sendBeat();
}

function beatPayload() {
  const s = state.settings;
  return {
    clock: engine.clock(),
    bpm: engine.bpm,
    snap: engine.snap,
    barH: s.barH,
    lanes: engine.lanes.map((l) => ({
      ...l,
      balls: engine.ballsOf(l.id).map((b) => ({ id: b.id, phase: b.phase })),
    })),
    instruments: Object.fromEntries(state.proj.notes.map((n) => [n.id, engine.instrumentOf(n.id)])),
    ghosts: engine.layers.map((l) => l.ghost).filter(Boolean),
    highlight: state.highlight,
    focus: state.focus,
    mutes: [...engine.mutes],
    solo: engine.solo,
    overlay: state.overlay,
    outlines: s.outlines,
    echoBars: engine.o.echoBars,
  };
}

function sendBeat() {
  state.proj.beat = beatPayload();
  channel.send('beat', state.proj.beat);
  renderBeatUI();
}
setInterval(sendBeat, 1000); // keep-alive

// The look-ahead must cover the longest gap between ticks: this window's main
// thread also runs detection, and a late tick would mean late notes. It grows
// with the gaps seen (from 100 ms, capped) and relaxes slowly.
let lastTick = 0;
let tickSlack = 0.1;
function schedulerTick() {
  const now = epochNow();
  if (lastTick) tickSlack = Math.min(0.35, Math.max(0.1, (now - lastTick) * 1.5, tickSlack * 0.995));
  lastTick = now;
  engine.setOptions({ lookahead: tickSlack });
  const hits = engine.tick(now);
  for (const h of hits) {
    playNote(h.instrument, freqOf(h.color) ?? freqOf('purple'), h.velocity, h.time);
    channel.send('hitFx', { noteId: h.noteId, color: h.color, at: h.time });
    state.halos.push({ noteId: h.noteId, color: h.color, at: h.time });
    state.hitLog.push(h);
  }
  if (state.hitLog.length > 500) state.hitLog.splice(0, state.hitLog.length - 500);
  const old = epochNow() - HALO_MS / 1000 - state.settings.ballLag - 0.1;
  if (state.halos.length && state.halos[0].at < old) state.halos = state.halos.filter((h) => h.at >= old);
  if (ring.expired(epochNow())) runAction({ action: 'ringCommit', cap: '⏱' });
}
setInterval(schedulerTick, 25);

function sendEcho() {
  state.proj.echo = engine.running || engine.layers.length ? engine.echoView(epochNow()) : null;
  channel.send('echo', state.proj.echo || { rows: null });
}
setInterval(sendEcho, 250);

function toast(key, text) {
  state.proj.toast = { key, text, at: epochNow() };
  channel.send('toast', { key, text });
}

function laneIndex(id) {
  return engine.lanes.findIndex((l) => l.id === id);
}

// Tab stops: every note, lane by lane, a pair's upper note before its target.
// The middle note of a 3-stack is a stop in both of its lanes.
function stops() {
  return engine.lanes.flatMap((l) => (l.upperId == null ? [l.targetId] : [l.upperId, l.targetId]).map((noteId) => ({ laneId: l.id, noteId })));
}

function laneName(id) {
  return `Lane ${laneIndex(id) + 1}`;
}

function setSetting(key, value) {
  state.settings[key] = value;
  saveSettings(state.settings);
  const input = els.sliders.querySelector(`input[data-key="${key}"]`);
  if (input) {
    input.value = value;
    input.nextElementSibling.textContent = input.value;
  }
}

// Every action from the keyboard (either window) or the buttons.
function runAction(a) {
  const now = epochNow();
  const lane = engine.lane(state.highlight);
  const colorName = (c) => `${c} (${pitchOf(c)})`;
  switch (a.action) {
    case 'toggleRun':
      toast(a.cap, engine.toggle(now) ? 'Clock running' : 'Clock stopped');
      break;
    case 'tempo':
      setSetting('bpm', engine.setBpm(engine.bpm + a.arg, now));
      toast(a.cap, `Tempo ${engine.bpm} BPM`);
      break;
    case 'snap':
      engine.snap = !engine.snap;
      setSetting('snap', engine.snap);
      rebuildLanes();
      toast(a.cap, `Snap ${engine.snap ? 'on' : 'off'}`);
      break;
    case 'lane': {
      const all = stops();
      const n = all.length;
      if (!n) return toast(a.cap, 'No lanes: put a note on the wall');
      const i = all.findIndex((t) => t.laneId === state.highlight && t.noteId === state.focus);
      ({ laneId: state.highlight, noteId: state.focus } = all[(((i < 0 ? 0 : i + a.arg) % n) + n) % n]);
      const l = engine.lane(state.highlight);
      const where = l.upperId == null ? '' : state.focus === l.upperId ? ' top' : ' bottom';
      toast(a.cap, `${laneName(l.id)}${where} · ${noteLabel(state.focus)} · ${engine.instrumentOf(state.focus)} · ${rateLabel(oneWay(l), engine.snap)}`);
      break;
    }
    case 'addBall':
    case 'removeBall': {
      if (!lane) return toast(a.cap, 'No lane highlighted');
      const ok = a.action === 'addBall' ? engine.addBall(lane.id) : engine.removeBall(lane.id);
      const count = engine.ballsOf(lane.id).length;
      toast(a.cap, ok ? `${laneName(lane.id)} → ${count} ball${count > 1 ? 's' : ''}` : `${laneName(lane.id)} has ${count} (${a.action === 'addBall' ? 'max' : 'min'})`);
      break;
    }
    case 'nudge':
      if (!lane) return toast(a.cap, 'No lane highlighted');
      state.offsets[lane.id] = (state.offsets[lane.id] || 0) + a.arg * 0.005;
      rebuildLanes();
      toast(a.cap, `${laneName(lane.id)} nudged ${a.arg < 0 ? '←' : '→'}`);
      break;
    case 'mute':
      toast(a.cap, `${engine.toggleMute(a.arg) ? 'Mute' : 'Unmute'} ${colorName(a.arg)}`);
      break;
    case 'solo':
      toast(a.cap, engine.toggleSolo(a.arg) ? `Solo ${colorName(a.arg)}` : 'Solo off');
      break;
    case 'reset':
      engine.resetBalls();
      toast(a.cap, 'Balls reset: 1 per lane');
      break;
    case 'openRing': {
      if (!lane) return toast(a.cap, 'No lane highlighted');
      openRing(state.focus ?? lane.targetId, a.cap);
      break;
    }
    case 'spin': {
      if (!ring.isOpen) return; // arrows only belong to the ring
      const inst = ring.spin(a.arg, now);
      previewInstrument(ring.noteId, inst);
      sendRing();
      toast(a.cap, inst);
      break;
    }
    case 'ringCommit': {
      const res = ring.commit();
      if (!res) return;
      engine.setInstrument(res.noteId, res.instrument);
      sendRing();
      toast(a.cap, `${noteLabel(res.noteId)} → ${res.instrument}`);
      break;
    }
    case 'ringCancel':
      if (!ring.isOpen) return;
      ring.cancel();
      sendRing();
      toast(a.cap, 'Instrument unchanged');
      break;
    case 'keep': {
      const layer = engine.keep();
      if (layer) layer.ghost = ghostOf(layer);
      const n = engine.layers.length;
      toast(a.cap, layer ? `Kept ${engine.o.echoBars} bar${engine.o.echoBars > 1 ? 's' : ''} · ${n} layer${n > 1 ? 's' : ''}` : 'Nothing to keep yet');
      sendEcho();
      break;
    }
    case 'clearLayers':
      toast(a.cap, `Cleared ${engine.clearLayers()} layer(s)`);
      sendEcho();
      break;
    case 'undoKeep': {
      const had = engine.undoKeep();
      toast(a.cap, had ? `Undo keep · ${engine.layers.length} left` : 'No layers to undo');
      sendEcho();
      break;
    }
    case 'help':
      state.overlay = !state.overlay;
      toast(a.cap, state.overlay ? 'Keys' : 'Keys hidden');
      break;
    default:
      return;
  }
  sendBeat();
}

// Snapshot of the notes and balls a kept layer came from, so the wall keeps
// showing them (dim) after the notes are taken down.
function ghostOf(layer) {
  const ids = new Set(layer.events.map((e) => e.noteId));
  const lanes = engine.lanes.filter((l) => ids.has(l.targetId) || ids.has(l.upperId));
  const used = new Set(lanes.flatMap((l) => [l.targetId, l.upperId]));
  return {
    from: engine.horizon - layer.L,
    L: layer.L,
    notes: state.proj.notes.filter((n) => used.has(n.id)).map((n) => ({ id: n.id, corners: n.corners, color: n.color })),
    lanes: lanes.map((l) => ({ ...l, balls: engine.ballsOf(l.id).map((b) => ({ id: b.id, phase: b.phase })) })),
  };
}

// Lanes drawn on the wall with the pos their balls follow: live lanes, then
// ghost lanes of kept layers whose notes are gone.
function drawnLanes() {
  const live = new Set(state.proj.notes.map((n) => n.id));
  const out = engine.lanes.map((lane) => ({ lane, balls: engine.ballsOf(lane.id), at: (p) => p }));
  for (const { ghost } of engine.layers) {
    for (const lane of ghost?.lanes || []) {
      if (!live.has(lane.targetId)) out.push({ lane, balls: lane.balls, at: (p) => ghostPos(ghost, p) });
    }
  }
  return out;
}

function noteColor(noteId) {
  return state.proj.notes.find((n) => n.id === noteId)?.color;
}

function noteLabel(noteId) {
  return pitchOf(noteColor(noteId)) ?? `#${noteId}`;
}

function previewInstrument(noteId, inst) {
  playNote(inst, freqOf(noteColor(noteId)) ?? freqOf('purple'), 0.8);
}

function sendRing() {
  state.proj.ring = ring.isOpen ? ring.view() : null;
  channel.send('ring', ring.view());
}

function openRing(noteId, cap) {
  ring.open(noteId, engine.instrumentOf(noteId), epochNow());
  sendRing();
  toast(cap, `${noteLabel(noteId)} · ${ring.current} · ← → to spin`);
}

// A click on the wall (projector window): a second click keeps the ring's
// choice, a click on a note opens the ring on it.
function clickWall(pt) {
  if (ring.isOpen) {
    runAction({ action: 'ringCommit', cap: 'Click' });
    return;
  }
  const note = noteAt(state.proj.notes, pt);
  if (note) openRing(note.id, 'Click');
}

function handleKey(k) {
  const a = keyAction(k);
  if (!a || a.action === 'fullscreen') return;
  if (k.repeat && a.action !== 'tempo' && a.action !== 'spin') return;
  runAction(a);
}

function isTyping(el) {
  return el?.tagName === 'SELECT' || el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && el.type === 'text');
}
window.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const a = keyAction({ key: e.key, code: e.code, shift: e.shiftKey });
  if (!a || a.action === 'fullscreen') return;
  e.preventDefault(); // no page scrolling / focus moves / slider nudging / button presses
  handleKey({ key: e.key, code: e.code, shift: e.shiftKey, repeat: e.repeat });
});
// Clicked buttons/checkboxes keep focus, and Space would press them again.
document.addEventListener('click', (e) => {
  if (e.target.matches?.('button, input[type=checkbox]')) e.target.blur();
});

els.runBtn.addEventListener('click', () => runAction({ action: 'toggleRun', cap: 'Space' }));
$('keepBtn').addEventListener('click', () => runAction({ action: 'keep', cap: 'K' }));
$('clearBtn').addEventListener('click', () => runAction({ action: 'clearLayers', cap: 'X' }));
$('undoBtn').addEventListener('click', () => runAction({ action: 'undoKeep', cap: 'Z' }));
$('bpmDown').addEventListener('click', () => runAction({ action: 'tempo', arg: -2, cap: '[' }));
$('bpmUp').addEventListener('click', () => runAction({ action: 'tempo', arg: 2, cap: ']' }));
els.snapBtn.addEventListener('click', () => runAction({ action: 'snap', cap: 'S' }));
els.outlines.checked = state.settings.outlines;
els.outlines.addEventListener('change', () => {
  setSetting('outlines', els.outlines.checked);
  sendBeat();
});

// Echo panel: the wall's echo strip, larger. Kept hits solid, live outlined.
function drawEchoPanel() {
  const cv = $('echoCanvas');
  const echo = state.proj.echo;
  const rows = echo?.rows || [];
  const ROW = 22;
  const TOP = 8;
  const LEFT = 56;
  const hgt = TOP * 2 + Math.max(1, rows.length) * ROW;
  if (cv.height !== hgt) cv.height = hgt;
  const c = cv.getContext('2d');
  const W = cv.width;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, hgt);
  const bars = echo?.bars ?? engine.o.echoBars;
  const steps = bars * 16;
  const xOf = (step) => LEFT + ((step + 0.5) / steps) * (W - LEFT - 8);
  // grid like a score: bars, quarters, 8ths, 16ths (see render.js gridLevel)
  for (let st = 0; st <= steps; st++) {
    const g = gridLevel(st);
    c.fillStyle = `rgba(255,255,255,${[0.03, 0.07, 0.14, 0.35][g]})`;
    c.fillRect(Math.round(xOf(st - 0.5)), TOP, g === 3 ? 2 : 1, hgt - 2 * TOP);
  }
  c.font = '12px ui-monospace, Menlo, monospace';
  c.textBaseline = 'middle';
  if (!rows.length) {
    c.fillStyle = '#9aa0a6';
    c.fillText(engine.running ? 'Listening… hits appear here' : 'Start the clock (Space) to hear the wall', LEFT, TOP + ROW / 2);
  }
  rows.forEach((row, r) => {
    const y = TOP + r * ROW + ROW / 2;
    const rgb = `rgb(${state.palette[row.color].join(',')})`;
    c.fillStyle = rgb;
    c.fillRect(6, y - 5, 10, 10);
    c.fillStyle = '#e6e6e6';
    c.fillText(row.pitch, 22, y);
    c.lineWidth = 2;
    for (const hit of row.hits) {
      c.beginPath();
      c.arc(xOf(hit.step), y, 6, 0, Math.PI * 2);
      if (hit.kept) {
        c.fillStyle = rgb;
        c.fill();
      } else {
        c.strokeStyle = rgb;
        c.stroke();
      }
    }
  });
  if (echo) {
    const pos = clockPos(engine.clock(), epochNow());
    const play = ((pos % steps) + steps) % steps;
    c.fillStyle = '#fff';
    c.fillRect(xOf(play - 0.5) - 1.5, TOP - 4, 3, hgt - 2 * TOP + 8);
    $('echoInfo').textContent = `${engine.bpm} BPM · bar ${Math.floor(play / 16) + 1}/${bars}`;
  } else {
    $('echoInfo').textContent = '';
  }
}

// Lanes panel: one row per note (a pair's upper note, then its target), the
// lane columns spanning both. Click a row to select that note. Instruments
// and ball counts can be set here too, so the laptop alone can configure all.
let lanesSig = '';
function renderLanes() {
  const tbody = $('lanesTable').tBodies[0];
  const note = (id, color) => ({ id, color, pitch: pitchOf(color) ?? '?', instrument: engine.instrumentOf(id), muted: !engine.audible(color) });
  const rows = engine.lanes.map((l, i) => ({
    id: l.id,
    num: i + 1,
    notes: [...(l.upperId == null ? [] : [note(l.upperId, l.upperColor)]), note(l.targetId, l.color)],
    rate: rateLabel(oneWay(l), engine.snap),
    balls: engine.ballsOf(l.id).length,
    hi: l.id === state.highlight,
    focus: state.focus,
  }));
  const sig = JSON.stringify(rows);
  // don't rebuild under an open dropdown
  if (sig === lanesSig || tbody.contains(document.activeElement)) return;
  lanesSig = sig;
  $('lanesEmpty').hidden = rows.length > 0;
  $('lanesInfo').textContent = rows.length ? `${rows.length} lane${rows.length > 1 ? 's' : ''} · Tab / click to select a note` : '';
  tbody.replaceChildren(...rows.flatMap((r) => r.notes.map((n, j) => {
    const tr = document.createElement('tr');
    tr.className = `lane${r.hi && n.id === r.focus ? ' hi' : ''}${j ? ' sub' : ''}`;
    const span = r.notes.length;
    const swatch = n.color ? `<span class="swatch" style="background:rgb(${state.palette[n.color].join(',')})"></span>` : '';
    const role = span > 1 ? `<span class="muted">${j ? 'bottom' : 'top'}</span> ` : '';
    const target = `<td>${role}${swatch}${n.pitch}${n.muted ? ' <span class="muted">muted</span>' : ''}</td>`;
    const inst = `<td><select title="Instrument of this note">${INSTRUMENTS.map((x) => `<option${x === n.instrument ? ' selected' : ''}>${x}</option>`).join('')}</select></td>`;
    tr.innerHTML = j
      ? `${target}${inst}`
      : `<td rowspan="${span}">${r.num}</td>${target}${inst}<td rowspan="${span}">${r.rate}</td>
      <td rowspan="${span}"><button data-d="-1" title="Remove a ball (⇧B)">−</button> ${r.balls} <button data-d="1" title="Add a ball (B)">+</button></td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('select')) return;
      state.highlight = r.id;
      state.focus = n.id;
      const d = Number(e.target.dataset?.d);
      if (d) runAction({ action: d > 0 ? 'addBall' : 'removeBall', cap: d > 0 ? 'B' : '⇧B' });
      else sendBeat();
    });
    tr.querySelector('select').addEventListener('change', (e) => {
      engine.setInstrument(n.id, e.target.value);
      previewInstrument(n.id, e.target.value);
      e.target.blur();
      sendBeat();
    });
    return tr;
  })));
}

function buildPitchButtons() {
  $('pitchButtons').replaceChildren(...NOTE_COLORS.map(({ name, pitch }, i) => {
    const b = document.createElement('button');
    b.dataset.color = name;
    b.title = `${name}: mute (${i + 1}) · solo (⇧${i + 1})`;
    b.innerHTML = `<span class="swatch"></span>${pitch}`;
    b.addEventListener('click', (e) => {
      runAction(e.shiftKey ? { action: 'solo', arg: name, cap: `⇧${i + 1}` } : { action: 'mute', arg: name, cap: String(i + 1) });
    });
    return b;
  }));
}

function renderPitchButtons() {
  for (const b of $('pitchButtons').children) {
    const c = b.dataset.color;
    b.querySelector('.swatch').style.background = `rgb(${state.palette[c].join(',')})`;
    b.classList.toggle('muted-pitch', !engine.audible(c));
    b.classList.toggle('solo-pitch', engine.solo === c);
  }
}

$('resetBalls').addEventListener('click', () => runAction({ action: 'reset', cap: 'R' }));
$('helpBtn').addEventListener('click', () => runAction({ action: 'help', cap: '?' }));

function renderBeatUI() {
  renderLanes();
  renderPitchButtons();
  $('helpBtn').classList.toggle('active', state.overlay);
  els.runBtn.textContent = engine.running ? 'Stop' : 'Start';
  els.runBtn.classList.toggle('active', engine.running);
  els.bpmOut.textContent = `${engine.bpm} BPM`;
  els.snapBtn.textContent = `Snap: ${engine.snap ? 'on' : 'off'}`;
  els.snapBtn.classList.toggle('active', engine.snap);
  $('keepBtn').textContent = `Keep last ${engine.o.echoBars} bar${engine.o.echoBars > 1 ? 's' : ''} (K)`;
  const n = engine.layers.length;
  $('layersInfo').textContent = n ? `${n} kept layer${n > 1 ? 's' : ''} looping` : 'nothing kept';
}

// Push everything the projector should be showing (after it (re)connects).
function syncProjector() {
  channel.send('calib', { on: state.calibrating });
  channel.send('cross', { pt: state.proj.cross });
  channel.send('notes', { notes: state.proj.notes });
  sendBeat();
}

setInterval(() => channel.send('ping'), 1000);

$('openProjector').addEventListener('click', () => {
  window.open('projector.html', 'sticky-wall-projector', 'popup,width=960,height=540');
});

// For tests / debugging from the devtools console.
window.stickyWall = { state, channel, engine, ring, runAction };

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
      if (s.group === 'Beat') applyBeatSettings();
      if (s.key === 'noteShiftX' && state.rawNotes) publishNotes(state.rawNotes);
    });
    groups.get(s.group).appendChild(row);
  }
}

els.resetSettings.addEventListener('click', () => {
  state.settings = { ...DEFAULTS, deviceId: state.settings.deviceId };
  saveSettings(state.settings);
  buildSliders();
  els.roiOnly.checked = state.settings.roiOnly;
  els.outlines.checked = state.settings.outlines;
  state.tracker?.setOptions(trackerOptions());
  engine.snap = state.settings.snap;
  applyBeatSettings();
  if (state.rawNotes) publishNotes(state.rawNotes);
  restartDetectionLoop();
});

function applyBeatSettings() {
  const s = state.settings;
  if (s.bpm !== engine.bpm) engine.setBpm(s.bpm, epochNow());
  engine.setOptions({ echoBars: s.echoBars, maxBallsPerLane: s.maxBallsPerLane });
  rebuildLanes();
}

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
  if (state.teaching) {
    teachColor(p);
    return;
  }
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
    setCrosshair(camToScreen(state.calib, p));
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
  resetShift();
  publishNotes([]);
  saveCalibration(null);
  showBanner('');
});

function resetShift() {
  if (!state.settings.noteShiftX) return;
  state.settings.noteShiftX = 0;
  saveSettings(state.settings);
  buildSliders();
  publishNotes(state.rawNotes);
}

function onCalibPointsChanged() {
  if (state.calibPts.length === 4 && state.cv) {
    try {
      state.calib = computeCalibration(state.cv, state.calibPts, videoSize());
      saveCalibration(state.calib);
      resetShift(); // the shift corrected the old calibration, not this one
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

// Calibration maps camera <-> unshifted projector coords; the "Shift outlines"
// slider moves everything drawn on the projector by noteShiftX. Anything
// converting real projector positions (balls, crosshair, projector edges)
// to/from the camera must go through these.
function camToScreen(calib, p) {
  const [x, y] = camToProj(calib, p);
  return [x + state.settings.noteShiftX, y];
}
function screenToCam(calib, [x, y]) {
  return projToCam(calib, [x - state.settings.noteShiftX, y]);
}
function screenQuadInCamera(calib) {
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map((p) => screenToCam(calib, p));
}

// Raw tracker output is kept so the shift slider can re-publish instantly.
function publishNotes(raw) {
  state.rawNotes = raw;
  const dx = state.settings.noteShiftX;
  const notes = raw.map((n) => ({ ...n, corners: n.corners.map(([x, y]) => [x + dx, y]) }));
  state.proj.notes = notes;
  channel.send('notes', { notes });
  rebuildLanes();
}

// Capsules in projector px ({ a, b, r }) covering where each ball is, or was
// within the camera lag, so a ball can never be detected as a note. Ball
// positions are analytic, so this uses the same formula as the projector.
// Balls only move up and down their lane; the capsule stops above the target
// so it never cuts into the note (see BALL_GAP).
function ballCapsules(now = epochNow()) {
  const { w, h } = state.proj;
  const s = state.settings;
  const rN = ballRadiusN(w, h);
  const gN = ballGapN(w, h);
  const R = BALL_R * refScale(w, h) * s.ballPad;
  const clock = engine.clock();
  const out = [];
  for (const { lane, balls, at } of drawnLanes()) {
    for (const ball of balls) {
      let lo = Infinity;
      let hi = -Infinity;
      const span = s.ballLag + 0.05;
      for (let i = 0; i <= 24; i++) {
        const y = ballY(lane, ball.phase, at(clockPos(clock, now - s.ballLag + (span * i) / 24)), rN, gN);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      const clear = (BALL_GAP * refScale(w, h) + R) / h; // capsule end -> paper
      if (lane.upperId != null) lo = Math.max(lo, lane.ceil + clear);
      hi = Math.min(hi, lane.top - clear);
      hi = Math.max(hi, lo);
      out.push({ a: [lane.x * w, lo * h], b: [lane.x * w, hi * h], r: R });
    }
  }
  return out;
}

// Capsules along the edges of each hit halo (note-coloured light around a note
// would otherwise grow the note or show up as a ring-shaped note). The band
// starts a little outside the note so it never cuts into it.
function haloCapsules(now = epochNow()) {
  const { w, h } = state.proj;
  const sc = refScale(w, h);
  const out = [];
  const lag = state.settings.ballLag;
  const notes = new Map(state.proj.notes.map((n) => [n.id, n]));
  for (const halo of state.halos) {
    const age = now - halo.at;
    const note = notes.get(halo.noteId);
    if (!note || age < -0.05 || age > HALO_MS / 1000 + lag) continue;
    const [lo, hi] = HALO_MASK;
    const pts = inflate(note.corners.map(([x, y]) => [x * w, y * h]), ((lo + hi) / 2) * sc);
    pts.forEach((p, i) => out.push({ a: p, b: pts[(i + 1) % pts.length], r: ((hi - lo) / 2) * sc }));
  }
  return out;
}

// Projector-px capsules -> camera px blockers for the detector.
function toCamBlockers(calib, capsules) {
  const { w, h } = state.proj;
  return capsules.map(({ a, b, r }) => {
    const an = [a[0] / w, a[1] / h];
    const c = screenToCam(calib, an);
    const ex = screenToCam(calib, [an[0] + r / w, an[1]]);
    const ey = screenToCam(calib, [an[0], an[1] + r / h]);
    const rc = Math.max(Math.hypot(ex[0] - c[0], ex[1] - c[1]), Math.hypot(ey[0] - c[0], ey[1] - c[1]));
    return { a: c, b: screenToCam(calib, [b[0] / w, b[1] / h]), r: rc };
  });
}

// Is the middle of a note (tracker coords, before the shift slider) covered by
// a ball's mask capsule? Then its detected shape is not the real outline.
function noteOccludedByBall(corners) {
  const { w, h } = state.proj;
  const dx = state.settings.noteShiftX;
  const c = centroid(corners.map(([x, y]) => [(x + dx) * w, y * h]));
  return ballCapsules().some((cap) => distToSegment(c, cap.a, cap.b) < cap.r);
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
    state.blockers = calib ? toCamBlockers(calib, [...ballCapsules(), ...haloCapsules()]) : [];
    const res = state.detector.process(els.video, w, h, state.settings, {
      maskCanvas: els.mask,
      roi: calib && state.settings.roiOnly ? screenQuadInCamera(calib) : null,
      blockers: state.blockers,
    });
    state.lastDetect = res;
    if (!calib || state.calibrating || els.freezeNotes.checked) return;
    const dets = res.notes
      .map((n) => ({ corners: n.corners.map((p) => camToProj(calib, p)), color: classifyColor(n.rgb, state.palette) }))
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
  drawEchoPanel();
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
    poly(ctx, screenQuadInCamera(state.calib));
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
    for (const n of state.rawNotes) {
      const cam = n.corners.map((p) => projToCam(calib, p));
      poly(ctx, cam);
      ctx.stroke();
      const [cx, cy] = centroid(cam);
      ctx.fillText(`#${n.id} ${n.color || ''}`, cx - 8 * k, cy + 5 * k);
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
    `Sound:      ${soundReady() ? '<span class="ok">on</span>' : '<span class="warn">off</span> - click anywhere on this page to enable'}`,
    `Beat:       ${engine.running ? '<span class="ok">running</span>' : 'stopped'} · ${engine.bpm} BPM · ${engine.lanes.length} lane(s)`,
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

// ---------------------------------------------------------------- note colours
// Teach: pick a colour, then click a detected note (yellow outline) in the feed.
// Its measured average colour becomes that colour's reference.

function buildColorButtons() {
  els.colorButtons.replaceChildren(...NOTE_COLORS.map(({ name }) => {
    const b = document.createElement('button');
    b.dataset.color = name;
    b.innerHTML = `<span class="swatch"></span>${name}`;
    b.addEventListener('click', () => {
      state.teaching = state.teaching === name ? null : name;
      playTone(freqOf(name)); // preview the pitch
      updateColorUI();
    });
    return b;
  }));
  updateColorUI();
}

function updateColorUI() {
  for (const b of els.colorButtons.children) {
    b.querySelector('.swatch').style.background = `rgb(${state.palette[b.dataset.color].join(',')})`;
    b.classList.toggle('active', b.dataset.color === state.teaching);
  }
  els.colorMsg.textContent = state.teaching
    ? `Click the ${state.teaching} note in the camera view.`
    : 'Pick a colour, then click that note in the camera view to teach it. Click a colour to hear its pitch.';
}

function teachColor(p) {
  feedCtx.save();
  const hit = state.lastDetect?.notes.find((n) => {
    poly(feedCtx, n.corners);
    return feedCtx.isPointInPath(p[0], p[1]);
  });
  feedCtx.restore();
  if (!hit) {
    els.colorMsg.textContent = `No detected note there. Click inside a yellow outline (${state.teaching}).`;
    return;
  }
  state.palette[state.teaching] = hit.rgb;
  savePalette(state.palette);
  state.teaching = null;
  updateColorUI();
}

$('resetColors').addEventListener('click', () => {
  state.palette = { ...DEFAULT_PALETTE };
  savePalette(null);
  updateColorUI();
});

// Browsers only allow audio after a user gesture on this page.
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// ---------------------------------------------------------------- boot

async function boot() {
  buildSliders();
  buildPitchButtons();
  sendBeat();
  buildColorButtons();
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
