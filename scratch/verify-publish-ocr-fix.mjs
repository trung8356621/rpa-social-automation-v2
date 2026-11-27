import { readFileSync } from "node:fs";
import { LocalOcr } from "../src/main/ocr.ts";
import { findOcrCandidates } from "../src/main/ocr-candidates.ts";
import { findChromaticButtonChips } from "../src/main/ocr-button-chips.ts";
import { resolveVisualTarget } from "../src/main/target-resolver.ts";
import sharp from "sharp";

const files = [
  "tests/fixtures/ocr-publish-match-to-bottom-d99eb08f.png",
  "tests/fixtures/ocr-publish-match-to-bottom-3a5d289a.png",
];
const ocr = new LocalOcr();
const selection = {
  text: "Publish",
  kind: "line",
  bbox: { x: 14, y: 18, width: 46, height: 11 },
  confidence: 92,
  confirmed: true,
  language: "vie+eng",
};
try {
  for (const file of files) {
    const frame = readFileSync(file);
    const chips = await findChromaticButtonChips(frame);
    const result = await ocr.recognize(frame);
    const hits = findOcrCandidates(result, selection);
    console.log(
      JSON.stringify({
        file,
        chips,
        hitCount: hits.length,
        hits: hits.map((h) => ({
          text: h.text,
          conf: h.confidence,
          bbox: h.bbox,
          center: { x: h.bbox.x + h.bbox.width / 2, y: h.bbox.y + h.bbox.height / 2 },
        })),
      }),
    );
    const template = await sharp({
      create: { width: 74, height: 43, channels: 3, background: "#2657d9" },
    })
      .png()
      .toBuffer();
    const payload = {
      action: "CLICK_TARGET",
      target: {
        asset: "publish.png",
        roi: { x: 688, y: 489, width: 75, height: 39 },
        environment: { width: 1024, height: 560, zoom: 1 },
        matchTo: "bottom",
        ocr: selection,
        clickOffset: { x: 0, y: 0 },
      },
    };
    const searchRegion = { x: 200, y: 40, width: 580, height: 480 };
    const resolved = await resolveVisualTarget(frame, template, payload, ocr, searchRegion);
    console.log("resolved", resolved.method, resolved.x, resolved.y, resolved.confidence);
  }
} finally {
  await ocr.close();
}
