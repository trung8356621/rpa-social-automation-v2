import type { Command } from "../../shared/contracts";
import type {
  PostDetailMatchResult,
  PostDetailOcrFrame,
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

export type PostDetailCollectorState = {
  step: PostDetailStep;
  sourceUrl: string;
  runId: string | null;
  visualReferences: VisualReferenceSample[];
  /** Confirmed OCR content ROI from Step 1/2 (image pixel coords). */
  contentRoi: import("../../shared/contracts").Rect | null;
  lastMatch: PostDetailMatchResult | null;
  lastScreenshot: { id: string; dataUrl: string; width: number; height: number } | null;
  frames: PostDetailOcrFrame[];
  selectedFrameIndex: number;
  viewMode: "original" | "crop" | "text";
};

export type {
  PostDetailMatchResult,
  PostDetailOcrFrame,
  PostDetailStep,
  VisualReferenceSample,
};
