import type { OcrResult, Rect } from "../contracts.js";

export type PostDetailStep = 1 | 2 | 3;

export type VisualMatchStatus = "MATCHED" | "AMBIGUOUS" | "NOT_FOUND";

export type OcrFrameStatus = "PENDING" | "OCR_DONE" | "OCR_FAILED" | "NEEDS_REVIEW";

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
  visualReferences: Array<Omit<VisualReferenceSample, "dataUrl"> & { dataUrl?: string }>;
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
