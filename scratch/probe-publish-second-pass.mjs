import sharp from "sharp";
import { readFileSync } from "node:fs";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";
const frame = readFileSync(file);

const langPath = path.resolve(".local/ocr-models");
await mkdir(langPath, { recursive: true });
await Promise.all(
  ["vie", "eng"].map((code) =>
    copyFile(
      path.join(
        path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)),
        "4.0.0_best_int",
        `${code}.traineddata.gz`,
      ),
      path.join(langPath, `${code}.traineddata.gz`),
    ),
  ),
);

async function ocr(buf, psm, label, scale = 2) {
  const meta = await sharp(buf).metadata();
  const pixels = await sharp(buf)
    .flatten({ background: "white" })
    .resize(meta.width * scale, meta.height * scale)
    .grayscale()
    .png()
    .toBuffer();
  const neg = await sharp(buf)
    .flatten({ background: "white" })
    .resize(meta.width * scale, meta.height * scale)
    .grayscale()
    .negate({ alpha: false })
    .png()
    .toBuffer();
  const worker = await createWorker("vie+eng", OEM.LSTM_ONLY, {
    langPath,
    gzip: true,
    workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
    cacheMethod: "none",
    errorHandler: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    user_defined_dpi: String(72 * scale),
  });
  for (const [name, img] of [
    ["gray", pixels],
    ["neg", neg],
  ]) {
    const { data } = await worker.recognize(img, {}, { text: true });
    const text = (data.text || "").replace(/\s+/g, " ").trim();
    const has = /publish/i.test(text);
    console.log(JSON.stringify({ label, variant: name, psm, has, text: text.slice(0, 120), conf: data.confidence }));
  }
  await worker.terminate();
}

// 1) bottom band of viewport
const bottom = await sharp(frame).extract({ left: 0, top: 420, width: 1024, height: 140 }).png().toBuffer();
await ocr(bottom, PSM.SPARSE_TEXT, "bottom_band_sparse");
await ocr(bottom, PSM.SINGLE_BLOCK, "bottom_band_block");

// 2) modal footer estimated
const footer = await sharp(frame).extract({ left: 220, top: 470, width: 560, height: 60 }).png().toBuffer();
await ocr(footer, PSM.SPARSE_TEXT, "modal_footer_sparse");
await ocr(footer, PSM.SINGLE_BLOCK, "modal_footer_block");
await ocr(footer, PSM.SINGLE_LINE, "modal_footer_line");

// 3) Find blue blobs via chroma and OCR each
const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const mask = new Uint8Array(info.width * info.height);
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    if (b > 160 && r < 100 && g < 140 && b - r > 100) mask[y * info.width + x] = 1;
  }
}
// connected components bounding boxes (4-connected flood), keep medium boxes
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
    const stack = [[x, y]];
    visited[idx] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      count++;
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
        stack.push([nx, ny]);
      }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (count > 200 && w > 40 && h > 16 && w < 300 && h < 80) boxes.push({ minX, minY, maxX, maxY, w, h, count });
  }
}
console.log(
  "blue boxes",
  boxes.map((b) => ({ ...b })),
);
for (const [i, b] of boxes.entries()) {
  const pad = 6;
  const left = Math.max(0, b.minX - pad);
  const top = Math.max(0, b.minY - pad);
  const width = Math.min(info.width - left, b.w + 2 * pad);
  const height = Math.min(info.height - top, b.h + 2 * pad);
  const crop = await sharp(frame).extract({ left, top, width, height }).png().toBuffer();
  await sharp(crop).toFile(`scratch/publish-ocr-probe/blob-${i}.png`);
  await ocr(crop, PSM.SPARSE_TEXT, `blob${i}_sparse`);
  await ocr(crop, PSM.SINGLE_BLOCK, `blob${i}_block`);
}
