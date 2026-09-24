// Camera -> projector calibration.
//
// The projector shows 4 dots at CALIB_DOTS (projector-normalized). The user
// clicks them in the camera feed; getPerspectiveTransform gives H mapping
// camera pixels to projector-normalized coordinates, and Hinv the reverse.

import { CALIB_DOTS } from './render.js';
import { invertH, isConvexQuad, applyH } from './homography.js';

export { CALIB_DOTS };

/**
 * @param cv       OpenCV module
 * @param camPts   4 clicked points in camera px, in dot order 1..4
 * @param camSize  [videoWidth, videoHeight] the points were clicked at
 */
export function computeCalibration(cv, camPts, camSize) {
  if (camPts.length !== 4) throw new Error('Need exactly 4 points');
  if (!isConvexQuad(camPts)) {
    throw new Error('The 4 points do not form a convex shape - check they were clicked in order 1, 2, 3, 4');
  }
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, camPts.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, CALIB_DOTS.flat());
  let M;
  try {
    M = cv.getPerspectiveTransform(src, dst);
    const H = Array.from(M.data64F);
    return {
      camPts: camPts.map((p) => [...p]),
      camSize: [...camSize],
      H,
      Hinv: invertH(H),
      created: new Date().toISOString(),
    };
  } finally {
    src.delete();
    dst.delete();
    M?.delete();
  }
}

export function camToProj(calib, p) {
  return applyH(calib.H, p);
}

export function projToCam(calib, p) {
  return applyH(calib.Hinv, p);
}

// Outline of the whole projected image in camera px (for overlays / ROI).
export function projectionQuadInCamera(calib) {
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map((p) => projToCam(calib, p));
}

/**
 * Refine a click to the centre of the bright calibration dot near it.
 * Looks in a window around the click, thresholds at 60% between the local min
 * and max brightness, flood-fills the bright blob nearest the click and returns
 * its centroid. Returns null if nothing dot-like is found (then the raw click
 * is used).
 *
 * @param imageData  ImageData of the window
 * @param ox, oy     position of the window's top-left in camera px
 * @param click      [x,y] in camera px
 * @param maxBlob    reject blobs larger than this many pixels (e.g. the border)
 */
export function snapToDot(imageData, ox, oy, click, maxBlob) {
  const { width: w, height: h, data } = imageData;
  const lum = new Float32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < w * h; i++) {
    const v = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    lum[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 40) return null; // no contrast: nothing bright here
  const thr = lo + (hi - lo) * 0.6;

  // bright pixel nearest to the click
  const cx = click[0] - ox;
  const cy = click[1] - oy;
  let seed = -1;
  let best = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] < thr) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < best) {
        best = d;
        seed = y * w + x;
      }
    }
  }
  if (seed < 0) return null;

  // flood fill (4-connected)
  const seen = new Uint8Array(w * h);
  const stack = [seed];
  seen[seed] = 1;
  let n = 0;
  let count = 0;
  let sx = 0;
  let sy = 0;
  let touchesEdge = false;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    if (++count > maxBlob) return null; // too big: that's the border, not a dot
    const wt = lum[i] - thr + 1;
    sx += (x + 0.5) * wt; // +0.5: pixel centre
    sy += (y + 0.5) * wt;
    n += wt;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
    const nb = [i - 1, i + 1, i - w, i + w];
    for (const j of nb) {
      if (j < 0 || j >= w * h || seen[j]) continue;
      if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
      if (lum[j] >= thr) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  if (touchesEdge || count < 3) return null;
  return [ox + sx / n, oy + sy / n];
}
