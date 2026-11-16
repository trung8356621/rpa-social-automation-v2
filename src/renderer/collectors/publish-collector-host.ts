/**
 * Verified Collector host publisher — same math as Feed Item CalibrationStep.
 * getBoundingClientRect → domRectToShellBounds(zoom) → collectorBrowserHost IPC.
 * No sidebar clamps / manual offsets.
 */
import { domRectToShellBounds } from "../../shared/collector-browser-host";
import { readAdminUiZoom } from "../ui-zoom";
import { collectorReportBrowserHost, type CollectorInvoke } from "./browser-capture";
import { getCollectorHostOwner, getCollectorHostOwnerRevision } from "./collector-host-owner";

export type HostClientRect = { left: number; top: number; width: number; height: number };

const CLIPPING_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);

/**
 * Returns true when an expanded right-anchored SidebarDrawer in the same
 * BrowserWorkspace physically overlaps the BrowserCore host rect.
 */
export function doesExpandedDrawerOverlapHost(hostEl: HTMLElement | null): boolean {
  if (!hostEl || !hostEl.isConnected) return false;
  const workspace =
    typeof hostEl.closest === "function" ? hostEl.closest(".rpa-browser-workspace") : null;
  const expandedDrawer = workspace?.querySelector('[data-browser-sidebar-drawer="expanded"]');
  if (!expandedDrawer) return false;
  const hostRect = hostEl.getBoundingClientRect();
  const drawerRect = expandedDrawer.getBoundingClientRect();
  if (hostRect.width < 10 || hostRect.height < 10 || drawerRect.width < 1) return false;
  return (
    drawerRect.left < hostRect.right &&
    drawerRect.right > hostRect.left &&
    drawerRect.top < hostRect.bottom &&
    drawerRect.bottom > hostRect.top
  );
}

/**
 * Intersect a host rect with its visible clipping ancestors, global sidebar,
 * and window viewport so native WebContentsView never paints over chrome.
 */
export function clipHostRectToVisibleArea(
  hostEl: HTMLElement,
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
): HostClientRect {
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;

  if (typeof window !== "undefined") {
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
  }

  if (typeof getComputedStyle === "function") {
    let parent = hostEl.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      const clipsX = CLIPPING_OVERFLOW.has(style.overflowX) || CLIPPING_OVERFLOW.has(style.overflow);
      const clipsY = CLIPPING_OVERFLOW.has(style.overflowY) || CLIPPING_OVERFLOW.has(style.overflow);
      if (clipsX || clipsY) {
        const pr = parent.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, pr.left);
          right = Math.min(right, pr.right);
        }
        if (clipsY) {
          top = Math.max(top, pr.top);
          bottom = Math.min(bottom, pr.bottom);
        }
      }
      parent = parent.parentElement;
    }
  }

  if (typeof document !== "undefined" && hostEl.closest(".app-page")) {
    const sidebar = document.querySelector(".app-sidebar");
    if (sidebar) {
      const sideRect = sidebar.getBoundingClientRect();
      if (sideRect.width > 0) {
        left = Math.max(left, sideRect.right);
      }
    }
  }

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const isCanonicalFixedHost =
    typeof hostEl.classList?.contains === "function" &&
    hostEl.classList.contains("rpa-browser-host");

  if (isCanonicalFixedHost) {
    // Hard-lock canonical 1024x560 dimensions for .rpa-browser-host so OpenCV
    // and DOM coordinates never shrink. Hide only if completely scrolled off-screen.
    if (width < 10 || height < 10) {
      return { left, top, width: 0, height: 0 };
    }
    return {
      left,
      top,
      width: rect.width,
      height: rect.height,
    };
  }

  return {
    left,
    top,
    width,
    height,
  };
}

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
  if (!hostEl || !hostEl.isConnected) {
    void collectorReportBrowserHost(invoke, null);
    return null;
  }
  const rect = hostEl.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) {
    void collectorReportBrowserHost(invoke, null);
    return null;
  }

  const clipped = clipHostRectToVisibleArea(hostEl, rect);
  if (clipped.width < 10 || clipped.height < 10) {
    void collectorReportBrowserHost(invoke, null);
    return null;
  }

  const zoom = readAdminUiZoom();
  const raw = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  const shellRect = domRectToShellBounds(clipped, zoom);
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

  const rawHost = box(hostEl);
  const clippedHost = hostEl && hostEl.isConnected
    ? clipHostRectToVisibleArea(hostEl, hostEl.getBoundingClientRect())
    : null;
  const calculatedShell = clippedHost && clippedHost.width >= 10 && clippedHost.height >= 10
    ? domRectToShellBounds(clippedHost, readAdminUiZoom())
    : null;
  const activeStepLabel =
    document.querySelector(".pdc-step-pill.active")?.textContent?.trim() || null;
  const drawerEl =
    hostEl && typeof hostEl.closest === "function"
      ? hostEl.closest(".rpa-browser-workspace")?.querySelector("[data-browser-sidebar-drawer]")
      : null;
  const sidebarState = drawerEl?.getAttribute("data-browser-sidebar-drawer") || "none";
  const sidebarOverlapsHost = doesExpandedDrawerOverlapHost(hostEl);

  return {
    windowInner: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    cssZoomStyle: zoomStyle,
    adminUiZoom: readAdminUiZoom(),
    navCssVar: navVar,
    activeOwner: getCollectorHostOwner(),
    ownerRevision: getCollectorHostOwnerRevision(),
    currentStep: activeStepLabel,
    sidebarState,
    sidebarOverlapsHost,
    shell: box(document.querySelector("main.app-shell")),
    sidebar: box(sidebar),
    page: box(page),
    workspace: box(workspace),
    host: rawHost,
    clippedHost,
    calculatedShell,
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
