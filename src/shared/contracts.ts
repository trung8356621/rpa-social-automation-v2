export type Rect = { x: number; y: number; width: number; height: number };
export type Action = "CLICK_TARGET" | "TYPE_ONLY" | "WAIT_VERIFY" | "SCROLL";
export type Payload = {
  action: Action;
  text?: string;
  target?: { asset: string; roi: Rect };
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
  action: Action;
  message: string;
  before?: Capture;
  after: Capture;
  match?: { score: number; x: number; y: number };
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
  | { type: "armTest"; stepId: string; version: number; overrideId?: string }
  | { type: "browserVisible"; visible: boolean };
export interface CreatorApi {
  invoke(command: Command): Promise<unknown>;
  onTest(callback: (result: Result[] | { error: string }) => void): () => void;
}
