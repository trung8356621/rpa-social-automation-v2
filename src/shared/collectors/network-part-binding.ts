/**
 * Resolve which Network Part configuration a Collector Script Workspace should use.
 * Display order of script.partRefs is never treated as execution order.
 */

import type { CollectorPart, CollectorScriptPartRef } from "./part-library-types.js";

export type NetworkPartOption = {
  partId: string;
  partVersion: number;
  name: string;
  status: CollectorPart["status"];
};

export type NetworkPartBinding =
  | { kind: "none"; reason: string; options: [] }
  | { kind: "single"; reason?: undefined; options: [NetworkPartOption]; selected: NetworkPartOption }
  | { kind: "multiple"; reason: string; options: NetworkPartOption[] };

/** Collect Network Part refs from a script composition (resolved against Part Library). */
export function listNetworkPartOptions(
  partRefs: CollectorScriptPartRef[],
  parts: ReadonlyArray<Pick<CollectorPart, "partId" | "name" | "partType" | "version" | "status">>,
): NetworkPartOption[] {
  const byId = new Map(parts.map((p) => [p.partId, p]));
  const out: NetworkPartOption[] = [];
  const seen = new Set<string>();
  for (const ref of partRefs) {
    const part = byId.get(ref.partId);
    if (!part || part.partType !== "network") continue;
    const key = `${ref.partId}@${ref.partVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      partId: ref.partId,
      partVersion: ref.partVersion,
      name: part.name,
      status: part.status,
    });
  }
  return out;
}

export function resolveNetworkPartBinding(
  partRefs: CollectorScriptPartRef[],
  parts: ReadonlyArray<Pick<CollectorPart, "partId" | "name" | "partType" | "version" | "status">>,
  selectedKey?: string | null,
): NetworkPartBinding {
  const options = listNetworkPartOptions(partRefs, parts);
  if (options.length === 0) {
    return {
      kind: "none",
      reason: "This Collector Script has no Network Part reference. Add a Network Part before starting capture.",
      options: [],
    };
  }
  if (options.length === 1) {
    return { kind: "single", options: [options[0]!], selected: options[0]! };
  }
  const selected = selectedKey
    ? options.find((o) => `${o.partId}@${o.partVersion}` === selectedKey)
    : undefined;
  return {
    kind: "multiple",
    reason: selected
      ? ""
      : "Multiple Network Parts are referenced. Select which Network Part configuration to use for this capture session.",
    options,
  };
}

export function networkPartOptionKey(option: Pick<NetworkPartOption, "partId" | "partVersion">): string {
  return `${option.partId}@${option.partVersion}`;
}
