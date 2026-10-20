import type { Payload } from "./contracts.js";
export type MatchTo = "none" | "top" | "middle" | "bottom";

/** Read-time interpretation only. Never mutates a stored payload or creates a version. */
export function effectiveMatchTo(payload?: Pick<Payload, "target">): MatchTo {
  if (!payload?.target?.ocr?.confirmed) return "none";
  const value = payload.target.matchTo;
  return value === "top" || value === "middle" || value === "bottom" ? value : "none";
}
export function matchToLabel(value?: string) {
  return value === "top" ? "Top" : value === "middle" ? "Middle" : value === "bottom" ? "Bottom" : "None";
}
