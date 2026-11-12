import type { Rect } from "../contracts.js";
import { EXECUTION_VIEWPORT } from "../geometry.js";
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
 * Image-geometry container estimate from visual anchors.
 * Action row is an anchor band; content region is primarily above it (Post Detail modal).
 * Never FOUND from a single Like icon alone.
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
}): PostDetailContainerResult {
  const allAnchors = input.frames.flatMap((f) => f.anchors);
  const frameIds = input.frames.map((f) => f.frameId);
  const evidenceRefs = frameIds.map((id) => `frame:${id}`);
  const types = uniqueAnchorTypes(allAnchors);
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

  // Prefer the frame with the most distinct anchor types (and highest mean score).
  let bestFrame: PostDetailScanFrame | null = null;
  let bestScore = -1;
  for (const frame of input.frames) {
    const t = uniqueAnchorTypes(frame.anchors);
    if (t.length < 2) continue;
    const mean = frame.anchors.reduce((s, a) => s + a.score, 0) / Math.max(1, frame.anchors.length);
    const rank = t.length * 10 + mean;
    if (rank > bestScore) {
      bestScore = rank;
      bestFrame = frame;
    }
  }

  if (!bestFrame) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...allAnchors.map((a) => a.score)),
      notes: [
        "Multiple anchor types appeared across frames but never co-occurred in one frame as an action row.",
      ],
    };
  }

  const rowAnchors = bestFrame.anchors;
  if (!anchorsFormActionRow(rowAnchors)) {
    return {
      ...base,
      status: "AMBIGUOUS",
      containerBounds: null,
      confidence: Math.max(...rowAnchors.map((a) => a.score)),
      notes: [
        `Frame ${bestFrame.frameId} has ${uniqueAnchorTypes(rowAnchors).length} anchor types but they do not form a horizontal action row.`,
      ],
    };
  }

  const rowBox = unionRect(rowAnchors.map((a) => a.bbox));
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
  const padX = Math.round(Math.min(48, frameW * 0.04));
  // Content of a Post Detail post sits above the Like/Comment/Share row.
  const contentTop = Math.max(0, Math.round(rowBox.y - frameH * 0.55));
  const contentBottom = Math.min(frameH, Math.round(rowBox.y + rowBox.height + Math.min(120, frameH * 0.12)));
  const left = Math.max(0, rowBox.x - padX);
  const right = Math.min(frameW, rowBox.x + rowBox.width + padX);
  const containerBounds: Rect = {
    x: left,
    y: contentTop,
    width: Math.max(4, right - left),
    height: Math.max(4, contentBottom - contentTop),
  };

  const confidence =
    rowAnchors.reduce((s, a) => s + a.score, 0) / rowAnchors.length * (uniqueAnchorTypes(rowAnchors).length / 3);

  return {
    ...base,
    status: "FOUND",
    containerBounds,
    confidence: Math.round(confidence * 1000) / 1000,
    notes: [
      `Action row on frame ${bestFrame.frameId} with types ${uniqueAnchorTypes(rowAnchors).join(",")}.`,
      "Container estimated from visual geometry (content above action row). Not DOM-derived.",
    ],
  };
}
