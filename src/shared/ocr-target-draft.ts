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

export function kindLabelVi(kind?: string): string {
  return kind === "word"
    ? "Từng từ"
    : kind === "block"
      ? "Khối chữ"
      : "Cả dòng chữ";
}

export function sameOcrSelection(
  a?: Pick<NonNullable<VisualTarget["ocr"]>, "text" | "kind" | "bbox">,
  b?: Pick<NonNullable<VisualTarget["ocr"]>, "text" | "kind" | "bbox">,
): boolean {
  if (!a || !b) return false;
  return (
    a.text === b.text
    && a.kind === b.kind
    && a.bbox.x === b.bbox.x
    && a.bbox.y === b.bbox.y
    && a.bbox.width === b.bbox.width
    && a.bbox.height === b.bbox.height
  );
}

export type OcrModalStatusCode = "none" | "saved" | "pending-mode" | "dirty";

/** Modal copy — never treat a live OCR scan as a saved confirmation. */
export function ocrModalStatus(input: {
  ocrKind: "none" | OcrKind;
  draftOcr?: VisualTarget["ocr"];
  savedOcr?: VisualTarget["ocr"];
}): { code: OcrModalStatusCode; label: string } {
  const draft = input.draftOcr?.confirmed ? input.draftOcr : undefined;
  const saved = input.savedOcr?.confirmed ? input.savedOcr : undefined;
  if (draft) {
    if (!sameOcrSelection(draft, saved)) {
      return {
        code: "dirty",
        label: `OCR thay đổi chưa lưu: ${kindLabelVi(draft.kind)} — ${draft.text}`,
      };
    }
    return {
      code: "saved",
      label: `OCR đã lưu: ${kindLabelVi(draft.kind)} — ${draft.text}`,
    };
  }
  if (input.ocrKind !== "none") {
    return {
      code: "pending-mode",
      label: `OCR chưa xác nhận: đã chọn “${kindLabelVi(input.ocrKind)}” — bấm một đoạn chữ bên dưới rồi Xong / Lưu.`,
    };
  }
  return { code: "none", label: "OCR chưa dùng (image-only)." };
}
