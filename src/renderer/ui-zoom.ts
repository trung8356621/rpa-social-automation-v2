/**
 * Administrative UI zoom — isolated from Browser Core / automation zoom.
 * Uses Chromium CSS `zoom` (not transform) so pointer hit-testing stays aligned.
 * Persists across reloads for both Electron shell and `dev:web`.
 */

export const ADMIN_UI_ZOOM_KEY = "rpa.admin.uiZoom";
export const ADMIN_UI_ZOOM_MIN = 0.75;
export const ADMIN_UI_ZOOM_MAX = 1.5;
export const ADMIN_UI_ZOOM_STEP = 0.1;

function clamp(n: number): number {
  const stepped = Math.round(n / ADMIN_UI_ZOOM_STEP) * ADMIN_UI_ZOOM_STEP;
  return Math.min(ADMIN_UI_ZOOM_MAX, Math.max(ADMIN_UI_ZOOM_MIN, Number(stepped.toFixed(2))));
}

export function readAdminUiZoom(): number {
  try {
    const raw = localStorage.getItem(ADMIN_UI_ZOOM_KEY);
    if (!raw) return 1;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : 1;
  } catch {
    return 1;
  }
}

export function applyAdminUiZoom(factor: number): number {
  const next = clamp(factor);
  document.documentElement.style.setProperty("--admin-ui-zoom", String(next));
  document.documentElement.style.zoom = String(next);
  try {
    localStorage.setItem(ADMIN_UI_ZOOM_KEY, String(next));
  } catch {
    /* ignore quota */
  }
  return next;
}

export function zoomAdminUiIn(): number {
  return applyAdminUiZoom(readAdminUiZoom() + ADMIN_UI_ZOOM_STEP);
}

export function zoomAdminUiOut(): number {
  return applyAdminUiZoom(readAdminUiZoom() - ADMIN_UI_ZOOM_STEP);
}

export function resetAdminUiZoom(): number {
  return applyAdminUiZoom(1);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Install Ctrl/Cmd ± / 0 handlers for the admin renderer.
 * Skips when the event originates inside an embedded browser host (if present).
 */
export function installAdminUiZoomShortcuts(): () => void {
  applyAdminUiZoom(readAdminUiZoom());

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    // Never steal keys while focus is inside a marked automation host.
    const t = e.target;
    if (t instanceof Element && t.closest("[data-browser-core-host], [data-automation-host]")) {
      return;
    }
    // Allow native undo/etc.; only handle zoom chords.
    const key = e.key;
    const code = e.code;
    const zoomIn =
      key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd";
    const zoomOut = key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract";
    const zoomReset = key === "0" || code === "Digit0" || code === "Numpad0";
    if (!zoomIn && !zoomOut && !zoomReset) return;
    // Still allow zoom from inputs (standard browser UX); do not block typing of +/=/- otherwise.
    if (isEditableTarget(t) && !zoomReset && !zoomIn && !zoomOut) return;
    e.preventDefault();
    if (zoomIn) zoomAdminUiIn();
    else if (zoomOut) zoomAdminUiOut();
    else resetAdminUiZoom();
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
