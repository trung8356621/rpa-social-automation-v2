import sharp from "sharp";
import { readFileSync } from "node:fs";
import Tesseract from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
const file =
  ".local/qa-profile-facebook-sandbox/captures/d99eb08f-5a92-45bf-a464-d86fd8bb6574.png";

// Precise button from blue scan: ~ around 693,505
const crops = [
  { name: "btn", left: 660, top: 488, width: 110, height: 40 },
  { name: "btn_wide", left: 640, top: 475, width: 140, height: 55 },
  { name: "btn_from_detected", left: 680, top: 490, width: 90, height: 40 },
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

const modes = [
  ["SPARSE", PSM.SPARSE_TEXT],
  ["SINGLE_LINE", PSM.SINGLE_LINE],
  ["SINGLE_WORD", PSM.SINGLE_WORD],
  ["SINGLE_BLOCK", PSM.SINGLE_BLOCK],
];

for (const c of crops) {
  const raw = await sharp(file)
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .png()
    .toBuffer();
  await sharp(raw).toFile(`scratch/publish-ocr-probe/focus-${c.name}.png`);

  for (const scale of [2, 3, 4]) {
    const gray = await sharp(raw)
      .flatten({ background: "white" })
      .resize(c.width * scale, c.height * scale, { kernel: "lanczos3" })
      .grayscale()
      .png()
      .toBuffer();
    const neg = await sharp(raw)
      .flatten({ background: "white" })
      .resize(c.width * scale, c.height * scale, { kernel: "lanczos3" })
      .grayscale()
      .negate({ alpha: false })
      .png()
      .toBuffer();
    // Adaptive: if mean luminance of center is dark, use negate
    const stats = await sharp(gray).stats();
    const mean = stats.channels[0].mean;
    await sharp(gray).toFile(`scratch/publish-ocr-probe/focus-${c.name}-s${scale}-gray.png`);
    await sharp(neg).toFile(`scratch/publish-ocr-probe/focus-${c.name}-s${scale}-neg.png`);

    for (const [modeName, psm] of modes) {
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        langPath,
        gzip: true,
        workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js"),
        cacheMethod: "none",
        errorHandler: () => {},
      });
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        user_defined_dpi: String(72 * scale),
      });
      for (const [vName, pixels] of [
        ["gray", gray],
        ["neg", neg],
      ]) {
        const { data } = await worker.recognize(pixels, {}, { text: true });
        const text = (data.text || "").replace(/\s+/g, " ").trim();
        if (text || /pub/i.test(text))
          console.log(
            JSON.stringify({
              crop: c.name,
              scale,
              mode: modeName,
              variant: vName,
              mean,
              text,
              conf: data.confidence,
            }),
          );
        else
          console.log(
            JSON.stringify({
              crop: c.name,
              scale,
              mode: modeName,
              variant: vName,
              mean,
              text: "",
              conf: data.confidence,
            }),
          );
      }
      await worker.terminate();
    }
  }
}
