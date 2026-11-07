import type { Rect } from "../contracts.js";

/** Collector scrolling-capture session phases (main + renderer). */
export type ScrollCapturePhase =
  | "IDLE"
  | "INITIAL_FRAME"
  | "ROI_SELECTED"
  | "EXTENDING"
  | "READY"
  | "CONFIRMED"
  | "CANCELLED"
  | "FAILED";

export type ScrollCaptureAction =
  | "begin"
  | "selectRoi"
  | "resetRoi"
  | "extendStart"
  | "extendOk"
  | "extendFail"
  | "confirm"
  | "cancel"
  | "sessionChange"
  | "navigateAway";

/**
 * Measured safe limits for Electron + Sharp stitching.
 * Chosen to stay under ~80MB RGBA accumulation and avoid multi-minute sessions.
 */
export const SCROLL_CAPTURE_LIMITS = Object.freeze({
  maxFrames: 24,
  maxHeightPx: 12_000,
  maxWidthPx: 4_000,
  maxBufferBytes: 80 * 1024 * 1024,
  settleMs: 450,
  minOverlapPx: 24,
  maxStickyPx: 180,
  /** Mean absolute difference (0–255); above → ALIGN_FAILED. */
  maxMad: 22,
  defaultScrollCssPx: 280,
  minNewContentPx: 8,
  /** Renderer/main bound for one extend (scroll+capture+align+stitch). */
  extendTimeoutMs: 12_000,
  /** Min ms between ROI-edge auto-extend requests. */
  edgeAutoScrollMs: 550,
  /** CSS px from Capture viewport bottom that arms edge auto-scroll. */
  edgeZonePx: 28,
  /** Preview considered at end when within this many CSS px of scrollHeight. */
  previewEndEpsilonPx: 3,
});

/** Decide whether a wheel/scroll gesture should extend the browser capture vs pan the preview. */
export function shouldExtendFromPreviewScroll(opts: {
  deltaY: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  epsilonPx?: number;
}): "preview" | "extend" | "ignore" {
  const eps = opts.epsilonPx ?? SCROLL_CAPTURE_LIMITS.previewEndEpsilonPx;
  if (!(opts.deltaY > 0)) {
    // Scroll up — only pan preview (never reverse-extend).
    return opts.scrollTop > 0 ? "preview" : "ignore";
  }
  const atEnd = opts.scrollTop + opts.clientHeight >= opts.scrollHeight - eps;
  return atEnd ? "extend" : "preview";
}

/** ROI bottom/corner pointer near the Capture viewport bottom edge. */
export function isRoiEdgeAutoScrollArmed(opts: {
  edge: "right" | "bottom" | "corner";
  pointerClientY: number;
  viewportTop: number;
  viewportHeight: number;
  zonePx?: number;
}): boolean {
  if (opts.edge === "right") return false;
  const zone = opts.zonePx ?? SCROLL_CAPTURE_LIMITS.edgeZonePx;
  return opts.pointerClientY >= opts.viewportTop + opts.viewportHeight - zone;
}

export type AlignFailureReason =
  | "WIDTH_MISMATCH"
  | "EMPTY"
  | "NO_NEW_CONTENT"
  | "ALIGN_FAILED"
  | "LIMIT_FRAMES"
  | "LIMIT_HEIGHT"
  | "LIMIT_MEMORY";

export type AlignOk = {
  ok: true;
  overlapPx: number;
  stickyPx: number;
  newContentPx: number;
  score: number;
};

export type AlignFail = {
  ok: false;
  reason: AlignFailureReason;
  score?: number;
  message: string;
};

export type AlignResult = AlignOk | AlignFail;

export function nextScrollCapturePhase(
  phase: ScrollCapturePhase,
  action: ScrollCaptureAction,
): ScrollCapturePhase {
  if (action === "cancel" || action === "sessionChange" || action === "navigateAway") {
    return phase === "IDLE" || phase === "CONFIRMED" ? phase : "CANCELLED";
  }
  switch (action) {
    case "begin":
      return "INITIAL_FRAME";
    case "selectRoi":
      return phase === "INITIAL_FRAME" || phase === "ROI_SELECTED" || phase === "READY" || phase === "EXTENDING"
        ? "ROI_SELECTED"
        : phase;
    case "resetRoi":
      return phase === "IDLE" || phase === "CONFIRMED" || phase === "CANCELLED" ? phase : "INITIAL_FRAME";
    case "extendStart":
      return phase === "ROI_SELECTED" || phase === "READY" || phase === "EXTENDING" ? "EXTENDING" : phase;
    case "extendOk":
      return phase === "EXTENDING" ? "READY" : phase;
    case "extendFail":
      return phase === "EXTENDING" ? "FAILED" : phase;
    case "confirm":
      return phase === "ROI_SELECTED" || phase === "READY" || phase === "EXTENDING" ? "CONFIRMED" : phase;
    default:
      return phase;
  }
}

/** Lock top-left after first ROI; only right/bottom/corner may grow. */
export function applyImmutableAnchorRoi(
  previous: Rect | undefined,
  next: Rect,
): Rect {
  if (!previous) return { ...next };
  return {
    x: previous.x,
    y: previous.y,
    width: next.width,
    height: next.height,
  };
}

function rowSlice(
  gray: Uint8Array,
  width: number,
  row: number,
  col0: number,
  col1: number,
): Uint8Array {
  const start = row * width + col0;
  return gray.subarray(start, row * width + col1);
}

function madRows(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  aRow0: number,
  bRow0: number,
  rows: number,
  col0: number,
  col1: number,
): number {
  if (rows <= 0 || col1 <= col0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let n = 0;
  const cols = col1 - col0;
  for (let r = 0; r < rows; r++) {
    const ra = rowSlice(a, width, aRow0 + r, col0, col1);
    const rb = rowSlice(b, width, bRow0 + r, col0, col1);
    for (let c = 0; c < cols; c++) {
      sum += Math.abs(ra[c]! - rb[c]!);
      n++;
    }
  }
  return n ? sum / n : Number.POSITIVE_INFINITY;
}

/** Detect sticky/fixed top band that is unchanged between consecutive frames. */
export function detectStickyTopPx(
  prev: { width: number; height: number; gray: Uint8Array },
  next: { width: number; height: number; gray: Uint8Array },
  maxSticky: number = SCROLL_CAPTURE_LIMITS.maxStickyPx,
  maxMad: number = SCROLL_CAPTURE_LIMITS.maxMad,
): number {
  if (prev.width !== next.width || prev.height < 8 || next.height < 8) return 0;
  const limit = Math.min(maxSticky, Math.floor(Math.min(prev.height, next.height) * 0.35));
  let sticky = 0;
  // Grow only while each newly added band is nearly identical (avoids diluting MAD).
  for (let h = 2; h <= limit; h += 2) {
    const band = madRows(prev.gray, next.gray, prev.width, h - 2, h - 2, 2, 0, prev.width);
    if (band <= 1) sticky = h;
    else break;
  }
  return sticky;
}

/**
 * Align next viewport under prev using overlap search on grayscale bytes.
 * Does not trust requested scroll deltas — image evidence only.
 */
export function alignVerticalFrames(
  prev: { width: number; height: number; gray: Uint8Array },
  next: { width: number; height: number; gray: Uint8Array },
  opts?: {
    minOverlap?: number;
    maxSticky?: number;
    maxMad?: number;
    minNewContent?: number;
  },
): AlignResult {
  if (!prev.width || !prev.height || !next.width || !next.height) {
    return { ok: false, reason: "EMPTY", message: "Empty frame — cannot align." };
  }
  if (prev.width !== next.width) {
    return {
      ok: false,
      reason: "WIDTH_MISMATCH",
      message: `Viewport width changed (${prev.width}→${next.width}); abort extend.`,
    };
  }
  const minOverlap = opts?.minOverlap ?? SCROLL_CAPTURE_LIMITS.minOverlapPx;
  const maxMad = opts?.maxMad ?? SCROLL_CAPTURE_LIMITS.maxMad;
  const minNew = opts?.minNewContent ?? SCROLL_CAPTURE_LIMITS.minNewContentPx;
  const col0 = Math.floor(prev.width * 0.08);
  const col1 = Math.floor(prev.width * 0.92);
  const compareH = Math.min(prev.height, next.height);
  const fullMad = madRows(prev.gray, next.gray, prev.width, 0, 0, compareH, col0, col1);
  if (fullMad <= maxMad * 0.5) {
    return {
      ok: false,
      reason: "NO_NEW_CONTENT",
      score: fullMad,
      message: "Scroll produced no new content (boundary or stalled).",
    };
  }

  const stickyPx = detectStickyTopPx(prev, next, opts?.maxSticky, maxMad);
  const contentPrevH = prev.height - stickyPx;
  const contentNextH = next.height - stickyPx;
  if (contentPrevH < minOverlap || contentNextH < minOverlap) {
    return {
      ok: false,
      reason: "ALIGN_FAILED",
      message: "Not enough content below sticky header to align.",
    };
  }

  const maxOverlap = Math.min(contentPrevH, contentNextH, Math.floor(Math.min(prev.height, next.height) * 0.9));
  let bestOverlap = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += 1) {
    const score = madRows(
      prev.gray,
      next.gray,
      prev.width,
      stickyPx + contentPrevH - overlap,
      stickyPx,
      overlap,
      col0,
      col1,
    );
    // Prefer larger overlap when scores tie (more shared content removed).
    if (score < bestScore - 0.05 || (Math.abs(score - bestScore) <= 0.05 && overlap > bestOverlap)) {
      bestScore = score;
      bestOverlap = overlap;
    }
  }

  if (!(bestOverlap >= minOverlap) || !(bestScore <= maxMad)) {
    return {
      ok: false,
      reason: "ALIGN_FAILED",
      score: bestScore,
      message: `Could not verify overlap (best MAD ${bestScore.toFixed(1)} > ${maxMad}). Last valid image kept.`,
    };
  }

  const newContentPx = next.height - stickyPx - bestOverlap;
  if (newContentPx < minNew) {
    return {
      ok: false,
      reason: "NO_NEW_CONTENT",
      score: bestScore,
      message: "Scroll produced no new content (boundary or stalled).",
    };
  }

  return {
    ok: true,
    overlapPx: bestOverlap,
    stickyPx,
    newContentPx,
    score: bestScore,
  };
}

export function assertWithinScrollCaptureLimits(opts: {
  frameCount: number;
  width: number;
  height: number;
  bufferBytes: number;
}): AlignFail | null {
  const L = SCROLL_CAPTURE_LIMITS;
  if (opts.frameCount > L.maxFrames) {
    return {
      ok: false,
      reason: "LIMIT_FRAMES",
      message: `Frame limit ${L.maxFrames} reached. Confirm current image or Cancel.`,
    };
  }
  if (opts.width > L.maxWidthPx) {
    return {
      ok: false,
      reason: "LIMIT_HEIGHT",
      message: `Width ${opts.width}px exceeds limit ${L.maxWidthPx}px.`,
    };
  }
  if (opts.height > L.maxHeightPx) {
    return {
      ok: false,
      reason: "LIMIT_HEIGHT",
      message: `Height ${opts.height}px exceeds limit ${L.maxHeightPx}px.`,
    };
  }
  if (opts.bufferBytes > L.maxBufferBytes) {
    return {
      ok: false,
      reason: "LIMIT_MEMORY",
      message: `Capture buffer exceeds ${(L.maxBufferBytes / (1024 * 1024)).toFixed(0)}MB safe limit.`,
    };
  }
  return null;
}

/** Crop ROI in accumulated image pixel space after optional auto-grow of bottom edge. */
export function growRoiBottom(roi: Rect, imageHeight: number, minSize = 4): Rect {
  return {
    x: roi.x,
    y: roi.y,
    width: roi.width,
    height: Math.max(minSize, Math.min(imageHeight - roi.y, Math.max(roi.height, imageHeight - roi.y))),
  };
}
