/**
 * Verified Collector host publisher — same math as Feed Item CalibrationStep.
 * getBoundingClientRect → domRectToShellBounds(zoom) → collectorBrowserHost IPC.
 * No sidebar clamps / manual offsets.
 */
import { domRectToShellBounds } from "../../shared/collector-browser-host";
import { readAdminUiZoom } from "../ui-zoom";
import { collectorReportBrowserHost, type CollectorInvoke } from "./browser-capture";

export type HostClientRect = { left: number; top: number; width: number; height: number };

export type PublishCollectorHostResult = {
  client: HostClientRect;
  shell: { x: number; y: number; width: number; height: number; active: true };
  zoom: number;
  raw: { left: number; top: number; width: number; height: number };
};

export function publishCollectorHostFromElement(
  invoke: CollectorInvoke,
  hostEl: HTMLElement | null,
): PublishCollectorHostResult | null {
  if (!hostEl) {
    void collectorReportBrowserHost(invoke, null);
    return null;
  }
  const rect = hostEl.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  const zoom = readAdminUiZoom();
  const raw = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  const shellRect = domRectToShellBounds(rect, zoom);
  const shell = { ...shellRect, active: true as const };
  void collectorReportBrowserHost(invoke, shell);
  return {
    client: { ...raw },
    shell,
    zoom,
    raw,
  };
}

/** Snapshot DOM geometry for diagnostics (no IPC side effects). */
export function snapshotCollectorHostGeometry(hostEl: HTMLElement | null): Record<string, unknown> {
  const zoomStyle = (() => {
    try {
      return getComputedStyle(document.documentElement).zoom || "";
    } catch {
      return "";
    }
  })();
  const navVar = (() => {
    try {
      const shell = document.querySelector("main.app-shell");
      return getComputedStyle(shell || document.documentElement).getPropertyValue("--app-nav-width").trim();
    } catch {
      return "";
    }
  })();
  const box = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const sidebar = document.querySelector(".app-sidebar");
  const page =
    document.querySelector(".post-detail-collector-page") ||
    document.querySelector(".feed-item-collector-page");
  const workspace =
    document.querySelector(".pdc-calibration-workspace") ||
    document.querySelector(".fic-calibration-workspace");
  const sidePanel =
    document.querySelector(".pdc-calibration-workspace > .pdc-side-panel") ||
    document.querySelector(".fic-calibration-workspace .fic-sidebar-panel") ||
    document.querySelector(".fic-sidebar-panel");
  const header =
    document.querySelector(".pdc-page-header") ||
    document.querySelector(".fic-page-header");
  const toolbar = document.querySelector(".pdc-toolbar") || document.querySelector(".fic-toolbar");

  return {
    windowInner: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    cssZoomStyle: zoomStyle,
    adminUiZoom: readAdminUiZoom(),
    navCssVar: navVar,
    shell: box(document.querySelector("main.app-shell")),
    sidebar: box(sidebar),
    page: box(page),
    workspace: box(workspace),
    host: box(hostEl),
    sidePanel: box(sidePanel),
    header: box(header),
    toolbar: box(toolbar),
    zoomHypothesis: (() => {
      const side = sidebar?.getBoundingClientRect();
      const navPx = Number.parseFloat(navVar);
      if (!side || !Number.isFinite(navPx) || navPx <= 0) return null;
      const ratio = side.width / navPx;
      return {
        sidebarWidthCss: side.width,
        navVarPx: navPx,
        ratio,
        /** If ≈ admin zoom, getBoundingClientRect is zoomed and must be divided for shell DIP. */
        rectsAppearZoomed: Math.abs(ratio - readAdminUiZoom()) < 0.08 || Math.abs(ratio - 1) >= 0.08,
      };
    })(),
  };
}
