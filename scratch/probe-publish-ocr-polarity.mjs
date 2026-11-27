import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";
const outDir = "scratch/publish-ocr-probe";
mkdirSync(outDir, { recursive: true });

const langPath = path.resolve(".local/ocr-models");
await mkdir(langPath, { recursive: true });
await Promise.all(
  ["vie", "eng"].map((code) =>
    copyFile(
      path.join(
        path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)),
        "4.0.0_best_int",
        `${code}.traineddata.gz`,
      ),
      path.join(langPath, `${code}.traineddata.gz`),
    ),
  ),
);

const worker = await createWorker("vie+eng", OEM.LSTM_ONLY, {
  langPath,
  gzip: true,
  workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
  cacheMethod: "none",
  errorHandler: () => {},
});
await worker.setParameters({
  tessedit_pageseg_mode: PSM.SPARSE_TEXT,
  user_defined_dpi: "144",
});

const frame = readFileSync(file);
const crops = [
  { name: "full", left: 0, top: 0, width: 1024, height: 560 },
  { name: "button_pad", left: 580, top: 420, width: 200, height: 100 },
  { name: "button_tight", left: 640, top: 460, width: 100, height: 45 },
  { name: "footer_row", left: 220, top: 430, width: 560, height: 90 },
];

async function variants(buf, w, h) {
  const scale = 2;
  const base = sharp(buf).flatten({ background: "white" }).resize(w * scale, h * scale);
  return {
    gray: await base.clone().grayscale().png().toBuffer(),
    gray_neg: await base.clone().grayscale().negate({ alpha: false }).png().toBuffer(),
    gray_norm: await base.clone().grayscale().normalize().png().toBuffer(),
    gray_neg_norm: await base
      .clone()
      .grayscale()
      .negate({ alpha: false })
      .normalize()
      .png()
      .toBuffer(),
    // Threshold after negate for high-contrast white-on-blue buttons
    gray_neg_thr: await base
      .clone()
      .grayscale()
      .negate({ alpha: false })
      .threshold(160)
      .png()
      .toBuffer(),
  };
}

function extractPublish(data) {
  const text = (data.text || "").normalize("NFC");
  const words = [];
  for (const block of data.blocks ?? [])
    for (const p of block.paragraphs)
      for (const line of p.lines) {
        if (/publish/i.test(line.text))
          words.push({
            kind: "line",
            text: line.text.trim(),
            conf: Math.min(...line.words.map((w) => w.confidence)),
            bbox: line.bbox,
          });
        for (const w of line.words)
          if (/publish/i.test(w.text))
            words.push({ kind: "word", text: w.text.trim(), conf: w.confidence, bbox: w.bbox });
      }
  return { has: /publish/i.test(text), textPreview: text.slice(0, 180), hits: words };
}

const report = [];
for (const c of crops) {
  const buf = await sharp(frame)
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .png()
    .toBuffer();
  const v = await variants(buf, c.width, c.height);
  for (const [name, pixels] of Object.entries(v)) {
    await sharp(pixels).toFile(path.join(outDir, `polarity-${c.name}-${name}.png`));
    const { data } = await worker.recognize(pixels, {}, { text: true, blocks: true });
    const found = extractPublish(data);
    const row = { crop: c.name, variant: name, ...found, conf: data.confidence };
    report.push(row);
    console.log(JSON.stringify(row));
  }
}

writeFileSync(path.join(outDir, "polarity-report.json"), JSON.stringify(report, null, 2));
await worker.terminate();
console.log("\nHITS:", report.filter((r) => r.has || r.hits.length).length);
