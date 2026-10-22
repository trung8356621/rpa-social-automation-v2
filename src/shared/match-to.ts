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

/** Log-friendly Match To: explain when stored top/middle/bottom is inert without OCR. */
export function matchToLogLabel(payload?: Pick<Payload, "target">): string {
  const effective = effectiveMatchTo(payload);
  const stored = payload?.target?.matchTo;
  if (
    (stored === "top" || stored === "middle" || stored === "bottom") &&
    effective === "none"
  )
    return `None (stored ${stored}; thiếu OCR confirmed)`;
  return matchToLabel(effective);
}
