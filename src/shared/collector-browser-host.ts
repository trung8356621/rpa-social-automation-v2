import type { AppPage, Rect } from "./contracts.js";

/** Measured Capture workspace hole in shell window DIP (from getBoundingClientRect). */
export type CollectorBrowserHost = Rect & { active: boolean };

export function shouldShowBrowserForPage(opts: {
  page: AppPage;
  browserVisible: boolean;
  collectorHostActive: boolean;
}): boolean {
  if (!opts.browserVisible) return false;
  if (opts.page === "creator" || opts.page === "studio-run") return true;
  if (opts.page === "collectors") return opts.collectorHostActive;
  return false;
}

export function resolveBrowserViewBounds(opts: {
  page: AppPage;
  collectorHost: CollectorBrowserHost | null;
  creatorBrowser: Rect;
}): Rect {
  const host = opts.collectorHost;
  if (
    opts.page === "collectors" &&
    host?.active &&
    Number.isFinite(host.x) &&
    Number.isFinite(host.y) &&
    host.width >= 4 &&
    host.height >= 4
  ) {
    return {
      x: Math.round(host.x),
      y: Math.round(host.y),
      width: Math.round(host.width),
      height: Math.round(host.height),
    };
  }
  return opts.creatorBrowser;
}

/** Convert a DOM rect into shell DIP, undoing admin CSS zoom when present. */
export function domRectToShellBounds(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  cssZoom = 1,
): Rect {
  const zoom = cssZoom > 0 ? cssZoom : 1;
  return {
    x: Math.round(rect.left / zoom),
    y: Math.round(rect.top / zoom),
    width: Math.max(4, Math.round(rect.width / zoom)),
    height: Math.max(4, Math.round(rect.height / zoom)),
  };
}

/**
 * Map shell DIP browser bounds into CSS `position:fixed` coords under admin UI zoom.
 * Native WebContentsView uses shell DIP; the React freeze overlay lives in the zoomed document.
 */
export function shellBoundsToCssFixed(bounds: Rect, cssZoom = 1): Rect {
  const zoom = cssZoom > 0 ? cssZoom : 1;
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(4, Math.round(bounds.width * zoom)),
    height: Math.max(4, Math.round(bounds.height * zoom)),
  };
}

/**
 * Aspect-preserving placement of a capture image inside a CSS display rect.
 * Prefer exact fill when aspects match (viewport-faithful freeze); otherwise contain.
 */
export function fitCaptureImageInDisplay(
  displayWidth: number,
  displayHeight: number,
  imageWidth: number,
  imageHeight: number,
  aspectEpsilon = 0.02,
): Rect {
  if (!(displayWidth > 0) || !(displayHeight > 0) || imageWidth < 1 || imageHeight < 1) {
    return {
      x: 0,
      y: 0,
      width: Math.max(0, displayWidth),
      height: Math.max(0, displayHeight),
    };
  }
  const displayAspect = displayWidth / displayHeight;
  const imageAspect = imageWidth / imageHeight;
  if (Math.abs(displayAspect - imageAspect) <= aspectEpsilon) {
    return { x: 0, y: 0, width: displayWidth, height: displayHeight };
  }
  const scale = Math.min(displayWidth / imageWidth, displayHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (displayWidth - width) / 2,
    y: (displayHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Map a pointer in CSS client space onto screenshot pixel / crop coordinates.
 * When `content` is set (image box inside the freeze surface), mapping uses that box.
 */
export function clientPointToCaptureCoords(
  clientX: number,
  clientY: number,
  display: Pick<DOMRect, "left" | "top" | "width" | "height">,
  imageWidth: number,
  imageHeight: number,
  content?: Pick<Rect, "x" | "y" | "width" | "height">,
): { x: number; y: number } {
  const box = content
    ? {
        left: display.left + content.x,
        top: display.top + content.y,
        width: content.width,
        height: content.height,
      }
    : display;
  if (!(box.width > 0) || !(box.height > 0) || imageWidth < 1 || imageHeight < 1) {
    return { x: 0, y: 0 };
  }
  const x = ((clientX - box.left) * imageWidth) / box.width;
  const y = ((clientY - box.top) * imageHeight) / box.height;
  return {
    x: Math.max(0, Math.min(imageWidth, x)),
    y: Math.max(0, Math.min(imageHeight, y)),
  };
}

/** Pure Capture UX phase machine (no DOM). Scroll is preserved by never re-navigating. */
export type CollectorCapturePhase = "browse" | "frozen";

export function nextCollectorCapturePhase(
  phase: CollectorCapturePhase,
  action: "captureRegion" | "confirm" | "cancel" | "leaveStep",
): CollectorCapturePhase {
  if (action === "leaveStep") return "browse";
  if (action === "captureRegion") return "frozen";
  if (action === "confirm" || action === "cancel") return "browse";
  return phase;
}

/** Commands used to leave freeze without changing URL/scroll (visibility only). */
export function collectorBrowseRestoreCommands(): ReadonlyArray<{ type: "browserVisible"; visible: boolean }> {
  return [{ type: "browserVisible", visible: true }];
}

/** Finalize a drag into a crop ROI in image coordinates (null if too small). */
export function dragToCaptureRoi(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minSize = 4,
): Rect | null {
  const x = Math.round(Math.min(startX, endX));
  const y = Math.round(Math.min(startY, endY));
  const width = Math.round(Math.abs(endX - startX));
  const height = Math.round(Math.abs(endY - startY));
  if (width < minSize || height < minSize) return null;
  return { x, y, width, height };
}

/** Resize only the right/bottom edges; the selected ROI's top-left never moves. */
export function resizeCaptureRoi(
  original: Rect,
  edge: "right" | "bottom" | "corner",
  pointerX: number,
  pointerY: number,
  imageWidth: number,
  imageHeight: number,
  minSize = 4,
): Rect {
  const maxWidth = Math.max(minSize, imageWidth - original.x);
  const maxHeight = Math.max(minSize, imageHeight - original.y);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
  return {
    x: original.x,
    y: original.y,
    width: edge === "bottom" ? original.width : clamp(pointerX - original.x, minSize, maxWidth),
    height: edge === "right" ? original.height : clamp(pointerY - original.y, minSize, maxHeight),
  };
}

/**
 * Crop extract rect in PNG pixels when Capture.width/height are image pixels
 * and the ROI was drawn in the same image space (1:1). Validates fit.
 */
export function assertRoiFitsCapture(roi: Rect, imageWidth: number, imageHeight: number): Rect {
  if (
    !Number.isFinite(roi.x) ||
    !Number.isFinite(roi.y) ||
    !Number.isFinite(roi.width) ||
    !Number.isFinite(roi.height) ||
    roi.width < 4 ||
    roi.height < 4 ||
    roi.x < 0 ||
    roi.y < 0 ||
    roi.x + roi.width > imageWidth ||
    roi.y + roi.height > imageHeight
  ) {
    throw new Error(
      `ROI ${roi.width}×${roi.height} at ${roi.x},${roi.y} does not fit capture ${imageWidth}×${imageHeight}.`,
    );
  }
  return {
    x: Math.round(roi.x),
    y: Math.round(roi.y),
    width: Math.round(roi.width),
    height: Math.round(roi.height),
  };
}
