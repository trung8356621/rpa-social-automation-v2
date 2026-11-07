/**
 * Development-only Electron Creator API stub for `npm run dev:web`.
 * Not used by production Electron preload / IPC.
 */
import type {
  BrowserSession,
  Command,
  CreatorApi,
  DraftEntry,
  DraftKey,
  State,
} from "../shared/contracts";

declare global {
  interface Window {
    __RPA_WEB_DEV__?: boolean;
    creator: CreatorApi;
  }
}

const draftStore = new Map<string, DraftEntry>();
const draftListeners = new Set<(key: string, entry: DraftEntry) => void>();

function entry(value: unknown, revision = 0): DraftEntry {
  return { revision, value };
}

function nowIso() {
  return new Date().toISOString();
}

function defaultSession(): BrowserSession {
  const ts = nowIso();
  return {
    id: "web-dev-session",
    name: "Web Dev Session",
    partition: "persist:web-dev",
    isDefault: true,
    domains: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function createState(partial?: Partial<State>): State {
  const session = defaultSession();
  return {
    flow: null,
    flows: [],
    steps: [],
    overrides: [],
    url: "",
    zoom: 1,
    browserBounds: { x: 0, y: 0, width: 1024, height: 560 },
    focused: true,
    visible: true,
    dataPath: "web-dev-local",
    appPage: "collectors",
    sidebarCollapsed: false,
    browserSessions: [session],
    activeBrowserSessionId: session.id,
    testLab: { groups: [], cases: [], ungroupedCollapsed: false },
    actionTags: [],
    scriptRequests: [],
    activeScriptsByTag: {},
    scenarioDemos: {},
    ...partial,
  };
}

let state = createState();

function readStateDraft(): State {
  const existing = draftStore.get("state");
  if (existing && existing.value && typeof existing.value === "object") {
    return existing.value as State;
  }
  return state;
}

function writeState(next: State) {
  state = next;
  const prev = draftStore.get("state");
  const nextEntry = entry(next, (prev?.revision ?? 0) + 1);
  draftStore.set("state", nextEntry);
  draftListeners.forEach((cb) => cb("state", nextEntry));
  return next;
}

async function handleCommand(command: Command): Promise<unknown> {
  switch (command.type) {
    case "state":
      return readStateDraft();
    case "appPage": {
      const next = { ...readStateDraft(), appPage: command.page };
      return writeState(next);
    }
    case "appSidebar": {
      const next = { ...readStateDraft(), sidebarCollapsed: command.collapsed };
      return writeState(next);
    }
    case "seoOpsGetSession":
      return {
        configured: false,
        baseUrl: "",
        authenticated: false,
        autoSyncEnabled: false,
        error: "Web-dev stub: SEO-OPS unavailable",
      };
    case "seoOpsSyncStatus":
      return { rows: [] };
    case "closeUiOverlay":
      return { ok: true };
    case "disarmTest":
    case "armTest":
      return readStateDraft();
    case "navigate":
    case "capture":
    case "crop":
    case "browserVisible":
    case "collectorBrowserHost":
    case "targetImage":
    case "switchBrowserSession":
      throw new Error(
        `Web-dev stub: ${(command as { type: string }).type} requires Electron Browser Core — not available in UI-only preview.`,
      );
    default:
      console.warn("[web-dev-stub] unsupported command", (command as { type: string }).type);
      return { ok: false, error: `Web-dev stub: ${(command as { type: string }).type} is unavailable` };
  }
}

export function installWebCreatorStub(): void {
  if (window.creator && window.__RPA_WEB_DEV__) return;
  // Never overwrite Electron preload contextBridge (read-only `creator`).
  if (window.creator && !window.__RPA_WEB_DEV__) {
    console.error(
      "[web-dev-stub] refused to install: window.creator already provided by Electron preload",
    );
    return;
  }
  window.__RPA_WEB_DEV__ = true;
  writeState(createState());

  const api: CreatorApi = {
    onRecording: () => () => undefined,
    onCaseState: () => () => undefined,
    readDraft(key: DraftKey, initial: unknown) {
      if (!draftStore.has(key)) draftStore.set(key, entry(initial, 0));
      return draftStore.get(key)!;
    },
    writeDraft(key: DraftKey, value: unknown) {
      const prev = draftStore.get(key);
      const nextEntry = entry(value, (prev?.revision ?? 0) + 1);
      draftStore.set(key, nextEntry);
      draftListeners.forEach((cb) => cb(key, nextEntry));
      if (key === "state" && value && typeof value === "object") {
        state = value as State;
      }
      return nextEntry;
    },
    onDraft(callback) {
      draftListeners.add(callback);
      return () => {
        draftListeners.delete(callback);
      };
    },
    onLayout: () => () => undefined,
    onFocusFlow: () => () => undefined,
    onRequestClose: () => () => undefined,
    onNavigation: () => () => undefined,
    onBrowserSessions: () => () => undefined,
    onExecution: () => () => undefined,
    onTest: () => () => undefined,
    invoke: (command) => handleCommand(command),
  };

  try {
    window.creator = api;
  } catch (error) {
    console.error("[web-dev-stub] failed to assign window.creator", error);
    return;
  }
  document.body.dataset.webDev = "true";
  document.title = "RPA Creator V2 · Web Dev";
}
