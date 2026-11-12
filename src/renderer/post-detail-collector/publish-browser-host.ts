/**
 * Post Detail host publisher — delegates to the shared Feed Item–compatible path.
 * No sidebar clamps. Coordinate math: getBoundingClientRect → domRectToShellBounds(adminUiZoom).
 */
import {
  publishCollectorHostFromElement,
  snapshotCollectorHostGeometry,
  type HostClientRect,
} from "../collectors/publish-collector-host";
import type { CollectorInvoke } from "../collectors/browser-capture";

export function publishPostDetailBrowserHost(
  invoke: CollectorInvoke,
  hostEl: HTMLElement | null,
): HostClientRect | null {
  const published = publishCollectorHostFromElement(invoke, hostEl);
  return published?.client ?? null;
}

export function snapshotPostDetailGeometry(hostEl: HTMLElement | null): Record<string, unknown> {
  return snapshotCollectorHostGeometry(hostEl);
}
