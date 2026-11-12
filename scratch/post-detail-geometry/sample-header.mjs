import sharp from "sharp";
import fs from "fs";

const { data, info } = await sharp("artifacts/post-detail-geometry/pdc-1366x768-sidebar-open.png")
  .raw()
  .ensureAlpha()
  .toBuffer({ resolveWithObject: true });

function sample(x, y) {
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function isBrowserBlack([r, g, b]) {
  return r <= 8 && g <= 14 && b <= 12 && g - r <= 8;
}

const rows = [50, 80, 90, 100, 120, 150, 180, 200, 220, 250, 260, 267, 270, 280];
const out = {};
for (const y of rows) {
  let first = null;
  let last = null;
  for (let x = 0; x < info.width; x++) {
    if (isBrowserBlack(sample(x, y))) {
      if (first == null) first = x;
      last = x;
    }
  }
  out[y] = {
    first,
    last,
    width: first != null ? last - first + 1 : 0,
    at150: sample(150, y),
    at225: sample(225, y),
    at320: sample(320, y),
    at500: sample(500, y),
  };
}

fs.writeFileSync("scratch/post-detail-geometry/pixel-header-scan.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
