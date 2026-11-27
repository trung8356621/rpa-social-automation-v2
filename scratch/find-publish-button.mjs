import sharp from "sharp";
import { writeFileSync } from "node:fs";

const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";
const { data, info } = await sharp(file)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const blues = [];
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    // Facebook-like primary blue button
    if (b > 180 && r < 80 && g > 80 && g < 160 && b - r > 120) blues.push([x, y]);
  }
}
if (!blues.length) {
  console.log("No blue pixels found with strict filter; relaxing...");
}
let minX = Infinity,
  minY = Infinity,
  maxX = -1,
  maxY = -1;
for (const [x, y] of blues) {
  minX = Math.min(minX, x);
  minY = Math.min(minY, y);
  maxX = Math.max(maxX, x);
  maxY = Math.max(maxY, y);
}
console.log("blue count", blues.length, "bbox", { minX, minY, maxX, maxY });

// Also find saturated blue-ish clusters with looser filter
const loose = [];
for (let y = Math.floor(info.height * 0.5); y < info.height; y++) {
  for (let x = Math.floor(info.width * 0.4); x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    if (b > 150 && b > r + 40 && b > g + 20 && r < 120) loose.push([x, y, r, g, b]);
  }
}
let lminX = Infinity,
  lminY = Infinity,
  lmaxX = -1,
  lmaxY = -1;
for (const [x, y] of loose) {
  lminX = Math.min(lminX, x);
  lminY = Math.min(lminY, y);
  lmaxX = Math.max(lmaxX, x);
  lmaxY = Math.max(lmaxY, y);
}
console.log("loose count", loose.length, "bbox", { lminX, lminY, lmaxX, lmaxY });
if (loose[0]) console.log("sample", loose[Math.floor(loose.length / 2)]);

// Dump a strip of bottom-right colors
const samples = [];
for (let y = 440; y < 540; y += 10)
  for (let x = 600; x < 820; x += 20) {
    const i = (y * info.width + x) * 4;
    samples.push({ x, y, rgb: [data[i], data[i + 1], data[i + 2]] });
  }
writeFileSync("scratch/publish-ocr-probe/color-samples.json", JSON.stringify({ blues: blues.length, loose: loose.length, bbox: { minX, minY, maxX, maxY }, looseBBox: { lminX, lminY, lmaxX, lmaxY }, samples }, null, 2));
console.log("wrote color-samples.json");

// Extract candidate button if found
if (loose.length > 100) {
  const pad = 8;
  const left = Math.max(0, lminX - pad);
  const top = Math.max(0, lminY - pad);
  const width = Math.min(info.width - left, lmaxX - lminX + 2 * pad);
  const height = Math.min(info.height - top, lmaxY - lminY + 2 * pad);
  await sharp(file)
    .extract({ left, top, width, height })
    .png()
    .toFile("scratch/publish-ocr-probe/detected-button.png");
  console.log("extracted", { left, top, width, height });
}
