import sharp from "sharp";
import { LocalOcr } from "../src/main/ocr.ts";
import { findOcrCandidates } from "../src/main/ocr-candidates.ts";

const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";
const box = { left: 688, top: 489, width: 75, height: 39 };
const ocr = new LocalOcr();
const selection = { text: "Publish", kind: "line" };

try {
  const tight = await sharp(file).extract(box).png().toBuffer();
  // Sample fill color from button center
  const { data } = await sharp(tight)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = 37,
    cy = 19;
  const i = (cy * 75 + cx) * 4;
  const fill = { r: data[i], g: data[i + 1], b: data[i + 2] };
  console.log("fill", fill);

  for (const [name, buf] of [
    ["tight", tight],
    [
      "pad2_white",
      await sharp(tight)
        .extend({ top: 2, bottom: 2, left: 2, right: 2, background: "#ffffff" })
        .png()
        .toBuffer(),
    ],
    [
      "pad2_fill",
      await sharp(tight)
        .extend({ top: 2, bottom: 2, left: 2, right: 2, background: fill })
        .png()
        .toBuffer(),
    ],
    [
      "pad8_fill",
      await sharp(tight)
        .extend({ top: 8, bottom: 8, left: 8, right: 8, background: fill })
        .png()
        .toBuffer(),
    ],
    [
      "pad2_black",
      await sharp(tight)
        .extend({ top: 2, bottom: 2, left: 2, right: 2, background: "#000000" })
        .png()
        .toBuffer(),
    ],
  ]) {
    const result = await ocr.recognize(buf);
    const hits = findOcrCandidates(result, selection);
    console.log(name, result.text, hits.map((h) => h.confidence));
  }
} finally {
  await ocr.close();
}
