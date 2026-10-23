import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const fp = ".local/creator/targets/884bfc4c-ba34-4b85-a642-5d76d1f7fd74.png";
const image = readFileSync(fp);
const { width, height } = await sharp(image).metadata();
const scale = 2;

const steps = {
  raw_2x: await sharp(image).resize(width * scale, height * scale).png().toBuffer(),
  flatten_2x: await sharp(image)
    .flatten({ background: "white" })
    .resize(width * scale, height * scale)
    .png()
    .toBuffer(),
  current: await sharp(image)
    .flatten({ background: "white" })
    .resize(width * scale, height * scale)
    .grayscale()
    .normalize()
    .png()
    .toBuffer(),
  no_flatten: await sharp(image)
    .resize(width * scale, height * scale)
    .grayscale()
    .normalize()
    .png()
    .toBuffer(),
  current_plus_linear: await sharp(image)
    .flatten({ background: "white" })
    .resize(width * scale, height * scale)
    .grayscale()
    .normalize()
    .linear(1.6, -40)
    .png()
    .toBuffer(),
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

const out = [];
for (const [name, buf] of Object.entries(steps)) {
  const { data } = await worker.recognize(buf, {}, { text: true, blocks: true });
  out.push({ name, text: data.text.trim(), confidence: data.confidence });
  console.log(name, JSON.stringify(data.text.trim()), "conf", data.confidence);
}
await worker.terminate();
writeFileSync(
  "scripts/dev/ocr-diagnose-preprocess-steps-out.json",
  JSON.stringify(out, null, 2),
);
