import { domRectToShellBounds } from "../../shared/collector-browser-host";
import { clampHostLeftOfSidebar } from "../../shared/post-detail-collector/host-bounds";
import { readAdminUiZoom } from "../ui-zoom";
import {
  collectorReportBrowserHost,
  type CollectorInvoke,
} from "../collectors/browser-capture";

/** Prefer live CSS zoom; fall back to persisted admin zoom. */
export function readEffectiveUiZoom(): number {
  try {
    const computed = Number.parseFloat(getComputedStyle(document.documentElement).zoom || "");
    if (Number.isFinite(computed) && computed > 0) return computed;
  } catch {
    /* ignore */
  }
  return readAdminUiZoom();
}

/**
 * Publish BrowserCore hole from a host element.
 * Clamps left edge to the app sidebar so the native WebContentsView never covers nav.
 */
export function publishPostDetailBrowserHost(
  invoke: CollectorInvoke,
  hostEl: HTMLElement | null,
): { left: number; top: number; width: number; height: number } | null {
  if (!hostEl) {
    void collectorReportBrowserHost(invoke, null);
    return null;
  }
  const rect = hostEl.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  const zoom = readEffectiveUiZoom();
  let clamped = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };

  const sidebar = document.querySelector(".app-sidebar") as HTMLElement | null;
  if (sidebar) {
    const side = sidebar.getBoundingClientRect();
    clamped = clampHostLeftOfSidebar(clamped, side.right);
  }

  const client = {
    left: clamped.x,
    top: clamped.y,
    width: clamped.width,
    height: clamped.height,
  };
  const shell = domRectToShellBounds(
    { left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height },
    zoom,
  );
  // Extra clamp in shell DIP space (sidebar width from CSS var).
  let navDip = 0;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--app-nav-width").trim();
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      // --app-nav-width is authored in layout CSS px; under CSS zoom, DIP = css/zoom.
      navDip = Math.round(parsed);
    }
  } catch {
    /* ignore */
  }
  const shellClamped = clampHostLeftOfSidebar(shell, navDip);

  void collectorReportBrowserHost(invoke, { ...shellClamped, active: true });
  return client;
}
