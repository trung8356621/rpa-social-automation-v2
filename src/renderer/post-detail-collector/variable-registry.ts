import { createEmptyDraft, cryptoRandomId } from "../../shared/collectors/fixtures";
import {
  loadCollectorStore,
  saveCollectorStore,
  upsertCollector,
  type StorageLike,
} from "../../shared/collectors/store";
import type {
  CollectorDraft,
  CollectorStoreEnvelope,
  CollectorValueType,
  CollectorVariable,
} from "../../shared/collectors/types";
import type { PostDetailDomVariableMapping } from "./types";

export type RegistryVariableOption = {
  collectorId: string;
  collectorName: string;
  id: string;
  key: string;
  label: string;
  valueType: CollectorValueType;
  required: boolean;
};

export const COLLECTOR_VALUE_TYPES: CollectorValueType[] = [
  "string",
  "text",
  "number",
  "boolean",
  "url",
  "datetime",
  "array",
  "object",
];

function getBrowserStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function slugifyVariableKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function loadRegistryEnvelope(storage?: StorageLike): CollectorStoreEnvelope | null {
  const target = getBrowserStorage(storage);
  if (!target) return null;
  try {
    return loadCollectorStore(target);
  } catch {
    return null;
  }
}

export function listRegistryVariables(storage?: StorageLike): RegistryVariableOption[] {
  const envelope = loadRegistryEnvelope(storage);
  if (!envelope) return [];
  return envelope.collectors.flatMap((collector) =>
    collector.variables.map((variable) => ({
      collectorId: collector.id,
      collectorName: collector.name,
      id: variable.id,
      key: variable.key,
      label: variable.label,
      valueType: variable.valueType,
      required: variable.required,
    })),
  );
}

export function ensureDefaultCollector(storage?: StorageLike): CollectorDraft | null {
  const target = getBrowserStorage(storage);
  if (!target) return null;
  const envelope = loadCollectorStore(target);
  if (envelope.collectors.length > 0) return envelope.collectors[0];
  const draft = createEmptyDraft({
    name: "Post Detail",
    description: "Post Detail Collector shared variables",
    strategy: "POST_DETAIL_VISUAL",
  });
  saveCollectorStore(target, upsertCollector(envelope, draft));
  return draft;
}

export function addRegistryVariable(
  collectorId: string,
  input?: { label?: string; key?: string; valueType?: CollectorValueType; required?: boolean },
  storage?: StorageLike,
): CollectorVariable | null {
  const target = getBrowserStorage(storage);
  if (!target) return null;
  const envelope = loadCollectorStore(target);
  const collector = envelope.collectors.find((c) => c.id === collectorId);
  if (!collector) return null;

  const existingKeys = new Set(collector.variables.map((v) => v.key));
  const baseLabel = (input?.label || "Custom Variable").trim() || "Custom Variable";
  const baseKey = slugifyVariableKey(input?.key || baseLabel) || "custom_var";
  let key = baseKey;
  let suffix = 2;
  while (existingKeys.has(key)) {
    key = `${baseKey}_${suffix++}`;
  }

  const variable: CollectorVariable = {
    id: cryptoRandomId(),
    key,
    label: baseLabel,
    valueType: input?.valueType || "string",
    required: Boolean(input?.required),
    source: "visual_dom",
    mappings: [],
  };

  const nextCollector: CollectorDraft = {
    ...collector,
    variables: [...collector.variables, variable],
    schemaRevision: (collector.schemaRevision ?? 1) + 1,
    dirty: true,
  };
  saveCollectorStore(target, upsertCollector(envelope, nextCollector));
  return variable;
}

export function countMappingsForVariable(
  mappings: PostDetailDomVariableMapping[],
  collectorId: string,
  variableId: string,
): number {
  return mappings.filter(
    (m) => m.collectorId === collectorId && m.variableId === variableId,
  ).length;
}

export function updateRegistryVariable(
  collectorId: string,
  variableId: string,
  patch: Partial<Pick<CollectorVariable, "label" | "key" | "valueType" | "required">>,
  mappings: PostDetailDomVariableMapping[],
  storage?: StorageLike,
): { ok: boolean; error?: string; mappings: PostDetailDomVariableMapping[] } {
  const target = getBrowserStorage(storage);
  if (!target) return { ok: false, error: "Storage unavailable", mappings };
  const envelope = loadCollectorStore(target);
  const collector = envelope.collectors.find((c) => c.id === collectorId);
  if (!collector) return { ok: false, error: "Collector not found", mappings };
  const existing = collector.variables.find((v) => v.id === variableId);
  if (!existing) return { ok: false, error: "Variable not found", mappings };

  const nextKey = patch.key !== undefined ? slugifyVariableKey(patch.key) : existing.key;
  if (!nextKey) return { ok: false, error: "Variable key cannot be empty.", mappings };
  if (
    nextKey !== existing.key &&
    collector.variables.some((v) => v.id !== variableId && v.key === nextKey)
  ) {
    return { ok: false, error: `Key "${nextKey}" already exists.`, mappings };
  }

  const nextLabel = patch.label !== undefined ? patch.label.trim() || nextKey : existing.label;
  const nextType = patch.valueType ?? existing.valueType;
  const nextRequired = patch.required ?? existing.required;

  const nextCollector: CollectorDraft = {
    ...collector,
    variables: collector.variables.map((v) =>
      v.id === variableId
        ? { ...v, key: nextKey, label: nextLabel, valueType: nextType, required: nextRequired }
        : v,
    ),
    schemaRevision: (collector.schemaRevision ?? 1) + 1,
    dirty: true,
  };
  saveCollectorStore(target, upsertCollector(envelope, nextCollector));

  const nextMappings = mappings.map((m) =>
    m.collectorId === collectorId && m.variableId === variableId
      ? { ...m, variableKey: nextKey, variableLabel: nextLabel }
      : m,
  );
  return { ok: true, mappings: nextMappings };
}

export function deleteRegistryVariable(
  collectorId: string,
  variableId: string,
  mappings: PostDetailDomVariableMapping[],
  storage?: StorageLike,
): { ok: boolean; mappings: PostDetailDomVariableMapping[] } {
  const target = getBrowserStorage(storage);
  if (!target) return { ok: false, mappings };
  const envelope = loadCollectorStore(target);
  const collector = envelope.collectors.find((c) => c.id === collectorId);
  if (!collector) return { ok: false, mappings };

  const nextCollector: CollectorDraft = {
    ...collector,
    variables: collector.variables.filter((v) => v.id !== variableId),
    schemaRevision: (collector.schemaRevision ?? 1) + 1,
    dirty: true,
  };
  saveCollectorStore(target, upsertCollector(envelope, nextCollector));

  const nextMappings = mappings.filter(
    (m) => !(m.collectorId === collectorId && m.variableId === variableId),
  );
  return { ok: true, mappings: nextMappings };
}
