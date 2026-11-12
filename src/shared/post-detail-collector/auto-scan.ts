import type { Rect } from "../contracts.js";
import { EXECUTION_VIEWPORT } from "../geometry.js";
import { inferHorizontalCardBounds } from "./scroll-motion.js";
import type {
  PostDetailAnchorType,
  PostDetailContainerResult,
  PostDetailScanFrame,
  PostDetailVisualAnchor,
} from "./types.js";

/** Wheel target at BrowserCore viewport center (DIP relative to the view, not the Windows desktop). */
export function viewportWheelPoint(viewport: { width: number; height: number }): { x: number; y: number } {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : EXECUTION_VIEWPORT.width;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : EXECUTION_VIEWPORT.height;
  return {
    x: Math.round(width / 2),
    y: Math.round(height / 2),
  };
}

export function inferAnchorTypeFromLabel(label: string): PostDetailAnchorType | null {
  const raw = (label || "").trim().toLowerCase();
  if (!raw) return null;
  if (/(^|[^a-z])like([^a-z]|$)/.test(raw) || raw === "thich" || raw.includes("thích")) return "LIKE";
  if (raw.includes("comment") || raw.includes("bình luận") || raw.includes("binh luan")) return "COMMENT";
  if (raw.includes("share") || raw.includes("chia sẻ") || raw.includes("chia se")) return "SHARE";
  return null;
}

export function uniqueAnchorTypes(anchors: PostDetailVisualAnchor[]): PostDetailAnchorType[] {
  return [...new Set(anchors.map((a) => a.type))];
}

function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.max(4, Math.round(maxX - minX)),
    height: Math.max(4, Math.round(maxY - minY)),
  };
}

/** True when anchors share a horizontal action-row band (similar center Y). */
export function anchorsFormActionRow(anchors: PostDetailVisualAnchor[], bandPx = 48): boolean {
  if (anchors.length < 2) return false;
  const centers = anchors.map((a) => a.bbox.y + a.bbox.height / 2);
  const min = Math.min(...centers);
  const max = Math.max(...centers);
  return max - min <= bandPx;
}

/**
 * Prefer the uppermost action-row co-occurrence (main post) over comment-row likes.
 * Among same-frame candidates, pick the band with highest Y-span compactness near the
 * vertical middle-upper of the frame when multiple bands exist.
 */
export function selectPrimaryActionRow(
  anchors: PostDetailVisualAnchor[],
  candidates: PostDetailVisualAnchor[] = [],
): PostDetailVisualAnchor[] | null {
  const pool = [...anchors, ...candidates];
  if (uniqueAnchorTypes(pool).length < 2) return null;

  // Group by approximate row band (bucket by centerY / 40).
  const bands = new Map<number, PostDetailVisualAnchor[]>();
  for (const a of pool) {
    const cy = a.bbox.y + a.bbox.height / 2;
    const key = Math.round(cy / 40);
    const list = bands.get(key) || [];
    list.push(a);
    bands.set(key, list);
  }

  let best: PostDetailVisualAnchor[] | null = null;
  let bestRank = -Infinity;
  for (const list of bands.values()) {
    // Dedupe by type keeping highest score.
    const byType = new Map<PostDetailAnchorType, PostDetailVisualAnchor>();
    for (const a of list) {
      const prev = byType.get(a.type);
      if (!prev || a.score > prev.score) byType.set(a.type, a);
    }
    const row = [...byType.values()];
    if (row.length < 2 || !anchorsFormActionRow(row)) continue;
    const meanY = row.reduce((s, a) => s + a.bbox.y + a.bbox.height / 2, 0) / row.length;
    const meanScore = row.reduce((s, a) => s + a.score, 0) / row.length;
    // Prefer higher on screen (main post action row is above comment likes) + score + type count.
    const rank = row.length * 20 + meanScore * 5 - meanY * 0.01;
    if (rank > bestRank) {
      bestRank = rank;
      best = row;
    }
  }
  return best;
}

export type HorizontalEdgeHint = { left: number; right: number; confidence: number } | null;

/**
 * Image-geometry container estimate from visual anchors + optional horizontal card edges.
 * Action row anchors the bottom of the main post content. Width comes from modal edges
 * when available — never from union of icon bboxes alone.
 * Never FOUND from a single Like icon or without horizontal edge evidence.
 */
export function detectPostDetailContainer(input: {
  runId: string;
  sourceUrl: string;
  frames: PostDetailScanFrame[];
  wheelPoint: { x: number; y: number };
  deltaY: number;
  settleMs: number;
  maxFrames: number;
  stoppedReason: string;
  requestedScrollPx?: number;
  observedScrollPx?: number;
  /** Optional per-frame column-mean profiles for horizontal edge inference (length = frame width). */
  horizontalProfiles?: Array<{ frameId: string; columns: Float64Array | number[] }>;
}): PostDetailContainerResult {
  const allAnchors = input.frames.flatMap((f) => f.anchors);
  const frameIds = input.frames.map((f) => f.frameId);
  const evidenceRefs = frameIds.map((id) => `frame:${id}`);
  const types = uniqueAnchorTypes(allAnchors);
  const visualConfirmed = input.frames.filter((f) => f.diagnostics?.scrollConfirmed === true).length;
  const base = {
    runId: input.runId,
    sourceUrl: input.sourceUrl,
    frameIds,
    visualAnchors: allAnchors,
    evidenceRefs,
    scrollMetadata: {
      wheelPoint: input.wheelPoint,
      deltaY: input.deltaY,
      settleMs: input.settleMs,
      maxFrames: input.maxFrames,
      framesCaptured: input.frames.length,
      stoppedReason: input.stoppedReason,
      requestedScrollPx: input.requestedScrollPx ?? Math.abs(input.deltaY) * Math.max(0, input.frames.length - 1),
      observedScrollPx: input.observedScrollPx ?? input.frames[input.frames.length - 1]?.observedScrollPx ?? 0,
      visualScrollConfirmedFrames: visualConfirmed,
    },
  };

  if (!allAnchors.length) {
    return {
      ...base,
      status: "NOT_FOUND",
      containerBounds: null,
      confidence: 0,
      notes: ["No visual anchors matched across scan frames."],
    };
  }

  if (types.length < 2) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...allAnchors.map((a) => a.score)),
      notes: [
        `Only anchor type(s): ${types.join(",") || "unknown"}. Need ≥2 of LIKE/COMMENT/SHARE to confirm Post Detail container.`,
      ],
    };
  }

  let bestFrame: PostDetailScanFrame | null = null;
  let bestRow: PostDetailVisualAnchor[] | null = null;
  let bestScore = -1;
  for (const frame of input.frames) {
    const row = selectPrimaryActionRow(frame.anchors, frame.anchorCandidates);
    if (!row) continue;
    const mean = row.reduce((s, a) => s + a.score, 0) / row.length;
    const rank = uniqueAnchorTypes(row).length * 10 + mean;
    if (rank > bestScore) {
      bestScore = rank;
      bestFrame = frame;
      bestRow = row;
    }
  }

  if (!bestFrame || !bestRow) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...allAnchors.map((a) => a.score)),
      notes: [
        "Multiple anchor types appeared across frames but no primary action row (main post) could be selected.",
      ],
    };
  }

  const rowBox = unionRect(bestRow.map((a) => a.bbox));
  if (!rowBox) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: null,
      notes: ["Failed to union action-row bboxes."],
    };
  }

  const frameW = bestFrame.width || EXECUTION_VIEWPORT.width;
  const frameH = bestFrame.height || EXECUTION_VIEWPORT.height;

  // Horizontal edges from image profile when provided; do NOT use icon-union width.
  let edge: HorizontalEdgeHint = null;
  const profile = input.horizontalProfiles?.find((p) => p.frameId === bestFrame!.frameId);
  if (profile?.columns?.length) {
    const inferred = inferHorizontalCardBounds(profile.columns);
    if (inferred) edge = inferred;
  }
  // Fallback: try any frame profile with good confidence.
  if (!edge && input.horizontalProfiles) {
    for (const p of input.horizontalProfiles) {
      const inferred = inferHorizontalCardBounds(p.columns);
      if (inferred && (!edge || inferred.confidence > edge.confidence)) edge = inferred;
    }
  }

  if (!edge) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...bestRow.map((a) => a.score)),
      notes: [
        `Action row found on ${bestFrame.frameId} (types ${uniqueAnchorTypes(bestRow).join(",")}) but modal horizontal edges were not confirmed from screenshot. Returning AMBIGUOUS — icon-union width is not used as container width.`,
      ],
    };
  }

  // Content sits above the main action row; bottom includes a short band past the row.
  const contentTop = Math.max(0, Math.round(rowBox.y - frameH * 0.55));
  const contentBottom = Math.min(frameH, Math.round(rowBox.y + rowBox.height + Math.min(120, frameH * 0.12)));
  const left = Math.max(0, edge.left);
  const right = Math.min(frameW, edge.right);
  if (right - left < frameW * 0.25) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: edge.confidence,
      notes: ["Inferred horizontal edges too narrow for a Post Detail card."],
    };
  }

  const containerBounds: Rect = {
    x: left,
    y: contentTop,
    width: Math.max(4, right - left),
    height: Math.max(4, contentBottom - contentTop),
  };

  // Multi-frame stability: if we have ≥2 frames with confirmed scroll, require action row
  // center X to stay near container mid (rejects wildly drifting false matches).
  const midX = containerBounds.x + containerBounds.width / 2;
  const rowMidX = rowBox.x + rowBox.width / 2;
  if (Math.abs(rowMidX - midX) > containerBounds.width * 0.35) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: edge.confidence,
      notes: ["Action row is not centered in inferred modal bounds — possible comment-row / false edge."],
    };
  }

  const confidence =
    (bestRow.reduce((s, a) => s + a.score, 0) / bestRow.length) *
    (uniqueAnchorTypes(bestRow).length / 3) *
    (0.6 + 0.4 * edge.confidence);

  return {
    ...base,
    status: "FOUND",
    containerBounds,
    confidence: Math.round(confidence * 1000) / 1000,
    notes: [
      `Primary action row on frame ${bestFrame.frameId} with types ${uniqueAnchorTypes(bestRow).join(",")}.`,
      `Container width from modal horizontal edges (conf=${edge.confidence}); height from content-above-action-row. Frame-relative bounds + scroll metadata for long posts.`,
      "Not DOM-derived.",
    ],
  };
}
