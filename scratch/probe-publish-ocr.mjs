import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalOcr } from "../src/main/ocr.ts";
import { findOcrCandidates, normalizeOcrText } from "../src/main/ocr-candidates.ts";

const captures = [
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png",
  ".local/qa-profile-facebook-sandbox/captures/3a5d289a-4b8f-40f7-9e49-6a5ce26e0381.png",
];

const selection = { text: "Publish", kind: "line" };
const outDir = "scratch/publish-ocr-probe";
mkdirSync(outDir, { recursive: true });

const ocr = new LocalOcr();

function summarize(result, label, offset = { x: 0, y: 0 }) {
  const hits = findOcrCandidates(result, selection);
  const publishish = result.segments.filter((s) =>
    /pub|lish|đăng|post/i.test(s.text),
  );
  return {
    label,
    textPreview: result.text.slice(0, 200),
    confidence: result.confidence,
    segmentCount: result.segments.length,
    publishCandidates: hits.map((h) => ({
      text: h.text,
      kind: h.kind,
      confidence: h.confidence,
      bbox: {
        x: h.bbox.x + offset.x,
        y: h.bbox.y + offset.y,
        width: h.bbox.width,
        height: h.bbox.height,
      },
    })),
    publishish: publishish.map((s) => ({
      text: s.text,
      kind: s.kind,
      confidence: s.confidence,
      bbox: {
        x: s.bbox.x + offset.x,
        y: s.bbox.y + offset.y,
        width: s.bbox.width,
        height: s.bbox.height,
      },
    })),
  };
}

async function preprocessVariants(buf, width, height) {
  const scale = 2;
  const base = sharp(buf).flatten({ background: "white" }).resize(width * scale, height * scale);
  return {
    current_gray: await base.clone().grayscale().png().toBuffer(),
    gray_negate: await base.clone().grayscale().negate().png().toBuffer(),
    gray_normalize: await base.clone().grayscale().normalize().png().toBuffer(),
    gray_negate_normalize: await base.clone().grayscale().negate().normalize().png().toBuffer(),
  };
}

async function recognizeRaw(workerPixels) {
  // Use LocalOcr private path via recognize on already-sized images by wrapping
  // through a temporary approach: call recognize on original-sized crops only.
  return null;
}

async function runCapture(file) {
  const frame = readFileSync(file);
  const meta = await sharp(frame).metadata();
  const id = path.basename(file, ".png");
  console.log("\n===", id, `${meta.width}x${meta.height}`, "===");

  // 1) Full viewport via LocalOcr.recognize (runtime Match To path)
  const full = await ocr.recognize(frame);
  const fullSummary = summarize(full, "full_viewport");
  console.log(JSON.stringify(fullSummary, null, 2));

  // Heuristic Publish button crop from visual description: bottom-right of modal
  // Modal roughly centered; Publish near ~640-760 x, ~470-520 y on 1024x560
  const crops = [
    { name: "button_tight", left: 620, top: 450, width: 120, height: 50 },
    { name: "button_pad", left: 580, top: 420, width: 200, height: 100 },
    { name: "footer_row", left: 220, top: 430, width: 560, height: 90 },
    { name: "modal_lower", left: 200, top: 300, width: 600, height: 230 },
    { name: "search_modal_est", left: 200, top: 40, width: 580, height: 480 },
  ];

  const cropResults = [];
  for (const c of crops) {
    const cropped = await sharp(frame)
      .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
      .png()
      .toBuffer();
    await sharp(cropped).toFile(path.join(outDir, `${id}-${c.name}.png`));
    const result = await ocr.recognize(cropped);
    const summary = summarize(result, c.name, { x: c.left, y: c.top });
    cropResults.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }

  // Polarity probe on button_pad using worker-level preprocess variants written to disk
  const pad = crops.find((c) => c.name === "button_pad");
  const padBuf = await sharp(frame)
    .extract({ left: pad.left, top: pad.top, width: pad.width, height: pad.height })
    .png()
    .toBuffer();
  const variants = await preprocessVariants(padBuf, pad.width, pad.height);
  for (const [name, buf] of Object.entries(variants)) {
    await sharp(buf).toFile(path.join(outDir, `${id}-pre-${name}.png`));
  }

  writeFileSync(
    path.join(outDir, `${id}-summary.json`),
    JSON.stringify({ file, full: fullSummary, crops: cropResults }, null, 2),
  );
}

try {
  for (const file of captures) await runCapture(file);
} finally {
  await ocr.close();
}
