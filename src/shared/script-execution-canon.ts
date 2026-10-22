import type { Flow, Payload, Step, Variable } from "./contracts.js";

/** Stable execution view for round-trip / overwrite comparisons (no createdAt). */
export type CanonicalExecution = {
  flow: {
    id: string;
    name: string;
    zoom: number;
    steps: Array<{ id: string; version: number }>;
    variables: Variable[];
    defaultPattern: { values: Record<string, string | string[] | number> };
    groups: NonNullable<Flow["groups"]>;
  };
  steps: Array<{
    id: string;
    version: number;
    name: string;
    payload: Payload;
  }>;
};

export function canonicalExecutionFromLocal(
  flow: Flow,
  steps: Step[],
): CanonicalExecution {
  const pinned = flow.steps.map((ref) => {
    const step = steps.find((s) => s.id === ref.id && s.version === ref.version);
    if (!step) throw new Error(`CANON: missing step ${ref.id}@${ref.version}`);
    return {
      id: step.id,
      version: step.version,
      name: step.name,
      payload: canonicalizePayload(step.payload),
    };
  });
  return {
    flow: {
      id: flow.id,
      name: flow.name,
      zoom: flow.zoom,
      steps: flow.steps.map((s) => ({ id: s.id, version: s.version })),
      variables: [...(flow.variables ?? [])]
        .map((v) => ({
          id: v.id,
          key: v.key,
          type: v.type,
          ...(v.description ? { description: v.description } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      defaultPattern: {
        values: { ...(flow.defaultPattern?.values ?? {}) },
      },
      groups: structuredClone(flow.groups ?? []),
    },
    steps: pinned,
  };
}

export function canonicalizePayload(payload: Payload): Payload {
  const clone = structuredClone(payload);
  if (clone.target) {
    const t = clone.target;
    clone.target = {
      asset: t.asset,
      roi: { ...t.roi },
      ...(t.matchTo !== undefined ? { matchTo: t.matchTo } : {}),
      ...(t.environment ? { environment: { ...t.environment } } : {}),
      ...(t.ocr ? { ocr: structuredClone(t.ocr) } : {}),
    };
  }
  return clone;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

export function executionEqual(a: CanonicalExecution, b: CanonicalExecution): boolean {
  return stableStringify(a) === stableStringify(b);
}
