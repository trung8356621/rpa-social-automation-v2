import type { OcrResult, Rect } from "../contracts.js";

export type PostDetailStep = 1 | 2 | 3;

export type VisualMatchStatus =
  "MATCHED" | "AMBIGUOUS" | "NOT_FOUND" | "MANUALLY_CONFIRMED";

export type OcrFrameStatus =
  "PENDING" | "OCR_DONE" | "OCR_FAILED" | "NEEDS_REVIEW";

/** Visual reference sample — UI variant template, not an OCR content frame. */
export type VisualReferenceSample = {
  sampleId: string;
  label: string;
  dataUrl: string;
  width: number;
  height: number;
  sourceCaptureId?: string;
  bbox: Rect;
  createdAt: string;
};

/** One OCR capture frame in a multi-sample sequence for a long post. */
export type PostDetailOcrFrame = {
  runId: string;
  frameId: string;
  frameIndex: number;
  scrollY: number | null;
  roi: Rect;
  screenshotDataUrl?: string;
  screenshotPath?: string;
  cropDataUrl?: string;
  cropPath?: string;
  ocrText: string;
  ocrConfidence: number | null;
  ocrSegments?: OcrResult["segments"];
  matchStatus: VisualMatchStatus | null;
  matchScore: number | null;
  matchTemplateId: string | null;
  processingStatus: OcrFrameStatus;
  diagnostics: {
    errors: string[];
    warnings: string[];
    notes: string[];
  };
  createdAt: string;
};

export type PostDetailMatchResult = {
  status: VisualMatchStatus;
  score: number | null;
  templateId: string | null;
  bbox: Rect | null;
  candidateCount: number;
  scores: number[];
  screenshotDataUrl?: string;
  notes: string[];
};

export type PostDetailRunManifest = {
  schemaVersion: string;
  kind: "POST_DETAIL";
  runId: string;
  sourceUrl: string;
  platform: string;
  createdAt: string;
  completedAt?: string;
  frameCount: number;
  visualReferenceCount: number;
  viewport?: { width: number; height: number };
};

export type PostDetailSavedRunSummary = {
  runId: string;
  sourceUrl: string;
  createdAt: string;
  frameCount: number;
  platform: string;
};

export type PostDetailSaveRunInput = {
  runId: string;
  sourceUrl: string;
  platform?: string;
  createdAt?: string;
  viewport?: { width: number; height: number };
  visualReferences: Array<
    Omit<VisualReferenceSample, "dataUrl"> & { dataUrl?: string }
  >;
  frames: Array<
    Omit<PostDetailOcrFrame, "screenshotDataUrl" | "cropDataUrl"> & {
      screenshotDataUrl?: string;
      cropDataUrl?: string;
    }
  >;
};

export type PostDetailSaveRunResult = {
  ok: boolean;
  runId: string;
  runDir: string;
  manifestPath: string;
  frameCount: number;
};

export type PostDetailLoadRunResult = {
  ok: boolean;
  runId: string;
  manifest: PostDetailRunManifest;
  visualReferences: VisualReferenceSample[];
  frames: PostDetailOcrFrame[];
};

export const POST_DETAIL_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_POST_DETAIL_FIXTURE_URL =
  "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/";

export type PostDetailAnchorType = "LIKE" | "COMMENT" | "SHARE";

export type PostDetailVisualAnchor = {
  type: PostDetailAnchorType;
  frameId: string;
  frameIndex: number;
  bbox: Rect;
  score: number;
  templateId: string;
  /** Rank among same-template candidates (0 = best). */
  candidateRank?: number;
  rejectionReason?: string | null;
};

export type PostDetailWheelOutcome =
  | "WHEEL_SENT"
  | "WHEEL_SENT_UNFOCUSED"
  | "WHEEL_BLOCKED"
  | "WHEEL_BLOCKED_FOCUS"
  | "WHEEL_BLOCKED_NOT_VISIBLE"
  | "WHEEL_SKIPPED"
  | "NONE";

export type PostDetailScrollConfirm =
  "VISUAL_SCROLL_CONFIRMED" | "SCROLL_NOT_MOVING" | "PENDING" | "N/A";

/** Per-frame Auto Scan diagnostics (no secrets). */
export type PostDetailFrameDiagnostics = {
  frameIndex: number;
  wheelTarget: { x: number; y: number } | null;
  requestedDeltaY: number | null;
  wheelOutcome: PostDetailWheelOutcome;
  wheelReason?: string;
  screenshotBeforeRef?: string;
  screenshotAfterRef?: string;
  visualMotionScore: number | null;
  scrollConfirmed: boolean | null;
  scrollConfirmLabel: PostDetailScrollConfirm;
  /** Cumulative visually confirmed scroll (magnitude), not requested wheel sum. */
  observedScrollPx: number;
  matchLogs: Array<{
    type: PostDetailAnchorType;
    templateId: string;
    score: number;
    threshold: number;
    bbox: Rect | null;
    accepted: boolean;
    rejectionReason: string | null;
    candidateRank: number;
  }>;
  containerCandidate: Rect | null;
  stopOrRejectReason?: string;
  timingsMs?: {
    wheelIpc?: number;
    settle?: number;
    screenshot?: number;
    decode?: number;
    match?: number;
    columnProfile?: number;
    onFrame?: number;
    total?: number;
  };
};

export type PostDetailScanFrame = {
  frameId: string;
  frameIndex: number;
  /** Cumulative *requested* wheel magnitude before this capture (for audit). */
  scrollDeltaApplied: number;
  /** Cumulative visually confirmed scroll magnitude. */
  observedScrollPx: number;
  screenshotDataUrl?: string;
  width: number;
  height: number;
  anchors: PostDetailVisualAnchor[];
  /** Extra same-type candidates retained for main vs comment action-row disambiguation. */
  anchorCandidates?: PostDetailVisualAnchor[];
  diagnostics?: PostDetailFrameDiagnostics;
  notes: string[];
};

export type PostDetailContainerStatus = "FOUND" | "AMBIGUOUS" | "NOT_FOUND";

export type MainActionRowStatus =
  "MAIN_ACTION_ROW_CANDIDATE" | "CONFIRMED" | "AMBIGUOUS" | "NOT_FOUND";

/** Best Like/Comment/Share action-row cluster retained across Auto Scan frames. */
export type PostDetailMainActionRow = {
  status: MainActionRowStatus;
  frameId: string;
  frameIndex: number;
  anchors: PostDetailVisualAnchor[];
  bbox: Rect;
  meanScore: number;
  types: Array<PostDetailAnchorType>;
  strength: "STRONG" | "WEAK";
  orderOk: boolean;
  observedScrollPx: number;
  notes: string[];
};

/** Step 2 primary output — Post Detail container from visual scan (not DOM). */
export type PostDetailContainerResult = {
  status: PostDetailContainerStatus;
  containerBounds: Rect | null;
  frameIds: string[];
  visualAnchors: PostDetailVisualAnchor[];
  confidence: number | null;
  evidenceRefs: string[];
  runId: string;
  sourceUrl: string;
  /** Phase A: best main action-row candidate (retained even when container AMBIGUOUS). */
  mainActionRow: PostDetailMainActionRow | null;
  scrollMetadata: {
    wheelPoint: { x: number; y: number };
    /** Signed wheel delta sent to BrowserCore (negative = content down per self-test). */
    deltaY: number;
    settleMs: number;
    maxFrames: number;
    framesCaptured: number;
    stoppedReason: string;
    requestedScrollPx: number;
    observedScrollPx: number;
    visualScrollConfirmedFrames: number;
  };
  notes: string[];
};

export const POST_DETAIL_AUTO_SCAN_DEFAULTS = Object.freeze({
  maxFrames: 20,
  /**
   * Signed mouseWheel deltaY. Negative scrolls content down in BrowserCore
   * (self-test: scroll(-400) increases scrollY). Fine step so Post Detail does not jump into comments.
   */
  deltaY: -100,
  /** Cap for adaptive settle (initial settle is shorter; extends only if motion unconfirmed). */
  settleMs: 550,
  settleMsInitial: 180,
  settleMsRetry: 220,
  matchThreshold: 0.55,
  /** Content-band MAD threshold for VISUAL_SCROLL_CONFIRMED. */
  motionThreshold: 6.5,
  /** Stop after this many consecutive wheels with no visual movement. */
  maxStaleWheels: 2,
  /** Retry focus-related wheel blocks before aborting scan. */
  maxFocusWheelRetries: 2,
});

/** Step 2 Auto Scan evidence — does not write final OCR manifest.json (Step 3 owns that). */
export type PostDetailSaveAutoScanInput = {
  runId: string;
  sourceUrl: string;
  visualReferences: Array<
    Omit<VisualReferenceSample, "dataUrl"> & { dataUrl?: string }
  >;
  frames: Array<
    Omit<PostDetailScanFrame, "screenshotDataUrl"> & {
      screenshotDataUrl?: string;
    }
  >;
  container: PostDetailContainerResult;
};

export type PostDetailSaveAutoScanResult = {
  ok: boolean;
  runId: string;
  runDir: string;
  autoScanManifestPath: string;
  frameCount: number;
};

export type PostDetailParsedJson = {
  post_id: string | null;
  post_url: string | null;
  author_name: string | null;
  author_url: string | null;
  post_time: string | null;
  content: string | null;
  images: string[];
  links: string[];
  reaction_count: number | null;
  comment_count: number | null;
  share_count: number | null;
};

export type PostDetailHtmlExtractionStatus =
  | "FOUND"
  | "AMBIGUOUS"
  | "STALE_VISUAL_ANCHOR"
  | "URL_MISMATCH"
  | "WEB_CONTENTS_CHANGED"
  | "NOT_FOUND";

export type PostDetailExtractAboveInput = {
  runId: string;
  expectedUrl: string;
  expectedWebContentsId: number;
  frameId: string;
  frameIndex: number;
  screenshot: { width: number; height: number };
  anchors: PostDetailVisualAnchor[];
};

export type PostDetailHtmlExtractionResult = {
  ok: boolean;
  status: PostDetailHtmlExtractionStatus;
  runId: string;
  rawHtml: string;
  extractedHtml: string;
  textPreview: string;
  parsed: PostDetailParsedJson;
  boundary: Record<string, unknown>;
  diagnostics: string[];
  evidencePaths?: Record<string, string>;
};

export type PostDetailParentCandidate = {
  index: number;
  parentLevel: number;
  descendantCount: number;
  urlMatchCount: number;
  similarRowCount: number;
  htmlSize: number;
  fingerprint: string;
  rect: Rect;
  tag: string;
  role: string | null;
  status: "CANDIDATE";
  urlCandidates: Array<{ href: string; reason: string }>;
};

export type PostDetailParentProbeInput = {
  sourceUrl: string;
  expectedWebContentsId: number;
  frameId: string;
  runId: string;
  screenshot: { width: number; height: number };
  anchors: PostDetailVisualAnchor[];
  expectedParentLevel?: number | null;
};

export type PostDetailParentProbeResult = {
  status: "FOUND" | "AMBIGUOUS" | "STALE_VISUAL_ANCHOR" | "URL_NOT_FOUND" | "WEB_CONTENTS_CHANGED";
  currentUrl: string;
  postId: string | null;
  platform?: string;
  actionRow: { tag: string; rect: Rect } | null;
  actionRowHtml: string;
  actionRowSignature: Record<string, unknown> | null;
  urlCandidates: Array<{ href: string; reason: string }>;
  levels: Array<Omit<PostDetailParentCandidate, "index" | "status"> & { status: "SCANNED" | "CANDIDATE" | "BOUNDARY_CROSSED" }>;
  candidates: PostDetailParentCandidate[];
  selectedIndex: number | null;
  stopReason: "SECOND_ACTION_ROW_FOUND" | "NO_SECOND_ACTION_ROW" | "STALE_VISUAL_ANCHOR" | "NO_POST_ID";
  boundaryLevel: number | null;
  expectedParentLevel?: number | null;
  calibrationMode?: "EXACT" | "EXPANDED_PLUS_MINUS_ONE" | "FULL_PROGRESSIVE";
  diagnostics: string[];
};

export type PostDetailActionAnchorProbeResult = {
  status: "FOUND" | "STALE_VISUAL_ANCHOR" | "AMBIGUOUS" | "WEB_CONTENTS_CHANGED";
  hits: Array<{ type: PostDetailAnchorType; point: { x: number; y: number }; tag: string | null; role: string | null; rect: Rect | null; text: string }>;
  actionRow: { tag: string; role: string | null; rect: Rect; descendantCount: number } | null;
  diagnostics: string[];
};

export type PostDetailParentConfirmation = {
  runId: string;
  postId: string;
  platform: string;
  confirmedAt: string;
  parentLevel: number;
  actionRowSignature: Record<string, unknown>;
  actionRowHtml: string;
  stopReason: PostDetailParentProbeResult["stopReason"];
  boundaryLevel: number | null;
  levelsInspected: number;
  candidate: PostDetailParentCandidate;
};
