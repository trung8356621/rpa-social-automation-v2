/**
 * Collector Part Library — logical contracts for reusable Parts and Collector Scripts.
 * Isolated from Script Creator / SQLite. Persistence is via PartLibraryRepository.
 */

export const PART_LIBRARY_SCHEMA_VERSION = 1;

/** Default repository key when using a key-value adapter (e.g. localStorage). UI must not hardcode this. */
export const PART_LIBRARY_DEFAULT_STORAGE_KEY = "rpa.collector-parts.v1";

/** Ephemeral session pointer for which Part the open editor is bound to (not Part config). */
export const ACTIVE_COLLECTOR_PART_SESSION_KEY = "rpa.collector-parts.activePartId";

export type CollectorPartType = "visual" | "network";
export type CollectorPartEditor = "feed-item-visual" | "post-detail" | "none";
export type CollectorPartStatus = "draft" | "ready";

export type PartInputContract = {
  schemaVersion: number;
  required: string[];
  optional: string[];
};

export type PartOutputContract = {
  schemaVersion: number;
  payloadKind: "visual_observations" | "network_records" | "unspecified";
};

/** Common result envelope — types only; no fictional runtime output. */
export type PartResultEnvelope<TPayload = unknown> = {
  schemaVersion: number;
  partId: string;
  partVersion: number;
  runId: string;
  status: "success" | "partial" | "failed";
  payload: TPayload;
  evidenceRefs: string[];
  diagnostics: string[];
};

export type VisualIconTemplateBlob = {
  kind: string;
  dataUrl: string;
  width: number;
  height: number;
  sourceFrameId: string;
  bbox: { x: number; y: number; width: number; height: number };
};

export type VisualIconTemplatesBlob = Partial<
  Record<"like" | "comment" | "share", VisualIconTemplateBlob>
>;

/** Independent Visual (Feed Item) configuration owned by one Part. */
export type VisualFeedItemPartConfig = {
  kind: "visual_feed_item";
  templates: VisualIconTemplatesBlob;
  step?: 1 | 2 | 3;
  reports?: unknown[];
  summaryStats?: unknown;
  currentRunId?: string | null;
  selectedFrameIndex?: number;
  selectedCandidateIndex?: number;
};

/** Independent Visual (Post Detail) configuration owned by one Part. */
export type VisualPostDetailPartConfig = {
  kind: "visual_post_detail";
  snapshot: Record<string, unknown>;
};

/** Network Part draft — capture not implemented. */
export type NetworkPartConfig = {
  kind: "network_draft";
  readiness: "not_implemented";
  note: string;
};

export type CollectorPartConfig =
  | VisualFeedItemPartConfig
  | VisualPostDetailPartConfig
  | NetworkPartConfig;

export type CollectorPart = {
  partId: string;
  name: string;
  partType: CollectorPartType;
  version: number;
  status: CollectorPartStatus;
  editor: CollectorPartEditor;
  inputContract: PartInputContract;
  outputContract: PartOutputContract;
  config: CollectorPartConfig;
  createdAt: string;
  updatedAt: string;
};

export type CollectorScriptPartRef = {
  partId: string;
  partVersion: number;
};

export type CollectorScriptDef = {
  scriptId: string;
  name: string;
  version: number;
  status: "draft";
  partRefs: CollectorScriptPartRef[];
  createdAt: string;
  updatedAt: string;
};

/** Idempotent adoption marker — which Part owns the adopted Feed Visual Counter snapshot. */
export type VisualFeedAdoptionRecord = {
  schemaVersion: 1;
  adoptedPartId: string;
  contentFingerprint: string;
  adoptedAt: string;
};

export type PartLibraryEnvelope = {
  schemaVersion: number;
  updatedAt: string;
  parts: CollectorPart[];
  scripts: CollectorScriptDef[];
  /** Present after one-time Feed Visual Counter → Part Library adoption. */
  visualFeedAdoption?: VisualFeedAdoptionRecord;
  parseWarnings?: string[];
  rawBackup?: string;
};

export function defaultVisualInputContract(): PartInputContract {
  return {
    schemaVersion: 1,
    required: ["browserSession"],
    optional: ["sourceUrl"],
  };
}

export function defaultVisualOutputContract(): PartOutputContract {
  return {
    schemaVersion: 1,
    payloadKind: "visual_observations",
  };
}

export function defaultNetworkInputContract(): PartInputContract {
  return {
    schemaVersion: 1,
    required: ["browserSession"],
    optional: ["sourceUrl"],
  };
}

export function defaultNetworkOutputContract(): PartOutputContract {
  return {
    schemaVersion: 1,
    payloadKind: "network_records",
  };
}

export function emptyVisualFeedItemConfig(): VisualFeedItemPartConfig {
  return {
    kind: "visual_feed_item",
    templates: {},
    step: 1,
    reports: [],
    summaryStats: null,
    currentRunId: null,
    selectedFrameIndex: 0,
    selectedCandidateIndex: 0,
  };
}

export function emptyPostDetailPartConfig(): VisualPostDetailPartConfig {
  return {
    kind: "visual_post_detail",
    snapshot: {},
  };
}

export function emptyNetworkPartConfig(): NetworkPartConfig {
  return {
    kind: "network_draft",
    readiness: "not_implemented",
    note: "Network capture and extraction are not implemented. This Part is a saved Draft placeholder only.",
  };
}
