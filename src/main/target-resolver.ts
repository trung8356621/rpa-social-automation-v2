import sharp from "sharp";
import type {
  Payload,
  OcrResult,
  Rect,
  Result,
  ResolutionTrace,
} from "../shared/contracts.js";
import type { OcrEngine } from "./ocr.js";
import { effectiveMatchTo } from "../shared/match-to.js";
import { findOcrCandidates, normalizeOcrText } from "./ocr-candidates.js";
import { confirmOcrContext } from "./ocr-context.js";
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
export class OcrNotFound extends TargetNotConfident {
  constructor(resolution?: ResolutionTrace, readonly outcome: "NOT_FOUND" | "OCR_LOW_CONFIDENCE" | "CONTEXT_REJECTED" = "NOT_FOUND", readonly recovery?: Rect) {
    super(`${outcome}: ${outcome === "NOT_FOUND" ? "không có ứng viên chữ phù hợp" : outcome === "OCR_LOW_CONFIDENCE" ? "có ứng viên chữ nhưng confidence dưới ngưỡng" : "có ứng viên chữ nhưng ngữ cảnh chưa xác nhận"}.`, resolution);
    if (resolution) resolution.ocrOutcome = outcome;
  }
}
export class OcrTechnicalError extends Error {
  constructor(readonly cause: unknown) {
    super(`OCR_TECHNICAL: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OcrTechnicalError";
  }
}
export const normalizeTargetText = normalizeOcrText;
export function resolveOcrText(
  result: OcrResult,
  selection: NonNullable<NonNullable<Payload["target"]>["ocr"]>,
  offset: Rect,
): NonNullable<Result["match"]> {
  const matches = findOcrCandidates(result, selection);
  if (!matches.length) throw new OcrNotFound();
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
    throw new TargetNotConfident("OCR_INVALID_BBOX: OCR bounding box không hợp lệ.");
  if (
    !Number.isFinite(found.confidence) ||
    found.confidence < MIN_OCR_CONFIDENCE
  )
    throw new TargetNotConfident(
      `OCR_LOW_CONFIDENCE: OCR confidence ${found.confidence.toFixed(1)} < ${MIN_OCR_CONFIDENCE}. Không gửi action.`,
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
  searchRegion?: Rect,
  onOcr?: (event: { phase: "start" | "result"; offset: Rect; result?: OcrResult }) => void,
): Promise<NonNullable<Result["match"]> & { resolution: ResolutionTrace }> {
  const target = payload.target!;
  // Match To explicitly searches the visible OCR region after bounded scrolling.
  if (target.ocr?.confirmed && effectiveMatchTo(payload) !== "none") {
    const size = await sharp(frame).metadata();
    let result: OcrResult;
    const offset = { x: 0, y: 0, width: size.width!, height: size.height! };
    onOcr?.({ phase: "start", offset });
    try { result = await ocr.recognize(frame); onOcr?.({ phase: "result", offset, result }); }
    catch (error) { throw new OcrTechnicalError(error); }
    const withinRegion = (box: Rect) => !searchRegion ||
      (box.x+box.width/2 >= searchRegion.x && box.x+box.width/2 <= searchRegion.x+searchRegion.width &&
       box.y+box.height/2 >= searchRegion.y && box.y+box.height/2 <= searchRegion.y+searchRegion.height);
    const trace: ResolutionTrace = { mode: "auto", attempts: [], context: [] };
    const allCandidates = findOcrCandidates(result, target.ocr);
    const candidates = allCandidates.filter(candidate => withinRegion(candidate.bbox));
    for (const candidate of allCandidates.filter(candidate => !withinRegion(candidate.bbox)))
      trace.attempts.push({ method: "ocr", outcome: "not_confident", confidence: candidate.confidence,
        reason: "OUTSIDE_SCROLL_CONTAINER", x: candidate.bbox.x+candidate.bbox.width/2, y: candidate.bbox.y+candidate.bbox.height/2 });
    // Preserve complete line/word evidence until candidates have been assembled.
    // Context can use all text visible inside the container, including at its edges.
    const contextOcr = { ...result, segments: result.segments.filter(segment => withinRegion(segment.bbox)) };
    if (!candidates.length) throw new OcrNotFound(trace);
    if (candidates.length > 32) throw new TargetNotConfident("CONTEXT_AMBIGUOUS: quá nhiều dòng chữ trùng trong viewport; không click.", trace, true);
    const confirmed: NonNullable<Result["match"]>[] = [];
    let confidentCandidates = 0;
    let edgeCandidate: Rect | undefined;
    for (const candidate of candidates) {
      let found: NonNullable<Result["match"]>;
      try {
        found = resolveOcrText({ ...result, segments: [candidate] }, target.ocr,
          { x: 0, y: 0, width: size.width!, height: size.height! });
      } catch (error) {
        if (!(error instanceof TargetNotConfident) || !error.message.startsWith("OCR_LOW_CONFIDENCE")) throw error;
        trace.attempts.push({ method: "ocr", outcome: "not_confident", reason: (error as Error).message,
          x: candidate.bbox.x+candidate.bbox.width/2, y: candidate.bbox.y+candidate.bbox.height/2, confidence: candidate.confidence });
        continue;
      }
      confidentCandidates++;
      trace.attempts.push({ method: "ocr", outcome: "matched", x: found.x, y: found.y, confidence: found.confidence });
      let context: NonNullable<ResolutionTrace["context"]>[number];
      try { context = await confirmOcrContext(frame, template, payload, ocr, found, contextOcr, candidate.bbox, searchRegion); }
      catch (error) { throw new OcrTechnicalError(error); }
      trace.context!.push(context);
      if (context.reason.startsWith("CONTEXT_INSUFFICIENT")) {
        trace.ocrOutcome = "CONTEXT_REJECTED";
        throw new TargetNotConfident(`CONTEXT_REJECTED: ${context.reason}`, trace);
      }
      if (context.confirmed) confirmed.push(found);
      if (context.reason.startsWith("CONTEXT_EDGE_PENDING")) edgeCandidate = candidate.bbox;
    }
    if (trace.context!.some(context => context.reason.startsWith("CONTEXT_AMBIGUOUS")))
      throw new TargetNotConfident("CONTEXT_AMBIGUOUS: ngữ cảnh chưa phân biệt được các ứng viên; không click.", trace, true);
    if (confirmed.length > 1) throw new TargetNotConfident("CONTEXT_AMBIGUOUS: nhiều mục tiêu cùng chữ/ngữ cảnh; không click.", trace, true);
    if (!confirmed.length) throw new OcrNotFound(trace, confidentCandidates ? "CONTEXT_REJECTED" : "OCR_LOW_CONFIDENCE",
      confidentCandidates === 1 ? edgeCandidate : undefined);
    trace.selectedMethod = "ocr";
    return { ...confirmed[0], resolution: trace };
  }
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
  let viewportOcr: OcrResult | undefined;
  let ocrRejection: TargetNotConfident | undefined;
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
      onOcr?.({ phase: "start", offset: roi });
      const recognized = await ocr.recognize(image);
      onOcr?.({ phase: "result", offset: roi, result: recognized });
      viewportOcr = { ...recognized, segments: recognized.segments.map(segment => ({ ...segment,
        bbox: { ...segment.bbox, x: segment.bbox.x+roi.x, y: segment.bbox.y+roi.y } })) };
      textMatch = resolveOcrText(recognized, target.ocr, roi);
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
      if (error instanceof TargetNotConfident) {
        ocrRejection = error;
        trace.ocrOutcome = error instanceof OcrNotFound ? error.outcome
          : error.message.startsWith("OCR_LOW_CONFIDENCE") ? "OCR_LOW_CONFIDENCE" : undefined;
      }
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
    let context: NonNullable<ResolutionTrace["context"]>[number];
    try {
      // Re-read only this screenshot for textual context outside the old search ROI.
      // Keep the click coordinates from the original OCR match unchanged.
      const size = await sharp(frame).metadata();
      const offset = { x: 0, y: 0, width: size.width!, height: size.height! };
      onOcr?.({ phase: "start", offset });
      const fullOcr = await ocr.recognize(frame);
      onOcr?.({ phase: "result", offset, result: fullOcr });
      const candidates = findOcrCandidates(fullOcr, target.ocr!).filter(candidate => candidate.confidence >= MIN_OCR_CONFIDENCE);
      if (candidates.length > 1) throw new TargetNotConfident("CONTEXT_AMBIGUOUS: nhiều ứng viên OCR trong viewport hiện tại; không click.", trace, true);
      const box = findOcrCandidates(viewportOcr!, target.ocr!).find(candidate =>
        Math.abs(candidate.bbox.x+candidate.bbox.width/2-textMatch!.x) <= 1 &&
        Math.abs(candidate.bbox.y+candidate.bbox.height/2-textMatch!.y) <= 1)?.bbox;
      context = await confirmOcrContext(frame, template, payload, ocr, textMatch, fullOcr, box);
    } catch (error) {
      if (error instanceof TargetNotConfident) throw error;
      throw new OcrTechnicalError(error);
    }
    trace.context = [context];
    if (!context.confirmed) { trace.ocrOutcome = "CONTEXT_REJECTED"; throw new TargetNotConfident(`CONTEXT_REJECTED: ${context.reason}`, trace); }
    trace.selectedMethod = "ocr";
    return { ...textMatch, resolution: trace };
  }
  if (ocrRejection) throw new TargetNotConfident(ocrRejection.message, trace, ocrRejection.ambiguous);
  return block(
    "Không xác định được target đủ tin cậy bằng AUTO. Chưa gửi click/nhập; hãy Redesign target.",
  );
}
