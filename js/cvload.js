// Resolves once vendor/opencv.js (loaded with a classic <script async>) has
// finished compiling its WebAssembly. Handles both build flavours: `cv` being a
// Promise, or a Module object that fires onRuntimeInitialized.
//
// Note: the Emscripten Module is a thenable whose then() hands back the Module
// itself, so awaiting or resolving with it recurses forever. We strip `then`
// before handing it to a Promise.

let readyPromise = null;

export function cvReady() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const c = window.cv;
      if (!c) {
        if (Date.now() - started > 30000) reject(new Error('opencv.js did not load'));
        else setTimeout(poll, 50);
        return;
      }
      const done = (mod) => {
        if (typeof mod.then === 'function') delete mod.then;
        window.cv = mod;
        resolve(mod);
      };
      if (c instanceof Promise) {
        c.then(done, reject);
      } else if (c.Mat) {
        done(c);
      } else {
        const prev = c.onRuntimeInitialized;
        c.onRuntimeInitialized = () => { prev?.(); done(c); };
      }
    };
    poll();
  });
  return readyPromise;
}
