// Tiny BroadcastChannel wrapper shared by control.html and projector.html.
// Both pages must be served from the same origin (e.g. http://localhost:8000).
//
// Coordinates on the wire are always "projector-normalized": x, y in [0, 1]
// relative to the projector window's width/height.
//
// control -> projector
//   notes   { notes: [{ id, corners: [[x,y] x4], color }] }   color: see colors.js
//   calib   { on: bool }                 show border + numbered corner dots
//   cross   { pt: [x,y] | null }         calibration test crosshair
//   cmd     { cmd: 'start'|'pause'|'toggleRun'|'resetBall'|'addBall'|'clearBalls'
//                  |'toggleGravity'|'toggleOutlines'|'toggleMode'
//                  |'action' }       action = Space: drop (drop mode) / pause (bounce)
//   steer   { dir: -1|0|1 }              move the waiting ball (drop mode)
//   config  { ballRadius, ballSpeed }    radius: fraction of min(w,h); speed: widths/s
//   ping    {}                           asks the projector to say hello
//
// projector -> control
//   hello   { w, h }                     projector window size in CSS px
//   balls   { balls: [{x,y,rx,ry,vx,vy,held}], t, running, gravity, outlines, mode }
//           ~10 Hz; rx/ry = radius / width|height, vx/vy per second
//   hit     { id, color, strength }      a ball hit a note (strength 0..1)

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
