import sharp from "sharp";
import type { Payload, OcrResult, Rect, Result } from "../shared/contracts.js";
import type { OcrEngine } from "./ocr.js";
import { matchTemplate } from "./visual.js";
export const MIN_OCR_CONFIDENCE = 80;
export class TargetNotConfident extends Error {}
export function normalizeTargetText(text: string) {
  return text
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("vi");
}
export function resolveOcrText(
  result: OcrResult,
  selection: NonNullable<NonNullable<Payload["target"]>["ocr"]>,
  offset: Rect,
): NonNullable<Result["match"]> {
  const matches = result.segments.filter(
    (segment) =>
      segment.kind === selection.kind &&
      normalizeTargetText(segment.text) === normalizeTargetText(selection.text),
  );
  if (matches.length !== 1)
    throw new TargetNotConfident(
      matches.length
        ? "OCR có nhiều vị trí cùng chữ; crop ROI hẹp hơn. Không gửi action."
        : "OCR không tìm thấy chính xác chữ đã xác nhận. Không gửi action.",
    );
  const found = matches[0];
  if (
    !Number.isFinite(found.confidence) ||
    found.confidence < MIN_OCR_CONFIDENCE
  )
    throw new TargetNotConfident(
      `OCR confidence ${found.confidence.toFixed(1)} < ${MIN_OCR_CONFIDENCE}. Không gửi action.`,
    );
  return {
    method: "ocr",
    text: found.text,
    confidence: found.confidence,
    score: found.confidence / 100,
    x: offset.x + found.bbox.x + found.bbox.width / 2,
    y: offset.y + found.bbox.y + found.bbox.height / 2,
  };
}
export async function resolveVisualTarget(
  frame: Buffer,
  template: Buffer,
  payload: Payload,
  ocr: OcrEngine,
): Promise<NonNullable<Result["match"]>> {
  const target = payload.target!;
  if (payload.method === "ocr") {
    if (!target.ocr?.confirmed)
      throw new TargetNotConfident("Chưa chọn và xác nhận chữ OCR.");
    const size = await sharp(frame).metadata();
    const left = Math.max(0, target.roi.x - 64),
      top = Math.max(0, target.roi.y - 64);
    const right = Math.min(size.width!, target.roi.x + target.roi.width + 64),
      bottom = Math.min(size.height!, target.roi.y + target.roi.height + 64);
    const roi = { x: left, y: top, width: right - left, height: bottom - top };
    try {
      const image = await sharp(frame)
        .extract({ left, top, width: roi.width, height: roi.height })
        .png()
        .toBuffer();
      return resolveOcrText(await ocr.recognize(image), target.ocr, roi);
    } catch (error) {
      if (error instanceof TargetNotConfident) throw error;
      throw new TargetNotConfident(
        `OCR thất bại: ${String((error as Error).message)}. Không fallback sang ảnh.`,
      );
    }
  }
  const match = await matchTemplate(frame, template, target.roi);
  const threshold = Math.max(0.96, payload.threshold ?? 0.96);
  if (match.score < threshold)
    throw new TargetNotConfident(
      `Ảnh không đủ khớp: ${match.score.toFixed(4)} < ${threshold}.`,
    );
  if (match.ambiguous)
    throw new TargetNotConfident(
      "Ảnh có nhiều vị trí gần giống nhau; không click đoán. Crop target rõ hơn.",
    );
  return { ...match, method: "image" };
}
