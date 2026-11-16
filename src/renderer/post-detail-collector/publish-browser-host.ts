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

export function sameHostClientRect(
  a: HostClientRect | null,
  b: HostClientRect | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * Coalesce rapid scroll/resize/ResizeObserver events into at most one
 * publish call per animation frame.
 */
export function createRafHostPublishScheduler(publish: () => void): {
  schedule: () => void;
  cancel: () => void;
} {
  let rafId = 0;
  return {
    schedule: () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        publish();
      });
    },
    cancel: () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}
