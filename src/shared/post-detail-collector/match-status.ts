import type { VisualMatchStatus } from "./types.js";

/**
 * Classify multi-template visual match outcomes.
 * Highest score alone is not enough when candidates are close — that is AMBIGUOUS.
 */
export function classifyVisualMatchStatus(
  scores: number[],
  matchedThreshold = 0.72,
  ambiguousGap = 0.05,
): VisualMatchStatus {
  const sorted = [...scores].filter((s) => Number.isFinite(s)).sort((a, b) => b - a);
  const best = sorted[0];
  if (best == null || best < matchedThreshold) return "NOT_FOUND";
  const second = sorted[1];
  if (second != null && best - second < ambiguousGap) return "AMBIGUOUS";
  return "MATCHED";
}

export function createPostDetailRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `pd_${stamp}_${rand}`;
}

export function createPostDetailFrameId(frameIndex: number, now = new Date()): string {
  const safe = Math.max(1, Math.floor(frameIndex));
  return `frame-${String(safe).padStart(3, "0")}_${now.getTime().toString(36)}`;
}
