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

const y = 400;
const strip = [];
for (let x = 200; x <= 340; x += 1) {
  strip.push({ x, rgb: sample(x, y) });
}
// Find transitions
const transitions = [];
for (let i = 1; i < strip.length; i++) {
  const a = strip[i - 1].rgb.join(",");
  const b = strip[i].rgb.join(",");
  if (a !== b) transitions.push({ from: strip[i - 1], to: strip[i] });
}

const rightStrip = [];
for (let x = 1030; x <= 1120; x += 1) {
  rightStrip.push({ x, rgb: sample(x, y) });
}
const rightTransitions = [];
for (let i = 1; i < rightStrip.length; i++) {
  const a = rightStrip[i - 1].rgb.join(",");
  const b = rightStrip[i].rgb.join(",");
  if (a !== b) rightTransitions.push({ from: rightStrip[i - 1], to: rightStrip[i] });
}

const out = { transitions, rightTransitions, sample210_330: strip.filter((p) => p.x % 5 === 0) };
fs.writeFileSync("scratch/post-detail-geometry/pixel-strip-1366.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
