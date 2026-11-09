/**
 * Collector C1.1 prototype types — isolated from Script Variable / SQLite contracts.
 * Script Variable remains: { id, key, type: text|file|files|integer|number, description? }
 */
import type { OcrResult, Rect } from "../contracts.js";

export const COLLECTOR_STORAGE_KEY = "rpa.collectors.prototype.v1";
/**
 * C1.6+: Four-step audit-driven wizard (Capture → Review & Mapping → Discovery → Validation).
 * C2: Real Browser Core captures (imageAsset) + Unknown extraction until engines exist.
 * C2.10: Five-step wizard with Live Browser Match Test (Capture → Review → Match Test → Discovery → Validation).
 */
export const COLLECTOR_SCHEMA_VERSION = 7;

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
/** C2.10 top-level wizard: 1 Capture · 2 Review & Mapping · 3 Match Test · 4 Discovery · 5 Validation */
export type WizardStepId = 1 | 2 | 3 | 4 | 5;
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

export type CollectorExtractionMethod = "OCR_TEXT" | "DOM_TEXT" | "DOM_ATTRIBUTE";

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
  // C2.10: Region association for container/region-scoped OCR
  regionId?: string;
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
  // C2.10.3: Extraction method per mapping & multi-variable mapping
  method?: CollectorExtractionMethod;
  attribute?: string;
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
  /** Visual & DOM regions defined/learned for this capture (C2.8) */
  regions?: CollectorRegion[];
  /** Layout context: feed stream item vs single post detail page (C2.8) */
  layoutContext?: LayoutContextKind;
  /** Verified post container element verified for this item (C2.8) */
  postContainer?: VerifiedPostContainer;
  /** Dynamic HTML extraction result for this item (C2.8) */
  dynamicExtraction?: DynamicHtmlExtractionResult;
  /** DOM snapshot captured alongside this item (C2.8) */
  domSnapshot?: CollectorDomSnapshot;
};

export type CollectorRegionType =
  | "BEGIN"
  | "END"
  | "FREE"
  | "STATIC"
  | "DYNAMIC";

export type RegionRelationshipKind =
  | "inside"
  | "after"
  | "before"
  | "between"
  | "belongs_to_container";

export type RegionRelationship = {
  relation: RegionRelationshipKind;
  targetRegionId: string;
};

export type NormalizedRegionGeometry = {
  relX: number; // 0..1 relative to original image width
  relY: number; // 0..1 relative to original image height
  relW: number; // 0..1 relative to original image width
  relH: number; // 0..1 relative to original image height
};

export type DomElementEvidence = {
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  cssSelector?: string;
  xpath?: string;
  bbox?: Rect;
  textSnippet?: string;
  attributes?: Record<string, string>;
  depth?: number;
};

export type CollectorRegionRole = "header" | "footer" | "content" | "media" | "actions" | "custom";

export type CollectorRegion = {
  id: string;
  captureItemId: string;
  type: CollectorRegionType;
  label: string;
  role?: CollectorRegionRole;
  groupTag?: string;
  geometry: NormalizedRegionGeometry;
  originalRoi?: Rect;
  candidateVariableKeys: string[];
  confirmed: boolean;
  simulatedProposal?: boolean;
  confidence?: number;
  evidence?: string;
  relationships?: RegionRelationship[];
  domEvidence?: DomElementEvidence;
  ocrEvidence?: {
    text: string;
    segmentIds?: string[];
    confidence: number;
  };
  referenceImage?: string;
  referenceImageAsset?: string;
  // C2.10: OCR result scoped strictly to this region crop
  ocr?: OcrResult;
  createdAt: string;
  updatedAt: string;
};

// C2.11: Group Tag suggestions for auto-complete combobox
export type GroupTagSuggestionKind =
  | "unpaired_in_sample"
  | "other_sample"
  | "existing_group"
  | "create_new";

export type GroupTagSuggestion = {
  tag: string;
  kind: GroupTagSuggestionKind;
  label?: string;
  hasBeginInSample?: boolean;
  hasEndInSample?: boolean;
  sampleCount: number;
};

// C2.11: Learned Anchor Rule Foundation
export type StableGeometryProfile = {
  minRelX: number;
  maxRelX: number;
  avgRelX: number;
  minRelY: number;
  maxRelY: number;
  avgRelY: number;
  minRelW: number;
  maxRelW: number;
  avgRelW: number;
  minRelH: number;
  maxRelH: number;
  avgRelH: number;
};

export type AnchorReferenceExample = {
  captureItemId: string;
  regionId: string;
  originalRoi?: Rect;
  geometry: NormalizedRegionGeometry;
  role?: CollectorRegionRole;
  domEvidence?: DomElementEvidence;
  ocrEvidenceText?: string;
  ocrText?: string;
  candidateVariableKeys: string[];
  referenceImageAsset?: string;
  referenceImage?: string;
};

export type AnchorLearnedFeature = {
  feature:
    | "header_layout"
    | "author_link_structure"
    | "timestamp_indicator"
    | "avatar_presence"
    | "semantic_role"
    | "stable_text_tokens";
  weight: number;
  supportCount: number;
  sampleCount: number;
  details?: string;
};

export type LearnedAnchorRule = {
  groupTag: string;
  type: CollectorRegionType;
  role: CollectorRegionRole;
  trainingSampleCount?: number;
  exampleCount: number;
  referenceExamples: AnchorReferenceExample[];
  geometryProfile: StableGeometryProfile;
  stableTokens: string[];
  variableTokens: string[];
  domProfile: {
    tagNames: string[];
    roles: string[];
    hasAttributes: string[];
  };
  features?: AnchorLearnedFeature[];
  evidenceStrength?: number;
  uncertainty?: number;
  associatedVariableKeys: string[];
};

export type LearnedAnchorGroup = {
  groupTag: string;
  beginRule?: LearnedAnchorRule;
  endRule?: LearnedAnchorRule;
  freeRules: LearnedAnchorRule[];
  sampleIds: string[];
};

// C2.11: Region Quick Fill Proposal
export type QuickFillProposal = {
  variableId: string;
  variableKey: string;
  targetRegionId: string;
  targetSegmentId: string;
  targetSegmentText?: string;
  method: CollectorExtractionMethod;
  attribute?: string;
  confidence: number;
  evidence: string;
  bbox: Rect;
  normalizedBbox: {
    relX: number;
    relY: number;
    relW: number;
    relH: number;
  };
  refSampleId: string;
  refRegionId: string;
};

export type QuickFillResult = {
  draft: CollectorDraft;
  proposals: QuickFillProposal[];
  appliedCount: number;
};

export type MatchTestStatus = "NOT TESTED" | "MATCHED" | "PARTIAL" | "AMBIGUOUS" | "NO MATCH" | "FAILED";

export type AnchorMatchDetail = {
  regionId: string;
  role: "BEGIN" | "END" | "FREE";
  groupTag?: string;
  matched: boolean;
  matchedElementId?: string;
  matchedTagName?: string;
  matchedRect?: Rect;
  confidence: number;
  method: "text_dom" | "visual_projection" | "none";
  evidence?: string;
};

export type CandidateDiagnosticInfo = {
  id: string;
  tagName: string;
  role?: string;
  textSnippet?: string;
  rect: Rect;
  isViewportRelative: boolean;
  isFixed?: boolean;
  score: number;
  method: string;
  reasons: string;
};

export type PostGroupMatch = {
  groupTag: string;
  status: MatchTestStatus;
  beginMatch?: AnchorMatchDetail;
  endMatch?: AnchorMatchDetail;
  dynamicBounds?: {
    dynamicStartY: number;
    dynamicEndY: number;
    height: number;
    bounds: Rect;
  };
  domContainer?: {
    containerId: string;
    tagName: string;
    role?: string;
    depth: number;
    isArticleOrCard: boolean;
  };
  domAssociationStatus: "CONFIRMED" | "FAILED" | "NOT_RESOLVED";
  visualConfidence: number;
  limitations?: string[];
  failureReason?: string;
  candidateDiagnostics?: {
    mode?: "BEGIN_ONLY" | "PAIRED";
    trainingSampleCount?: number;
    learnedFeatures?: AnchorLearnedFeature[];
    liveCandidatesBeforeDeduplication?: number;
    liveCandidatesAfterDeduplication?: number;
    topCandidates?: Array<{
      id: string;
      tagName: string;
      role?: string;
      textSnippet?: string;
      rect: Rect;
      score: number;
      featureScores?: Record<string, number>;
      method: string;
      reasons: string;
    }>;
    selectedCandidate?: {
      id: string;
      tagName: string;
      rect: Rect;
      score: number;
      featuresMatched: string[];
    } | null;
    rejectionReasons?: Array<{
      id: string;
      tagName: string;
      textSnippet?: string;
      reason: string;
    }>;
    outerContainerDiagnostics?: Array<{
      beginElement: {
        id: string;
        tagName: string;
        rect: Rect;
        textSnippet?: string;
      };
      ancestorCandidates: Array<{
        id: string;
        tagName: string;
        role?: string;
        rect: Rect;
        score: number;
        reasons: string;
        rejected?: boolean;
        rejectionReason?: string;
      }>;
      selectedOuterContainer: {
        id: string;
        tagName: string;
        role?: string;
        rect: Rect;
        selectionReason: string;
        confidence: number;
      };
    }>;
    deduplicationDecisions?: string[];
    finalUniquePostCount?: number;
    topBeginCandidates: CandidateDiagnosticInfo[];
    topEndCandidates: CandidateDiagnosticInfo[];
    rejectedPairings: Array<{
      beginId: string;
      beginTag: string;
      beginY: number;
      endId: string;
      endTag: string;
      endY: number;
      reason: string;
    }>;
    selectedPair?: {
      beginId: string;
      beginTag: string;
      beginY: number;
      endId: string;
      endTag: string;
      endY: number;
      containerId?: string;
      containerTag?: string;
      containerRect?: Rect;
      score: number;
    } | null;
  };
};

export type MatchedPostItem = {
  index: number; // 1, 2, 3
  groupTag: string;
  beginRect?: Rect;
  endRect?: Rect;
  containerRect?: Rect;
  containerId?: string;
  beginElementId?: string;
  endElementId?: string;
  containerTagName?: string;
  beginMatched: boolean;
  endMatched: boolean;
  paired: boolean;
  domResolved: boolean;
  confidence: number;
  failureReason?: string;
};

export type MatchTestResult = {
  testedAt: string;
  browserUrl: string;
  status: MatchTestStatus;
  matchedPostCount: number;
  groups: PostGroupMatch[];
  matchedItems?: MatchedPostItem[];
  summary: string;
  limitations?: string[];
  error?: string;
};

export type LayoutContextKind = "FEED_ITEM" | "POST_DETAIL";

export type VerifiedPostContainer = {
  containerId: string;
  tagName: string;
  selector: string;
  role?: string;
  layoutContext: LayoutContextKind;
  confidence: number;
  evidence: string[];
  headerMatched: boolean;
  footerMatched: boolean;
  isNestedSharedPost: boolean;
  outerHtmlSnippet?: string;
  rejectionReason?: string;
  groupTag?: string;
  rect?: Rect;
};

export type DynamicHtmlExtractionResult = {
  status: "success" | "partial" | "empty" | "stale";
  rawHtml: string;
  extractedText?: string;
  mediaUrls?: string[];
  linkPreviews?: Array<{ title: string; url: string; domain?: string }>;
  isComplete: boolean;
  hasCollapsedText: boolean;
  hasLazyMedia: boolean;
  evidence: string[];
  extractedAt: string;
};

export type CollectorDomElement = {
  id: string;
  tagName: string;
  role?: string;
  className?: string;
  idAttr?: string;
  rect: Rect;
  textSnippet: string;
  attributes: Record<string, string>;
  childrenIds: string[];
  parentId?: string;
  depth: number;
  isArticleOrCard?: boolean;
  isFeedContainer?: boolean;
  isDialogOrModal?: boolean;
  isFixed?: boolean;
  hasMedia?: boolean;
  outerHtmlSnippet?: string;
};

export type CollectorDomSnapshot = {
  url: string;
  capturedAt: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; dpr: number };
  elements: CollectorDomElement[];
  rootId?: string;
  isStale?: boolean;
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
  regions?: CollectorRegion[];
  layoutContext?: LayoutContextKind;
  matchTest?: MatchTestResult;
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
  /** Visual & DOM region anchors across the collector (C2.8) */
  regions?: CollectorRegion[];
  /** Layout context: feed stream item vs single post detail page (C2.8) */
  layoutContext?: LayoutContextKind;
  /** Live Browser Match Test results (C2.10) */
  matchTest?: MatchTestResult;
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
