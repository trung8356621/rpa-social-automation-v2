import type { Rect } from "../contracts.js";
import type { PostDetailAnchorType, PostDetailVisualAnchor } from "./types.js";

export type ActionRowStrength = "STRONG" | "WEAK" | "INVALID";

function uniqueAnchorTypes(anchors: PostDetailVisualAnchor[]): PostDetailAnchorType[] {
  return [...new Set(anchors.map((a) => a.type))];
}

function anchorsFormActionRow(anchors: PostDetailVisualAnchor[], bandPx = 48): boolean {
  if (anchors.length < 2) return false;
  const centers = anchors.map((a) => a.bbox.y + a.bbox.height / 2);
  return Math.max(...centers) - Math.min(...centers) <= bandPx;
}

export type ActionRowCluster = {
  anchors: PostDetailVisualAnchor[];
  bbox: Rect;
  meanScore: number;
  types: PostDetailAnchorType[];
  /** Geometric + score quality for early stop. */
  strength: ActionRowStrength;
  orderOk: boolean;
  spacingOk: boolean;
  sizeOk: boolean;
  bandOk: boolean;
  reasons: string[];
};

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

const TYPE_ORDER: PostDetailAnchorType[] = ["LIKE", "COMMENT", "SHARE"];

/** Like → Comment → Share left-to-right when those types are present. */
export function actionRowOrderOk(anchors: PostDetailVisualAnchor[]): boolean {
  const present = TYPE_ORDER.filter((t) => anchors.some((a) => a.type === t));
  if (present.length < 2) return false;
  const xs = present.map((t) => {
    const a = anchors.find((x) => x.type === t)!;
    return a.bbox.x + a.bbox.width / 2;
  });
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! + 2 < xs[i - 1]!) return false;
  }
  return true;
}

/** Neighbor centers should be within a plausible FB action-button gap. */
export function actionRowSpacingOk(anchors: PostDetailVisualAnchor[]): boolean {
  const sorted = [...anchors].sort((a, b) => a.bbox.x - b.bbox.x);
  if (sorted.length < 2) return false;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const gap = cur.bbox.x - (prev.bbox.x + prev.bbox.width);
    gaps.push(gap);
  }
  // Allow slight overlap to ~3× icon width.
  const maxW = Math.max(...sorted.map((a) => a.bbox.width));
  return gaps.every((g) => g > -maxW * 0.5 && g < maxW * 4.5);
}

export function actionRowSizeOk(anchors: PostDetailVisualAnchor[]): boolean {
  if (anchors.length < 2) return false;
  const heights = anchors.map((a) => a.bbox.height);
  const widths = anchors.map((a) => a.bbox.width);
  const meanH = heights.reduce((s, h) => s + h, 0) / heights.length;
  const meanW = widths.reduce((s, w) => s + w, 0) / widths.length;
  if (meanH < 8 || meanW < 8) return false;
  return heights.every((h) => Math.abs(h - meanH) <= meanH * 0.75) &&
    widths.every((w) => Math.abs(w - meanW) <= meanW * 1.25);
}

function dedupeByType(list: PostDetailVisualAnchor[]): PostDetailVisualAnchor[] {
  const byType = new Map<PostDetailAnchorType, PostDetailVisualAnchor>();
  for (const a of [...list].sort((x, y) => y.score - x.score)) {
    if (!byType.has(a.type)) byType.set(a.type, a);
  }
  return [...byType.values()].sort((a, b) => a.bbox.x - b.bbox.x);
}

/**
 * Build horizontal action-row clusters from all match candidates (not only best-per-type).
 * Tries combinations of LIKE/COMMENT/SHARE that share a Y band and L→C→S order.
 */
export function clusterActionRows(
  anchors: PostDetailVisualAnchor[],
  candidates: PostDetailVisualAnchor[] = [],
): ActionRowCluster[] {
  const pool = [...anchors, ...candidates];
  if (!pool.length) return [];

  // Bucket by center Y with a fixed band (not per-icon height — mixed template
  // crops like 26px Like vs 31px Comment must stay in one horizontal row).
  const bandSize = 40;
  const bands = new Map<number, PostDetailVisualAnchor[]>();
  for (const a of pool) {
    const cy = a.bbox.y + a.bbox.height / 2;
    const key = Math.round(cy / bandSize);
    const list = bands.get(key) || [];
    list.push(a);
    bands.set(key, list);
  }

  const clusters: ActionRowCluster[] = [];
  for (const list of bands.values()) {
    const row = dedupeByType(list);
    if (row.length < 2) continue;
    const bandOk = anchorsFormActionRow(row, Math.max(48, Math.round(Math.max(...row.map((a) => a.bbox.height)) * 1.5)));
    if (!bandOk) continue;
    const orderOk = actionRowOrderOk(row);
    const spacingOk = actionRowSpacingOk(row);
    const sizeOk = actionRowSizeOk(row);
    const bbox = unionRect(row.map((a) => a.bbox));
    if (!bbox) continue;
    const meanScore = row.reduce((s, a) => s + a.score, 0) / row.length;
    const types = uniqueAnchorTypes(row);
    const reasons: string[] = [];
    if (!orderOk) reasons.push("Icons not in Like→Comment→Share left-to-right order.");
    if (!spacingOk) reasons.push("Horizontal spacing outside plausible action-button range.");
    if (!sizeOk) reasons.push("Icon sizes inconsistent for one action row.");
    if (types.length < 2) reasons.push("Need ≥2 of LIKE/COMMENT/SHARE.");

    let strength: ActionRowStrength = "INVALID";
    if (bandOk && orderOk && spacingOk && sizeOk && types.length >= 2) {
      strength = types.length >= 3 && meanScore >= 0.7 ? "STRONG" : "WEAK";
      if (types.length >= 2 && meanScore >= 0.85 && orderOk && spacingOk) {
        // Two high-confidence ordered icons are enough to pause for review.
        strength = types.length >= 3 ? "STRONG" : "WEAK";
      }
    }
    if (strength === "INVALID") continue;

    clusters.push({
      anchors: row,
      bbox,
      meanScore: Math.round(meanScore * 1000) / 1000,
      types,
      strength,
      orderOk,
      spacingOk,
      sizeOk,
      bandOk,
      reasons,
    });
  }

  clusters.sort((a, b) => {
    const sa = (a.types.length >= 3 ? 100 : 0) + a.meanScore * 10 - a.bbox.y * 0.001;
    const sb = (b.types.length >= 3 ? 100 : 0) + b.meanScore * 10 - b.bbox.y * 0.001;
    return sb - sa;
  });
  return clusters;
}

export function scoreActionRowCluster(cluster: ActionRowCluster): number {
  const typeBonus = cluster.types.length >= 3 ? 30 : cluster.types.length * 8;
  const geo =
    (cluster.bandOk ? 5 : 0) +
    (cluster.orderOk ? 8 : 0) +
    (cluster.spacingOk ? 4 : 0) +
    (cluster.sizeOk ? 3 : 0);
  const strengthBonus = cluster.strength === "STRONG" ? 20 : cluster.strength === "WEAK" ? 5 : 0;
  return typeBonus + geo + strengthBonus + cluster.meanScore * 10;
}

/**
 * First strong-enough action row from scan start wins.
 * Later comment rows must not replace an earlier better/equal candidate.
 */
export function pickBestActionRowCandidate(
  current: ActionRowCluster | null,
  next: ActionRowCluster | null,
  nextFrameIndex: number,
  currentFrameIndex: number | null,
): { cluster: ActionRowCluster; frameIndex: number } | null {
  if (!next && !current) return null;
  if (!next) return current && currentFrameIndex != null ? { cluster: current, frameIndex: currentFrameIndex } : null;
  if (!current || currentFrameIndex == null) return { cluster: next, frameIndex: nextFrameIndex };

  const nextScore = scoreActionRowCluster(next);
  const curScore = scoreActionRowCluster(current);
  // Prefer earlier frame when scores are close — main post appears before comments.
  if (nextFrameIndex < currentFrameIndex && nextScore >= curScore - 5) {
    return { cluster: next, frameIndex: nextFrameIndex };
  }
  if (nextScore > curScore + 8) {
    return { cluster: next, frameIndex: nextFrameIndex };
  }
  return { cluster: current, frameIndex: currentFrameIndex };
}

/** Pause auto-scroll when we have a reviewable main action-row candidate. */
export function shouldStopForActionRow(cluster: ActionRowCluster | null): boolean {
  if (!cluster) return false;
  if (cluster.strength === "STRONG") return true;
  // WEAK with 3 ordered icons or 2 very high scores → stop for user confirm.
  if (cluster.types.length >= 3 && cluster.orderOk && cluster.bandOk) return true;
  if (cluster.types.length >= 2 && cluster.meanScore >= 0.9 && cluster.orderOk && cluster.bandOk) return true;
  return false;
}
