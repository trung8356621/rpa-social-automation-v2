import sharp from "sharp";
import { readFileSync } from "node:fs";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { LocalOcr } from "../src/main/ocr.ts";
import { findOcrCandidates } from "../src/main/ocr-candidates.ts";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const files = [
  "scratch/publish-ocr-probe/blob-0.png",
  ".local/qa-profile-facebook-sandbox/targets/6b84e6f1-ac39-48fc-9835-499972acd2f9.png",
];
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

const local = new LocalOcr();
for (const file of files) {
  const buf = readFileSync(file);
  const meta = await sharp(buf).metadata();
  console.log("\nFILE", file, meta.width, meta.height);
  const result = await local.recognize(buf);
  const hits = findOcrCandidates(result, { text: "Publish", kind: "line" });
  console.log("LocalOcr", JSON.stringify({ text: result.text, conf: result.confidence, hits, segs: result.segments.slice(0, 8) }));

  for (const [name, psm] of [
    ["SPARSE", PSM.SPARSE_TEXT],
    ["BLOCK", PSM.SINGLE_BLOCK],
    ["LINE", PSM.SINGLE_LINE],
  ]) {
    const scale = 2;
    const gray = await sharp(buf)
      .flatten({ background: "white" })
      .resize(meta.width * scale, meta.height * scale)
      .grayscale()
      .png()
      .toBuffer();
    const neg = await sharp(gray).negate({ alpha: false }).png().toBuffer();
    const worker = await createWorker("vie+eng", OEM.LSTM_ONLY, {
      langPath,
      gzip: true,
      workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
      cacheMethod: "none",
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: "144" });
    for (const [v, img] of [
      ["gray", gray],
      ["neg", neg],
    ]) {
      const { data } = await worker.recognize(img, {}, { text: true });
      console.log(name, v, JSON.stringify(data.text.trim()), data.confidence);
    }
    await worker.terminate();
  }
}
await local.close();
