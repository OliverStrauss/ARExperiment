// Tiny BroadcastChannel wrapper shared by control.html and projector.html.
// Both pages must be served from the same origin (e.g. http://localhost:8000).
//
// Coordinates on the wire are always "projector-normalized": x, y in [0, 1]
// relative to the projector window's width/height.
//
// control -> projector
//   notes   { notes: [{ id, corners: [[x,y] x4] }] }
//   calib   { on: bool }                 show border + numbered corner dots
//   cross   { pt: [x,y] | null }         calibration test crosshair
//   cmd     { cmd: 'start'|'pause'|'toggleRun'|'resetBall'|'addBall'|'clearBalls' }
//   config  { gravity, outlines, ballRadius, ballSpeed }
//   ping    {}                           asks the projector to say hello
//
// projector -> control
//   hello   { w, h }                     projector window size in CSS px
//   balls   { balls: [{x,y,rx,ry,vx,vy}], t, running }  ~10 Hz heartbeat

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
