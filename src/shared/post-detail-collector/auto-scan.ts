import type { Rect } from "../contracts.js";
import { EXECUTION_VIEWPORT } from "../geometry.js";
import {
  clusterActionRows,
  pickBestActionRowCandidate,
  scoreActionRowCluster,
  shouldStopForActionRow,
  type ActionRowCluster,
} from "./action-row.js";
import { inferHorizontalCardBounds } from "./scroll-motion.js";
import type {
  PostDetailAnchorType,
  PostDetailContainerResult,
  PostDetailMainActionRow,
  PostDetailScanFrame,
  PostDetailVisualAnchor,
} from "./types.js";

export { clusterActionRows, shouldStopForActionRow, scoreActionRowCluster } from "./action-row.js";

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

/** Rows whose center sits in the bottom ~30% are comment-zone candidates (vs main post). */
export function isLikelyCommentZoneRow(row: PostDetailVisualAnchor[], frameHeight: number): boolean {
  if (!row.length || !(frameHeight > 0)) return false;
  const meanY = row.reduce((s, a) => s + a.bbox.y + a.bbox.height / 2, 0) / row.length;
  return meanY >= frameHeight * 0.7;
}

function collectActionRowBands(
  anchors: PostDetailVisualAnchor[],
  candidates: PostDetailVisualAnchor[] = [],
): PostDetailVisualAnchor[][] {
  const pool = [...anchors, ...candidates];
  if (uniqueAnchorTypes(pool).length < 2) return [];

  const bands = new Map<number, PostDetailVisualAnchor[]>();
  for (const a of pool) {
    const cy = a.bbox.y + a.bbox.height / 2;
    const key = Math.round(cy / 40);
    const list = bands.get(key) || [];
    list.push(a);
    bands.set(key, list);
  }

  const rows: PostDetailVisualAnchor[][] = [];
  for (const list of bands.values()) {
    const byType = new Map<PostDetailAnchorType, PostDetailVisualAnchor>();
    for (const a of list) {
      const prev = byType.get(a.type);
      if (!prev || a.score > prev.score) byType.set(a.type, a);
    }
    const row = [...byType.values()];
    if (row.length >= 2 && anchorsFormActionRow(row)) rows.push(row);
  }
  rows.sort((a, b) => {
    const ya = a.reduce((s, x) => s + x.bbox.y + x.bbox.height / 2, 0) / a.length;
    const yb = b.reduce((s, x) => s + x.bbox.y + x.bbox.height / 2, 0) / b.length;
    return ya - yb;
  });
  return rows;
}

/**
 * Prefer the uppermost action-row co-occurrence (main post) over comment-row likes.
 * If the only row sits in the comment zone after meaningful scroll (no upper competitor),
 * return null → detection stays AMBIGUOUS. Never promote comment likes as main post.
 * A single mid/lower row on early frames (post just scrolled into view) is still allowed.
 */
export function selectPrimaryActionRow(
  anchors: PostDetailVisualAnchor[],
  candidates: PostDetailVisualAnchor[] = [],
  opts?: { frameHeight?: number; observedScrollPx?: number },
): PostDetailVisualAnchor[] | null {
  const clusters = clusterActionRows(anchors, candidates);
  if (!clusters.length) {
    // Fallback to legacy band collect for ≥2 types without full geometry.
    const rows = collectActionRowBands(anchors, candidates);
    if (!rows.length) return null;
    const frameHeight = opts?.frameHeight && opts.frameHeight > 0 ? opts.frameHeight : 0;
    const observedScrollPx = opts?.observedScrollPx ?? 0;
    const upper = rows[0]!;
    if (rows.length >= 2) return upper;
    if (frameHeight > 0 && isLikelyCommentZoneRow(upper, frameHeight) && observedScrollPx >= 250) {
      return null;
    }
    return upper;
  }

  // Prefer uppermost valid cluster (main post before comment rows).
  const sorted = [...clusters].sort((a, b) => a.bbox.y - b.bbox.y);
  const frameHeight = opts?.frameHeight && opts.frameHeight > 0 ? opts.frameHeight : 0;
  const observedScrollPx = opts?.observedScrollPx ?? 0;
  const upper = sorted[0]!;
  if (
    sorted.length === 1 &&
    frameHeight > 0 &&
    isLikelyCommentZoneRow(upper.anchors, frameHeight) &&
    observedScrollPx >= 250
  ) {
    return null;
  }
  return upper.anchors;
}

export function toMainActionRow(
  cluster: ActionRowCluster,
  frame: { frameId: string; frameIndex: number; observedScrollPx: number },
  status: PostDetailMainActionRow["status"],
): PostDetailMainActionRow {
  return {
    status,
    frameId: frame.frameId,
    frameIndex: frame.frameIndex,
    anchors: cluster.anchors,
    bbox: cluster.bbox,
    meanScore: cluster.meanScore,
    types: cluster.types,
    strength: cluster.strength === "STRONG" ? "STRONG" : "WEAK",
    orderOk: cluster.orderOk,
    observedScrollPx: frame.observedScrollPx,
    notes: [
      `types=${cluster.types.join(",")}`,
      `strength=${cluster.strength}`,
      `orderOk=${cluster.orderOk}`,
      ...cluster.reasons,
    ],
  };
}

/** Track best action-row cluster across frames (earlier main-post wins over later comments). */
export function updateBestActionRow(
  best: { cluster: ActionRowCluster; frameIndex: number; frameId: string; observedScrollPx: number } | null,
  frame: PostDetailScanFrame,
): { cluster: ActionRowCluster; frameIndex: number; frameId: string; observedScrollPx: number } | null {
  let clusters = clusterActionRows(frame.anchors, frame.anchorCandidates);
  if (!clusters.length) return best;
  // Prefer uppermost on this frame.
  clusters = [...clusters].sort((a, b) => a.bbox.y - b.bbox.y);
  let next = clusters[0]!;
  // After meaningful scroll, reject a lone comment-zone band (do not promote comment likes).
  if (
    clusters.length === 1 &&
    frame.height > 0 &&
    isLikelyCommentZoneRow(next.anchors, frame.height) &&
    (frame.observedScrollPx ?? 0) >= 250
  ) {
    return best;
  }
  // When multiple bands exist, uppermost is main; ignore deeper comment bands for "next".
  const picked = pickBestActionRowCandidate(
    best?.cluster ?? null,
    next,
    frame.frameIndex,
    best?.frameIndex ?? null,
  );
  if (!picked) return best;
  if (best && picked.frameIndex === best.frameIndex && picked.cluster === best.cluster) return best;
  const source =
    picked.frameIndex === frame.frameIndex
      ? frame
      : { frameId: best!.frameId, frameIndex: best!.frameIndex, observedScrollPx: best!.observedScrollPx };
  return {
    cluster: picked.cluster,
    frameIndex: picked.frameIndex,
    frameId: source.frameId,
    observedScrollPx: source.observedScrollPx,
  };
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

  // Phase A: retain best action-row cluster across frames (earlier wins).
  let tracked: { cluster: ActionRowCluster; frameIndex: number; frameId: string; observedScrollPx: number } | null =
    null;
  for (const frame of input.frames) {
    tracked = updateBestActionRow(tracked, frame);
  }
  const mainActionRow: PostDetailMainActionRow | null = tracked
    ? toMainActionRow(
        tracked.cluster,
        {
          frameId: tracked.frameId,
          frameIndex: tracked.frameIndex,
          observedScrollPx: tracked.observedScrollPx,
        },
        shouldStopForActionRow(tracked.cluster) ? "MAIN_ACTION_ROW_CANDIDATE" : "AMBIGUOUS",
      )
    : null;

  const withMain = { ...base, mainActionRow };

  if (!allAnchors.length) {
    return {
      ...withMain,
      status: "NOT_FOUND",
      containerBounds: null,
      confidence: 0,
      notes: ["No visual anchors matched across scan frames."],
    };
  }

  if (types.length < 2) {
    return {
      ...withMain,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...allAnchors.map((a) => a.score)),
      notes: [
        `Only anchor type(s): ${types.join(",") || "unknown"}. Need ≥2 of LIKE/COMMENT/SHARE in one action-row cluster.`,
        ...(mainActionRow ? [`Best partial row on frame ${mainActionRow.frameId}.`] : []),
      ],
    };
  }

  let bestFrame: PostDetailScanFrame | null =
    tracked ? input.frames.find((f) => f.frameId === tracked!.frameId) || null : null;
  let bestRow: PostDetailVisualAnchor[] | null = tracked?.cluster.anchors ?? null;
  let sawCommentZoneOnly = false;
  if (!bestRow) {
    for (const frame of input.frames) {
      const row = selectPrimaryActionRow(frame.anchors, frame.anchorCandidates, {
        frameHeight: frame.height,
        observedScrollPx: frame.observedScrollPx ?? input.observedScrollPx ?? 0,
      });
      if (!row) {
        const bands = collectActionRowBands(frame.anchors, frame.anchorCandidates);
        if (
          bands.some((b) => isLikelyCommentZoneRow(b, frame.height)) &&
          (frame.observedScrollPx ?? 0) >= 250
        ) {
          sawCommentZoneOnly = true;
        }
        continue;
      }
      bestFrame = frame;
      bestRow = row;
      break;
    }
  }

  if (!bestFrame || !bestRow) {
    return {
      ...withMain,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...allAnchors.map((a) => a.score)),
      notes: [
        sawCommentZoneOnly
          ? "Only comment-zone action row(s) matched — not confirming as main-post action row. Scroll to top of the post and rescan, or Confirm manually."
          : "Multiple anchor types appeared across frames but no primary action row (main post) could be selected.",
      ],
    };
  }

  const rowBox = unionRect(bestRow.map((a) => a.bbox));
  if (!rowBox) {
    return {
      ...withMain,
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
  if (!edge && input.horizontalProfiles) {
    for (const p of input.horizontalProfiles) {
      const inferred = inferHorizontalCardBounds(p.columns);
      if (inferred && (!edge || inferred.confidence > edge.confidence)) edge = inferred;
    }
  }

  // Phase A: action-row candidate is enough to stop/review even without modal edges.
  if (!edge) {
    return {
      ...withMain,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...bestRow.map((a) => a.score)),
      notes: [
        `Main action row on ${bestFrame.frameId} (types ${uniqueAnchorTypes(bestRow).join(",")}) retained as candidate.`,
        "Modal horizontal edges not confirmed — container AMBIGUOUS; Confirm Action Row to proceed.",
        ...(mainActionRow?.status === "MAIN_ACTION_ROW_CANDIDATE"
          ? ["Phase A: MAIN_ACTION_ROW_CANDIDATE ready for confirm."]
          : []),
      ],
    };
  }

  const contentTop = Math.max(0, Math.round(rowBox.y - frameH * 0.55));
  const contentBottom = Math.min(frameH, Math.round(rowBox.y + rowBox.height + Math.min(120, frameH * 0.12)));
  const left = Math.max(0, edge.left);
  const right = Math.min(frameW, edge.right);
  if (right - left < frameW * 0.25) {
    return {
      ...withMain,
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

  const midX = containerBounds.x + containerBounds.width / 2;
  const rowMidX = rowBox.x + rowBox.width / 2;
  if (Math.abs(rowMidX - midX) > containerBounds.width * 0.35) {
    return {
      ...withMain,
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
    ...withMain,
    status: "FOUND",
    containerBounds,
    confidence: Math.round(confidence * 1000) / 1000,
    notes: [
      `Primary action row on frame ${bestFrame.frameId} with types ${uniqueAnchorTypes(bestRow).join(",")}.`,
      `Container width from modal horizontal edges (conf=${edge.confidence}); height from content-above-action-row.`,
      "Not DOM-derived.",
    ],
  };
}
