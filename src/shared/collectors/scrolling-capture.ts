import type { Rect } from "../contracts.js";

/**
 * Authoritative scrolling-capture operation lifecycle (main owns truth).
 *
 * Legal transitions (extend path):
 *   ROI_SELECTED|READY|RECOVERABLE_ERROR --extendStart→ EXTENDING
 *   EXTENDING --settle→ SETTLING --ok→ READY | --fail→ RECOVERABLE_ERROR
 *   READY|ROI_SELECTED|RECOVERABLE_ERROR --confirm→ CONFIRMING → CONFIRMED
 *   * --cancel|sessionChange|navigateAway→ CANCELLED
 *
 * EXTENDING rejects a second extend (main single-flight). FAILED kept as
 * legacy alias of RECOVERABLE_ERROR for older diagnostics strings.
 */
export type ScrollCapturePhase =
  | "IDLE"
  | "INITIAL_FRAME"
  | "ROI_SELECTED"
  | "EXTENDING"
  | "SETTLING"
  | "READY"
  | "RECOVERABLE_ERROR"
  | "CONFIRMING"
  | "CONFIRMED"
  | "CANCELLED"
  | "FAILED";

export type ScrollCaptureAction =
  | "begin"
  | "selectRoi"
  | "resetRoi"
  | "extendStart"
  | "extendSettle"
  | "extendOk"
  | "extendFail"
  | "confirm"
  | "confirmDone"
  | "cancel"
  | "sessionChange"
  | "navigateAway";

/** Stages timed during one extend (for timeout diagnosis). */
export type ExtendStageName =
  | "main_enter"
  | "scroll"
  | "settle"
  | "screenshot"
  | "decode"
  | "align"
  | "stitch"
  | "respond"
  | "ui_complete";

/** Cumulative mark (ms since op start). */
export type ExtendStageTiming = { stage: ExtendStageName | string; ms: number };

/** Per-stage wall duration for timeout diagnosis. */
export type ExtendStageDuration = {
  stage: ExtendStageName | string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

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
  /** Strict MAD for near-identical bands (sticky / unchanged screenshot). */
  maxMad: 22,
  /**
   * Robust per-row median MAD for geometry-verified overlap.
   * Higher than maxMad because FB video/animation dirties some rows; geometry must agree.
   */
  robustMad: 48,
  /** Fraction of overlap rows that must stay under maxMad when geometry is used. */
  minStableRowFraction: 0.28,
  defaultScrollCssPx: 280,
  minNewContentPx: 8,
  /** Allowed mismatch between CSS→px expected shift and optional pixel refine (px). */
  geometryRefineTolPx: 18,
  /** Renderer/main bound for one extend (scroll+capture+align+stitch). */
  extendTimeoutMs: 12_000,
  /** Min ms between ROI-edge auto-extend requests. */
  edgeAutoScrollMs: 550,
  /** CSS px from Capture viewport bottom that arms edge auto-scroll. */
  edgeZonePx: 28,
  /** Preview considered at end when within this many CSS px of scrollHeight. */
  previewEndEpsilonPx: 3,
  /** Wheel-at-end debounce: one extend per gesture burst (C2.5.3). */
  wheelDebounceMs: 200,
  /** Held ROI-edge preview scroll step (CSS px per animation tick). */
  edgePreviewScrollPx: 18,
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
  | "LAYOUT_SHIFT"
  | "LIMIT_FRAMES"
  | "LIMIT_HEIGHT"
  | "LIMIT_MEMORY";

export type AlignStrategy = "geometry+stable" | "geometry" | "pixel";

export type AlignOk = {
  ok: true;
  strategy: AlignStrategy;
  overlapPx: number;
  stickyPx: number;
  newContentPx: number;
  score: number;
  expectedShiftPx: number;
  stableRowFraction: number;
};

export type AlignFail = {
  ok: false;
  reason: AlignFailureReason;
  score?: number;
  message: string;
  expectedShiftPx?: number;
};

export type AlignResult = AlignOk | AlignFail;

export type ExtendFailureKind =
  | "BROWSER_SCROLL_FAILED"
  | "SCREENSHOT_UNCHANGED"
  | "ALIGN_FAILED"
  | "CONTAINER_REPLACED"
  | "LAYOUT_SHIFT"
  | "LIMIT"
  | "TIMEOUT"
  | "SUCCESS";

/** Structured extend diagnostics — no screenshot bytes / secrets. */
export type ExtendDiagnostics = {
  sessionId: string;
  containerId: string;
  scrollBefore: number;
  scrollAfter: number;
  scrollDeltaCss: number;
  viewportCssWidth: number;
  viewportCssHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
  strategy?: AlignStrategy | "none";
  score?: number;
  expectedShiftPx?: number;
  accepted: boolean;
  failureKind: ExtendFailureKind;
  message: string;
  /** Cumulative ms from main_enter for each completed stage. */
  stages?: ExtendStageTiming[];
  /** Wall-clock duration per stage (scroll/screenshot/align/stitch/…). */
  stageDurations?: ExtendStageDuration[];
  totalMs?: number;
  /** Stage that was in progress when timeout fired (if known). */
  timeoutStage?: string;
  singleFlight?: "accepted" | "rejected_busy" | "coalesced";
  /** Correlates one extend IPC with main logs. */
  operationId?: string;
  startedAt?: number;
  endedAt?: number;
};

/** Phases that may start a new extend (not already in-flight). */
export function canStartExtend(phase: ScrollCapturePhase): boolean {
  return phase === "ROI_SELECTED" || phase === "READY" || phase === "RECOVERABLE_ERROR" || phase === "FAILED";
}

/** Phases that may confirm the current PNG. */
export function canConfirmCapture(phase: ScrollCapturePhase): boolean {
  return phase === "ROI_SELECTED" || phase === "READY" || phase === "RECOVERABLE_ERROR" || phase === "FAILED";
}

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
      return phase === "INITIAL_FRAME" || phase === "ROI_SELECTED" || phase === "READY" || phase === "RECOVERABLE_ERROR" || phase === "FAILED"
        ? "ROI_SELECTED"
        : phase;
    case "resetRoi":
      return phase === "IDLE" || phase === "CONFIRMED" || phase === "CANCELLED" ? phase : "INITIAL_FRAME";
    case "extendStart":
      return canStartExtend(phase) ? "EXTENDING" : phase;
    case "extendSettle":
      return phase === "EXTENDING" ? "SETTLING" : phase;
    case "extendOk":
      return phase === "EXTENDING" || phase === "SETTLING" ? "READY" : phase;
    case "extendFail":
      return phase === "EXTENDING" || phase === "SETTLING" ? "RECOVERABLE_ERROR" : phase;
    case "confirm":
      return canConfirmCapture(phase) ? "CONFIRMING" : phase;
    case "confirmDone":
      return phase === "CONFIRMING" ? "CONFIRMED" : phase;
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

export type GrayFrame = { width: number; height: number; gray: Uint8Array };

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

function rowMadList(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  aRow0: number,
  bRow0: number,
  rows: number,
  col0: number,
  col1: number,
): number[] {
  const out: number[] = [];
  const cols = col1 - col0;
  if (rows <= 0 || cols <= 0) return out;
  for (let r = 0; r < rows; r++) {
    const ra = rowSlice(a, width, aRow0 + r, col0, col1);
    const rb = rowSlice(b, width, bRow0 + r, col0, col1);
    let sum = 0;
    for (let c = 0; c < cols; c++) sum += Math.abs(ra[c]! - rb[c]!);
    out.push(sum / cols);
  }
  return out;
}

function median(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Detect sticky/fixed top band that is unchanged between consecutive frames. */
export function detectStickyTopPx(
  prev: GrayFrame,
  next: GrayFrame,
  maxSticky: number = SCROLL_CAPTURE_LIMITS.maxStickyPx,
): number {
  if (prev.width !== next.width || prev.height < 8 || next.height < 8) return 0;
  const limit = Math.min(maxSticky, Math.floor(Math.min(prev.height, next.height) * 0.35));
  let sticky = 0;
  for (let h = 2; h <= limit; h += 2) {
    const band = madRows(prev.gray, next.gray, prev.width, h - 2, h - 2, 2, 0, prev.width);
    if (band <= 1) sticky = h;
    else break;
  }
  return sticky;
}

/** Map CSS scroll delta into screenshot pixels using viewport CSS height ↔ screenshot height. */
export function cssDeltaToScreenshotPx(
  scrollDeltaCss: number,
  viewportCssHeight: number,
  screenshotHeight: number,
): number {
  if (!(viewportCssHeight > 0) || !(screenshotHeight > 0) || !Number.isFinite(scrollDeltaCss)) return 0;
  return Math.round((scrollDeltaCss * screenshotHeight) / viewportCssHeight);
}

export type StableOverlapStats = {
  medianMad: number;
  meanMad: number;
  stableRowFraction: number;
};

/** Score overlap using side columns + row median (tolerant of center video animation). */
export function scoreOverlapRobust(
  prev: GrayFrame,
  next: GrayFrame,
  stickyPx: number,
  overlapPx: number,
  strictMad = SCROLL_CAPTURE_LIMITS.maxMad,
): StableOverlapStats {
  const contentPrevH = prev.height - stickyPx;
  const aRow0 = stickyPx + contentPrevH - overlapPx;
  const bRow0 = stickyPx;
  if (overlapPx < 4 || aRow0 < stickyPx || bRow0 < 0) {
    return { medianMad: Number.POSITIVE_INFINITY, meanMad: Number.POSITIVE_INFINITY, stableRowFraction: 0 };
  }
  const w = prev.width;
  const left0 = Math.floor(w * 0.04);
  const left1 = Math.floor(w * 0.22);
  const right0 = Math.floor(w * 0.78);
  const right1 = Math.floor(w * 0.96);
  const left = rowMadList(prev.gray, next.gray, w, aRow0, bRow0, overlapPx, left0, left1);
  const right = rowMadList(prev.gray, next.gray, w, aRow0, bRow0, overlapPx, right0, right1);
  const rows = left.map((v, i) => (v + (right[i] ?? v)) / 2);
  const meanMad = rows.reduce((s, v) => s + v, 0) / (rows.length || 1);
  const medianMad = median(rows);
  const stable = rows.filter((v) => v <= strictMad).length;
  return {
    medianMad,
    meanMad,
    stableRowFraction: rows.length ? stable / rows.length : 0,
  };
}

/**
 * Primary aligner: trust measured scroll displacement + scale, verify with stable side regions.
 * Falls back to pixel search only when geometry is unavailable (delta≈0 already handled upstream).
 */
export function alignExtendFrames(opts: {
  prev: GrayFrame;
  next: GrayFrame;
  scrollDeltaCss: number;
  viewportCssHeight: number;
  minOverlap?: number;
  minNewContent?: number;
  robustMad?: number;
  minStableRowFraction?: number;
}): AlignResult {
  const { prev, next } = opts;
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
  if (prev.height !== next.height) {
    return {
      ok: false,
      reason: "LAYOUT_SHIFT",
      message: `Screenshot height changed (${prev.height}→${next.height}); abort extend.`,
    };
  }

  const minOverlap = opts.minOverlap ?? SCROLL_CAPTURE_LIMITS.minOverlapPx;
  const minNew = opts.minNewContent ?? SCROLL_CAPTURE_LIMITS.minNewContentPx;
  const robustMad = opts.robustMad ?? SCROLL_CAPTURE_LIMITS.robustMad;
  const minStable = opts.minStableRowFraction ?? SCROLL_CAPTURE_LIMITS.minStableRowFraction;
  const col0 = Math.floor(prev.width * 0.08);
  const col1 = Math.floor(prev.width * 0.92);

  const fullMad = madRows(prev.gray, next.gray, prev.width, 0, 0, prev.height, col0, col1);
  if (fullMad <= SCROLL_CAPTURE_LIMITS.maxMad * 0.5) {
    return {
      ok: false,
      reason: "NO_NEW_CONTENT",
      score: fullMad,
      message: "Screenshot unchanged after scroll — no new content to append.",
    };
  }

  const stickyPx = detectStickyTopPx(prev, next);
  const contentH = prev.height - stickyPx;
  if (contentH < minOverlap + minNew) {
    return {
      ok: false,
      reason: "ALIGN_FAILED",
      message: "Not enough content below sticky header to align.",
    };
  }

  const expectedShiftPx = cssDeltaToScreenshotPx(
    opts.scrollDeltaCss,
    opts.viewportCssHeight,
    prev.height,
  );
  if (expectedShiftPx < minNew) {
    return {
      ok: false,
      reason: "NO_NEW_CONTENT",
      expectedShiftPx,
      message: "Measured scroll displacement too small after scale conversion.",
    };
  }
  if (expectedShiftPx > contentH - minOverlap) {
    return {
      ok: false,
      reason: "LAYOUT_SHIFT",
      expectedShiftPx,
      message: "Scroll displacement exceeds viewport content — possible layout reflow.",
    };
  }

  const overlapPx = contentH - expectedShiftPx;
  const stats = scoreOverlapRobust(prev, next, stickyPx, overlapPx);
  const geometryOk =
    stats.medianMad <= robustMad &&
    (stats.stableRowFraction >= minStable || stats.medianMad <= SCROLL_CAPTURE_LIMITS.maxMad * 1.5);

  if (geometryOk) {
    return {
      ok: true,
      strategy: stats.stableRowFraction >= minStable ? "geometry+stable" : "geometry",
      overlapPx,
      stickyPx,
      newContentPx: expectedShiftPx,
      score: stats.medianMad,
      expectedShiftPx,
      stableRowFraction: stats.stableRowFraction,
    };
  }

  // Optional refine: search near expected shift (±tol) for better stable score — still geometry-anchored.
  const tol = SCROLL_CAPTURE_LIMITS.geometryRefineTolPx;
  let best = { shift: expectedShiftPx, stats, overlap: overlapPx };
  for (let shift = expectedShiftPx - tol; shift <= expectedShiftPx + tol; shift++) {
    if (shift < minNew || shift > contentH - minOverlap) continue;
    const o = contentH - shift;
    const s = scoreOverlapRobust(prev, next, stickyPx, o);
    if (
      s.medianMad < best.stats.medianMad - 0.5 ||
      (Math.abs(s.medianMad - best.stats.medianMad) <= 0.5 && s.stableRowFraction > best.stats.stableRowFraction)
    ) {
      best = { shift, stats: s, overlap: o };
    }
  }
  if (
    best.stats.medianMad <= robustMad &&
    (best.stats.stableRowFraction >= minStable || best.stats.medianMad <= SCROLL_CAPTURE_LIMITS.maxMad * 1.5)
  ) {
    return {
      ok: true,
      strategy: "geometry+stable",
      overlapPx: best.overlap,
      stickyPx,
      newContentPx: best.shift,
      score: best.stats.medianMad,
      expectedShiftPx,
      stableRowFraction: best.stats.stableRowFraction,
    };
  }

  return {
    ok: false,
    reason: "ALIGN_FAILED",
    score: best.stats.medianMad,
    expectedShiftPx,
    message:
      `Could not verify scroll geometry (median side-MAD ${best.stats.medianMad.toFixed(1)}, ` +
      `stable rows ${(best.stats.stableRowFraction * 100).toFixed(0)}%). ` +
      `Animated video may dominate the frame. Last valid image kept; scroll restored.`,
  };
}

/**
 * Legacy pixel-only aligner retained for static fixtures / regression.
 * Prefer alignExtendFrames for Facebook runtime.
 */
export function alignVerticalFrames(
  prev: GrayFrame,
  next: GrayFrame,
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
  const stickyPx = detectStickyTopPx(prev, next, opts?.maxSticky);
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
    strategy: "pixel",
    overlapPx: bestOverlap,
    stickyPx,
    newContentPx,
    score: bestScore,
    expectedShiftPx: newContentPx,
    stableRowFraction: 1,
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
