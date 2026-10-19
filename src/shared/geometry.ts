import type { Rect } from "./contracts.js";
export const WEB_WIDTH = 1024;
export const WEB_HEIGHT = 560;
export const SIDE_WIDTH = 320;
export const TOP_HEIGHT = 88;
export function validateZoom(value: number) {
  if (![1, 0.9, 0.8].includes(value))
    throw new Error("Zoom hỗ trợ: 100%, 90%, 80%.");
  return value;
}
export function validateRect(rect: Rect, width: number, height: number): Rect {
  if (!rect || !Object.values(rect).every(Number.isFinite))
    throw new Error("ROI không hợp lệ.");
  const r = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  if (
    r.x < 0 ||
    r.y < 0 ||
    r.width < 4 ||
    r.height < 4 ||
    r.x + r.width > width ||
    r.y + r.height > height
  )
    throw new Error("ROI nằm ngoài ảnh hoặc nhỏ hơn 4 px.");
  return r;
}
// Captures are normalized to view DIPs. Input uses view DIPs; CSS = DIP / zoom.
export function imageToInput(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  bounds: Rect,
) {
  if (
    ![x, y, imageWidth, imageHeight].every(Number.isFinite) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    x >= imageWidth ||
    y >= imageHeight
  )
    throw new Error("Điểm ngoài ảnh.");
  return {
    x: Math.floor((x * bounds.width) / imageWidth),
    y: Math.floor((y * bounds.height) / imageHeight),
  };
}

export const EDITOR_WIDTH = 352;
/** Two canonical viewport widths, independent of fullscreen/restore. */
export function workspaceLayout(
  editorOpen: boolean,
  debugOpen: boolean,
  contentWidth: number,
  contentHeight: number,
) {
  const x = SIDE_WIDTH + (editorOpen ? EDITOR_WIDTH : 0);
  return {
    browser: {
      x,
      y: TOP_HEIGHT,
      width: WEB_WIDTH - (editorOpen ? EDITOR_WIDTH : 0),
      height: WEB_HEIGHT,
    },
    debug: {
      x,
      y: contentHeight - (debugOpen ? 200 : 36),
      width: Math.max(1, contentWidth - x),
      height: debugOpen ? 200 : 36,
    },
  };
}
