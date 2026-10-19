import Tesseract from "tesseract.js";
import type { Worker, Bbox } from "tesseract.js";
import sharp from "sharp";
import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OcrResult, OcrSegment, Rect } from "../shared/contracts.js";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
}
export class LocalOcr implements OcrEngine {
  private ready?: Promise<Worker>;
  private busy = false;
  private getWorker() {
    this.ready ??= (async () => {
      // Explicit filesystem langPath: never fall back to a CDN at runtime.
      const langPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../.local/ocr-models",
      );
      await mkdir(langPath, { recursive: true });
      await Promise.all(
        ["vie", "eng"].map((code) =>
          copyFile(
            path.join(
              path.dirname(
                require.resolve(`@tesseract.js-data/${code}/package.json`),
              ),
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
        workerPath:
          require.resolve("tesseract.js/src/worker-script/node/index.js"),
        cacheMethod: "none",
        errorHandler: () => {},
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        user_defined_dpi: "144",
      });
      return worker;
    })();
    return this.ready;
  }
  async recognize(image: Buffer): Promise<OcrResult> {
    if (this.busy) throw new Error("OCR đang bận; đợi tác vụ hiện tại.");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.read(image),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("OCR local timeout sau 30 giây.")),
            30000,
          );
        }),
      ]);
    } catch (error) {
      const pending = this.ready;
      this.ready = undefined;
      void pending?.then(
        (worker) => worker.terminate(),
        () => {},
      );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.busy = false;
    }
  }
  private async read(image: Buffer): Promise<OcrResult> {
    const metadata = await sharp(image).metadata();
    const width = metadata.width!,
      height = metadata.height!;
    if (!width || !height || width * height > 1024 * 560)
      throw new Error("Ảnh OCR vượt giới hạn ROI/viewport.");
    const scale = 2;
    const pixels = await sharp(image)
      .flatten({ background: "white" })
      .resize(width * scale, height * scale)
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    const worker = await this.getWorker();
    const { data } = await worker.recognize(
      pixels,
      {},
      { text: true, blocks: true },
    );
    const segments: OcrSegment[] = [];
    const box = (b: Bbox): Rect => {
      const x = Math.max(0, Math.floor(b.x0 / scale)),
        y = Math.max(0, Math.floor(b.y0 / scale));
      return {
        x,
        y,
        width: Math.min(width, Math.ceil(b.x1 / scale)) - x,
        height: Math.min(height, Math.ceil(b.y1 / scale)) - y,
      };
    };
    const add = (
      text: string,
      bbox: Bbox,
      confidence: number,
      kind: OcrSegment["kind"],
    ) => {
      const clean = text.normalize("NFC").trim();
      const rect = box(bbox);
      if (
        clean &&
        rect.width > 0 &&
        rect.height > 0 &&
        Number.isFinite(confidence)
      )
        segments.push({
          id: String(segments.length),
          text: clean,
          bbox: rect,
          confidence: Math.max(0, Math.min(100, confidence)),
          kind,
        });
    };
    for (const block of data.blocks ?? [])
      for (const paragraph of block.paragraphs)
        for (const line of paragraph.lines) {
          const confidence = line.words.length
            ? Math.min(...line.words.map((word) => word.confidence))
            : line.confidence;
          add(line.text, line.bbox, confidence, "line");
          for (const word of line.words)
            add(word.text, word.bbox, word.confidence, "word");
        }
    return {
      text: data.text.normalize("NFC").trim(),
      confidence: data.confidence,
      segments,
      language: "vie+eng",
    };
  }
  async close() {
    const pending = this.ready;
    this.ready = undefined;
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.then(
          (worker) => worker.terminate(),
          () => {},
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export const localOcr = new LocalOcr();
