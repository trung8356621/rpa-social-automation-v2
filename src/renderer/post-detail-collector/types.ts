import type { Command } from "../../shared/contracts";
import type {
  PostDetailContainerResult,
  PostDetailMatchResult,
  PostDetailOcrFrame,
  PostDetailHtmlExtractionResult,
  PostDetailParentConfig,
  PostDetailDomAnchorRecord,
  PostDetailSavedParentResolution,
  PostDetailEngagementOcrResult,
  PostDetailScanFrame,
  PostDetailStep,
  VisualReferenceSample,
} from "../../shared/post-detail-collector/types";

export type Invoke = <T>(command: Command) => Promise<T>;

export type BrowserProbe = {
  available: boolean;
  webContentsId: number;
  url: string;
  isSocialPage: boolean;
  sessionId?: string;
};

export type PostDetailMajorStep = 1 | 2 | 3;
export type PostDetailProcessingSubstep = 1 | 2 | 3;
export type PostDetailUrlStatus = "PENDING" | "PROCESSING" | "READY" | "NEEDS_ATTENTION" | "FAILED";

export type PostDetailUrlItem = {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  postId: string | null;
  platform: string | null;
  groupSlug?: string;
  groupId?: string;
  status: PostDetailUrlStatus;
  strategyId?: string;
  diagnostics: string[];
  engagementAnchorsVerified?: boolean;
  updatedAt: string;
};

export type PostDetailDomStrategy = {
  id: string;
  version: 1;
  platform: string;
  structuralSignature: string;
  parentConfig: PostDetailParentConfig;
  anchors: Partial<Record<"like_anchor" | "comment_anchor" | "share_anchor", PostDetailDomAnchorRecord>>;
  validationStatus: "CONFIRMED" | "LEGACY" | "VARIATION";
  successes: number;
  failures: number;
  createdAt: string;
  updatedAt: string;
};

export type PostDetailCollectorState = {
  schemaVersion: 2;
  majorStep: PostDetailMajorStep;
  processingSubstep: PostDetailProcessingSubstep;
  urlItems: PostDetailUrlItem[];
  selectedUrlId: string | null;
  strategies: PostDetailDomStrategy[];
  step: PostDetailStep;
  /** User-intended post URL (Open URL target). */
  sourceUrl: string;
  /** Live BrowserCore URL (probe / navigation result). */
  browserUrl: string;
  runId: string | null;
  visualReferences: VisualReferenceSample[];
  /** Confirmed Post Detail container / OCR region from Step 2 (never action-row template ROI). */
  contentRoi: import("../../shared/contracts").Rect | null;
  containerResult: PostDetailContainerResult | null;
  scanFrames: PostDetailScanFrame[];
  lastMatch: PostDetailMatchResult | null;
  lastScreenshot: { id: string; dataUrl: string; width: number; height: number } | null;
  frames: PostDetailOcrFrame[];
  selectedFrameIndex: number;
  viewMode: "original" | "crop" | "text";
  htmlExtraction: PostDetailHtmlExtractionResult | null;
  parentConfigs: Record<string, PostDetailParentConfig>;
  savedParentResolution: PostDetailSavedParentResolution | null;
  engagementResults: Record<string, PostDetailEngagementOcrResult>;
  variableMappings: PostDetailDomVariableMapping[];
  hiddenExtractedData: Record<string, string[]>;
  batchUrlsText: string;
  batchResults: BatchValidationRow[];
  batchConfigVersion: number;
  batchValidatedVersion: number | null;
};

export type BatchFieldResult = {
  variableId: string;
  variableKey: string;
  variableLabel: string;
  required: boolean;
  value: string;
  values?: string[];
  method: PostDetailExtractionMethod | "UNMAPPED";
  attribute?: string;
  relativeXPath: string;
  status: "PASS" | "REVIEW";
  fieldStatus?: "PASS" | "MISSING" | "NEEDS_ATTENTION";
  reason?: string;
};

export type BatchValidationRow = {
  url: string;
  resolvedUrl: string;
  postId: string | null;
  parentStatus: "Matched" | "Failed" | "Invalid";
  passedCount: number;
  totalCount: number;
  extractedCount?: number;
  missingCount?: number;
  needsAttentionCount?: number;
  userVerifiedCount?: number;
  configVersion?: number;
  status: "PASS" | "REVIEW" | "FAILED";
  failureReason?: string;
  parentDiagnostics?: string[];
  fields: BatchFieldResult[];
  validatedAt: string;
};

export type PostDetailExtractionMethod =
  | "VISUAL_OCR"
  | "DOM_TEXT"
  | "DOM_ATTRIBUTE"
  | "DOM_ATTRIBUTE_REF_TEXT"
  | "DOM_TEXT_NUMBER"
  | "DOM_ATTRIBUTE_NUMBER"
  | "CONTENT_TEXT"
  | "CONTENT_HTML"
  | "POST_IMAGES";

export type PostImageEntry = {
  url: string;
  sourcePath: number[];
  quality: "high" | "standard" | "fallback";
  sourceAttr: string;
  permalink?: string;
};

export type PostDetailDomVariableMapping = {
  collectorId: string;
  variableId: string;
  variableKey: string;
  variableLabel: string;
  method: PostDetailExtractionMethod;
  attribute?: string;
  relativePath: number[];
  relativeXPath: string;
  preview: string;
  sourceContext?: "post" | "comment" | "unknown";
  sourceSemantic?: "created_at" | "content" | "like_count" | "comment_count" | "share_count" | "post_images";
  outputKey?: string;
  confirmed: true;
  updatedAt: string;
};

export type {
  PostDetailContainerResult,
  PostDetailMatchResult,
  PostDetailOcrFrame,
  PostDetailScanFrame,
  PostDetailStep,
  VisualReferenceSample,
};
