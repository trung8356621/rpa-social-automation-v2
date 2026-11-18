/** Identity of document.activeElement — never includes field values. */
export type ActiveElementMeta = {
  editable: boolean;
  /** tag#id[name] — stable focus identity without secrets */
  key: string;
  tag: string;
};

export const BODY_FOCUS: ActiveElementMeta = {
  editable: false,
  key: "body",
  tag: "body",
};

/**
 * After a synthetic click (often an htmlFor label), decide whether DOM focus is
 * ready for typeOnly. Accept when:
 * - focus moved to a different editable control, or
 * - we gained editable focus from a non-editable element, or
 * - same editable stayed focused for sameFieldMinMs (re-click same field).
 */
export function shouldAcceptFocusSettle(
  before: ActiveElementMeta,
  after: ActiveElementMeta,
  elapsedMs: number,
  sameFieldMinMs = 80,
): boolean {
  if (!after.editable) return false;
  if (after.key !== before.key) return true;
  if (!before.editable) return true;
  return elapsedMs >= sameFieldMinMs;
}
