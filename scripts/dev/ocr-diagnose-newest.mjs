import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { localOcr } from "../../src/main/ocr.ts";
import { findOcrCandidates, normalizeOcrText } from "../../src/main/ocr-candidates.ts";

const fp = ".local/creator/targets/884bfc4c-ba34-4b85-a642-5d76d1f7fd74.png";
const buf = readFileSync(fp);
const meta = await sharp(buf).metadata();
const stats = await sharp(buf).stats();
const out = {
  path: fp,
  width: meta.width,
  height: meta.height,
  channels: meta.channels,
  sizeBytes: buf.length,
  channelsMean: stats.channels.map((c) => ({
    mean: c.mean,
    min: c.min,
    max: c.max,
  })),
};
try {
  const ocr = await localOcr.recognize(buf);
  out.ocr = {
    rawText: ocr.text,
    confidence: ocr.confidence,
    segmentCount: ocr.segments.length,
    lines: ocr.segments.filter((s) => s.kind === "line"),
    words: ocr.segments.filter((s) => s.kind === "word"),
    matchBan: findOcrCandidates(ocr, {
      text: "Bạn viết gì đi...",
      kind: "line",
    }).map((c) => ({ text: c.text, confidence: c.confidence, bbox: c.bbox })),
    normalizedRaw: normalizeOcrText(ocr.text),
  };
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
}
await localOcr.close();
writeFileSync("scripts/dev/ocr-diagnose-newest-out.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
