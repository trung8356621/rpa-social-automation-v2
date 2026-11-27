import sharp from "sharp";
import { LocalOcr } from "../src/main/ocr.ts";
import { findOcrCandidates } from "../src/main/ocr-candidates.ts";

const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";
const { data, info } = await sharp(file)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

// Find blue connected components more carefully — require strong primary blue
const mask = new Uint8Array(info.width * info.height);
for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
  const r = data[p],
    g = data[p + 1],
    b = data[p + 2];
  // Primary action blue ~ rgb(38,87,217) from sample
  if (b >= 190 && r <= 60 && g >= 70 && g <= 120 && b - g >= 90) mask[i] = 1;
}
const visited = new Uint8Array(mask.length);
const boxes = [];
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const idx = y * info.width + x;
    if (!mask[idx] || visited[idx]) continue;
    let minX = x,
      maxX = x,
      minY = y,
      maxY = y,
      count = 0;
    const q = [idx];
    visited[idx] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      count++;
      const cx = cur % info.width,
        cy = (cur / info.width) | 0;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
        const nidx = ny * info.width + nx;
        if (!mask[nidx] || visited[nidx]) continue;
        visited[nidx] = 1;
        q.push(nidx);
      }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (count >= 400 && w >= 50 && h >= 20 && w <= 220 && h <= 70) {
      boxes.push({ minX, minY, maxX, maxY, w, h, count });
    }
  }
}
console.log("boxes", boxes);

const ocr = new LocalOcr();
const selection = { text: "Publish", kind: "line" };
try {
  for (const [i, b] of boxes.entries()) {
    for (const pad of [0, 2, 4, 8]) {
      const left = Math.max(0, b.minX - pad);
      const top = Math.max(0, b.minY - pad);
      const width = Math.min(info.width - left, b.w + 2 * pad);
      const height = Math.min(info.height - top, b.h + 2 * pad);
      const crop = await sharp(file).extract({ left, top, width, height }).png().toBuffer();
      await sharp(crop).toFile(`scratch/publish-ocr-probe/tight-${i}-pad${pad}.png`);
      const result = await ocr.recognize(crop);
      const hits = findOcrCandidates(result, selection).map((h) => ({
        text: h.text,
        conf: h.confidence,
        bbox: {
          x: h.bbox.x + left,
          y: h.bbox.y + top,
          width: h.bbox.width,
          height: h.bbox.height,
        },
      }));
      console.log(JSON.stringify({ i, pad, left, top, width, height, text: result.text, hits }));
    }
  }

  // Also: full frame via LocalOcr then merge synthetic button crops
  const full = await ocr.recognize(await sharp(file).png().toBuffer());
  console.log(
    "full hits",
    findOcrCandidates(full, selection).length,
    "seg",
    full.segments.length,
  );
} finally {
  await ocr.close();
}
