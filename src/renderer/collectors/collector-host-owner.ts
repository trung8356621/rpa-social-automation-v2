/**
 * Single-owner guard for Collector BrowserCore host reporting.
 * Prevents an unmounting step from clearing the host after a newer step claimed it.
 */

let currentOwner: string | null = null;
let revision = 0;

export function claimCollectorHostOwner(prefix = "host"): { ownerId: string; revision: number } {
  revision += 1;
  const ownerId = `${prefix}:${revision}`;
  currentOwner = ownerId;
  return { ownerId, revision };
}

export function releaseCollectorHostOwner(ownerId: string, onRelease: () => void): boolean {
  if (currentOwner !== ownerId) return false;
  currentOwner = null;
  onRelease();
  return true;
}

export function isCollectorHostOwner(ownerId: string): boolean {
  return currentOwner === ownerId;
}

export function getCollectorHostOwner(): string | null {
  return currentOwner;
}
