import type { V3Request } from "./admin-v3.js";
import type { NetworkSettings, NetworkRunSettings } from "./network-mode.js";
export type Rect = { x: number; y: number; width: number; height: number };
export type MainPage = "scenarios" | "browser-sessions" | "test-lab" | "settings" | "variations" | "widget-registry" | "workflows" | "builds-releases";
export type AppPage = MainPage | "creator" | "test-case" | "studio-run";
export type VariableValues = Record<string, string | string[] | number>;
export type CaseRunStatus = "RUNNING" | "PASS" | "BLOCKED" | "SKIPPED" | "ERROR" | "ACTION_SENT";
export type CaseStepResult = {
  stepId: string; name: string; version: number;
  status: CaseRunStatus | "PENDING"; message: string;
  runtimeStatus?: Result["status"];
  error?: ExecutionError;
};
export type ExecutionError = {
  code: "UPLOAD_FILES_INVALID" | "VARIABLE_INVALID" | "STEP_BLOCKED";
  category: "Dữ liệu upload" | "Variable" | "Runtime";
  stepId: string;
  version: number;
  variableId?: string;
  variableKey?: string;
  field?: string;
  message: string;
  suggestedAction: string;
  details?: string[];
};
export type CaseResult = {
  status: CaseRunStatus | "FAILED"; // FAILED remains readable for saved V1 results.
  startedAt: string; finishedAt: string; message: string;
  stepId?: string; stepName?: string; version?: number;
  runId?: string; caseId?: string; caseName?: string;
  flowId?: string; scenarioName?: string; sessionId?: string; sessionName?: string; startUrl?: string;
  steps?: CaseStepResult[];
  screenshotPath?: string; screenshotAt?: string; screenshotError?: string;
  evidenceError?: string;
  recordingPath?: string; recordingError?: string;
  error?: ExecutionError;
};
export type TestCaseConfig = { recording?: boolean; name: string; flowId: string; sessionId: string; startUrl: string; values: VariableValues };
export type TestCase = TestCaseConfig & { id: string; groupId?: string; lastResult?: CaseResult };
export type TestLabState = {
  groups: { id: string; name: string; collapsed: boolean }[];
  cases: TestCase[]; ungroupedCollapsed: boolean;
};
export type ScenarioOrganization = {
  groups: { id: string; name: string; collapsed: boolean }[];
  membership: Record<string, string>;
  ungroupedCollapsed: boolean;
};
export type WorkspaceTab = {
  id: string;
  kind: "creator" | "test-case" | "studio";
  studioId?: string; studioPage?: MainPage;
  caseId?: string;
  flowId: string;
  sessionId?: string;
  url?: string;
};
export type BrowserSession = {
  id: string; name: string; partition: string; isDefault: boolean;
  lastUrl?: string; domains: string[]; createdAt: string; updatedAt: string;
};
export type BrowserSessionsState = {
  browserSessions: BrowserSession[]; activeBrowserSessionId: string; sessionError?: string;
};
export type Action =
  | "CLICK_TARGET"
  | "CLICK_AND_TYPE"
  | "UPLOAD_FILE"
  | "QUICK_TAG"
  | "TYPE_ONLY"
  | "WAIT_VERIFY"
  | "SCROLL"
  | "SLEEP";
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
  /** Retained for legacy versions. Runtime replaces this with the run's Network Mode Sleep Delay. */
  sleepMs?: number;
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
  type: "text" | "file" | "files" | "integer" | "number";
  description?: string;
};
export type StepGroup = {
  id: string;
  name: string;
  slug: string;
  collapsed: boolean;
  stepIds: string[];
  /** Empty groups have no Step reference to anchor their position in the list. */
  emptyPosition?: number;
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
  pipeline: "auto-roi" | "ocr-viewport" | "quick-tag-position" | "sleep";
  sleepMs?: number;
};
export type ExecutionDetails = ExecutionStart & {
  network?: NetworkRunSettings;
  runId: string;
  testRunId?: string;
  batchRunId?: string;
  ocrPasses: number;
  scrolls: number;
  stopReason: string;
};
export type Result = {
  networkHint?: string;
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
  error?: ExecutionError;
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
export type UploadFileCheck = {
  path: string;
  name: string;
  status: "VALID" | "INVALID" | "UNRESOLVED";
  reason?: string;
};
export type UploadFileValidation = {
  status: "VALID" | "INVALID" | "UNRESOLVED";
  validCount: number;
  invalidCount: number;
  files: UploadFileCheck[];
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
/** Non-executable Step/version with a broken Variable binding (payload preserved). */
export type InvalidStepRef = {
  flowId: string;
  stepId: string;
  version: number;
  reason:
    | "missing_variable"
    | "legacy_incomplete"
    | "inline_conflict"
    | "override_invalid"
    | "invalid_payload";
  variableId?: string;
  detail: string;
};
export type State = {
  runningStudio?: boolean;
  testLab?: TestLabState;
  runningTestCaseId?: string;
  scenarioOrganization?: ScenarioOrganization;
  browserSessions?: BrowserSession[];
  activeBrowserSessionId?: string;
  sessionError?: string;
  appPage?: AppPage;
  sidebarCollapsed?: boolean;
  networkSettings?: NetworkSettings;
  flow: Flow | null;
  flows: Flow[];
  steps: Step[];
  overrides: Override[];
  invalidSteps?: InvalidStepRef[];
  url: string;
  zoom: number;
  browserBounds: Rect;
  focused: boolean;
  visible: boolean;
  dataPath: string;
};
export type Command =
  | { type: "studio"; request: V3Request }
  | { type: "recordingEvent"; token: string; event: "ready" | "chunk" | "done" | "error"; data?: string }
  | { type: "testCaseVideo"; caseId: string; runId: string }
  | { type: "testCaseScreenshot"; caseId: string; runId: string }
  | {
      type: "attachScriptVideoDemo";
      caseId: string;
      runId: string;
      scriptVersion?: string;
      reviewed: boolean;
    }
  | {
      type: "exportScriptRelease";
      flowId: string;
      version: string;
      packageKey?: string;
      includeVideoDemo?: boolean;
    }
  | { type: "exportFullBackup" }
  | { type: "importFullBackup"; token?: string; confirmed?: boolean }
  | { type: "seoOpsGetSession" }
  | { type: "seoOpsSetEndpoint"; baseUrl: string }
  | { type: "seoOpsLogin"; email: string; password: string }
  | { type: "seoOpsLogout" }
  | { type: "seoOpsSyncStatus" }
  | { type: "seoOpsSyncAll"; version?: string }
  | { type: "seoOpsSyncFlow"; flowId: string; version?: string }
  | { type: "seoOpsBackupInfo" }
  | { type: "seoOpsRestore"; confirmed: boolean }
  | { type: "deleteScenario"; id: string; confirmed: boolean }
  | { type: "testGroup"; operation: "create" | "update" | "delete"; id?: string; name?: string; collapsed?: boolean; confirmed?: boolean }
  | { type: "collapseUngroupedCases"; collapsed: boolean }
  | { type: "saveTestCase"; id?: string; config: TestCaseConfig }
  | { type: "deleteTestCase"; id: string; confirmed: boolean }
  | { type: "moveTestCase"; id: string; groupId?: string }
  | { type: "runTestCase"; id: string }
  | { type: "createScenarioGroup"; name: string }
  | { type: "updateScenarioGroup"; id: string; name?: string; collapsed?: boolean }
  | { type: "deleteScenarioGroup"; id: string; confirmed: boolean }
  | { type: "moveScenarioToGroup"; flowId: string; groupId?: string }
  | { type: "collapseUngroupedScenarios"; collapsed: boolean }
  | { type: "activateWorkspace"; flowId: string; sessionId?: string; url?: string; editorExpanded: boolean }
  | { type: "createBrowserSession"; name: string }
  | { type: "renameBrowserSession"; id: string; name: string }
  | { type: "deleteBrowserSession"; id: string; confirmed: boolean }
  | { type: "removeSessionDomain"; id: string; domain: string }
  | { type: "switchBrowserSession"; id: string }
  | { type: "appPage"; page: AppPage }
  | { type: "appSidebar"; collapsed: boolean }
  | { type: "setNetworkSettings"; settings: NetworkSettings }
  | { type: "confirmWindowClose" }
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
  | { type: "validateUploadFiles"; files?: unknown; unresolved?: boolean }
  | { type: "crop"; captureId: string; roi: Rect }
  | { type: "saveStep"; id?: string; name: string; payload: Payload }
  | { type: "selectVersion"; id: string; version: number }
  | { type: "scriptHealthScan" }
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
  "sleepMs",
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
  onRecording(callback: (message: { type: "start" | "frame" | "stop"; token: string; data?: string }) => void): () => void;
  onCaseState(callback: (state: State) => void): () => void;
  readDraft(key: DraftKey, initial: unknown): DraftEntry;
  writeDraft(key: DraftKey, value: unknown): DraftEntry;
  onDraft(callback: (key: string, entry: DraftEntry) => void): () => void;
  onLayout(callback: (bounds: Rect) => void): () => void;
  onFocusFlow(callback: () => void): () => void;
  onRequestClose(callback: () => void): () => void;
  onNavigation(callback: (url: string) => void): () => void;
  onBrowserSessions(callback: (snapshot: BrowserSessionsState) => void): () => void;
  invoke(command: Command): Promise<unknown>;
  onExecution(callback: (execution: ExecutionStart) => void): () => void;
  onTest(callback: (result: Result[] | { error: string }) => void): () => void;
}
