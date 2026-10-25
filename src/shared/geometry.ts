import type { Rect } from "./contracts.js";
export const EXECUTION_VIEWPORT = Object.freeze({ width: 1024, height: 560 });
export const WEB_WIDTH = EXECUTION_VIEWPORT.width;
export const WEB_HEIGHT = EXECUTION_VIEWPORT.height;
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

export function assertCanonicalScreenshot(width?: number, height?: number) {
  if (width !== EXECUTION_VIEWPORT.width || height !== EXECUTION_VIEWPORT.height)
    throw new Error(
      `Screenshot viewport mismatch: expected ${EXECUTION_VIEWPORT.width}×${EXECUTION_VIEWPORT.height}, got ${width ?? "unknown"}×${height ?? "unknown"}. Không scale ảnh hoặc tọa độ.`,
    );
}

export const EDITOR_WIDTH = 352;
export const APP_NAV_EXPANDED = 208;
export const APP_NAV_COLLAPSED = 56;
/** Preserve the native viewport. Controls move to its right, never over it. */
export function workspaceLayout(
  editorOpen: boolean,
  debugOpen: boolean,
  contentWidth: number,
  contentHeight: number,
  sidebarCollapsed = false,
  executionMode = false,
) {
  const requestedNav = sidebarCollapsed ? APP_NAV_COLLAPSED : APP_NAV_EXPANDED;
  const navigationWidth = contentWidth >= WEB_WIDTH + SIDE_WIDTH + requestedNav ? requestedNav
    : contentWidth >= WEB_WIDTH + SIDE_WIDTH + APP_NAV_COLLAPSED ? APP_NAV_COLLAPSED : 0;
  const editorBeside = editorOpen && contentWidth >= navigationWidth + WEB_WIDTH + SIDE_WIDTH + EDITOR_WIDTH;
  const controlsWidth = SIDE_WIDTH + (editorBeside ? EDITOR_WIDTH : 0);
  const x = navigationWidth + Math.max(0, Math.floor((contentWidth - navigationWidth - WEB_WIDTH - controlsWidth) / 2));
  const workspaceHeight = Math.max(WEB_HEIGHT, contentHeight - TOP_HEIGHT);
  return {
    navigationWidth,
    minWidth: navigationWidth + WEB_WIDTH + controlsWidth,
    stepsLeft: x + WEB_WIDTH,
    editorLeft: x + WEB_WIDTH + (editorBeside ? SIDE_WIDTH : 0),
    editorWidth: editorBeside ? EDITOR_WIDTH : SIDE_WIDTH,
    editorBeside,
    browser: {
      x,
      y: TOP_HEIGHT,
      width: WEB_WIDTH,
      height: executionMode ? WEB_HEIGHT : workspaceHeight,
    },
    workspaceHeight,
    debug: {
      x,
      y: contentHeight - (debugOpen ? 200 : 36),
      width: Math.max(1, contentWidth - x),
      height: debugOpen ? 200 : 36,
    },
  };
}
