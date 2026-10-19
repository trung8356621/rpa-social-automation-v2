import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";
// Bounded local RGB template search. OCR is a separate resolver; no DOM or AI.
export async function matchTemplate(
  screenshot: Buffer,
  template: Buffer,
  roi: Rect,
) {
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
  return { ...best, ambiguous, x: best.x + tw / 2, y: best.y + th / 2 };
}
