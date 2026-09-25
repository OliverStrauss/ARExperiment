// Vision pipeline (OpenCV.js). Every cv.Mat allocated per call is deleted before
// returning; long-lived Mats are cached on the Detector and reused.
//
// All coordinates going in and out are in *source* pixels (video.videoWidth x
// video.videoHeight). Internally the frame is downscaled to params.procWidth
// for speed and results are scaled back up.

const V_FLOOR = 25; // adaptive mode: below this the camera is just noise
const BG_W = 96; // wall-colour estimate is computed at this width...
const BG_K = 41; // ...with this median kernel (~40% of the frame width)

export class Detector {
  constructor(cv) {
    this.cv = cv;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.cache = {}; // long-lived Mats keyed by purpose
    this.cacheKey = {};
  }

  // Returns a cached Mat of the given size/type filled with `vals`, rebuilding
  // it only if the size or values changed.
  _const(name, rows, cols, type, vals) {
    const cv = this.cv;
    const key = `${rows}x${cols}:${type}:${vals.join(',')}`;
    if (this.cacheKey[name] !== key) {
      this.cache[name]?.delete();
      this.cache[name] = new cv.Mat(rows, cols, type, new cv.Scalar(...vals));
      this.cacheKey[name] = key;
    }
    return this.cache[name];
  }

  // Lighting-tolerant "is this pixel more colourful than the wall around it".
  // Estimates the wall colour as a heavy median blur of the a/b (Lab) channels on a
  // tiny copy of the frame (notes are small, so the median ignores them), then keeps
  // pixels whose chroma differs from that by > thresh. Lab a/b barely change with
  // brightness, and subtracting the local wall removes gradients and colour casts.
  _chromaMask(rgb, pw, ph, thresh, track) {
    const cv = this.cv;
    const lab = track(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const small = track(new cv.Mat());
    cv.resize(lab, small, new cv.Size(BG_W, Math.max(1, Math.round((BG_W * ph) / pw))), 0, 0, cv.INTER_AREA);
    cv.medianBlur(small, small, BG_K);
    const bg = track(new cv.Mat());
    cv.resize(small, bg, new cv.Size(pw, ph), 0, 0, cv.INTER_LINEAR);
    const diff = track(new cv.Mat());
    cv.absdiff(lab, bg, diff);
    const ch = track(new cv.MatVector());
    cv.split(diff, ch);
    const sum = track(new cv.Mat());
    cv.add(track(ch.get(1)), track(ch.get(2)), sum); // |da| + |db| (get() returns a new Mat: must be deleted)
    const out = track(new cv.Mat());
    cv.threshold(sum, out, thresh, 255, cv.THRESH_BINARY);
    return out;
  }

  /**
   * @param source   <video> or <canvas> to read from
   * @param srcW/srcH source pixel size
   * @param params   settings (see settings.js)
   * @param opts.maskCanvas  optional canvas to draw the cleaned mask into
   * @param opts.roi         optional [[x,y] x4] (source px): keep only this quad
   * @param opts.blockers    optional [{a:[x,y], b:[x,y], r}] capsules (source px)
   *                         painted black before cleanup (used for the ball)
   */
  process(source, srcW, srcH, params, opts = {}) {
    const cv = this.cv;
    const t0 = performance.now();
    const scale = Math.min(1, params.procWidth / srcW);
    const pw = Math.max(1, Math.round(srcW * scale));
    const ph = Math.max(1, Math.round(srcH * scale));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.ctx.drawImage(source, 0, 0, pw, ph);
    const img = this.ctx.getImageData(0, 0, pw, ph);

    const mats = [];
    const track = (m) => { mats.push(m); return m; };
    try {
      const rgba = track(cv.matFromImageData(img));
      const rgb = track(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      const hsv = track(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

      // --- HSV threshold. hMin > hMax means "wrap around" (for reds).
      // With localChroma on, absolute S/V floors are dropped (they are what
      // breaks under shadow / dim light) and the local-chroma test below takes over.
      const adaptive = params.localChroma > 0;
      const sMin = adaptive ? 0 : params.sMin;
      const vMin = adaptive ? V_FLOOR : params.vMin;
      const mask = track(new cv.Mat());
      const T = cv.CV_8UC3;
      if (params.hMin <= params.hMax) {
        const lo = this._const('lo', ph, pw, T, [params.hMin, sMin, vMin, 0]);
        const hi = this._const('hi', ph, pw, T, [params.hMax, params.sMax, params.vMax, 0]);
        cv.inRange(hsv, lo, hi, mask);
      } else {
        const lo1 = this._const('lo', ph, pw, T, [params.hMin, sMin, vMin, 0]);
        const hi1 = this._const('hi', ph, pw, T, [179, params.sMax, params.vMax, 0]);
        const lo2 = this._const('lo2', ph, pw, T, [0, sMin, vMin, 0]);
        const hi2 = this._const('hi2', ph, pw, T, [params.hMax, params.sMax, params.vMax, 0]);
        const m2 = track(new cv.Mat());
        cv.inRange(hsv, lo1, hi1, mask);
        cv.inRange(hsv, lo2, hi2, m2);
        cv.bitwise_or(mask, m2, mask);
      }

      if (adaptive) cv.bitwise_and(mask, this._chromaMask(rgb, pw, ph, params.localChroma, track), mask);

      // --- Region of interest (projected area) and blockers (the ball).
      if (opts.roi) {
        const roiMask = track(cv.Mat.zeros(ph, pw, cv.CV_8UC1));
        const flat = opts.roi.flatMap(([x, y]) => [Math.round(x * scale), Math.round(y * scale)]);
        const poly = track(cv.matFromArray(4, 1, cv.CV_32SC2, flat));
        const polys = track(new cv.MatVector());
        polys.push_back(poly);
        cv.fillPoly(roiMask, polys, new cv.Scalar(255));
        cv.bitwise_and(mask, roiMask, mask);
      }
      for (const b of opts.blockers || []) {
        const a = new cv.Point(Math.round(b.a[0] * scale), Math.round(b.a[1] * scale));
        const c = new cv.Point(Math.round(b.b[0] * scale), Math.round(b.b[1] * scale));
        const r = Math.max(1, Math.round(b.r * scale));
        cv.circle(mask, a, r, new cv.Scalar(0), -1);
        cv.circle(mask, c, r, new cv.Scalar(0), -1);
        cv.line(mask, a, c, new cv.Scalar(0), 2 * r);
      }

      // --- Morphology: open removes speckles, close fills small holes.
      const k = Math.max(1, Math.round(params.morph * scale) | 1);
      if (k > 1) {
        const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
        cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
        cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
      }

      if (opts.maskCanvas) cv.imshow(opts.maskCanvas, mask);

      // --- Contours -> filtered minimum-area rectangles.
      const contours = track(new cv.MatVector());
      const hierarchy = track(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const frameArea = pw * ph;
      const minA = (params.minArea / 100) * frameArea;
      const maxA = (params.maxArea / 100) * frameArea;
      const notes = [];
      const rejected = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        try {
          const area = cv.contourArea(c);
          if (area < minA * 0.25) continue; // specks: not even worth showing
          const rr = cv.minAreaRect(c);
          const corners = cv.RotatedRect.points(rr).map((p) => [p.x / scale, p.y / scale]);
          const rectArea = rr.size.width * rr.size.height;
          const rectangularity = rectArea > 0 ? area / rectArea : 0;
          let reason = null;
          if (area < minA) reason = 'small';
          else if (area > maxA) reason = 'large';
          else if (rectangularity < params.minRect) reason = 'shape';
          if (reason) {
            if (rejected.length < 50) rejected.push({ corners, reason });
          } else {
            notes.push({ corners, area: area / (scale * scale), rectangularity, rgb: this._meanRgb(rgb, contours, hierarchy, i, c) });
          }
        } finally {
          c.delete();
        }
      }

      return { notes, rejected, ms: performance.now() - t0, procSize: [pw, ph] };
    } finally {
      mats.forEach((m) => m.delete());
    }
  }

  // Average colour [r, g, b] of the pixels inside contour i.
  _meanRgb(rgb, contours, hierarchy, i, contour) {
    const cv = this.cv;
    const rect = cv.boundingRect(contour);
    const roi = rgb.roi(rect);
    const m = cv.Mat.zeros(rect.height, rect.width, cv.CV_8UC1);
    try {
      cv.drawContours(m, contours, i, new cv.Scalar(255), -1, cv.LINE_8, hierarchy, 0, new cv.Point(-rect.x, -rect.y));
      return cv.mean(roi, m).slice(0, 3).map(Math.round);
    } finally {
      roi.delete();
      m.delete();
    }
  }

  dispose() {
    Object.values(this.cache).forEach((m) => m.delete());
    this.cache = {};
    this.cacheKey = {};
  }
}
