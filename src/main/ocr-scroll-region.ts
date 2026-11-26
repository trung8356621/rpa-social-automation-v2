import type { Rect } from "../shared/contracts.js";

/** Geometry used to pick the Match To scroll container (no DOM). */
export type OcrScrollCandidate = {
  /** True when this candidate is the active modal/dialog element. */
  isModal: boolean;
  /** True when document.activeElement is inside this candidate. */
  containsFocus: boolean;
  /** Visible CSS-pixel area intersecting the viewport. */
  visibleArea: number;
};

/**
 * Prefer the modal when it is scrollable so nested composers (focused
 * contenteditable/editor panes) do not steal Match To scrolling.
 * Publish / dialog chrome then stays inside the OCR search region.
 */
export function chooseOcrScrollCandidateIndex(
  candidates: OcrScrollCandidate[],
): number | null {
  if (!candidates.length) return null;
  const modalIndex = candidates.findIndex((c) => c.isModal);
  if (modalIndex >= 0) return modalIndex;
  const focused = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.containsFocus);
  const pool = focused.length ? focused : candidates.map((c, index) => ({ c, index }));
  pool.sort((a, b) => b.c.visibleArea - a.c.visibleArea);
  return pool[0]?.index ?? null;
}

/** Build the DIP searchRegion for OCR from modal or scroll-element boxes. */
export function computeOcrSearchRegion(input: {
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  /** When set, OCR covers the whole visible modal (footer/chrome included). */
  modalBox?: { left: number; top: number; right: number; bottom: number } | null;
  scrollBox: { left: number; top: number; right: number; bottom: number };
  scrollIsPageRoot: boolean;
}): Rect {
  const r =
    input.modalBox ??
    (input.scrollIsPageRoot
      ? { left: 0, top: 0, right: input.viewportWidth, bottom: input.viewportHeight }
      : input.scrollBox);
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(input.viewportWidth, r.right);
  const bottom = Math.min(input.viewportHeight, r.bottom);
  const zoom = input.zoom;
  return {
    x: Math.ceil(left * zoom),
    y: Math.ceil(top * zoom),
    width: Math.max(0, Math.floor(right * zoom) - Math.ceil(left * zoom)),
    height: Math.max(0, Math.floor(bottom * zoom) - Math.ceil(top * zoom)),
  };
}
