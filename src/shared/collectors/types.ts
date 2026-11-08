/**
 * Collector C1.1 prototype types — isolated from Script Variable / SQLite contracts.
 * Script Variable remains: { id, key, type: text|file|files|integer|number, description? }
 */
import type { OcrResult, Rect } from "../contracts.js";

export const COLLECTOR_STORAGE_KEY = "rpa.collectors.prototype.v1";
/**
 * C1.6+: Four-step audit-driven wizard (Capture → Review & Mapping → Discovery → Validation).
 * C2: Real Browser Core captures (imageAsset) + Unknown extraction until engines exist.
 */
export const COLLECTOR_SCHEMA_VERSION = 6;

export type CollectorStrategy = "FEED_NETWORK_JSON" | "POST_DETAIL_VISUAL";
export type CollectorStatus = "draft" | "ready" | "outdated_validation";
export type CollectorValueType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "url"
  | "datetime"
  | "array"
  | "object";
export type CollectorSource =
  | "network_json"
  | "visual_dom"
  | "ocr_image"
  | "manual"
  | "derived";
/** C1.6 top-level wizard: 1 Capture · 2 Review & Mapping · 3 Discovery · 4 Validation */
export type WizardStepId = 1 | 2 | 3 | 4;
export type MappingPresence = "mapped" | "not_present" | "unmapped";
/** Per-capture audit status — Proposed is never Confirmed. */
export type CaptureAuditStatus =
  | "unreviewed"
  | "proposed"
  | "confirmed"
  | "needs_attention"
  | "excluded";
export type ValidationOutcome =
  | "all_pass"
  | "partial"
  | "failed"
  | "missing_required"
  | "ambiguous_match";
export type ValidationResultKind = "valid" | "partial" | "failed";
export type CandidateDecision = "pending" | "accepted" | "rejected";

/** Simulated audit match state — failed does not imply a new Post Type. */
export type AuditMatchState =
  | "matched"
  | "partial"
  | "failed"
  | "unresolved"
  | "excluded";

/**
 * Optional extraction variant after user audit confirms a structural difference.
 * Shares the collector Variables schema — does not duplicate Variable definitions.
 */
export type VariantPattern = {
  id: string;
  label: string;
  /** Optional user-defined tag (not auto Post Type). */
  tag: string;
  createdAt: string;
  notes: string;
  /** Keys into draft.variables — alternate mapping notes only. */
  variableKeys: string[];
  sourceRecordKeys: string[];
};

export type AuditRecordAction = {
  recordKey: string;
  state: AuditMatchState;
  mappingIssue?: boolean;
  variantId?: string;
  note?: string;
};

export type CollectorVariableMapping = {
  /**
   * Mapping identity key.
   * C1.6+: CaptureItem id. Legacy records may still store linked mock sample ids until migrated.
   */
  sampleId: string;
  presence: MappingPresence;
  observedValueId?: string;
  confirmed: boolean;
  /** True when filled by deterministic simulated auto-match (not live Network/DOM/OCR). */
  simulatedProposal?: boolean;

  // C2.7: Actual OCR evidence and learned rule mapping
  segmentId?: string;
  text?: string;
  bbox?: Rect;
  confidence?: number;
  evidence?: string;
  normalizedBbox?: {
    relX: number;
    relY: number;
    relW: number;
    relH: number;
  };
  nearbyAnchors?: {
    prevLineText?: string;
    nextLineText?: string;
  };
};

/** Per-capture review/audit state — independent of fixed Sample A/B/C roles. */
export type CaptureAudit = {
  captureItemId: string;
  status: CaptureAuditStatus;
  /** Shared schema revision when status became confirmed (detect later schema edits). */
  schemaRevisionAtConfirm?: number;
  note?: string;
  isolated?: boolean;
  /** User organizational tags when excluded (not Post Type / classification). */
  excludeTags?: string[];
  excludeReason?: string;
};

/** Collector output variable — conceptual cousin of Script Variable; not interchangeable. */
export type CollectorVariable = {
  id: string;
  key: string;
  label: string;
  valueType: CollectorValueType;
  required: boolean;
  expectedValue?: string;
  source?: CollectorSource;
  mappings: CollectorVariableMapping[];
  validationStatus?: "ok" | "missing" | "mismatch" | "unmapped";
};

export type MockSampleAsset = {
  id: string;
  title: string;
  classification: string;
  source: string;
  capturedAt: string;
  /** Lightweight SVG data-URI reference — never persisted in localStorage. */
  previewAssetId: string;
  summary: string;
  kind: "normal_text" | "image_text" | "recruitment" | "mixed_media" | "shared_post";
  observedValues: MockObservedValue[];
  parentLevels: number;
};

export type MockObservedValue = {
  id: string;
  label: string;
  value: string;
  source: CollectorSource;
  channel: "post_body" | "image_ocr" | "network" | "meta";
};

export type SampleSlot = "A" | "B" | "C";

/** ROI in preview-container pixels — Collector prototype only; not Script ROI. */
export type SampleRoi = {
  x: number;
  y: number;
  width: number;
  height: number;
  containerWidth: number;
  containerHeight: number;
};

/** Independent capture record — not a training role. */
export type CaptureItem = {
  id: string;
  /**
   * Optional linked mock fixture (legacy C1 simulated captures only).
   * Real Browser Core captures leave this empty — no invented extraction.
   */
  linkedMockSampleId?: string;
  captureSceneId?: string;
  captureUrl?: string;
  capturedAt: string;
  roi?: SampleRoi;
  /** Legacy mock SVG preview id — never a real screenshot claim. */
  previewAssetId?: string;
  /**
   * Real cropped PNG filename under app `targets/` (same store as Script targets).
   * Not embedded in localStorage.
   */
  imageAsset?: string;
  /** Browser Session id that owned the WebContents at capture time (no cookies). */
  browserSessionId?: string;
  /** true = C1 simulated fixture; false/undefined with imageAsset = real capture. */
  simulatedCapture?: boolean;
  /** Actual OCR result recognized from imageAsset (C2.7) */
  ocr?: OcrResult;
};

export function isRealCapture(item: CaptureItem): boolean {
  return Boolean(item.imageAsset) && item.simulatedCapture !== true;
}

/** Training role A/B/C references a CaptureItem — does not duplicate capture payloads. */
export type SampleAssignment = {
  slot: SampleSlot;
  captureItemId: string | null;
};

/** @deprecated C1–C1.4 shape retained only for localStorage migration. */
export type CollectorSampleSelection = {
  slot: SampleSlot;
  sampleId: string | null;
  captureItemId?: string | null;
  captureSceneId?: string;
  captureUrl?: string;
  capturedAt?: string;
  roi?: SampleRoi;
  previewAssetId?: string;
  simulatedCapture?: boolean;
};

export type ParentRangeState = {
  sampleLevels: Record<SampleSlot, number>;
  observedMin: number;
  observedMax: number;
  suggestedTolerance: number;
  parentUp: number;
  childDown: number;
  highlightedLevel: number;
  multiPostWarning: boolean;
  excessiveUiWarning: boolean;
};

export type DiscoveryCandidate = {
  id: string;
  strategy: CollectorStrategy;
  title: string;
  confidence: number;
  evidence: string;
  matchedVariableKeys: string[];
  decision: CandidateDecision;
  detail: Record<string, unknown>;
};

export type ValidationRecord = {
  sampleId: string;
  role: "training" | "holdout";
  /** @deprecated C1.6 uses captureItemId; slot kept for migrated snapshots. */
  slot?: SampleSlot;
  captureItemId?: string;
  auditStatus?: CaptureAuditStatus;
  expected: Record<string, string>;
  actual: Record<string, string>;
  missingRequired: string[];
  optionalMissing: string[];
  identityMismatch: boolean;
  duplicateOf?: string;
  result: ValidationResultKind;
};

export type ValidationRun = {
  id: string;
  outcome: ValidationOutcome;
  ranAt: string;
  outdated: boolean;
  records: ValidationRecord[];
  metrics: {
    matched: number;
    partial: number;
    unmatched: number;
    unique: number;
    duplicates: number;
  };
  rawJson: unknown;
  evidence: string[];
};

export type CollectorVersionSnapshot = {
  id: string;
  version: number;
  label: string;
  createdAt: string;
  active: boolean;
  immutable: true;
  strategy: CollectorStrategy | "";
  classification: string;
  variables: CollectorVariable[];
  captures?: CaptureItem[];
  captureAudits?: CaptureAudit[];
  schemaRevision?: number;
  samples: SampleAssignment[];
  parentRange: ParentRangeState;
  candidates: DiscoveryCandidate[];
  wizardStep: WizardStepId;
  samplesCompatible?: boolean;
  activeReviewCaptureId?: string;
  teachingCaptureId?: string;
  validation?: ValidationRun;
  variants?: VariantPattern[];
  auditActions?: AuditRecordAction[];
};

export type CollectorDraft = {
  id: string;
  name: string;
  description: string;
  /** Empty until author chooses at Discovery. */
  strategy: CollectorStrategy | "";
  platformLabel: string;
  /** Optional historical / audit label — never required at creation or Capture. */
  classification: string;
  status: CollectorStatus;
  createdAt: string;
  updatedAt: string;
  wizardStep: WizardStepId;
  /** Capture library — any length; not training roles. */
  captures: CaptureItem[];
  /** Per-capture audit / review status (C1.6). */
  captureAudits: CaptureAudit[];
  /** Bumped when shared Variables schema changes after teaching confirms. */
  schemaRevision: number;
  /**
   * Legacy A/B/C assignments — retained for migration / version snapshots only.
   * C1.6 UI does not require filling these.
   */
  samples: SampleAssignment[];
  /** @deprecated Compatibility flag from C1.5 assign step. */
  samplesCompatible: boolean;
  /** Active capture id inside Review & Mapping. */
  activeReviewCaptureId?: string;
  /** First confirmed teaching capture (reference schema). */
  teachingCaptureId?: string;
  /** Shared Variables schema for default pattern + all variants. */
  variables: CollectorVariable[];
  parentRange: ParentRangeState;
  candidates: DiscoveryCandidate[];
  validation?: ValidationRun;
  /** Default extraction pattern is implicit; variants are optional and audit-driven. */
  variants: VariantPattern[];
  auditActions: AuditRecordAction[];
  versions: CollectorVersionSnapshot[];
  activeVersionId?: string;
  dirty: boolean;
  /** Capture item id to replace when confirming the next ROI (library recapture). */
  recaptureItemId?: string;
};

export type CollectorTestCase = {
  id: string;
  name: string;
  collectorId: string;
  versionId?: string;
  strategy: CollectorStrategy | "";
  outcome: ValidationOutcome;
};

export type CollectorStoreEnvelope = {
  schemaVersion: number;
  updatedAt: string;
  collectors: CollectorDraft[];
  classifications: string[];
  testCases: CollectorTestCase[];
  parseWarnings?: string[];
  rawBackup?: string;
};

export type CollectorListFilters = {
  query: string;
  strategy: "" | CollectorStrategy;
  status: "" | CollectorStatus;
};

/** Bundled mock feed scene for simulated capture (not live Browser Core). */
export type CaptureScenePost = {
  id: string;
  label: string;
  /** Suggested linked mock sample when ROI centers in this post. */
  linkedSampleId: string;
  /** Relative bounds within scene (0–1). */
  bounds: { x: number; y: number; width: number; height: number };
};

export type CaptureScene = {
  id: string;
  title: string;
  defaultUrl: string;
  posts: CaptureScenePost[];
};
