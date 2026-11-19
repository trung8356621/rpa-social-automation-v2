/**
 * Collector Script composition helpers — Part references only (no execution semantics).
 * Display order must not be treated as runtime order.
 */

import type { CollectorScriptPartRef } from "./part-library-types.js";

export function samePartRef(a: CollectorScriptPartRef, b: CollectorScriptPartRef): boolean {
  return a.partId === b.partId && a.partVersion === b.partVersion;
}

/** Append a Part reference. Skips exact partId+partVersion duplicates. Never replaces existing refs. */
export function addPartRef(
  refs: CollectorScriptPartRef[],
  next: CollectorScriptPartRef,
): { refs: CollectorScriptPartRef[]; added: boolean; reason?: "duplicate" } {
  if (refs.some((r) => samePartRef(r, next))) {
    return { refs, added: false, reason: "duplicate" };
  }
  return { refs: [...refs, next], added: true };
}

/** Remove one reference by index (stable for unresolved/missing Parts). */
export function removePartRefAt(
  refs: CollectorScriptPartRef[],
  index: number,
): CollectorScriptPartRef[] {
  if (index < 0 || index >= refs.length) return refs;
  return refs.filter((_, i) => i !== index);
}

export type ResolvedScriptPartRef = CollectorScriptPartRef & {
  resolved: boolean;
  name?: string;
  partType?: "visual" | "network";
};

export function resolveScriptPartRefs(
  refs: CollectorScriptPartRef[],
  partsById: Map<
    string,
    { name: string; partType: "visual" | "network"; version: number } | undefined
  >,
): ResolvedScriptPartRef[] {
  return refs.map((ref) => {
    const part = partsById.get(ref.partId);
    if (!part) {
      return { ...ref, resolved: false };
    }
    return {
      ...ref,
      resolved: true,
      name: part.name,
      partType: part.partType,
    };
  });
}
