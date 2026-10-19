export type Rect = { x: number; y: number; width: number; height: number };
export type Action =
  "CLICK_TARGET" | "CLICK_AND_TYPE" | "TYPE_ONLY" | "WAIT_VERIFY" | "SCROLL";
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
export type VisualTarget = {
  asset: string;
  roi: Rect;
  ocr?: Omit<OcrSegment, "id"> & { confirmed: true; language: "vie+eng" };
};
export type Payload = {
  action: Action;
  text?: string;
  inputMethod?: "keyboard" | "clipboard";
  target?: VisualTarget;
  method?: "image" | "ocr";
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
export type Flow = {
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
};
export type Result = {
  id: string;
  ok: boolean;
  status: "ACTION_SENT" | "VERIFIED" | "BLOCKED" | "FAILED" | "REJECTED";
  review?: { verdict: "correct" | "incorrect"; at: string; by: "user" };
  flowId?: string;
  overrideId?: string;
  targetAsset?: string;
  clickSent?: boolean;
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
  | { type: "navigate"; url: string }
  | { type: "fixture" }
  | { type: "toggleFullscreen" }
  | { type: "environment"; zoom: number }
  | { type: "newFlow"; name: string }
  | { type: "openFlow"; id: string }
  | { type: "targetImage"; asset: string }
  | { type: "ocrTarget"; asset: string }
  | { type: "capture" }
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
  | { type: "test"; stepId: string; version: number; overrideId?: string }
  | { type: "testPair"; firstId: string; secondId: string; delayMs: number }
  | { type: "reviewTest"; runId: string; verdict: "correct" | "incorrect" }
  | { type: "armTest"; stepId: string; version: number; overrideId?: string }
  | { type: "disarmTest" }
  | { type: "browserVisible"; visible: boolean };
export interface CreatorApi {
  invoke(command: Command): Promise<unknown>;
  onTest(callback: (result: Result[] | { error: string }) => void): () => void;
}
