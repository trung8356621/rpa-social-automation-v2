import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const root = process.cwd();
const { localOcr } = await import(pathToFileURL(path.join(root, "dist/main/ocr.js")).href);
const { classifyEngagementOcr } = await import(pathToFileURL(path.join(root, "dist/shared/post-detail-collector/engagement-ocr.js")).href);

const cropPath = process.argv[2] || path.join(
  root,
  "scratch/post-detail-runs/pd_20261116T170031Z_00up2a/engagement-ocr/29362527793432657/engagement.png",
);
const evidencePath = process.argv[3] || path.join(
  root,
  "scratch/post-detail-runs/pd_20261116T170031Z_00up2a/engagement-ocr/29362527793432657/result.json",
);

const crop = readFileSync(cropPath);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const actionRects = evidence.actionRects || [];
const cropMeta = await sharp(crop).metadata();
const cropW = cropMeta.width;
const cropH = cropMeta.height;

async function runVariant(name, prepare) {
  const prepared = await prepare();
  const raw = await localOcr.recognize(prepared.buffer);
  const ocr = {
    ...raw,
    segments: raw.segments.map((segment) => ({
      ...segment,
      bbox: {
        x: segment.bbox.x - (prepared.padX || 0),
        y: segment.bbox.y - (prepared.padY || 0),
        width: segment.bbox.width,
        height: segment.bbox.height,
      },
    })),
  };
  const classified = classifyEngagementOcr({ ocr, actionRects, cropHeight: cropH });
  const verified = Object.values(classified.fields).filter((field) => field.status === "verified").length;
  return {
    name,
    verified,
    raw: ocr.text,
    confidence: ocr.confidence,
    numeric: ocr.segments.filter((s) => /\d/.test(s.text)).map((s) => ({
      id: s.id, text: s.text, conf: s.confidence, bbox: s.bbox, kind: s.kind,
    })),
    fields: Object.fromEntries(Object.entries(classified.fields).map(([key, value]) => [key, {
      value: value.value, status: value.status, reason: value.failureReason, rawText: value.rawText,
    }])),
    diagnostics: classified.diagnostics,
  };
}

const focusWidth = Math.min(cropW, Math.max(280, Math.round(cropW * 0.48)));
const pad = 10;
const variants = [
  await runVariant("left-focus+pad+linear", async () => ({
    buffer: await sharp(crop)
      .extract({ left: 0, top: 0, width: focusWidth, height: cropH })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" })
      .grayscale()
      .linear(1.28, -22)
      .png()
      .toBuffer(),
    padX: pad,
    padY: pad,
  })),
  await runVariant("left-focus+pad-only", async () => ({
    buffer: await sharp(crop)
      .extract({ left: 0, top: 0, width: focusWidth, height: cropH })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" })
      .grayscale()
      .png()
      .toBuffer(),
    padX: pad,
    padY: pad,
  })),
  await runVariant("left-220+threshold", async () => ({
    buffer: await sharp(crop)
      .extract({ left: 0, top: 0, width: Math.min(cropW, 240), height: cropH })
      .extend({ top: 12, bottom: 12, left: 12, right: 12, background: "#ffffff" })
      .grayscale()
      .linear(1.6, -40)
      .threshold(160)
      .png()
      .toBuffer(),
    padX: 12,
    padY: 12,
  })),
  await runVariant("full-crop-pad", async () => ({
    buffer: await sharp(crop)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" })
      .grayscale()
      .linear(1.2, -16)
      .png()
      .toBuffer(),
    padX: pad,
    padY: pad,
  })),
];

const before = {
  name: "saved-evidence",
  verified: 0,
  raw: evidence.ocr?.text,
  numeric: (evidence.ocr?.segments || []).filter((s) => /\d/.test(s.text)).map((s) => s.text),
  fields: Object.fromEntries(Object.entries(evidence.fields || {}).map(([k, v]) => [k, v.value])),
  diagnostics: evidence.diagnostics,
};

const best = [...variants].sort((a, b) => b.verified - a.verified || b.numeric.length - a.numeric.length)[0];
const outDir = path.join(root, "artifacts/engagement-ocr-debug");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "real-crop-compare.json"), JSON.stringify({ cropPath, cropW, cropH, before, variants, best }, null, 2));
console.log(JSON.stringify({
  before,
  best: {
    name: best.name,
    verified: best.verified,
    raw: best.raw,
    numeric: best.numeric.map((n) => n.text),
    fields: Object.fromEntries(Object.entries(best.fields).map(([k, v]) => [k, v.value])),
    diagnostics: best.diagnostics,
  },
  all: variants.map((v) => ({
    name: v.name,
    verified: v.verified,
    numeric: v.numeric.map((n) => `${n.text}@${Math.round(n.bbox.x)}`),
    fields: Object.fromEntries(Object.entries(v.fields).map(([k, f]) => [k, f.value])),
  })),
}, null, 2));
await localOcr.close();
