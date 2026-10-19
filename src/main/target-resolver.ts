import sharp from "sharp";
import type {
  Payload,
  OcrResult,
  Rect,
  Result,
  ResolutionTrace,
} from "../shared/contracts.js";
import type { OcrEngine } from "./ocr.js";
import { matchTemplate } from "./visual.js";
export const MIN_OCR_CONFIDENCE = 80;
export class TargetNotConfident extends Error {
  constructor(
    message: string,
    readonly resolution?: ResolutionTrace,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}
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
      undefined,
      matches.length > 1,
    );
  const found = matches[0];
  if (
    !Object.values(found.bbox).every(Number.isFinite) ||
    found.bbox.x < 0 ||
    found.bbox.y < 0 ||
    found.bbox.width <= 0 ||
    found.bbox.height <= 0 ||
    found.bbox.x + found.bbox.width > offset.width ||
    found.bbox.y + found.bbox.height > offset.height
  )
    throw new TargetNotConfident("OCR bounding box không hợp lệ.");
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
): Promise<NonNullable<Result["match"]> & { resolution: ResolutionTrace }> {
  const target = payload.target!;
  const trace: ResolutionTrace = {
    mode: "auto",
    legacyMethod:
      payload.method === "image" || payload.method === "ocr"
        ? payload.method
        : undefined,
    attempts: [],
  };
  const block = (reason: string): never => {
    trace.blockedReason = reason;
    throw new TargetNotConfident(reason, trace);
  };
  let image: Awaited<ReturnType<typeof matchTemplate>> | undefined;
  let imageReason = "";
  const threshold = Math.max(0.96, payload.threshold ?? 0.96);
  try {
    image = await matchTemplate(frame, template, target.roi);
    imageReason = image.ambiguous
      ? "Ảnh có nhiều vị trí gần giống nhau."
      : image.score < threshold
        ? `Image score ${image.score.toFixed(4)} < ${threshold}.`
        : "Ảnh khớp duy nhất trong vùng tìm.";
    trace.attempts.push({
      method: "image",
      outcome: image.ambiguous
        ? "ambiguous"
        : image.score >= threshold
          ? "matched"
          : "not_confident",
      score: image.score,
      x: image.x,
      y: image.y,
      reason: imageReason,
    });
  } catch (error) {
    imageReason = (error as Error).message;
    trace.attempts.push({
      method: "image",
      outcome: "failed",
      reason: imageReason,
    });
  }
  if (image?.ambiguous)
    block("Target ảnh có nhiều vị trí; không click đoán. Crop lại target.");
  const imageGood = image !== undefined && image.score >= threshold;
  if (!imageGood) trace.fallbackReason = imageReason;
  let textMatch: NonNullable<Result["match"]> | undefined;
  if (target.ocr?.confirmed) {
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
      textMatch = resolveOcrText(await ocr.recognize(image), target.ocr, roi);
      trace.attempts.push({
        method: "ocr",
        outcome: "matched",
        score: textMatch.score,
        confidence: textMatch.confidence,
        x: textMatch.x,
        y: textMatch.y,
        reason: imageGood
          ? "Đối chiếu an toàn với vị trí ảnh."
          : "Fallback từ Image Matching.",
      });
    } catch (error) {
      const ambiguous = error instanceof TargetNotConfident && error.ambiguous;
      trace.attempts.push({
        method: "ocr",
        outcome: ambiguous
          ? "ambiguous"
          : error instanceof TargetNotConfident
            ? "not_confident"
            : "failed",
        reason: (error as Error).message,
      });
      if (ambiguous)
        block(
          "OCR có nhiều vị trí cùng chữ; không click đoán. Crop lại target.",
        );
    }
  } else
    trace.attempts.push({
      method: "ocr",
      outcome: "unavailable",
      reason: "Chưa có chữ OCR được xác nhận.",
    });
  if (image && textMatch && image.score >= 0.94 && target.ocr) {
    // Compare the saved text anchor translated by image displacement, not ROI center.
    const anchor = target.ocr.bbox;
    const expectedX =
      image.x - target.roi.width / 2 + anchor.x + anchor.width / 2;
    const expectedY =
      image.y - target.roi.height / 2 + anchor.y + anchor.height / 2;
    if (
      Math.abs(expectedX - textMatch.x) > Math.max(12, anchor.width * 0.25) ||
      Math.abs(expectedY - textMatch.y) > Math.max(12, anchor.height * 0.25)
    )
      block(
        "Image và OCR đưa ra vị trí mâu thuẫn; không click đoán. Redesign target.",
      );
  }
  if (imageGood) {
    trace.selectedMethod = "image";
    return { ...image!, method: "image", resolution: trace };
  }
  if (textMatch) {
    trace.selectedMethod = "ocr";
    return { ...textMatch, resolution: trace };
  }
  return block(
    "Không xác định được target đủ tin cậy bằng AUTO. Chưa gửi click/nhập; hãy Redesign target.",
  );
}
