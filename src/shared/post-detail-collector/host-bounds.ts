import type { Rect } from "../contracts.js";

/**
 * Keep BrowserCore host to the right of the app sidebar (same coordinate space).
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
