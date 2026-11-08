import type { Rect } from "../contracts.js";
import { clientPointToCaptureCoords } from "../collector-browser-host.js";
import { SCROLL_CAPTURE_LIMITS } from "./scrolling-capture.js";

/**
 * C2.5.4 coordinate / ownership contract
 *
 * 1. Accumulated image (width/height, PNG) — owned by scroll-capture session.
 * 2. Preview viewport scroll (scrollTop/scrollLeft) — owned by the preview scroller only.
 * 3. ROI geometry — image-pixel coords; after first select, x/y (anchor) are immutable;
 *    only width/height change via user resize intent.
 *
 * Mapping: client → image uses the scrolled canvas origin:
 *   canvasClientLeft = scrollerRect.left - scrollLeft
 *   canvasClientTop  = scrollerRect.top  - scrollTop
 * then scale by imageBoxCss → image pixels.
 *
 * Preview scroll must never rewrite ROI. Extend must never auto-grow ROI height.
 */

export type PreviewScrollerGeom = {
  left: number;
  top: number;
  scrollLeft: number;
  scrollTop: number;
};

/** C2.5.5: no preview_up — upward resize is pointer-owned; auto-scroll only expands downward. */
export type EdgeNavAction = "none" | "preview_down" | "browser_extend";

export function scrolledCanvasDisplay(
  scroller: PreviewScrollerGeom,
  imageBoxCss: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: scroller.left - scroller.scrollLeft,
    top: scroller.top - scroller.scrollTop,
    width: imageBoxCss.width,
    height: imageBoxCss.height,
  };
}

/** Client pointer → accumulated-image pixel coordinates (includes preview scroll). */
export function clientToImageCoords(
  clientX: number,
  clientY: number,
  scroller: PreviewScrollerGeom,
  imageBoxCss: { width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const display = scrolledCanvasDisplay(scroller, imageBoxCss);
  return clientPointToCaptureCoords(
    clientX,
    clientY,
    display,
    imageWidth,
    imageHeight,
    { x: 0, y: 0, width: imageBoxCss.width, height: imageBoxCss.height },
  );
}

/**
 * Clamp ROI to image bounds without expanding height/width beyond the user's selection.
 * Used after stitch when the image grows — never auto-grows ROI to the new bottom.
 */
export function clampRoiToImage(
  roi: Rect,
  anchor: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
  minSize = 4,
): Rect {
  const maxW = Math.max(minSize, imageWidth - anchor.x);
  const maxH = Math.max(minSize, imageHeight - anchor.y);
  return {
    x: anchor.x,
    y: anchor.y,
    width: Math.min(Math.max(minSize, roi.width), maxW),
    height: Math.min(Math.max(minSize, roi.height), maxH),
  };
}

/** Decide preview/browser edge navigation while a bottom/corner resize is held. */
export function resizeEdgeNavAction(opts: {
  edge: "right" | "bottom" | "corner";
  pointerClientY: number;
  viewportTop: number;
  viewportHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  zonePx?: number;
  epsilonPx?: number;
}): EdgeNavAction {
  if (opts.edge === "right") return "none";
  const zone = opts.zonePx ?? SCROLL_CAPTURE_LIMITS.edgeZonePx;
  const eps = opts.epsilonPx ?? SCROLL_CAPTURE_LIMITS.previewEndEpsilonPx;
  const bottom = opts.viewportTop + opts.viewportHeight;
  if (opts.pointerClientY >= bottom - zone) {
    const atEnd = opts.scrollTop + opts.clientHeight >= opts.scrollHeight - eps;
    return atEnd ? "browser_extend" : "preview_down";
  }
  // Near top: do not auto-scroll — competing with upward pointer shrink causes jitter.
  return "none";
}

/** CSS px step for held-edge preview navigation (per tick). */
export function edgePreviewScrollStep(): number {
  return SCROLL_CAPTURE_LIMITS.edgePreviewScrollPx;
}
