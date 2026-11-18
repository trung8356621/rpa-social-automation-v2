import type { Rect, VisualTarget } from "./contracts.js";

/** Center of confirmed OCR bbox in target-asset (ROI-local) pixels. */
export function ocrCenterInAsset(bbox: Rect): { x: number; y: number } {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

/** Suggested offset from OCR label center into a field below the label. */
export function suggestBelowLabelOffset(bbox: Rect): { x: number; y: number } {
  return { x: 0, y: Math.round(bbox.height / 2 + 14) };
}

/**
 * Predicted points on the target crop preview.
 * - imageCenter: AUTO image path clicks here (template / ROI center).
 * - ocrCenter: confirmed OCR label center (identity anchor).
 * - clickPoint: OCR path click = ocrCenter + clickOffset (textbox when offset set).
 */
export function predictedClickInAsset(target: VisualTarget): {
  imageCenter: { x: number; y: number };
  ocrCenter?: { x: number; y: number };
  clickPoint: { x: number; y: number };
  via: "roi-center" | "ocr-center" | "ocr-offset";
} {
  const imageCenter = {
    x: target.roi.width / 2,
    y: target.roi.height / 2,
  };
  if (!target.ocr?.confirmed) {
    return { imageCenter, clickPoint: imageCenter, via: "roi-center" };
  }
  const ocrCenter = ocrCenterInAsset(target.ocr.bbox);
  const ox = target.clickOffset?.x ?? 0;
  const oy = target.clickOffset?.y ?? 0;
  const clickPoint = { x: ocrCenter.x + ox, y: ocrCenter.y + oy };
  return {
    imageCenter,
    ocrCenter,
    clickPoint,
    via: ox !== 0 || oy !== 0 ? "ocr-offset" : "ocr-center",
  };
}

export function applyOcrClickOffset(
  x: number,
  y: number,
  offset?: { x: number; y: number },
): { x: number; y: number } {
  if (!offset) return { x, y };
  return { x: x + offset.x, y: y + offset.y };
}
