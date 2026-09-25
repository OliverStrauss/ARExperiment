// Tiny BroadcastChannel wrapper shared by control.html and projector.html.
// Both pages must be served from the same origin (e.g. http://localhost:8000).
//
// Coordinates on the wire are always "projector-normalized": x, y in [0, 1]
// relative to the projector window's width/height.
//
// Times are seconds on the epoch clock both windows share:
// (performance.timeOrigin + performance.now()) / 1000 (see beat.js epochNow).
//
// control -> projector
//   notes   { notes: [{ id, corners: [[x,y] x4], color }] }   color: see colors.js
//   calib   { on: bool }                 show border + numbered corner dots
//   cross   { pt: [x,y] | null }         calibration test crosshair
//   ping    {}                           asks the projector to say hello
//   beat    { clock: { running, bpm, anchor, pos0 }, bpm, snap,
//             lanes: [{ ...buildLanes() lane (see lanes.js), balls: [{ id, phase }] }],
//             instruments: { noteId: instrument }, highlight, focus, mutes: [colours],
//             solo, overlay, outlines, echoBars }
//           On every change + 1 s keep-alive. pos (16ths) = clockPos(clock, now);
//           ball phases are in 16ths (see beat.js).
//   echo    { bars, playheadStep, rows: [{ pitch, color, hits: [{ step, v, kept }] }] }  ~4 Hz
//   ring    { open: true, noteId, choices, index, deadline, timeout } | { open: false }
//   toast   { key, text }                shown for 1 s
//   hitFx   { noteId, color, at }        sent when scheduled (~100 ms early);
//                                        the halo starts at `at`
//
// projector -> control
//   hello   { w, h }                     projector window size in CSS px
//   key     { key, code, shift, repeat } forwarded key presses (see keys.js)
//   click   { x, y }                     mouse click on the wall, normalized

export const CHANNEL_NAME = 'sticky-wall';

export function createChannel(role, onMessage) {
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.from === role) return;
    onMessage(msg);
  };
  return {
    send(type, payload = {}) {
      bc.postMessage({ type, from: role, ...payload });
    },
    close() {
      bc.close();
    },
  };
}
