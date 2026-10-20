export type Rect = { x: number; y: number; width: number; height: number };
export type Action =
  | "CLICK_TARGET"
  | "CLICK_AND_TYPE"
  | "UPLOAD_FILE"
  | "QUICK_TAG"
  | "TYPE_ONLY"
  | "WAIT_VERIFY"
  | "SCROLL";
export type OcrSegment = {
  id: string;
  text: string;
  bbox: Rect;
  confidence: number;
  kind: "line" | "word";
};
export type OcrResult = {
  text: string;
  confidence: number;
  segments: OcrSegment[];
  language: "vie+eng";
};
export type VisualEnvironment = { width: number; height: number; zoom: number };
export type VisualTarget = {
  /** current is a read-compatible legacy spelling of none. */
  matchTo?: "none" | "current" | "top" | "middle" | "bottom";
  environment?: VisualEnvironment;
  asset: string;
  roi: Rect;
  ocr?: Omit<OcrSegment, "id"> & { confirmed: true; language: "vie+eng" };
};
export type Payload = {
  action: Action;
  variableId?: string;
  /** Number of complete, equally sized visible rows in the cropped ROI. */
  quickTagRows?: number;
  /** Runtime only: resolved from an Integer variable's Default Pattern. */
  quickTagCount?: number;
  /** Legacy input, migrated by Store. */
  text?: string;
  inputMethod?: "keyboard" | "clipboard";
  files?: string[];
  target?: VisualTarget;
  method?: "auto" | "image" | "ocr";
  deltaY?: number;
  timeoutMs?: number;
  threshold?: number;
};
export type Step = {
  id: string;
  version: number;
  name: string;
  payload: Payload;
  createdAt: string;
};
export type Override = {
  id: string;
  stepId: string;
  baseVersion: number;
  name: string;
  segment: Payload[];
};
export type Variable = {
  id: string;
  key: string;
  type: "text" | "file" | "files" | "integer";
  description?: string;
};
export type StepGroup = {
  id: string;
  name: string;
  slug: string;
  collapsed: boolean;
  stepIds: string[];
};
export type Flow = {
  variables?: Variable[];
  defaultPattern?: { values: Record<string, string | string[] | number> };
  groups?: StepGroup[];
  id: string;
  name: string;
  zoom: number;
  steps: { id: string; version: number }[];
};
export type Capture = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  zoom: number;
  url: string;
  timestamp: string;
  backend: "cdp-surface";
  bounds?: Rect;
};
export type ExecutionStart = {
  stepId: string;
  version: number;
  overrideId?: string;
  matchTo: "none" | "current" | "top" | "middle" | "bottom";
  pipeline: "auto-roi" | "ocr-viewport" | "quick-tag-position";
};
export type ExecutionDetails = ExecutionStart & {
  runId: string;
  testRunId?: string;
  batchRunId?: string;
  ocrPasses: number;
  scrolls: number;
  stopReason: string;
};
export type Result = {
  execution?: ExecutionDetails;
  id: string;
  ok: boolean;
  status: "ACTION_SENT" | "VERIFIED" | "BLOCKED" | "FAILED" | "REJECTED";
  review?: { verdict: "correct" | "incorrect"; at: string; by: "user" };
  flowId?: string;
  overrideId?: string;
  targetAsset?: string;
  clickSent?: boolean;
  resolution?: ResolutionTrace;
  upload?: UploadInfo;
  evidenceWarning?: string;
  input?: {
    method: "keyboard" | "clipboard";
    focus: {
      browser: boolean;
      editor: boolean;
      route: string;
      caret: "unknown";
    };
    clipboard?: "restored" | "changed" | "restore_failed";
    warning?: string;
  };
  action: Action;
  message: string;
  before?: Capture;
  after?: Capture;
  match?: {
    score: number;
    x: number;
    y: number;
    method?: "image" | "ocr";
    text?: string;
    confidence?: number;
  };
  source: "base" | "override";
  stepId: string;
  version: number;
};
export type UploadInfo = {
  transport: "cdp-file-chooser";
  fileCount: number;
  assignedCount: number;
  phase: "waiting_chooser" | "assigning_files" | "files_selected";
  chooserMode?: "selectSingle" | "selectMultiple";
  preview: "unverified" | "confirmed_by_user";
  cleanupWarning?: string;
};
export type ResolutionTrace = {
  ocrOutcome?: "NOT_FOUND" | "OCR_LOW_CONFIDENCE" | "CONTEXT_REJECTED";
  context?: { x: number; y: number; confirmed: boolean; reason: string; imageScore?: number; anchor?: string }[];
  mode: "auto";
  legacyMethod?: "image" | "ocr";
  selectedMethod?: "image" | "ocr";
  fallbackReason?: string;
  blockedReason?: string;
  attempts: {
    method: "image" | "ocr";
    outcome:
      "matched" | "not_confident" | "ambiguous" | "failed" | "unavailable";
    reason?: string;
    score?: number;
    confidence?: number;
    x?: number;
    y?: number;
  }[];
};
export type State = {
  flow: Flow | null;
  flows: Flow[];
  steps: Step[];
  overrides: Override[];
  url: string;
  zoom: number;
  browserBounds: Rect;
  focused: boolean;
  visible: boolean;
  dataPath: string;
};
export type Command =
  | { type: "state" }
  | { type: "workspaceScroll"; left: number; top: number }
  | { type: "closeUiOverlay"; name: string }
  | { type: "organize"; groups: StepGroup[]; stepIds: string[] }
  | {
      type: "variables";
      variables: Variable[];
      values: Record<string, string | string[] | number>;
    }
  | { type: "pointerReport" }
  | { type: "panel"; panel: "editor" | "debug"; expanded: boolean }
  | { type: "focusFlow" }
  | { type: "copyUrl" }
  | { type: "navigate"; url: string }
  | { type: "fixture" }
  | { type: "toggleFullscreen" }
  | { type: "environment"; zoom: number }
  | { type: "newFlow"; name: string }
  | { type: "openFlow"; id: string }
  | { type: "targetImage"; asset: string }
  | { type: "ocrTarget"; asset: string }
  | { type: "capture" }
  | { type: "pickUploadFiles" }
  | { type: "crop"; captureId: string; roi: Rect }
  | { type: "saveStep"; id?: string; name: string; payload: Payload }
  | { type: "selectVersion"; id: string; version: number }
  | {
      type: "saveOverride";
      stepId: string;
      version: number;
      name: string;
      segment: Payload[];
    }
  | { type: "test"; stepId: string; version: number; overrideId?: string; batchRunId?: string }
  | { type: "playAllSkipped"; stepId: string; version: number; batchRunId: string }
  | { type: "playAllTransition"; batchRunId: string; previousStepId: string; previousVersion: number; nextStepId: string; nextVersion: number }
  | { type: "startPlayAllLog" }
  | { type: "endPlayAllLog"; runId: string; failed?: boolean }
  | { type: "testPair"; firstId: string; secondId: string; delayMs: number }
  | {
      type: "reviewTest";
      runId: string;
      verdict: "correct" | "incorrect";
      previewConfirmed?: boolean;
    }
  | { type: "armTest"; stepId: string; version: number; overrideId?: string }
  | { type: "disarmTest" }
  | { type: "browserVisible"; visible: boolean };
export const DRAFT_KEYS = [
  "variableId",
  "state",
  "action",
  "name",
  "text",
  "delta",
  "quickTagRows",
  "inputMethod",
  "pairDelay",
  "target",
  "targetImage",
  "files",
  "ocrResult",
  "ocrError",
  "ocrLoading",
  "ocrKind",
  "selected",
  "overrideId",
  "shot",
  "cropMode",
  "roi",
  "message",
  "busy",
  "results",
  "flowName",
  "context",
  "editorRevision",
  "editorExpanded",
  "debugExpanded",
] as const;
export type DraftKey = (typeof DRAFT_KEYS)[number];
export type DraftEntry = { revision: number; value: unknown };
export interface CreatorApi {
  readDraft(key: DraftKey, initial: unknown): DraftEntry;
  writeDraft(key: DraftKey, value: unknown): DraftEntry;
  onDraft(callback: (key: string, entry: DraftEntry) => void): () => void;
  onLayout(callback: (bounds: Rect) => void): () => void;
  onFocusFlow(callback: () => void): () => void;
  onNavigation(callback: (url: string) => void): () => void;
  invoke(command: Command): Promise<unknown>;
  onExecution(callback: (execution: ExecutionStart) => void): () => void;
  onTest(callback: (result: Result[] | { error: string }) => void): () => void;
}
