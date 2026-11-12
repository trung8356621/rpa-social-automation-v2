import type { Rect } from "../contracts.js";

/** Content band used to detect modal scroll (exclude chrome / far sides). */
export function defaultScrollCompareRoi(width: number, height: number): Rect {
  const w = Math.max(4, Math.round(width));
  const h = Math.max(4, Math.round(height));
  const x = Math.round(w * 0.22);
  const y = Math.round(h * 0.12);
  return {
    x,
    y,
    width: Math.max(4, Math.round(w * 0.56)),
    height: Math.max(4, Math.round(h * 0.7)),
  };
}

/**
 * Mean absolute difference of grayscale luma in ROI between two RGBA buffers.
 * Higher = more visual change. Threshold ~8–12 typically separates still vs scrolled FB UI.
 */
export function measureVisualMotionScore(
  prev: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  next: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  roi?: Rect,
): { score: number; sampleCount: number; roi: Rect } {
  const w = Math.min(prev.width, next.width);
  const h = Math.min(prev.height, next.height);
  const region = roi && roi.width > 0 && roi.height > 0 ? roi : defaultScrollCompareRoi(w, h);
  const x0 = Math.max(0, Math.min(w - 1, Math.round(region.x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(region.y)));
  const x1 = Math.max(x0 + 1, Math.min(w, x0 + Math.round(region.width)));
  const y1 = Math.max(y0 + 1, Math.min(h, y0 + Math.round(region.height)));
  // Subsample for speed (every 2nd pixel).
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * prev.width + x) * 4;
      const j = (y * next.width + x) * 4;
      const lp = 0.299 * prev.data[i]! + 0.587 * prev.data[i + 1]! + 0.114 * prev.data[i + 2]!;
      const ln = 0.299 * next.data[j]! + 0.587 * next.data[j + 1]! + 0.114 * next.data[j + 2]!;
      sum += Math.abs(lp - ln);
      count += 1;
    }
  }
  return {
    score: count ? Math.round((sum / count) * 1000) / 1000 : 0,
    sampleCount: count,
    roi: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  };
}

/** Visual scroll confirmed when content-band MAD exceeds threshold (not whole-viewport flicker). */
export function isVisualScrollConfirmed(score: number, threshold = 6.5): boolean {
  return Number.isFinite(score) && score >= threshold;
}

/**
 * Infer modal/card left-right edges from a grayscale column-energy profile.
 * Looks for bright card vs darker backdrop; returns null when edges are unclear.
 */
export function inferHorizontalCardBounds(
  grayColumns: Float64Array | number[],
  opts?: { minWidthRatio?: number; maxWidthRatio?: number; edgeDrop?: number },
): { left: number; right: number; confidence: number } | null {
  const n = grayColumns.length;
  if (n < 32) return null;
  const minW = Math.round(n * (opts?.minWidthRatio ?? 0.28));
  const maxW = Math.round(n * (opts?.maxWidthRatio ?? 0.78));
  const edgeDrop = opts?.edgeDrop ?? 18;

  // Smooth 5-tap.
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += Number(grayColumns[j]);
      c += 1;
    }
    smooth[i] = s / c;
  }

  const mid = Math.floor(n / 2);
  const centerMean =
    (smooth[mid - 1]! + smooth[mid]! + smooth[mid + 1]!) / 3;
  // Walk outward from center until brightness drops (backdrop).
  let left = mid;
  while (left > 4 && centerMean - smooth[left]! < edgeDrop) left -= 1;
  let right = mid;
  while (right < n - 5 && centerMean - smooth[right]! < edgeDrop) right += 1;

  const width = right - left;
  if (width < minW || width > maxW) return null;
  // Require a real drop near edges vs center.
  const leftDrop = centerMean - smooth[Math.max(0, left)]!;
  const rightDrop = centerMean - smooth[Math.min(n - 1, right)]!;
  if (leftDrop < edgeDrop * 0.5 || rightDrop < edgeDrop * 0.5) return null;

  const confidence = Math.min(1, (leftDrop + rightDrop) / (edgeDrop * 4));
  return { left, right, confidence: Math.round(confidence * 1000) / 1000 };
}
