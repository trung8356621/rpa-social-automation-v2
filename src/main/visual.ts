import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";
export type ImageSearchTrace = {
  stage: "local" | "viewport";
  searchRegion: Rect;
  score: number;
  secondScore: number;
  x: number;
  y: number;
  ambiguous: boolean;
  complete: boolean;
  elapsedMs: number;
  positions: number;
  reason: string;
};
// Bounded RGB template search. OCR is a separate resolver; no DOM or AI.
export async function matchTemplate(
  screenshot: Buffer,
  template: Buffer,
  roi: Rect,
  options: { expand?: boolean; threshold?: number; onSearch?: (event: ImageSearchTrace) => void } = {},
) {
  const started = performance.now();
  const frame = await sharp(screenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const target = await sharp(template)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = frame.info;
  const tw = target.info.width,
    th = target.info.height;
  if (tw !== roi.width || th !== roi.height || tw > w || th > h)
    throw new Error("Kích thước target không khớp ROI.");
  const mins = [255, 255, 255],
    maxs = [0, 0, 0];
  for (let i = 0; i < target.data.length; i++) {
    const ch = i % 3;
    mins[ch] = Math.min(mins[ch], target.data[i]);
    maxs[ch] = Math.max(maxs[ch], target.data[i]);
  }
  if (Math.max(...maxs.map((v, ch) => v - mins[ch])) < 25)
    throw new Error("Target ít chi tiết; crop lại gồm nhãn/icon và biên.");
  function score(x: number, y: number) {
    let diff = 0,
      n = 0;
    const stride = Math.max(1, Math.floor(Math.sqrt((tw * th) / 1500)));
    for (let ty = 0; ty < th; ty += stride)
      for (let tx = 0; tx < tw; tx += stride)
        for (let ch = 0; ch < 3; ch++) {
          diff += Math.abs(
            frame.data[((y + ty) * w + x + tx) * c + ch] -
              target.data[(ty * tw + tx) * 3 + ch],
          );
          n++;
        }
    return 1 - diff / (n * 255);
  }
  const left = Math.max(0, roi.x - 64),
    right = Math.min(w - tw, roi.x + 64),
    top = Math.max(0, roi.y - 64),
    bottom = Math.min(h - th, roi.y + 64);
  let best = { score: -1, x: roi.x, y: roi.y };
  const candidates: (typeof best)[] = [];
  const consider = (x: number, y: number) => {
    const value = score(x, y);
    if (value > best.score) best = { score: value, x, y };
  };
  consider(roi.x, roi.y);
  for (let y = top; y <= bottom; y += 4)
    for (let x = left; x <= right; x += 4) {
      const value = score(x, y);
      candidates.push({ score: value, x, y });
      if (value > best.score) best = { score: value, x, y };
    }
  const coarse = { ...best };
  for (
    let y = Math.max(top, coarse.y - 4);
    y <= Math.min(bottom, coarse.y + 4);
    y++
  )
    for (
      let x = Math.max(left, coarse.x - 4);
      x <= Math.min(right, coarse.x + 4);
      x++
    )
      consider(x, y);
  const alternative = candidates
    .sort((a, b) => b.score - a.score)
    .find(
      (item) =>
        Math.abs(item.x - best.x) > Math.max(8, tw * 0.65) ||
        Math.abs(item.y - best.y) > Math.max(8, th * 0.65),
    );
  let secondScore = -1;
  if (alternative)
    for (
      let y = Math.max(top, alternative.y - 4);
      y <= Math.min(bottom, alternative.y + 4);
      y++
    )
      for (
        let x = Math.max(left, alternative.x - 4);
        x <= Math.min(right, alternative.x + 4);
        x++
      )
        secondScore = Math.max(secondScore, score(x, y));
  const ambiguous =
    secondScore >= 0.96 ||
    (secondScore >= 0.94 && best.score - secondScore < 0.015);
  const local = { ...best, ambiguous, x: best.x + tw / 2, y: best.y + th / 2 };
  const threshold = Math.max(0.96, options.threshold ?? 0.96);
  options.onSearch?.({ stage: "local", searchRegion: {
    x: left, y: top, width: right-left+tw, height: bottom-top+th,
  }, ...local, secondScore, complete: true, elapsedMs: performance.now()-started,
    positions: candidates.length, reason: ambiguous ? "AMBIGUOUS" : best.score >= threshold ? "MATCHED" : "LOW_SCORE" });
  if (!options.expand || ambiguous || local.score >= threshold) return local;

  // Search every possible top-left position: a coarse pixel grid can miss a small
  // icon between grid points. Reuse the local score's sampling and threshold.
  // Visit distinctive template pixels first and reject only when accumulated RGB
  // error already exceeds the full score budget (no approximate prefilter).
  const stride = Math.max(1, Math.floor(Math.sqrt((tw * th) / 1500)));
  const samples: { offset: number; r: number; g: number; b: number; contrast: number }[] = [];
  const mean = [0, 0, 0];
  for (let ty = 0; ty < th; ty += stride)
    for (let tx = 0; tx < tw; tx += stride) {
      const index = (ty*tw+tx)*3;
      const [r,g,b] = target.data.subarray(index,index+3);
      samples.push({ offset: (ty*w+tx)*c, r, g, b, contrast: 0 });
      mean[0] += r; mean[1] += g; mean[2] += b;
    }
  for (let ch = 0; ch < 3; ch++) mean[ch] /= samples.length;
  for (const sample of samples)
    sample.contrast = Math.abs(sample.r-mean[0])+Math.abs(sample.g-mean[1])+Math.abs(sample.b-mean[2]);
  samples.sort((a,b) => b.contrast-a.contrast);
  const denominator = samples.length*3*255;
  // Include all scores relevant to the existing ambiguity check, not just matches.
  const maxDiff = (1-0.94)*denominator;
  const deadline = performance.now()+2000;
  const viewportCandidates: { score: number; x: number; y: number }[] = [];
  let positions = 0;
  let reason = "NOT_FOUND";
  let complete = true;
  best = { score: local.score, x: local.x-tw/2, y: local.y-th/2 };
  scan: for (let y = 0; y <= h-th; y++) {
    if (y % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    for (let x = 0; x <= w-tw; x++) {
      if (positions % 256 === 0 && performance.now() >= deadline) {
        complete = false; reason = "IMAGE_SEARCH_TIME_LIMIT"; break scan;
      }
      positions++;
      const base = (y*w+x)*c;
      let diff = 0;
      for (const sample of samples) {
        const index = base+sample.offset;
        diff += Math.abs(frame.data[index]-sample.r)+Math.abs(frame.data[index+1]-sample.g)+Math.abs(frame.data[index+2]-sample.b);
        if (diff > maxDiff) break;
      }
      if (diff > maxDiff) continue;
      const candidate = { score: 1-diff/denominator, x, y };
      if (candidate.score > best.score) best = candidate;
      viewportCandidates.push(candidate);
      if (viewportCandidates.length > 8192) {
        complete = false; reason = "IMAGE_SEARCH_CANDIDATE_LIMIT"; break scan;
      }
    }
  }
  secondScore = viewportCandidates.reduce((second,item) =>
    Math.abs(item.x-best.x) > Math.max(8,tw*0.65) || Math.abs(item.y-best.y) > Math.max(8,th*0.65)
      ? Math.max(second,item.score) : second, -1);
  const viewportAmbiguous = secondScore >= 0.96 || (secondScore >= 0.94 && best.score-secondScore < 0.015);
  const result = { ...best, ambiguous: viewportAmbiguous, x: best.x+tw/2, y: best.y+th/2 };
  if (complete) reason = viewportAmbiguous ? "AMBIGUOUS" : best.score >= threshold ? "MATCHED" : "LOW_SCORE";
  options.onSearch?.({ stage: "viewport", searchRegion: { x: 0, y: 0, width: w, height: h },
    ...result, secondScore, complete, elapsedMs: performance.now()-started, positions, reason });
  // Never accept a partial scan: a duplicate might be in the unvisited region.
  if (!complete) throw new Error(`${reason}: chưa xác minh duy nhất toàn viewport; không gửi action.`);
  return result;
}
