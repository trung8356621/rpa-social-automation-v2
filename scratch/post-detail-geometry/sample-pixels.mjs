import sharp from "sharp";
import fs from "fs";

const path = "artifacts/post-detail-geometry/pdc-1366x768-sidebar-open.png";
const img = sharp(path);
const meta = await img.metadata();
const { data, info } = await img.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

function sample(x, y) {
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function isBrowserBlack([r, g, b]) {
  // Facebook blank / chromium surface (~5,10,8) — not PDC green (~11,26,20) or sidebar blue (~17,31,48)
  return r <= 8 && g <= 14 && b <= 12 && g - r <= 8;
}

function isSidebarBlue([r, g, b]) {
  return b > r + 10 && b > g;
}

function isPdcGreen([r, g, b]) {
  return g > r + 5 && g > b && g >= 18;
}

const rows = [280, 400, 500, 600];
const analysis = {};
for (const y of rows) {
  let firstBrowser = null;
  let lastBrowser = null;
  let firstSidebar = null;
  let lastSidebar = null;
  for (let x = 0; x < info.width; x++) {
    const c = sample(x, y);
    if (isBrowserBlack(c)) {
      if (firstBrowser == null) firstBrowser = x;
      lastBrowser = x;
    }
    if (isSidebarBlue(c)) {
      if (firstSidebar == null) firstSidebar = x;
      lastSidebar = x;
    }
  }
  analysis[y] = {
    firstBrowser,
    lastBrowser,
    browserWidth: firstBrowser != null && lastBrowser != null ? lastBrowser - firstBrowser + 1 : 0,
    firstSidebar,
    lastSidebar,
    at100: sample(100, y),
    at225: sample(225, y),
    at320: sample(320, y),
    at500: sample(500, y),
    at1059: sample(1059, y),
    at1100: sample(1100, y),
    at1200: sample(1200, y),
  };
}

// Expected from diagnostic
const expected = { x: 225, y: 267, width: 834, height: 492 };
const out = { meta, expected, analysis };
fs.writeFileSync("scratch/post-detail-geometry/pixel-samples-1366.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
