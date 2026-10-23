/**
 * Focused OCR diagnostic — crop fixtures only, no browser/Facebook.
 * Does not modify SQLite.
 */
import sharp from "sharp";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { localOcr } from "../../src/main/ocr.ts";
import {
  findOcrCandidates,
  normalizeOcrText,
} from "../../src/main/ocr-candidates.ts";

const cases = [
  {
    id: "A-asset-030160",
    asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
    expected: "@ Bạn viết gì đi...",
    kind: "line",
  },
  {
    id: "B-asset-7093",
    asset: "3547b983-9d08-4e42-a519-895fe10d2c4d.png",
    expected: "Bạn viết gì đi...",
    kind: "line",
  },
  {
    id: "C-asset-08947",
    asset: "ee23380e-02b5-4c60-abfb-dd8b3ce16756.png",
    expected: "@ Bạn viết gì đi...",
    kind: "line",
  },
];

const targetsDir = ".local/creator/targets";
const results = [];

for (const c of cases) {
  const fp = path.join(targetsDir, c.asset);
  const entry = { id: c.id, asset: c.asset, expected: c.expected };
  if (!existsSync(fp)) {
    entry.error = "ASSET_MISSING";
    results.push(entry);
    continue;
  }
  const buf = readFileSync(fp);
  const meta = await sharp(buf).metadata();
  entry.input = {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    sizeBytes: buf.length,
  };
  entry.engine = {
    lib: "tesseract.js",
    language: "vie+eng",
    oem: "LSTM_ONLY",
    psm: "SPARSE_TEXT",
    dpi: 144,
    preprocess: "flatten-white → 2x resize → grayscale → normalize",
  };
  try {
    const ocr = await localOcr.recognize(buf);
    entry.rawText = ocr.text;
    entry.confidence = ocr.confidence;
    entry.language = ocr.language;
    entry.lines = ocr.segments
      .filter((s) => s.kind === "line")
      .map((s) => ({
        text: s.text,
        confidence: s.confidence,
        bbox: s.bbox,
      }));
    entry.words = ocr.segments
      .filter((s) => s.kind === "word")
      .map((s) => ({
        text: s.text,
        confidence: s.confidence,
        bbox: s.bbox,
      }));
    entry.normalizedExpected = normalizeOcrText(c.expected);
    entry.normalizedRaw = normalizeOcrText(ocr.text);
    const candidates = findOcrCandidates(ocr, {
      text: c.expected,
      kind: c.kind,
    });
    entry.candidates = candidates.map((m) => ({
      text: m.text,
      confidence: m.confidence,
      bbox: m.bbox,
      normalized: normalizeOcrText(m.text),
    }));
    entry.match = candidates.length === 1 ? "MATCHED" : candidates.length ? "AMBIGUOUS" : "NOT_FOUND";
    entry.reason =
      candidates.length === 1
        ? "EXACT_NORMALIZED_MATCH"
        : candidates.length
          ? "MULTIPLE_CANDIDATES"
          : "NO_CANDIDATE_AFTER_NORMALIZE";
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.match = "OCR_TECHNICAL";
  }
  results.push(entry);
  console.log(
    JSON.stringify(
      {
        id: entry.id,
        dim: entry.input,
        match: entry.match,
        raw: entry.rawText,
        lines: entry.lines?.map((l) => l.text),
        error: entry.error,
      },
      null,
      2,
    ),
  );
}

await localOcr.close();
writeFileSync(
  "scripts/dev/ocr-diagnose-crops-out.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      node: process.version,
      results,
    },
    null,
    2,
  ),
);
console.log("wrote scripts/dev/ocr-diagnose-crops-out.json");
