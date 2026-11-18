import type { OcrSegment, Rect, VisualTarget } from "./contracts.js";

/** Clamp OCR bbox into the target asset (ROI-local) so save validation cannot reject a confirm. */
export function clampOcrBboxToRoi(bbox: Rect, roi: Rect): Rect {
  const maxX = Math.max(0, roi.width);
  const maxY = Math.max(0, roi.height);
  const x = Math.max(0, Math.min(Math.floor(bbox.x), Math.max(0, maxX - 1)));
  const y = Math.max(0, Math.min(Math.floor(bbox.y), Math.max(0, maxY - 1)));
  const width = Math.max(1, Math.min(Math.ceil(bbox.width), maxX - x));
  const height = Math.max(1, Math.min(Math.ceil(bbox.height), maxY - y));
  return { x, y, width, height };
}

export type OcrKind = "line" | "word" | "block";

/** Build confirmed OCR payload for the target draft — always includes a valid kind. */
export function confirmedOcrFromSegment(
  segment: OcrSegment,
  roi: Rect,
  fallbackKind: OcrKind = "line",
): NonNullable<VisualTarget["ocr"]> & { kind: OcrKind } {
  const kind: OcrKind =
    segment.kind === "line" || segment.kind === "word" || segment.kind === "block"
      ? segment.kind
      : fallbackKind;
  return {
    text: segment.text,
    bbox: clampOcrBboxToRoi(segment.bbox, roi),
    confidence: segment.confidence,
    kind,
    language: "vie+eng",
    confirmed: true,
  };
}

export function ocrKindFromTarget(target?: VisualTarget): "none" | OcrKind {
  const kind = target?.ocr?.confirmed ? target.ocr.kind : undefined;
  return kind === "line" || kind === "word" || kind === "block" ? kind : "none";
}
