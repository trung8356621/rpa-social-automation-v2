import type { Rect } from "./contracts.js";
import { validateRect } from "./geometry.js";

/** FlaUI / UIA-accessible names for Creator Crop Modal numeric fields. */
export const CROP_ROI_FIELD_LABELS = {
  x: "ROI X",
  y: "ROI Y",
  width: "ROI Width",
  height: "ROI Height",
} as const;

export const CROP_ROI_GROUP_LABEL = "ROI numeric coordinates";
export const CROP_ROI_CONFIRM_LABEL = "Dùng ROI";

export type CropRoiFieldKey = keyof typeof CROP_ROI_FIELD_LABELS;
export type CropRoiFields = Record<CropRoiFieldKey, string>;

export function emptyCropRoiFields(): CropRoiFields {
  return { x: "", y: "", width: "", height: "" };
}

export function cropRoiFieldsFromRect(roi: Rect): CropRoiFields {
  return {
    x: String(roi.x),
    y: String(roi.y),
    width: String(roi.width),
    height: String(roi.height),
  };
}

export type ParseCropRoiResult =
  | { ok: true; roi: Rect }
  | { ok: false; error: string };

/**
 * Parse numeric ROI fields in image/DIP coordinate space.
 * Does not clamp out-of-bounds or negative values — rejects instead.
 */
export function parseCropRoiFields(
  fields: CropRoiFields,
  imageWidth: number,
  imageHeight: number,
): ParseCropRoiResult {
  const raw = [fields.x, fields.y, fields.width, fields.height];
  if (raw.some((value) => value.trim() === "")) {
    return { ok: false, error: "ROI thiếu tọa độ." };
  }
  const x = Number(fields.x);
  const y = Number(fields.y);
  const width = Number(fields.width);
  const height = Number(fields.height);
  if (![x, y, width, height].every(Number.isFinite)) {
    return { ok: false, error: "ROI không hợp lệ." };
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, error: "ROI Width/Height phải lớn hơn 0." };
  }
  if (x < 0 || y < 0) {
    return { ok: false, error: "ROI X/Y không được âm." };
  }
  try {
    return { ok: true, roi: validateRect({ x, y, width, height }, imageWidth, imageHeight) };
  } catch (error) {
    return { ok: false, error: String((error as Error).message || error) };
  }
}

/** True when ROI is ready for the existing "Dùng ROI" / saveCrop path. */
export function canConfirmCropRoi(
  roi: Rect | undefined,
  imageWidth: number,
  imageHeight: number,
): boolean {
  if (!roi) return false;
  return parseCropRoiFields(cropRoiFieldsFromRect(roi), imageWidth, imageHeight).ok;
}

/**
 * Map a pointer position from displayed screenshot pixels to image DIP coordinates.
 * When display size ≠ image size (CSS scale / zoom), converts proportionally.
 * Pointer path clamps to image edges (same as prior drag behavior).
 */
export function displayToImagePoint(
  clientX: number,
  clientY: number,
  display: Pick<DOMRect, "left" | "top" | "width" | "height">,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  if (
    ![clientX, clientY, display.left, display.top, display.width, display.height, imageWidth, imageHeight].every(
      Number.isFinite,
    ) ||
    display.width <= 0 ||
    display.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    throw new Error("ROI display mapping không hợp lệ.");
  }
  const x = ((clientX - display.left) / display.width) * imageWidth;
  const y = ((clientY - display.top) / display.height) * imageHeight;
  return {
    x: Math.max(0, Math.min(imageWidth, x)),
    y: Math.max(0, Math.min(imageHeight, y)),
  };
}

/** Build a drag ROI preview in image coordinates (may be below confirmable size). */
export function roiFromDragPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Rect {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y)),
  };
}
