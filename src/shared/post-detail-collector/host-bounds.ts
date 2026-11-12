import type { Rect } from "../contracts.js";

/**
 * @deprecated Do not use for live host publishing.
 * App pages already apply `margin-left: var(--app-nav-width)`.
 * Live path: getBoundingClientRect → domRectToShellBounds(adminUiZoom) only.
 * Kept for reference / emergency diagnostics.
 */
export function clampHostLeftOfSidebar(host: Rect, sidebarRight: number): Rect {
  if (!Number.isFinite(sidebarRight) || sidebarRight <= 0) return host;
  if (host.x >= sidebarRight - 0.5) return host;
  const delta = sidebarRight - host.x;
  return {
    x: sidebarRight,
    y: host.y,
    width: Math.max(4, host.width - delta),
    height: host.height,
  };
}
