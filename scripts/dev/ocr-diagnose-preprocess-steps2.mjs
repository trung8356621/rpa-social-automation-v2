import sharp from "sharp";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const crops = {
  caseD: ".local/creator/targets/884bfc4c-ba34-4b85-a642-5d76d1f7fd74.png",
  caseB: ".local/creator/targets/3547b983-9d08-4e42-a519-895fe10d2c4d.png",
  caseA: ".local/creator/targets/17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  fixture: "tests/fixtures/ocr-vie-eng.svg",
};

const langPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.local/ocr-models",
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

async function prep(image, mode) {
  const { width, height } = await sharp(image).metadata();
  const scale = 2;
  let pipeline = sharp(image).flatten({ background: "white" }).resize(width * scale, height * scale);
  if (mode.includes("gray")) pipeline = pipeline.grayscale();
  if (mode.includes("norm")) pipeline = pipeline.normalize();
  if (mode.includes("linear")) pipeline = pipeline.linear(1.6, -40);
  return pipeline.png().toBuffer();
}

const modes = ["none", "gray", "norm", "gray+norm", "gray+linear"];
const out = {};
for (const [label, file] of Object.entries(crops)) {
  const image = file.endsWith(".svg")
    ? await sharp(file).png().toBuffer()
    : readFileSync(file);
  out[label] = {};
  for (const mode of modes) {
    const buf = await prep(image, mode);
    const { data } = await worker.recognize(buf, {}, { text: true });
    out[label][mode] = { text: data.text.trim().slice(0, 80), conf: data.confidence };
    console.log(label, mode, JSON.stringify(out[label][mode].text));
  }
}
await worker.terminate();
writeFileSync(
  "scripts/dev/ocr-diagnose-preprocess-steps2-out.json",
  JSON.stringify(out, null, 2),
);
