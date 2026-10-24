import { AdminStudioPage, type StudioEditorHandle } from "./admin-studio";
import { installBrowserRecording } from "./browser-recording";
import { effectiveMatchTo, matchToLabel } from "../shared/match-to";
import { playSequential, playbackResult, type StepPlayback } from "./playback";
import { StepList } from "./step-list";
import { TargetModal } from "./target-modal";
import { UiPopover } from "./ui-popover";
import { NetworkSettings } from "./network-settings";
import { AppNavigation, ScenariosPage } from "./app-shell";
import { BrowserSessionsPage, SessionSelector } from "./browser-sessions";
import { TestLabPage, TestCaseEditor, CaseResultView, ExecutionErrorView, type CaseEditorHandle } from "./test-lab";
import { Variables, Groups } from "./flow-controls";
import { SeoOpsAuthPanel } from "./seo-ops-panel";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { unstable_batchedUpdates } from "react-dom";
import { WorkspaceTabs } from "./workspace-tabs";
import type {
  Action,
  WorkspaceTab,
  MainPage,
  TestCase,
  AppPage,
  Capture,
  Command,
  CreatorApi,
  Payload,
  Rect,
  Result,
  OcrResult,
  OcrSegment,
  ExecutionStart,
  ExecutionError,
  State,
  Step,
} from "../shared/contracts";
import { errorDestination } from "../shared/error-navigation";
import "./style.css";
import { useDraft, captureEditorDraft, restoreEditorDraft, type EditorDraft } from "./draft";
import { targetEnvironment } from "../shared/visual-environment";
import { WEB_WIDTH, WEB_HEIGHT, workspaceLayout, APP_NAV_COLLAPSED, APP_NAV_EXPANDED } from "../shared/geometry";
import { defaultNetworkSettings, NETWORK_LABELS } from "../shared/network-mode";
document.documentElement.style.setProperty("--web-height", `${WEB_HEIGHT}px`);
declare global {
  interface Window {
    creator: CreatorApi;
  }
}

const panel = new URLSearchParams(location.search).get("panel");
const shell = !panel;
document.body.dataset.panel = panel || "shell";

type TabDraft = {
  editor: EditorDraft; dirty: boolean; ocrEdit?: string; ocrKind: "none" | "line" | "word";
  playback: Record<string, StepPlayback>; activeStepId: string; blocked: Set<string>;
  execution?: ExecutionStart; urlInput: string; urlDirty: boolean;
};

function Creator() {
  useEffect(() => shell ? installBrowserRecording() : undefined, []);
  const [mainPage, setMainPage] = useState<MainPage>("scenarios");
  const studioEditors = useRef(new Map<string, StudioEditorHandle>());
  const [, setStudioRevision] = useState(0);
  const reportStudio = useCallback((id: string, handle: StudioEditorHandle) => {
    const previous = studioEditors.current.get(id);
    studioEditors.current.set(id, handle);
    if (!previous || previous.dirty !== handle.dirty || previous.name !== handle.name) setStudioRevision(x => x + 1);
  }, []);
  const caseEditors = useRef(new Map<string, CaseEditorHandle>());
  const [, setCaseRevision] = useState(0);
  const reportCase = useCallback((id: string, handle: CaseEditorHandle) => {
    caseEditors.current.set(id, handle); setCaseRevision(value => value + 1);
  }, []);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const tabDrafts = useRef(new Map<string, TabDraft>());
  const workspaceRestoring = useRef(false);
  const workspaceLock = useRef(false);
  const browserUrl = useRef("");
  const caseRunRef = useRef<{ id?: string; runId?: string }>({});
  const pendingCloseTab = useRef<string | undefined>(undefined);
  const closeTabHandler = useRef<(id: string) => void>(() => {});
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [exitIntent, setExitIntent] = useState<"close" | "reload">();
  const [exitRevision, setExitRevision] = useState(0);
  const exitReviewed = useRef(new Set<string>());
  function updateTabs(next: WorkspaceTab[]) { tabsRef.current = next; setTabs(next); }

  const [state, setState] = useDraft<State>("state");
  const [seoOpsAuthenticated, setSeoOpsAuthenticated] = useState(false);
  const [seoOpsAutoSyncEnabled, setSeoOpsAutoSyncEnabled] = useState(false);
  const [focusVariableId, setFocusVariableId] = useState<string>();
  const appPage = state?.appPage ?? "scenarios";
  const creatorVisible = appPage === "creator";
  const activeCaseTab = tabs.find(t => t.id === activeTabId && t.kind === "test-case");
  useEffect(() => {
    if (["scenarios", "browser-sessions", "test-lab", "settings", "variations", "widget-registry", "workflows", "builds-releases"].includes(appPage)) setMainPage(appPage as MainPage);
  }, [appPage]);
  useEffect(() => {
    if (!shell) return;
    void window.creator.invoke({ type: "seoOpsGetSession" }).then((session) => {
      const s = session as { authenticated?: boolean; autoSyncEnabled?: boolean };
      setSeoOpsAuthenticated(Boolean(s.authenticated));
      setSeoOpsAutoSyncEnabled(Boolean(s.autoSyncEnabled));
    }).catch(() => setSeoOpsAuthenticated(false));
  }, [appPage]);
  const sidebarCollapsed = state?.sidebarCollapsed ?? false;
  const networkSettings = state?.networkSettings ?? defaultNetworkSettings();
  const networkDelays = networkSettings.presets[networkSettings.mode];
  useEffect(() => {
    // A renderer reload can return to an already active main-process Creator.
    // Adopt that context without resetting its editor or creating another Browser.
    if (!creatorVisible || !state?.flow || activeTabId || workspaceLock.current) return;
    const tab: WorkspaceTab = { id: crypto.randomUUID(), kind: "creator", flowId: state.flow.id,
      sessionId: state.activeBrowserSessionId, url: state.url || undefined };
    updateTabs([tab]);
    setActiveTabId(tab.id);
  }, [creatorVisible, state?.flow?.id, activeTabId]);
  const [variableId, setVariableId] = useDraft("variableId", "");
  const [quickTagRows, setQuickTagRows] = useDraft("quickTagRows", 5);
  const [url, setUrl] = useState("");
  const urlEdit = useRef({ dirty: false, revision: 0 });
  const [action, setAction] = useDraft<Action>("action", "CLICK_TARGET");
  const [name, setName] = useDraft("name", "");
  const [delta, setDelta] = useDraft("delta", -400);
  const [inputMethod, setInputMethod] = useDraft<"keyboard" | "clipboard">(
    "inputMethod",
    "keyboard",
  );
  const [pairDelay, setPairDelay] = useDraft("pairDelay", 800);
  const [target, setTarget] = useDraft<Payload["target"]>("target");
  const [targetImage, setTargetImage] = useDraft("targetImage", "");
  const [ocrResult, setOcrResult] = useDraft<OcrResult>("ocrResult");
  const [ocrError, setOcrError] = useDraft("ocrError", "");
  const [ocrLoading, setOcrLoading] = useDraft("ocrLoading", false);
  const [ocrEdit, setOcrEdit] = useState<string>();
  const [ocrKind, setOcrKind] = useState<"none" | "line" | "word">("none");
  const [selected, setSelected] = useDraft<Step>("selected");
  const [overrideId, setOverrideId] = useDraft("overrideId", "");
  const [targetModal, setTargetModal] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ proceed: () => void | Promise<void>; closing?: boolean; caseTabId?: string; studioTabId?: string }>();
  const pendingNavigationRef = useRef(false);
  const [confirmWorking, setConfirmWorking] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [pageError, setPageError] = useState("");
  const allowUnload = useRef(false);
  const leaveHandler = useRef<() => void>(() => {});
  const reloadHandler = useRef<() => void>(() => {});
  useEffect(() => { if (!workspaceRestoring.current) setOcrKind(target?.ocr?.kind ?? "none"); },
    [target?.asset, target?.ocr?.kind, selected?.id, selected?.version, overrideId]);
  useEffect(() => setTargetModal(false), [selected?.id, selected?.version, action, state?.flow?.id, overrideId]);
  useEffect(() => { if (!workspaceRestoring.current) setOcrEdit(undefined); }, [target?.asset, target?.ocr?.text,
    selected?.id, selected?.version, overrideId]);
  const [shot, setShot] = useDraft<Capture>("shot");
  const [cropMode, setCropMode] = useDraft("cropMode", false);
  const [roi, setRoi] = useDraft<Rect>("roi");
  const [message, setMessage] = useDraft(
    "message",
    "Tạo flow, chọn Action rồi crop target nếu cần.",
  );
  const [busy, setBusy] = useDraft("busy", false);
  const [results, setResults] = useDraft<Result[]>("results", []);
  const [flowName, setFlowName] = useDraft("flowName", "Facebook draft POC");
  const [context, setContext] = useDraft("context", "Ngữ cảnh sửa lỗi");
  const [editorRevision, setEditorRevision] = useDraft("editorRevision", 0);
  const [editorExpanded, setEditorExpanded] = useDraft("editorExpanded", false);
  useEffect(() => { if (!editorExpanded) setTargetModal(false); }, [editorExpanded]);
  const [debugExpanded, setDebugExpanded] = useDraft("debugExpanded", true);
  const layout = workspaceLayout(editorExpanded, debugExpanded, window.innerWidth, window.innerHeight, sidebarCollapsed);
  const navigationWidth = creatorVisible ? layout.navigationWidth : sidebarCollapsed ? APP_NAV_COLLAPSED : APP_NAV_EXPANDED;
  const [stepPlayback, setStepPlayback] = useState<
    Record<string, StepPlayback>
  >({});
  const [activeStepId, setActiveStepId] = useState("");
  const [blockedSteps, setBlockedSteps] = useState<Set<string>>(() => new Set());
  function toggleBlocked(stepId: string) {
    setBlockedSteps(previous => {
      const next = new Set(previous);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  }
  const playLock = useRef(false);
  const listRunIds = useRef(new Set<string>());
  const [execution, setExecution] = useState<ExecutionStart>();
  const executionRef = useRef<ExecutionStart | undefined>(undefined);
  useEffect(() => {
    if (workspaceRestoring.current) return;
    setStepPlayback({});
    setActiveStepId("");
    setResults([]);
    listRunIds.current.clear();
    setExecution(undefined);
    executionRef.current = undefined;
  }, [state?.flow?.id, state?.activeBrowserSessionId]);
  useEffect(() => {
    if (shell && !playLock.current && results.length)
      setStepPlayback((previous) => ({
        ...previous,
        ...Object.fromEntries(
          results.map((r) => [r.stepId, playbackResult([r])]),
        ),
      }));
  }, [results]);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const goToFlowRef = useRef<() => void>(() => {});
  const resultPanel = useRef<HTMLDivElement>(null);
  function executionLabel(run: ExecutionStart) {
    if (run.pipeline === "sleep") return `${run.stepId.slice(0, 8)} · v${run.version} · Đang chờ ${run.sleepMs}ms`;
    return `${run.stepId.slice(0, 8)} · v${run.version} · ${run.overrideId ? "Override" : "Base"} · Match To ${matchToLabel(run.matchTo)} · ${run.pipeline}`;
  }
  function executionFailed(message: string) {
    const run = executionRef.current;
    if (run) setStepPlayback(previous => previous[run.stepId]?.status === "running"
      ? { ...previous, [run.stepId]: {
          status: /Viewport|Zoom|không thuộc flow/i.test(message) ? "blocked" : "fail", message,
        } }
      : previous);
  }
  const latest = useRef({ selected, overrideId, busy });
  latest.current = { selected, overrideId, busy };
  useEffect(() => {
    if (shell) document.querySelector(".panel-body")?.scrollTo({ top: 0 });
  }, [editorRevision, editorExpanded]);
  useEffect(() => {
    if (results.length)
      resultPanel.current?.parentElement?.scrollTo({ top: 0 });
  }, [results]);

  useEffect(() => {
    if (!shell) return;
    let frame = 0;
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void invoke({
          type: "workspaceScroll",
          left: window.scrollX,
          top: window.scrollY,
        }).catch((e) => setMessage(String(e)));
      });
    };
    window.addEventListener("scroll", scroll);
    window.addEventListener("resize", scroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", scroll);
    };
  }, []);
  async function setEditorOpen(expanded: boolean) {
    const next = await invoke<State>({
      type: "panel",
      panel: "editor",
      expanded,
    });
    setState(next);
    setEditorExpanded(expanded);
  }
  function showEditor() {
    setEditorRevision((value) => value + 1);
    void setEditorOpen(true).catch((e) => setMessage(String(e)));
  }
  function resetStepDraft() {
    setSelected(undefined);
    setVariableId("");
    setQuickTagRows(5);
    setTarget(undefined);
    setTargetImage("");
    setOcrResult(undefined);
    setOcrError("");
    setName("");
    setOverrideId("");
    setResults([]);
    setAction("CLICK_TARGET");
    setDelta(-400);
    setInputMethod("keyboard");
    setOcrEdit(undefined);
  }
  function newStep() {
    requestNavigation(async () => {
      resetStepDraft();
      await setEditorOpen(true);
      setEditorRevision(value => value + 1);
      setMessage("Chọn Action cho Step tiếp theo từ trạng thái browser hiện tại. Không chạy lại flow.");
      requestAnimationFrame(() => document.querySelector('[aria-label="Action"]')?.scrollIntoView({ block: "center" }));
    });
  }
  async function reviewClick(result: Result, verdict: "correct" | "incorrect") {
    if (shot) await closeShot();
    const reviewed = await invoke<Result>({
      type: "reviewTest",
      runId: result.id,
      verdict,
      previewConfirmed:
        result.action === "UPLOAD_FILE" && verdict === "correct",
    });
    setResults((previous) =>
      previous.map((r) =>
        r.id === reviewed.id
          ? { ...r, ...reviewed, before: r.before, after: r.after }
          : r,
      ),
    );
    if (verdict === "incorrect") await openRedesign(result);
    else
      setMessage(
        "Đã VERIFIED bằng xác nhận của bạn. Có thể tạo Step tiếp theo từ browser hiện tại.",
      );
  }
  async function openRedesign(result: Result) {
    const base = state!.steps.find(
      (s) => s.id === result.stepId && s.version === result.version,
    )!;
    const overlay = state!.overrides.find((o) => o.id === result.overrideId);
    await loadStep({ ...base, payload: overlay?.segment[0] ?? base.payload });
    setMessage(
      `Redesign ${base.name} / v${base.version}. Base giữ nguyên; chỉ tạo version mới khi lưu. Browser giữ trạng thái hiện tại.`,
    );
    document
      .querySelector('[aria-label="Action"]')
      ?.scrollIntoView({ block: "center" });
  }

  async function invoke<T>(command: Command): Promise<T> {
    return window.creator.invoke(command) as Promise<T>;
  }
  async function task(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      executionFailed((e as Error).message);
      setMessage((e as Error).message);
      if (!creatorVisible) setPageError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!shell) return;
    const offFocus = window.creator.onFocusFlow(() => goToFlowRef.current());
    const offLayout = window.creator.onLayout((bounds) => {
      setState((previous) =>
        previous ? { ...previous, browserBounds: bounds } : previous,
      );
    });
    let navigationSeen = false;
    const syncUrl = (actual: string) => {
      browserUrl.current = actual;
      if (!urlEdit.current.dirty) setUrl(actual);
    };
    const offNavigation = window.creator.onNavigation((actual) => {
      navigationSeen = true;
      syncUrl(actual);
    });
    const offCaseState = window.creator.onCaseState(snapshot => {
      setState(snapshot);
      const item = snapshot.testLab?.cases.find(item => item.id === (snapshot.runningTestCaseId ?? caseRunRef.current.id));
      const run = item?.lastResult;
      if (run?.runId && run.runId !== caseRunRef.current.runId) {
        caseRunRef.current = { id: item!.id, runId: run.runId };
        setResults([]); setExecution(undefined); executionRef.current = undefined;
      }
      const playback: Record<string, StepPlayback> = {};
      for (const step of run?.steps ?? []) if (step.status !== "PENDING") playback[step.stepId] = {
        status: step.status === "RUNNING" ? "running" : step.status === "BLOCKED" ? "blocked"
          : step.status === "ERROR" ? "fail" : step.status === "SKIPPED" ? "skipped" : "pass",
        message: step.message, resultStatus: step.runtimeStatus,
      };
      setStepPlayback(playback);
      const active = run?.steps?.find(step => step.status === "RUNNING")
        ?? run?.steps?.find(step => ["BLOCKED", "ERROR"].includes(step.status))
        ?? run?.steps?.filter(step => !["PENDING", "SKIPPED"].includes(step.status)).at(-1);
      setActiveStepId(active?.stepId ?? "");
      browserUrl.current = snapshot.url;
      urlEdit.current = { dirty: false, revision: urlEdit.current.revision + 1 };
      setUrl(snapshot.url);
    });
    const offSessions = window.creator.onBrowserSessions(snapshot => {
      setState(previous => previous ? { ...previous, ...snapshot } : previous);
    });
    void invoke<State>({ type: "state" })
      .then((snapshot) => {
        setState(snapshot);
        if (!navigationSeen) syncUrl(snapshot.url);
      })
      .catch((e) => setMessage(String(e)));
    const offExecution = window.creator.onExecution((run) => {
      executionRef.current = run;
      setExecution(run);
      setActiveStepId(run.stepId);
      setResults([]);
      setStepPlayback(previous => ({ ...previous, [run.stepId]: { status: "running", message: executionLabel(run) } }));
      setMessage(`Đang chạy bản đã lưu: ${executionLabel(run)}`);
    });
    const offTest = window.creator.onTest((result) => {
      if (Array.isArray(result)) {
        setResults(result);
        setMessage(result.map((r) => r.message).join("\n"));
      } else {
        setResults([]);
        executionFailed(result.error);
        setMessage(result.error);
      }
    });
    return () => {
      offLayout();
      offFocus();
      offNavigation();
      offSessions();
      offCaseState();
      offTest();
      offExecution();
    };
  }, []);
  useEffect(() => { workspaceRestoring.current = false; }, [restoreRevision]);
  useEffect(() => {
    if (!shell) return;
    if (workspaceRestoring.current || workspaceLock.current) return;
    if (selected && creatorVisible && !activeCaseTab)
      void invoke({
        type: "armTest",
        stepId: selected.id,
        version: selected.version,
        overrideId: overrideId || undefined,
      }).catch((e) => setMessage(String(e)));
    else
      void invoke({ type: "disarmTest" }).catch((e) => setMessage(String(e)));
  }, [selected, overrideId, creatorVisible, state?.activeBrowserSessionId, busy, activeTabId, restoreRevision, !!activeCaseTab]);
  useEffect(() => {
    if (!busy && pendingCloseTab.current === activeTabId) {
      const id = pendingCloseTab.current;
      pendingCloseTab.current = undefined;
      if (id) closeTabHandler.current(id);
    }
  }, [activeTabId, busy]);
  useEffect(() => {
    if (!shot) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        void task(closeShot);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [shot, busy]);
  async function loadStep(step: Step, edit = true) {
    if (edit) showEditor();
    if (selected?.id !== step.id || selected?.version !== step.version)
      setResults([]);
    setSelected(step);
    setName(step.name);
    setAction(step.payload.action);
    setVariableId(step.payload.variableId || "");
    setInputMethod(step.payload.inputMethod ?? "keyboard");
    setDelta(step.payload.deltaY ?? -400);
    setQuickTagRows(step.payload.quickTagRows ?? 5);
    setTarget(step.payload.target);
    setOcrResult(undefined);
    setOcrError("");
    setOverrideId("");
    setTargetImage(
      step.payload.target
        ? await invoke<string>({
            type: "targetImage",
            asset: step.payload.target.asset,
          })
        : "",
    );
  }
  function payload(): Payload {
    return {
      action,
      ...(["TYPE_ONLY", "CLICK_AND_TYPE"].includes(action)
        ? { variableId, inputMethod }
        : {}),
      ...(action === "SCROLL" ? { deltaY: delta } : {}),
      ...(action === "UPLOAD_FILE" ? { variableId } : {}),
      ...(action === "QUICK_TAG" ? { variableId, quickTagRows, target: target ? { ...target, ocr: undefined, matchTo: "none" as const } : undefined } : {}),
      ...([
        "CLICK_TARGET",
        "CLICK_AND_TYPE",
        "UPLOAD_FILE",
        "WAIT_VERIFY",
      ].includes(action)
        ? { target: target ? { ...target, matchTo: effectiveMatchTo({ target }) } : target, method: "auto", threshold: 0.96, timeoutMs: 3000 }
        : {}),
    };
  }
  async function run(step: Step, overlay: string, fromBrowser = false) {
    // Disabling a previously focused editor button can pull focus away from the
    // native browser view. The browser shortcut must not mutate UI before input.
    latest.current.busy = true;
    if (!fromBrowser) {
      setBusy(true);
      setResults([]);
    }
    try {
      const r = await invoke<Result[]>({
        type: "test",
        stepId: step.id,
        version: step.version,
        overrideId: overlay || undefined,
      });
      setResults(r);
      setMessage(r.map((r) => r.message).join("\n"));
    } catch (e) {
      setResults([]);
      executionFailed((e as Error).message);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function playSteps(steps: Step[], all = false) {
    if (busy || playLock.current || shot || !steps.length) return;
    playLock.current = true;
    setBusy(true);
    setResults([]);
    if (all) setStepPlayback({});
    let batchRunId: string | undefined;
    let failed = false;
    try {
      if (all) batchRunId = await invoke<string>({ type: "startPlayAllLog" });
      await setEditorOpen(false);
      await playSequential(
        steps,
        async (step) => {
          // Play saved references without overwriting the Editor draft/selected version.
          setResults([]);
          const next = await invoke<Result[]>({
            type: "test",
            stepId: step.id,
            version: step.version,
            batchRunId,
          });
          next.forEach((result) => listRunIds.current.add(result.id));
          setResults(next);
          return next;
        },
        (step, progress) => {
          setActiveStepId(step.id);
          setStepPlayback((previous) => ({ ...previous, [step.id]: progress }));
          setMessage(`${step.name}: ${progress.message}`);
        },
        all ? async (step) => {
          if (!blockedSteps.has(step.id)) return false;
          await invoke({ type: "playAllSkipped", stepId: step.id, version: step.version, batchRunId: batchRunId! });
          return true;
        } : undefined,
        all ? async (previous, next) => {
          await invoke({ type: "playAllTransition", batchRunId: batchRunId!,
            previousStepId: previous.id, previousVersion: previous.version,
            nextStepId: next.id, nextVersion: next.version });
        } : undefined,
      );
    } catch (error) {
      failed = true;
      setMessage(String(error));
    } finally {
      if (batchRunId) {
        try { await invoke({ type: "endPlayAllLog", runId: batchRunId, failed }); }
        catch (error) { setMessage(String(error)); }
      }
      playLock.current = false;
      setBusy(false);
    }
  }
  function playSavedSteps(step?: Step) {
    requestNavigation(async () => {
      const snapshot = window.creator.readDraft("state", state).value as State;
      const refs = snapshot.flow?.steps.filter(ref => !step || ref.id === step.id) ?? [];
      const steps = refs.map(ref => snapshot.steps.find(s => s.id === ref.id && s.version === ref.version)!).filter(Boolean);
      await playSteps(steps, !step);
    });
  }
  async function closeShot() {
    await invoke({ type: "browserVisible", visible: true });
    drag.current = undefined;
    setShot(undefined);
    setCropMode(false);
    setRoi(undefined);
  }
  async function capture() {
    if (!state?.flow) {
      setMessage("Tạo hoặc chọn flow ở Bước 1 trước khi chụp ROI.");
      return;
    }
    const image = await invoke<Capture>({ type: "capture" });
    await invoke({ type: "browserVisible", visible: false });
    setShot(image);
    setRoi(undefined);
    setCropMode(true);
    setMessage(
      `Kéo ROI trên ảnh ${image.width}×${image.height} DIP. Giữ nguyên viewport trong lúc crop.`,
    );
  }
  async function inspect(image: Capture) {
    await invoke({ type: "browserVisible", visible: false });
    setShot(image);
    setCropMode(false);
  }
  async function saveCrop() {
    if (!shot || !roi) return;
    const t = await invoke<{
      asset: string;
      roi: Rect;
      dataUrl: string;
      environment: { width: number; height: number; zoom: number };
    }>({
      type: "crop",
      captureId: shot.id,
      roi,
    });
    setTarget({ asset: t.asset, roi: t.roi, environment: t.environment });
    setOcrResult(undefined);
    setOcrError("");
    setTargetImage(t.dataUrl);
    await closeShot();
    setTargetModal(true);
    if (action === "QUICK_TAG") {
      setMessage("ROI QUICK_TAG đã lưu. Khai báo số hàng và kiểm tra chấm click tại tâm hàng đầu; không xác minh danh tính.");
      return;
    }
    await readOcr(t.asset);
    setMessage(
      "ROI đã lưu. Chọn và xác nhận một dòng/từ OCR, hoặc giữ image-only; sau đó lưu Base/Override.",
    );
  }
  async function readOcr(asset: string) {
    setOcrLoading(true);
    setOcrError("");
    setOcrResult(undefined);
    try {
      setOcrResult(await invoke<OcrResult>({ type: "ocrTarget", asset }));
    } catch (error) {
      setOcrError(
        `OCR thất bại: ${(error as Error).message}. Vẫn có thể lưu target chỉ dùng ảnh.`,
      );
    } finally {
      setOcrLoading(false);
    }
  }
  function clearTargetOcr() {
    setOcrKind("none");
    setOcrEdit(undefined);
    setTarget((previous) => {
      if (!previous) return previous;
      const { ocr, matchTo, ...rest } = previous;
      return rest;
    });
  }
  function confirmOcr(segment: OcrSegment) {
    setOcrKind(segment.kind);
    setTarget((previous) =>
      previous
        ? {
            ...previous,
            ocr: {
              text: segment.text,
              bbox: segment.bbox,
              confidence: segment.confidence,
              kind: segment.kind,
              language: "vie+eng",
              confirmed: true,
            },
          }
        : previous,
    );
    setMessage(
      `Đã xác nhận chữ “${segment.text}” để AUTO dùng khi cần. Lưu target để áp dụng.`,
    );
  }
  function goToFlow() {
    if (!shell) {
      void invoke({ type: "focusFlow" });
      return;
    }
    navigateApp("scenarios");
  }
  goToFlowRef.current = goToFlow;
  async function changeAppPage(page: AppPage) {
    const next = await invoke<State>({ type: "appPage", page });
    setState(next);
    if (["scenarios", "browser-sessions", "test-lab", "settings", "variations", "widget-registry", "workflows", "builds-releases"].includes(page)) setMainPage(page as MainPage);
    setPageError("");
    window.scrollTo({ left: 0, top: 0 });
  }
  function captureActiveTab() {
    if (!activeTabId || tabsRef.current.find(t => t.id === activeTabId)?.kind !== "creator") return;
    tabDrafts.current.set(activeTabId, {
      editor: captureEditorDraft(), dirty: editorDirty, ocrEdit, ocrKind,
      playback: stepPlayback, activeStepId, blocked: new Set(blockedSteps), execution,
      urlInput: url, urlDirty: urlEdit.current.dirty,
    });
    if (creatorVisible) updateTabs(tabsRef.current.map(tab => tab.id === activeTabId
      ? { ...tab, sessionId: state?.activeBrowserSessionId, url: browserUrl.current || undefined } : tab));
  }
  function navigateApp(page: AppPage) {
    if (page === appPage || busy || shot || ocrLoading || workspaceLock.current || pendingNavigationRef.current) return;
    // Pages leave the editor mounted. Drafts are retained, so navigation need not discard them.
    captureActiveTab();
    void task(() => changeAppPage(page));
  }
  async function activateTab(tab: WorkspaceTab) {
    captureActiveTab();
    if (tab.kind === "studio") { await changeAppPage(tab.studioPage ?? "variations"); setActiveTabId(tab.id); return; }
    workspaceRestoring.current = true;
    try {
      if (tab.kind === "test-case") {
        const next = await invoke<State>({ type: "appPage", page: "test-case" });
        unstable_batchedUpdates(() => {
          setState(next); restoreEditorDraft(); setOcrEdit(undefined); setOcrKind("none");
          setStepPlayback({}); setExecution(undefined); executionRef.current = undefined;
          setActiveStepId(""); setBlockedSteps(new Set()); setTargetModal(false);
          browserUrl.current = next.url;
          urlEdit.current = { dirty: false, revision: urlEdit.current.revision + 1 };
          setUrl(next.url);
          if (!tabsRef.current.some(t => t.id === tab.id)) updateTabs([...tabsRef.current, tab]);
          setActiveTabId(tab.id); setRestoreRevision(value => value + 1); setPageError("");
        });
        return;
      }
      const saved = tabDrafts.current.get(tab.id);
      const next = await invoke<State>({ type: "activateWorkspace", flowId: tab.flowId,
        sessionId: tab.sessionId, url: tab.url, editorExpanded: saved?.editor.editorExpanded === true });
      unstable_batchedUpdates(() => {
        setState(next);
        restoreEditorDraft(saved?.editor);
        setOcrEdit(saved?.ocrEdit);
        setOcrKind(saved?.ocrKind ?? "none");
        setStepPlayback(saved?.playback ?? {});
        setActiveStepId(saved?.activeStepId ?? "");
        setBlockedSteps(new Set(saved?.blocked ?? []));
        setExecution(saved?.execution);
        executionRef.current = saved?.execution;
        listRunIds.current.clear();
        setTargetModal(false);
        browserUrl.current = next.url;
        urlEdit.current = { dirty: saved?.urlDirty ?? false, revision: urlEdit.current.revision + 1 };
        setUrl(saved?.urlDirty ? saved.urlInput : next.url);
        const updated = { ...tab, sessionId: next.activeBrowserSessionId, url: next.url };
        updateTabs(tabsRef.current.some(t => t.id === tab.id)
          ? tabsRef.current.map(t => t.id === tab.id ? updated : t) : [...tabsRef.current, updated]);
        setActiveTabId(tab.id);
        setRestoreRevision(revision => revision + 1);
        setPageError("");
      });
      window.scrollTo({ left: 0, top: 0 });
    } catch (error) {
      workspaceRestoring.current = false;
      pendingCloseTab.current = undefined;
      setExitIntent(undefined);
      exitReviewed.current.clear();
      throw error;
    }
  }
  function openScenario(id: string, focus?: { stepId: string; version: number }) {
    if (workspaceLock.current || pendingNavigationRef.current || busy || shot || ocrLoading) return;
    const existing = tabsRef.current.find(tab => tab.kind === "creator" && tab.flowId === id);
    if (existing?.id === activeTabId && creatorVisible && !focus) return;
    const tab = existing ?? { id: crypto.randomUUID(), kind: "creator" as const, flowId: id,
      sessionId: state?.activeBrowserSessionId, url: browserUrl.current || undefined };
    workspaceLock.current = true;
    void task(async () => {
      try {
        await activateTab(tab);
        if (focus) {
          const snap = window.creator.readDraft("state", state).value as State;
          const step = snap.steps.find(s => s.id === focus.stepId && s.version === focus.version);
          if (step) await loadStep(step);
        }
      }
      finally { workspaceLock.current = false; }
    });
  }
  function openCase(id?: string) {
    if (busy || shot || ocrLoading || workspaceLock.current || pendingNavigationRef.current || !state) return;
    const existing = id ? tabsRef.current.find(t => t.kind === "test-case" && t.caseId === id) : undefined;
    const item = id ? state.testLab?.cases.find(c => c.id === id) : undefined;
    if (id && !item) return;
    const tab: WorkspaceTab = existing ?? { id: crypto.randomUUID(), kind: "test-case", caseId: id,
      flowId: item?.flowId ?? state.flows[0]?.id ?? "", sessionId: item?.sessionId };
    workspaceLock.current = true;
    void task(async () => { try { await activateTab(tab); } finally { workspaceLock.current = false; } });
  }
  function fixExecutionError(error: ExecutionError, flowId: string) {
    const destination = errorDestination(error);
    if (destination.kind === "variable") {
      setFocusVariableId(destination.variableId);
      openFlow(flowId);
    } else openFlow(flowId, { stepId: destination.stepId, version: destination.version });
  }
  function caseSaved(tabId: string, item: TestCase, next: State) {
    setState(next);
    updateTabs(tabsRef.current.map(t => t.id === tabId ? { ...t, caseId: item.id, flowId: item.flowId, sessionId: item.sessionId } : t));
  }
  function canRunCase(id: string) {
    const tab = tabsRef.current.find(tab => tab.kind === "test-case" && tab.caseId === id);
    return !tab || !caseEditors.current.get(tab.id)?.dirty;
  }
  function runCase(id: string) {
    if (busy || shot || ocrLoading || workspaceLock.current || pendingNavigationRef.current || !state || !canRunCase(id)) return;
    const item = state.testLab?.cases.find(item => item.id === id);
    if (!item) return;
    const tab: WorkspaceTab = tabsRef.current.find(tab => tab.kind === "test-case" && tab.caseId === id)
      ?? { id: crypto.randomUUID(), kind: "test-case", caseId: id, flowId: item.flowId, sessionId: item.sessionId };
    workspaceLock.current = true;
    void task(async () => {
      try {
        await activateTab(tab);
        setState(await invoke<State>({ type: "runTestCase", id }));
      } catch (error) { setState(await invoke<State>({ type: "state" })); throw error; }
      finally { workspaceLock.current = false; }
    });
  }
  async function updateWorkspace(command: Command) {
    if (command.type === "deleteScenario") {
      const count = state?.testLab?.cases.filter(c => c.flowId === command.id).length ?? 0;
      if (count) throw new Error(`${count} Test Case đang dùng Scenario này. Hãy sửa hoặc xóa các Case trước.`);
      if (tabsRef.current.some(t => t.kind === "creator" && t.flowId === command.id) ||
          [...caseEditors.current.values()].some(editor => editor.flowId === command.id))
        throw new Error("Đóng các tab đang dùng Scenario này trước khi xóa. Bản nháp chưa lưu được giữ nguyên.");
    }
    if (command.type === "deleteTestCase" && tabsRef.current.some(t => t.caseId === command.id))
      throw new Error("Đóng tab Test Case này trước khi xóa.");
    setBusy(true);
    try {
      const next = await invoke<State>(command); setState(next);
      if (command.type === "deleteScenario" && state?.flow?.id === command.id) resetStepDraft();
    } finally { setBusy(false); }
  }
  function tabDirty(id: string) {
    const tab = tabsRef.current.find(t => t.id === id);
    return tab?.kind === "studio" ? studioEditors.current.get(id)?.dirty ?? false : tab?.kind === "test-case" ? caseEditors.current.get(id)?.dirty ?? false
      : id === activeTabId ? editorDirty : tabDrafts.current.get(id)?.dirty ?? false;
  }
  function createScenario() {
    if (workspaceLock.current || pendingNavigationRef.current || busy || shot || ocrLoading) return;
    workspaceLock.current = true;
    void task(async () => {
      let created: State | undefined;
      try {
        captureActiveTab();
        created = await invoke<State>({ type: "newFlow", name: flowName });
        await activateTab({ id: crypto.randomUUID(), kind: "creator", flowId: created.flow!.id,
          sessionId: created.activeBrowserSessionId });
      } catch (error) {
        // newFlow selects its Flow immediately. If tab activation fails, restore
        // the previous runtime context before the existing draft becomes editable.
        if (created) setState(state?.flow
          ? await invoke<State>({ type: "openFlow", id: state.flow.id }) : created);
        throw error;
      } finally { workspaceLock.current = false; }
    });
  }
  async function removeTab(id: string) {
    const remaining = tabsRef.current.filter(tab => tab.id !== id);
    if (id === activeTabId) {
      const index = tabsRef.current.findIndex(tab => tab.id === id);
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) await activateTab(next);
      else {
        await changeAppPage(mainPage);
        resetStepDraft();
        await setEditorOpen(false);
        setActiveTabId(undefined);
      }
    }
    tabDrafts.current.delete(id);
    caseEditors.current.delete(id);
    updateTabs(remaining.map(tab => tabsRef.current.find(t => t.id === tab.id) ?? tab));
  }
  function closeTab(id: string) {
    if (busy || shot || ocrLoading || workspaceLock.current || pendingNavigationRef.current) return;
    if (id !== activeTabId) {
      if (!tabDirty(id)) {
        tabDrafts.current.delete(id);
        caseEditors.current.delete(id);
        updateTabs(tabsRef.current.filter(tab => tab.id !== id));
        return;
      }
      const tab = tabsRef.current.find(t => t.id === id);
      if (!tab) return;
      pendingCloseTab.current = id;
      if (tab.kind === "test-case" || tab.kind === "studio") {
        workspaceLock.current = true;
        void task(async () => { try { await activateTab(tab); } finally { workspaceLock.current = false; } });
      } else openScenario(tab.flowId);
      return;
    }
    requestNavigation(() => removeTab(id), true);
  }
  closeTabHandler.current = closeTab;
  async function updateBrowserSessions(command: Command) {
    if (command.type === "deleteBrowserSession" && (tabsRef.current.some(tab => tab.sessionId === command.id) || [...caseEditors.current.values()].some(editor => editor.sessionId === command.id)))
      throw new Error("Đóng các tab đang nhớ Session này trước khi xóa Session.");
    setBusy(true);
    try { setState(await invoke<State>(command)); }
    finally { setBusy(false); }
  }
  function selectSession(id: string) {
    if (id === state?.activeBrowserSessionId) return;
    void task(async () => {
      const snapshot = await invoke<State>({ type: "switchBrowserSession", id });
      setState(snapshot);
      browserUrl.current = snapshot.url;
      if (creatorVisible) updateTabs(tabsRef.current.map(tab => tab.id === activeTabId
        ? { ...tab, sessionId: snapshot.activeBrowserSessionId, url: snapshot.url } : tab));
      urlEdit.current.dirty = false;
      urlEdit.current.revision++;
      setUrl(snapshot.url);
      if (snapshot.sessionError) {
        setMessage(snapshot.sessionError);
        if (!creatorVisible) setPageError(snapshot.sessionError);
      } else setPageError("");
    });
  }
  function openSession(id: string) {
    if (busy || shot || ocrLoading || workspaceLock.current || pendingNavigationRef.current) return;
    workspaceLock.current = true;
    void task(async () => {
      try {
        const tab = tabsRef.current.find(t => t.kind === "creator" && t.flowId === state?.flow?.id);
        if (state?.flow) await activateTab({ ...(tab ?? { id: crypto.randomUUID(), kind: "creator" as const,
          flowId: state.flow.id }), sessionId: id, url: undefined });
        else {
          setState(await invoke<State>({ type: "switchBrowserSession", id }));
          await changeAppPage("scenarios");
        }
      } finally { workspaceLock.current = false; }
    });
  }
  function point(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          shot?.width ?? state?.browserBounds.width ?? WEB_WIDTH,
          e.clientX - r.left,
        ),
      ),
      y: Math.max(0, Math.min(shot?.height ?? WEB_HEIGHT, e.clientY - r.top)),
    };
  }
  const needsTarget = [
    "QUICK_TAG",
    "CLICK_TARGET",
    "CLICK_AND_TYPE",
    "UPLOAD_FILE",
    "WAIT_VERIFY",
  ].includes(action);
  const selectedIndex =
    state?.flow?.steps.findIndex((s) => s.id === selected?.id) ?? -1;
  const previousRef =
    selectedIndex > 0 ? state?.flow?.steps[selectedIndex - 1] : undefined;
  const previousClick = previousRef
    ? state?.steps.find(
        (s) =>
          s.id === previousRef.id &&
          s.version === previousRef.version &&
          s.payload.action === "CLICK_TARGET",
      )
    : undefined;
  const navigationLocked = busy || !!shot || !!state?.runningTestCaseId || !!state?.runningStudio;
  const locked = navigationLocked || !!activeCaseTab;
  const field = (label: string, child: React.ReactNode) => (
    <label>
      {label}
      {child}
    </label>
  );
  function resultSummary(result: Result) {
    if (result.status === "VERIFIED") return "Bạn đã xác nhận Step hoàn thành.";
    if (result.status === "REJECTED")
      return "Kết quả chưa đúng. Redesign rồi lưu version mới.";
    if (result.status === "ACTION_SENT")
      return result.action === "UPLOAD_FILE"
        ? "Đã chọn ảnh. Kiểm tra đủ thumbnail rồi xác nhận."
        : "Đã gửi thao tác. Quan sát browser rồi chọn Đúng hoặc Sai.";
    if (result.action === "TYPE_ONLY" || result.action === "SCROLL")
      return "Chưa chạy. Click vào browser rồi dùng Ctrl+Shift+T, hoặc Test cặp CLICK → TYPE.";
    return result.message;
  }
  async function saveBase() {
    if (selected && !editorDirty) return;
    const draftPayload = payload();
    if (ocrEdit !== undefined && draftPayload.target?.ocr)
      draftPayload.target = { ...draftPayload.target, ocr: { ...draftPayload.target.ocr, text: ocrEdit.trim() } };
    const next = await invoke<State>({
      type: "saveStep",
      id: selected?.id,
      name,
      payload: draftPayload,
    });
    setState(next);
    const ref = selected
      ? next.flow!.steps.find((s) => s.id === selected.id)!
      : next.flow!.steps.at(-1)!;
    await loadStep(
      next.steps.find((s) => s.id === ref.id && s.version === ref.version)!, false,
    );
    setMessage(`Đã lưu Base v${ref.version}; version cũ vẫn được giữ.`);
  }
  const expanded = shell ? editorExpanded : debugExpanded;
  const selectedBase = selected && (state?.steps.find(step => step.id === selected.id && step.version === selected.version) ?? selected);
  const activePayload = overrideId
    ? state?.overrides.find((o) => o.id === overrideId)?.segment[0]
    : selectedBase?.payload;
  function editableConfig(p: Payload) {
    if (p.action === "SLEEP") {
      return JSON.stringify([p.action]);
    }
    const target = p.target ? { ...p.target, matchTo: effectiveMatchTo(p) } : null;
    return JSON.stringify([p.action, p.variableId ?? "", p.inputMethod ?? "keyboard", p.deltaY ?? -400, p.quickTagRows ?? null, target]);
  }
  const editorDirty = (ocrEdit !== undefined && ocrEdit.trim() !== target?.ocr?.text) || (selected
    ? name !== selectedBase?.name || editableConfig(payload()) !== editableConfig(selectedBase!.payload)
    : name !== "" || editableConfig(payload()) !== editableConfig({ action: "CLICK_TARGET" }));
  function requestNavigation(proceed: () => void | Promise<void>, closing = false) {
    if (pendingNavigationRef.current) return;
    if (!(activeTabId ? tabDirty(activeTabId) : editorDirty)) { void task(async () => { await proceed(); }); return; }
    pendingNavigationRef.current = true;
    setConfirmError("");
    setPendingNavigation({ proceed, closing, caseTabId: activeCaseTab?.id, studioTabId: tabs.find(t => t.id === activeTabId && t.kind === "studio")?.id });
  }
  function stayInEditor() {
    if (confirmWorking) return;
    setExitIntent(undefined);
    exitReviewed.current.clear();
    pendingNavigationRef.current = false;
    setPendingNavigation(undefined);
    setConfirmError("");
  }
  async function continueNavigation(save: boolean) {
    if (!pendingNavigation || confirmWorking) return;
    setConfirmWorking(true);
    setBusy(true);
    try {
      if (pendingNavigation.studioTabId) {
        const handle = studioEditors.current.get(pendingNavigation.studioTabId);
        if (!handle) throw new Error("Studio draft is unavailable.");
        if (save) await handle.save(); else handle.discard();
      } else if (pendingNavigation.caseTabId) {
        const handle = caseEditors.current.get(pendingNavigation.caseTabId);
        if (!handle) throw new Error("Không tìm thấy draft Test Case.");
        if (save) await handle.save(); else handle.discard();
      } else if (save) await saveBase();
      else if (selectedBase) await loadStep(selectedBase, false);
      else resetStepDraft();
      const proceed = pendingNavigation.proceed;
      pendingNavigationRef.current = false;
      setPendingNavigation(undefined);
      await proceed();
    } catch (error) {
      setConfirmError(String(error));
      setMessage(String(error));
    } finally {
      setConfirmWorking(false);
      setBusy(false);
    }
  }
  leaveHandler.current = () => {
    if (busy || state?.runningStudio || state?.runningTestCaseId) { setMessage("Đợi tác vụ hiện tại kết thúc trước khi đóng Creator."); return; }
    exitReviewed.current.clear();
    setExitIntent("close");
  };
  reloadHandler.current = () => {
    if (busy || state?.runningStudio || state?.runningTestCaseId) { setMessage("Đợi tác vụ hiện tại kết thúc trước khi reload Creator."); return; }
    exitReviewed.current.clear();
    setExitIntent("reload");
  };
  const anyDirty = editorDirty || tabs.some(tab => tabDirty(tab.id));
  const dirtyRef = useRef(anyDirty);
  dirtyRef.current = anyDirty;
  // Reuse the same Save/Discard confirmation for every dirty tab before leaving
  // the application. Inactive drafts must not disappear behind a clean active tab.
  useEffect(() => {
    if (!exitIntent || busy || pendingNavigationRef.current || workspaceLock.current) return;
    const currentId = activeTabId ?? "initial";
    if ((activeTabId ? tabDirty(activeTabId) : editorDirty) && !exitReviewed.current.has(currentId)) {
      requestNavigation(() => {
        exitReviewed.current.add(currentId);
        setExitRevision(revision => revision + 1);
      }, exitIntent === "close");
      return;
    }
    const next = tabsRef.current.find(tab => tab.id !== activeTabId &&
      tabDirty(tab.id) && !exitReviewed.current.has(tab.id));
    if (next) {
      workspaceLock.current = true;
      void task(async () => { try { await activateTab(next); } finally { workspaceLock.current = false; } });
      return;
    }
    allowUnload.current = true;
    if (exitIntent === "reload") window.location.reload();
    else void invoke({ type: "confirmWindowClose" }).catch(error => {
      allowUnload.current = false;
      setExitIntent(undefined);
      setMessage(String(error));
    });
  }, [exitIntent, exitRevision, activeTabId, busy, editorDirty, anyDirty]);
  useEffect(() => {
    if (!shell) return;
    const off = window.creator.onRequestClose(() => leaveHandler.current());
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowUnload.current || (!dirtyRef.current && !latest.current.busy)) return;
      event.preventDefault();
      event.returnValue = "";
      setTimeout(() => reloadHandler.current(), 0);
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { off(); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);
  const expected = activePayload
    ? targetEnvironment(activePayload, state?.flow?.zoom ?? 1)
    : undefined;
  const viewportOcr = effectiveMatchTo(activePayload) !== "none";
  const environmentMismatch =
    expected &&
    state &&
    (expected.width !== state.browserBounds.width ||
      (!viewportOcr && expected.height !== state.browserBounds.height) ||
      expected.zoom !== state.zoom);
  useEffect(() => {
    document.documentElement.style.setProperty("--web-height",
      `${shot?.height ?? state?.browserBounds.height ?? WEB_HEIGHT}px`);
    document.documentElement.style.setProperty(
      "--browser-left",
      `${state?.browserBounds.x ?? 320}px`,
    );
    document.documentElement.style.setProperty(
      "--browser-width",
      `${state?.browserBounds.width ?? 1024}px`,
    );
    document.documentElement.style.setProperty(
      "--editor-left",
      `${layout.editorLeft}px`,
    );
    document.documentElement.style.setProperty(
      "--editor-width",
      `${layout.editorWidth}px`,
    );
  }, [state?.browserBounds.x, state?.browserBounds.width, state?.browserBounds.height, shot?.height, layout.editorLeft, layout.editorWidth]);
  function togglePanel() {
    const next = !expanded;
    if (shell) {
      if (next) void task(() => setEditorOpen(true));
      else requestNavigation(() => setEditorOpen(false));
      return;
    }
    void task(async () => {
      await invoke({ type: "panel", panel: "debug", expanded: next });
      setDebugExpanded(next);
    });
  }
  const workspaceTabs = <WorkspaceTabs tabs={tabs} activeId={activeTabId} state={state}
    mainPage={mainPage} locked={navigationLocked || ocrLoading || !!pendingNavigation || stepPlayback[activeStepId]?.status === "running"}
    dirty={tabDirty} caseName={id => studioEditors.current.get(id)?.name ?? caseEditors.current.get(id)?.name}
    open={tab => {
      if (tab.kind === "creator") openScenario(tab.flowId);
      else if (!navigationLocked && !workspaceLock.current && !pendingNavigationRef.current) {
        workspaceLock.current = true;
        void task(async () => { try { await activateTab(tab); } finally { workspaceLock.current = false; } });
      }
    }} close={closeTab} scenarios={() => navigateApp(mainPage)} />;
  return (
    <main className="app-shell" data-page={appPage} data-case-browser={creatorVisible && !!activeCaseTab}
      data-editor-overlay={creatorVisible && editorExpanded && !layout.editorBeside}
      style={{ "--app-nav-width": `${navigationWidth}px`, "--creator-min-width": `${layout.minWidth}px`,
        "--steps-left": `${layout.stepsLeft}px`, "--editor-left": `${layout.editorLeft}px`,
        "--steps-width": `${layout.editorBeside ? 320 : Math.max(320, Math.min(420, window.innerWidth - layout.stepsLeft))}px`,
        "--editor-width": `${layout.editorWidth}px` } as React.CSSProperties}>
      {shell && pendingNavigation && <UiPopover variant="modal" label="Thay đổi chưa lưu"
        className="unsaved-confirm" close={stayInEditor}>
        <div className="popover-heading"><b>Thay đổi chưa lưu</b>
          <button className="icon-button" aria-label="Ở lại Editor" disabled={confirmWorking} onClick={stayInEditor}>×</button>
        </div>
        <p>Tab đang có thay đổi chưa lưu. Chọn cách tiếp tục.</p>
        {confirmError && <p role="alert">{confirmError}</p>}
        <div className="popover-footer">
          <button className="primary" disabled={confirmWorking} onClick={() => void continueNavigation(true)}>{pendingNavigation.closing ? "Lưu & đóng" : "Lưu & tiếp tục"}</button>
          <button disabled={confirmWorking} onClick={() => void continueNavigation(false)}>Không lưu</button>
          <button disabled={confirmWorking} onClick={stayInEditor}>Ở lại</button>
        </div>
      </UiPopover>}
      {shell && navigationWidth > 0 && <AppNavigation page={creatorVisible || appPage === "test-case" || appPage === "studio-run" ? mainPage : appPage} collapsed={navigationWidth === APP_NAV_COLLAPSED}
        locked={navigationLocked || !state} navigate={navigateApp} toggle={() => void task(async () => {
          setState(await invoke<State>({ type: "appSidebar", collapsed: !sidebarCollapsed }));
        })} />}
      {shell && !creatorVisible && <div className="workspace-page-strip">{workspaceTabs}</div>}
      {shell && appPage === "studio-run" && <div className="studio-run-status" role="status">Studio execution · local Browser Session · shared V2 Runtime. Wait for the structured result.</div>}
      {shell && appPage === "scenarios" && <ScenariosPage state={state} name={flowName} setName={setFlowName}
        locked={navigationLocked || ocrLoading} open={openScenario} create={createScenario}
        update={updateWorkspace}
        invoke={invoke}
        authenticated={seoOpsAuthenticated}
        autoSyncEnabled={seoOpsAutoSyncEnabled}
        onState={setState}
        sessionControl={<SessionSelector state={state} locked={navigationLocked || stepPlayback[activeStepId]?.status === "running"} select={selectSession} />} />}
      {shell && appPage === "browser-sessions" && <BrowserSessionsPage state={state} locked={navigationLocked}
        update={updateBrowserSessions} open={openSession} />}
      {shell && appPage === "test-lab" && <TestLabPage state={state} locked={navigationLocked} update={updateWorkspace}
        open={openCase} run={runCase} canRun={canRunCase} create={() => openCase()} canDelete={id => !tabsRef.current.some(t => t.caseId === id)} />}
      {shell && state && tabs.filter(tab => tab.kind === "test-case").map(tab => <div key={tab.id} className="case-editor-host"
        hidden={tab.id !== activeTabId || appPage !== "test-case"}>
        <TestCaseEditor tabId={tab.id} item={state.testLab?.cases.find(c => c.id === tab.caseId)} state={state}
          locked={navigationLocked} report={reportCase} saved={caseSaved} saving={setBusy} run={runCase}
          fix={error => fixExecutionError(error, tab.flowId)} />
      </div>)}
      {shell && state && <AdminStudioPage report={reportStudio} page={appPage} state={state} locked={navigationLocked}
        selectedId={tabs.find(t => t.id === activeTabId && t.kind === "studio")?.studioId}
        open={(id, page, label) => {
          captureActiveTab();
          const tab: WorkspaceTab = { id: `studio:${id}`, kind: "studio", studioId: id, studioPage: page, flowId: label };
          if (!tabsRef.current.some(t => t.id === tab.id)) updateTabs([...tabsRef.current, tab]);
          setActiveTabId(tab.id); void task(() => changeAppPage(page));
        }} />}
      {shell && appPage === "settings" && <section className="app-page" aria-label="Settings">
        <div className="page-heading"><h1>Settings</h1><p>Cấu hình local cho ứng dụng trên máy này.</p></div>
        <SeoOpsAuthPanel
          locked={navigationLocked}
          invoke={async (command) => {
            const result = await invoke(command);
            if (command.type === "seoOpsLogin" || command.type === "seoOpsLogout" || command.type === "seoOpsGetSession" || command.type === "seoOpsSetEndpoint") {
              const session = command.type === "seoOpsGetSession" || command.type === "seoOpsSetEndpoint"
                ? result as { authenticated?: boolean; autoSyncEnabled?: boolean }
                : await invoke<{ authenticated?: boolean; autoSyncEnabled?: boolean }>({ type: "seoOpsGetSession" });
              setSeoOpsAuthenticated(Boolean(session.authenticated));
              setSeoOpsAutoSyncEnabled(Boolean(session.autoSyncEnabled));
            }
            return result;
          }}
        />
        <NetworkSettings state={state} locked={navigationLocked} update={async command => setState(await invoke<State>(command))} />
      </section>}
      {shell && !creatorVisible && pageError && <p className="app-page-error" role="alert">{pageError}</p>}
      {shell && creatorVisible && (
        <>
          <header>
            {workspaceTabs}
            {activeCaseTab && <button disabled={navigationLocked} onClick={() => navigateApp("test-case")}>Cấu hình Case</button>}
            <SessionSelector state={state} locked={locked || stepPlayback[activeStepId]?.status === "running"} select={selectSession} />
            <button
              className="primary"
              disabled={
                locked ||
                !state?.flow ||
                (needsTarget && !target) ||
                (["UPLOAD_FILE", "TYPE_ONLY", "CLICK_AND_TYPE", "QUICK_TAG"].includes(
                  action,
                ) &&
                  !variableId)
              }
              onClick={() => void task(saveBase)}
            >
              Save step
            </button>
            <div className="environment">
              ONE SESSION <i />
              {state?.browserBounds.width ?? WEB_WIDTH} × {state?.browserBounds.height ?? WEB_HEIGHT} DIP ·{" "}
              {Math.round((state?.zoom || 1) * 100)}% zoom
            </div>
            {state && (
              <Variables
                state={state}
                locked={locked}
                focusVariableId={focusVariableId}
                onFocusHandled={() => setFocusVariableId(undefined)}
                update={async (c) => setState(await invoke<State>(c))}
              />
            )}
          </header>
          <nav>
            <div className="workspace-scroll" aria-label="Workspace scrolling">
              <button
                title="Scroll workspace left"
                aria-label="Workspace left"
                onClick={() => window.scrollBy({ left: -240 })}
              >
                ←
              </button>
              <button
                title="Scroll workspace right"
                aria-label="Workspace right"
                onClick={() => window.scrollBy({ left: 240 })}
              >
                →
              </button>
            </div>
            {shot ? (
              <>
                <span className="capture-instructions" role="note">
                  {cropMode
                    ? "Kéo để chọn ROI trên ảnh. Esc để hủy."
                    : "Đang xem ảnh kiểm thử. Esc để quay lại."}
                </span>
                {cropMode && (
                  <button
                    className="primary"
                    disabled={!roi || roi.width < 4 || roi.height < 4 || busy}
                    onClick={() => void task(saveCrop)}
                  >
                    Dùng ROI {roi ? `${roi.width}×${roi.height}` : ""}
                  </button>
                )}
                <button disabled={busy} onClick={() => void task(closeShot)}>
                  Quay lại browser · Esc
                </button>
              </>
            ) : (
              <>
                <input
                  aria-label="URL"
                  value={url}
                  onChange={(e) => {
                    urlEdit.current.dirty = true;
                    urlEdit.current.revision++;
                    setUrl(e.target.value);
                  }}
                />
                <button
                  disabled={locked}
                  onClick={() =>
                    void task(async () => {
                      const revision = urlEdit.current.revision;
                      const snapshot = await invoke<State>({
                        type: "navigate",
                        url,
                      });
                      setState(snapshot);
                      if (revision === urlEdit.current.revision) {
                        urlEdit.current.dirty = false;
                        setUrl(snapshot.url);
                      }
                    })
                  }
                >
                  Mở URL
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    void task(async () => {
                      await invoke<string>({ type: "copyUrl" });
                      setMessage("Đã sao chép URL hiện tại của browser.");
                    })
                  }
                >
                  Copy URL
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    void task(async () =>
                      setState(await invoke<State>({ type: "fixture" })),
                    )
                  }
                >
                  Trang kiểm chuẩn
                </button>
                <label>
                  Zoom
                  <select
                    aria-label="Zoom"
                    disabled={locked || !!state?.flow?.steps.length}
                    value={state?.zoom || 1}
                    onChange={(e) =>
                      void task(async () =>
                        setState(
                          await invoke<State>({
                            type: "environment",
                            zoom: Number(e.target.value),
                          }),
                        ),
                      )
                    }
                  >
                    <option value="1">100%</option>
                    <option value="0.9">90%</option>
                    <option value="0.8">80%</option>
                  </select>
                </label>
              </>
            )}
          </nav>
          <aside className="creator-steps" aria-label="Steps">
            {activeCaseTab && <><b>Test Case · bản đã lưu</b>
              <p>{state?.runningTestCaseId ? "Đang chạy, vui lòng đợi." : "Đã kết thúc. Kiểm tra website hoặc mở Cấu hình Case để chạy lại."}</p>
              {!state?.runningTestCaseId && state?.testLab?.cases.find(c => c.id === activeCaseTab.caseId)?.lastResult &&
                <CaseResultView item={state.testLab.cases.find(c => c.id === activeCaseTab.caseId)!} state={state}
                  locked={navigationLocked || !canRunCase(activeCaseTab.caseId!)} runAgain={() => runCase(activeCaseTab.caseId!)}
                  onFix={error => fixExecutionError(error, activeCaseTab.flowId)} />}</>}
            {state?.sessionError && <p className="network-failure-hint" role="alert">{state.sessionError}</p>}
            {results.filter(result => result.networkHint).map(result =>
              <p key={result.id} className="network-failure-hint" role="alert">{result.networkHint}</p>)}
            <div className="execution-summary" role="status" aria-label="Lượt chạy hiện tại">
              {execution ? <><b>Bản đã chạy: {executionLabel(execution)}</b>
                <p>{stepPlayback[execution.stepId]?.status ?? "running"} · {stepPlayback[execution.stepId]?.message}</p>
              </> : <small>Play dùng version Base đã ghim trong danh sách; không dùng bản nháp Editor.</small>}
              {results.map(result => <p key={result.id}>
                v{result.version} · {result.status} · {matchToLabel(result.execution?.matchTo)}
                {result.execution && <> · OCR {result.execution.ocrPasses} / scroll {result.execution.scrolls} · {result.execution.stopReason}</>}
              </p>)}
            </div>
            {results.filter(result => result.error).map(result => <ExecutionErrorView key={`error-${result.id}`} error={result.error!}
              stepName={state?.steps.find(step => step.id === result.stepId && step.version === result.version)?.name}
              onFix={error => state?.flow && fixExecutionError(error, state.flow.id)} />)}
            {state && !activeCaseTab && (
              <Groups
                newStep={newStep}
                playAll={() => playSavedSteps()}
                state={state}
                locked={locked}
                update={async (c) => setState(await invoke<State>(c))}
              />
            )}
            {state && (
              <StepList
                state={state}
                selected={selected}
                playback={stepPlayback}
                activeStepId={activeStepId}
                blockedSteps={blockedSteps}
                toggleBlocked={toggleBlocked}
                play={playSavedSteps}
                locked={locked}
                update={async (c) => {
                  setBusy(true);
                  try {
                    setState(await invoke<State>(c));
                  } catch (e) {
                    setMessage(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
                select={(s) =>
                  requestNavigation(async () => {
                    const current = window.creator.readDraft("selected", undefined).value as Step | undefined;
                    await loadStep(s.id === selected?.id && current?.id === s.id ? current : s, false);
                    await setEditorOpen(false);
                    setResults([]);
                  })
                }
                edit={(s) => {
                  if (s.id === selected?.id && s.version === selected.version) showEditor();
                  else requestNavigation(() => loadStep(s));
                }}
              />
            )}
            {!state?.flow?.steps.length && (
              <p className="hint">
                Chọn Action trong Step Editor, crop target rồi Save step.
              </p>
            )}
          </aside>
          {shot && (
            <div
              className="snapshot"
              style={{
                left:
                  (shot.bounds?.x ?? 320 + WEB_WIDTH - shot.width) +
                  window.scrollX,
                top: shot.bounds?.y ?? 88,
                width: shot.width,
                height: shot.height,
              }}
              onPointerDown={(e) => {
                if (!cropMode) return;
                drag.current = point(e);
                e.currentTarget.setPointerCapture(e.pointerId);
                setRoi(undefined);
              }}
              onPointerMove={(e) => {
                if (!drag.current || !cropMode) return;
                const p = point(e),
                  s = drag.current;
                setRoi({
                  x: Math.round(Math.min(p.x, s.x)),
                  y: Math.round(Math.min(p.y, s.y)),
                  width: Math.round(Math.abs(p.x - s.x)),
                  height: Math.round(Math.abs(p.y - s.y)),
                });
              }}
              onPointerUp={() => {
                drag.current = undefined;
              }}
              onPointerCancel={() => {
                drag.current = undefined;
                setRoi(undefined);
              }}
              onLostPointerCapture={() => {
                drag.current = undefined;
              }}
            >
              <img
                alt="Browser screenshot"
                draggable={false}
                src={shot.dataUrl}
                style={{ width: shot.width, height: shot.height }}
              />
              {roi && (
                <div
                  className="roi"
                  style={{
                    left: roi.x,
                    top: roi.y,
                    width: roi.width,
                    height: roi.height,
                  }}
                />
              )}
            </div>
          )}{" "}
        </>
      )}
      {(shell && creatorVisible && !activeCaseTab && editorExpanded && !shot) && (
        <section
          className={shell ? "panel editor-column" : "panel"}
          aria-label={shell ? "Step Editor" : "Test & Debug"}
        >
          <div className="panel-heading">
            <b>{shell ? "Step Editor" : "Test & Debug"}</b>
            <span>
              {selected?.name || "Step mới"}
              {overrideId ? " · Override" : ""}
            </span>
            <button
              aria-label={
                shell
                  ? "Đóng Step Editor"
                  : expanded
                    ? "Thu gọn panel"
                    : "Mở panel"
              }
              aria-expanded={expanded}
              onMouseDown={(e) => e.preventDefault()}
              onClick={togglePanel}
            >
              {shell ? "Đóng ×" : expanded ? "−" : "+"}
            </button>
          </div>
          {!shell && expanded && selected && (
            <div className="test-controls">
              {environmentMismatch && (
                <div className="environment-warning" role="note">
                  Target cần {expected!.width}×{expected!.height} @{" "}
                  {expected!.zoom * 100}%; hiện tại {state!.browserBounds.width}
                  ×{state!.browserBounds.height}. Test sẽ bị chặn khi khác môi
                  trường.
                  <p>
                    Crop lại target ở viewport hiện tại rồi lưu redesign. Target
                    cũ được giữ nguyên.
                  </p>
                </div>
              )}
              <button
                disabled={locked}
                onClick={() => void run(selected, overrideId)}
              >
                Test step đã lưu · Ctrl+Shift+T
              </button>
            </div>
          )}
          {expanded && (
            <div className="panel-body">
              {shell && <div className="editor-task-summary">
                <h2>{name && name !== action ? name : target?.ocr?.text || name || "Step mới"}</h2>
                {target?.ocr?.text && name && name !== target.ocr.text && name !== action && <p>{target.ocr.text}</p>}
                <small>{selected ? `Base v${selected.version}` : "Chưa lưu"} · {editorDirty ? "Có thay đổi chưa lưu · Play dùng bản đã lưu" : "Đã lưu"}</small>
              </div>}
              {shell && <details className="editor-save-state"><summary>Phiên bản & lượt chạy</summary>
                {execution && <><b>Lượt chạy: {executionLabel(execution)}</b>
                  <p>{stepPlayback[execution.stepId]?.status} · {stepPlayback[execution.stepId]?.message}</p></>}
                Editor: {selected ? `${selected.name} · Base v${selected.version}` : "Step mới"}
                <br />{editorDirty ? "Có thay đổi chưa lưu — Play không dùng bản nháp này." : "Đã lưu."}
                <br />Match To Editor: {matchToLabel(effectiveMatchTo({ target }))}
                {selected && <><br />Ctrl+Shift+T: v{selected.version} · {overrideId ? "Override" : "Base"} · Match To {matchToLabel(effectiveMatchTo(activePayload))}</>}
              </details>}
              {shell ? (
                <>
                  {field(
                    "Action",
                    <select
                      aria-label="Action"
                      disabled={locked}
                      value={action}
                      onChange={(e) => {
                        setAction(e.target.value as Action);
                        setTarget(undefined);
                        setTargetImage("");
                        setOcrResult(undefined);
                        setOcrError("");
                      }}
                    >
                      <option>CLICK_TARGET</option>
                      <option>CLICK_AND_TYPE</option>
                      <option>UPLOAD_FILE</option>
                      <option>QUICK_TAG</option>
                      <option>TYPE_ONLY</option>
                      <option value="WAIT_VERIFY">WAIT / VERIFY</option>
                      <option>SCROLL</option>
                      <option>SLEEP</option>
                    </select>,
                  )}
                  {field(
                    "Tên step",
                    <input
                      aria-label="Tên step"
                      disabled={locked}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />,
                  )}
                  {needsTarget && <>
                    <button className="target-open" disabled={locked} aria-haspopup="dialog"
                      onClick={() => setTargetModal(true)}>{target ? "Xem target" : "Thêm target"} <span>↗</span></button>
                    {target && action !== "QUICK_TAG" && <>
                      {field("Match To",
                        <select aria-label="Match To" disabled={locked || !target.ocr?.confirmed}
                          title="None: không cuộn, AUTO Image Matching rồi OCR fallback trên viewport hiện tại. Top/Middle/Bottom: về đầu rồi quét xuống 1/3, 2/3 hoặc toàn vùng. OCR cần khớp ngữ cảnh ROI."
                          value={effectiveMatchTo({ target })}
                          onChange={(e) => setTarget({ ...target, matchTo: e.target.value as NonNullable<NonNullable<Payload["target"]>["matchTo"]> })}>
                          <option value="none">None</option>
                          <option value="top">Top</option>
                          <option value="middle">Middle</option>
                          <option value="bottom">Bottom</option>
                        </select>)}

                    </>}
                    {!target && <p className="hint">Chưa chọn ảnh target</p>}
                  </>}
                  {needsTarget && targetModal && <TargetModal
                    name={name} target={target} image={targetImage}
                    quickTagRows={action === "QUICK_TAG" ? quickTagRows : undefined}
                    locked={locked} canCapture={!!state?.flow}
                    close={() => { setOcrEdit(undefined); setTargetModal(false); }}
                    crop={() => { setTargetModal(false); void task(capture); }}
                    confirmed={action !== "QUICK_TAG" && target && <>
                      <div className="eyebrow">OCR LOCAL · VIỆT + ANH</div>
                      {target.ocr ? (
                        <div className="ocr-confirmed">
                          <small>OCR đã xác nhận</small>
                          {ocrEdit !== undefined ? (
                            <input
                              aria-label="Chỉnh sửa OCR đã xác nhận"
                              autoFocus
                              disabled={locked}
                              maxLength={2000}
                              value={ocrEdit}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) => setOcrEdit(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing) return;
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setOcrEdit(undefined);
                                } else if (e.key === "Enter") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const text = ocrEdit.trim();
                                  if (!text) return;
                                  setTarget((previous) => previous?.ocr
                                    ? { ...previous, ocr: { ...previous.ocr, text } }
                                    : previous);
                                  setOcrEdit(undefined);
                                }
                              }}
                            />
                          ) : (
                            <b title="Double-click để sửa · Enter lưu · Esc hủy"
                              onDoubleClick={() => {
                                if (!locked) setOcrEdit(target.ocr!.text);
                              }}>{target.ocr.text}</b>
                          )}
                          <p className="hint">
                            {Math.round(target.ocr.confidence)}% confidence
                          </p>
                          <button
                            aria-label="Clear confirmed OCR"
                            className="ocr-clear"
                            disabled={locked}
                            onClick={clearTargetOcr}
                          >
                            ×
                          </button>
                        </div>
                      ) : null}

                    </>}
                    ocrControls={<>
                  {needsTarget && target && action !== "QUICK_TAG" && (
                    <section className="ocr-panel" aria-label="OCR ROI">
                      <label>
                        Chọn chữ nhận diện
                        <select aria-label="Chọn chữ nhận diện" value={ocrKind} disabled={locked}
                          onChange={(e) => {
                            const kind = e.target.value as "none" | "line" | "word";
                            if (kind === "none") clearTargetOcr();
                            else setOcrKind(kind);
                          }}>
                          <option value="none">Không dùng chữ</option>
                          <option value="line">Cả dòng chữ</option>
                          <option value="word">Từng từ</option>
                        </select>
                      </label>
                      {ocrKind === "none" && <p className="hint">Nhận diện bằng ảnh</p>}
                      {ocrKind !== "none" && !target.ocr && !ocrResult && !ocrLoading &&
                        <p className="hint">Đọc lại OCR rồi chọn chữ để xác nhận.</p>}

                      {ocrLoading && <p role="note">Đang đọc OCR trên máy…</p>}
                      {ocrError && (
                        <p role="note" className="hint">
                          {ocrError}
                        </p>
                      )}
                      {ocrKind !== "none" && ocrResult && !ocrResult.segments.length && (
                        <p className="hint">
                          ROI không có chữ đọc được. Có thể lưu image-only cho
                          nút icon.
                        </p>
                      )}
                      {ocrKind !== "none" && ocrResult && ocrResult.segments.length > 0 && (
                        <>
                          <p className="hint">
                            {target.ocr
                              ? "Bấm dòng/từ khác để đổi chữ đã xác nhận."
                              : "Không tự chọn chữ. Bấm một dòng/từ bên dưới để xác nhận target."}
                          </p>
                          <div className="ocr-candidates">
                            {ocrResult.segments
                              .filter((s) => s.kind === ocrKind)
                              .map((s) => (
                                <button
                                  key={s.id}
                                  className="ocr-candidate"
                                  disabled={locked}
                                  aria-pressed={
                                    target.ocr?.text === s.text &&
                                    target.ocr.kind === s.kind &&
                                    target.ocr.bbox.x === s.bbox.x &&
                                    target.ocr.bbox.y === s.bbox.y
                                  }
                                  onClick={() => confirmOcr(s)}
                                >
                                  <b>{s.text}</b>
                                  <small>
                                    {s.confidence.toFixed(1)}% · bbox {s.bbox.x}
                                    ,{s.bbox.y} · {s.bbox.width}×{s.bbox.height}
                                  </small>
                                </button>
                              ))}
                          </div>
                        </>
                      )}
                      <button
                        disabled={locked}
                        onClick={() => void task(() => readOcr(target.asset))}
                      >
                        Đọc lại OCR
                      </button>

                    </section>
                  )}

                    </>}
                  />}
                  {["TYPE_ONLY", "CLICK_AND_TYPE"].includes(action) && (
                    <>
                      <label>
                        Phương thức nhập
                        <select
                          aria-label="Phương thức nhập"
                          disabled={locked}
                          value={inputMethod}
                          onChange={(e) =>
                            setInputMethod(
                              e.target.value as "keyboard" | "clipboard",
                            )
                          }
                        >
                          <option value="keyboard">
                            Keyboard · native text + Shift+Enter
                          </option>
                          <option value="clipboard">
                            Clipboard paste · phục hồi clipboard
                          </option>
                        </select>
                      </label>
                      <select
                        aria-label="Text variable"
                        value={variableId}
                        disabled={locked}
                        onChange={(e) => setVariableId(e.target.value)}
                      >
                        <option value="">Select Text variable</option>
                        {state?.flow?.variables
                          ?.filter((v) => v.type === "text")
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.key}
                            </option>
                          ))}
                      </select>
                      <p className="hint">
                        {action === "CLICK_AND_TYPE" ? (
                          "Composer cần đang mở. Crop ô nhập; Test sẽ click một lần rồi nhập. Quan sát bản nháp trước khi xác nhận."
                        ) : (
                          <>
                            Gửi vào caret hiện tại; không tự click/focus. Native
                            browser focus không chứng minh caret sẵn sàng. Lưu →
                            test cặp CLICK → TYPE bên dưới, hoặc click thủ công
                            ô nhập rồi Ctrl+Shift+T. Clipboard chỉ phục hồi khi
                            chưa bị thay đổi trong lúc paste.
                          </>
                        )}
                      </p>
                    </>
                  )}
                  {action === "SLEEP" && <section aria-label="Sleep">
                    <p>Chờ {networkDelays.sleepDelayMs}ms · {NETWORK_LABELS[networkSettings.mode]}</p>
                    <p className="hint">Thời gian chờ theo Network Mode trong Settings, được chốt khi bắt đầu lượt chạy. Không dùng Variable hoặc thời gian riêng trong Step.</p>
                  </section>}
                  {action === "QUICK_TAG" && <section aria-label="Quick Tag">
                    <p className="hint">Chọn theo vị trí, không xác minh danh tính người được chọn. Crop các hàng đầy đủ, cao đều nhau, bắt đầu từ hàng đầu muốn chọn. Không cuộn hoặc mở danh sách khác.</p>
                    {field("Số hàng hiển thị trong ROI (1–20)", <input type="number" min={1} max={20} step={1}
                      aria-label="Số hàng QUICK_TAG" disabled={locked} value={quickTagRows}
                      onChange={e => setQuickTagRows(Number(e.target.value))} />)}
                    <label>Số lượng chọn · Variable Integer
                      <select aria-label="QUICK_TAG Integer variable" disabled={locked} value={variableId} onChange={e => setVariableId(e.target.value)}>
                        <option value="">Chọn Variable Integer</option>
                        {state?.flow?.variables?.filter(v => v.type === "integer").map(v => <option key={v.id} value={v.id}>{v.key}</option>)}
                      </select>
                    </label>
                    <p className="hint">Dùng Default Pattern: 1–10, không vượt số hàng ROI. Click tâm hàng đầu rồi chờ hàng kế tiếp dồn lên và ổn định; nếu không đổi sẽ dừng. Không tự retry. Xem chấm tọa độ trong “Xem target”.</p>
                  </section>}
                  {action === "UPLOAD_FILE" && (
                    <section aria-label="Ảnh upload">
                      <select
                        aria-label="File variable"
                        value={variableId}
                        disabled={locked}
                        onChange={(e) => setVariableId(e.target.value)}
                      >
                        <option value="">Select File/Files variable</option>
                        {state?.flow?.variables
                          ?.filter(
                            (v) => v.type === "file" || v.type === "files",
                          )
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.key}
                            </option>
                          ))}
                      </select>
                      <p className="hint">
                        Crop nút Ảnh/Video đang hiển thị trong composer. Action
                        chỉ chọn file; phải quan sát đủ thumbnail/preview ảnh
                        thật rồi xác nhận. Không Publish.
                      </p>
                    </section>
                  )}
                  {action === "SCROLL" &&
                    field(
                      "Delta Y (âm = xuống)",
                      <input
                        aria-label="Scroll delta"
                        disabled={locked}
                        type="number"
                        value={delta}
                        onChange={(e) => setDelta(Number(e.target.value))}
                      />,
                    )}
                  <button
                    className="primary"
                    disabled={
                      locked ||
                      !state?.flow ||
                      (needsTarget && !target) ||
                      (["UPLOAD_FILE", "TYPE_ONLY", "CLICK_AND_TYPE", "QUICK_TAG"].includes(
                        action,
                      ) &&
                        !variableId)
                    }
                    onClick={() => void task(saveBase)}
                  >
                    {selected
                      ? `Lưu redesign → v${Math.max(...(state?.steps.filter((s) => s.id === selected.id).map((s) => s.version) || [1])) + 1}`
                      : "Lưu Base v1"}
                  </button>
                  {selected && (
                    <details className="advanced">
                      <summary>Version & Override</summary>
                      <div className="row">
                        {field(
                          "Viewing version",
                          <select
                            aria-label="Viewing version"
                            disabled={locked}
                            value={selected.version}
                            onChange={(e) => {
                              const step = state!.steps.find(s => s.id === selected.id && s.version === Number(e.target.value))!;
                              if (step.version !== selected.version) requestNavigation(() => loadStep(step));
                            }}
                          >
                            {state?.steps
                              .filter((s) => s.id === selected.id)
                              .map((s) => {
                                const pinned =
                                  state.flow?.steps.find((r) => r.id === s.id)?.version ===
                                  s.version;
                                const invalid = (state.invalidSteps ?? []).some(
                                  (r) => r.stepId === s.id && r.version === s.version,
                                );
                                return (
                                  <option key={s.version} value={s.version}>
                                    v{s.version}
                                    {pinned ? " · pinned" : ""}
                                    {invalid ? " · invalid" : ""}
                                  </option>
                                );
                              })}
                          </select>,
                        )}
                        <p className="hint">
                          Pinned version:{" "}
                          <b>
                            v
                            {state?.flow?.steps.find((r) => r.id === selected.id)?.version ??
                              "?"}
                          </b>{" "}
                          (Play All / Test Lab)
                        </p>
                        {state?.flow?.steps.find((r) => r.id === selected.id)?.version !==
                          selected.version && (
                          <small className="hint" role="status">
                            Đang xem v{selected.version}; chưa phải version đã ghim — chọn version không tự pin.
                          </small>
                        )}
                        <button
                          disabled={locked}
                          title="Ghim version đang xem cho Play All / Test Lab."
                          onClick={() =>
                            void task(async () => {
                              setState(
                                await invoke<State>({
                                  type: "selectVersion",
                                  id: selected.id,
                                  version: selected.version,
                                }),
                              );
                              setMessage(
                                `Đã pin v${selected.version} cho Play All / Test Lab.`,
                              );
                            })
                          }
                        >
                          Pin this version
                        </button>
                        {state?.flow?.steps.find((r) => r.id === selected.id)?.version ===
                          selected.version && (
                          <small className="hint">Viewing = Pinned</small>
                        )}
                        {(state?.invalidSteps ?? []).some(
                          (r) =>
                            r.stepId === selected.id &&
                            r.version === selected.version,
                        ) && (
                          <small className="hint" role="alert">
                            Version đang xem không hợp lệ — pin version khác hoặc sửa trước khi chạy.
                          </small>
                        )}
                      </div>
                      {field(
                        "Implementation",
                        <select
                          aria-label="Implementation"
                          disabled={locked}
                          value={overrideId}
                          onChange={(e) => setOverrideId(e.target.value)}
                        >
                          <option value="">Base v{selected.version}</option>
                          {state?.overrides
                            .filter(
                              (o) =>
                                o.stepId === selected.id &&
                                o.baseVersion === selected.version,
                            )
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                Override · {o.name}
                              </option>
                            ))}
                        </select>,
                      )}
                      <input
                        aria-label="Ngữ cảnh Override"
                        disabled={locked}
                        value={context}
                        onChange={(e) => setContext(e.target.value)}
                      />
                      <button
                        disabled={locked || (needsTarget && !target)}
                        onClick={() =>
                          void task(async () => {
                            const next = await invoke<State>({
                              type: "saveOverride",
                              stepId: selected.id,
                              version: selected.version,
                              name: context,
                              segment: [payload()],
                            });
                            setState(next);
                            setOverrideId(next.overrides.at(-1)!.id);
                            setMessage(
                              "Đã lưu Override riêng; Base không thay đổi. Chọn Base để bỏ áp dụng Override.",
                            );
                          })
                        }
                      >
                        Lưu form thành Override riêng
                      </button>
                      <p className="hint mono">
                        {selected.id} / v{selected.version}
                      </p>
                    </details>
                  )}
                </>
              ) : (
                <>
                  {!selected && (
                    <p className="hint">
                      Lưu hoặc chọn Step để Test. Kết quả cần bạn xác nhận.
                    </p>
                  )}
                  <div
                    role="status"
                    className="status"
                    hidden={
                      !busy &&
                      results.length > 0 &&
                      message === results.map((r) => r.message).join("\n")
                    }
                  >
                    {busy ? "Đang xử lý…" : message}
                  </div>
                  <div ref={resultPanel} aria-label="Kết quả Test">
                    {results.map((r) => (
                      <div
                        className={
                          "result " +
                          (r.status === "VERIFIED"
                            ? "pass"
                            : r.status === "ACTION_SENT"
                              ? "sent"
                              : "fail")
                        }
                        key={r.id}
                      >
                        <b>
                          {r.status} · {r.action}
                        </b>
                        <p>{resultSummary(r)}</p>
                        {r.status === "ACTION_SENT" &&
                          [
                            "CLICK_TARGET",
                            "CLICK_AND_TYPE",
                            "UPLOAD_FILE",
                            "TYPE_ONLY",
                          ].includes(r.action) && (
                            <div className="review-actions">
                              <button
                                disabled={
                                  locked ||
                                  !state?.flow?.steps.some(
                                    (s) =>
                                      s.id === r.stepId &&
                                      s.version === r.version,
                                  )
                                }
                                onClick={() =>
                                  void task(() => reviewClick(r, "correct"))
                                }
                              >
                                {r.action === "UPLOAD_FILE"
                                  ? "Đã thấy đủ preview — Hoàn thành Step"
                                  : "Đúng — Hoàn thành Step"}
                              </button>
                              <button
                                disabled={
                                  locked ||
                                  !state?.flow?.steps.some(
                                    (s) =>
                                      s.id === r.stepId &&
                                      s.version === r.version,
                                  )
                                }
                                onClick={() =>
                                  requestNavigation(() => reviewClick(r, "incorrect"))
                                }
                              >
                                Sai — Redesign Step
                              </button>
                            </div>
                          )}
                        {r.status === "BLOCKED" &&
                          ["CLICK_AND_TYPE", "UPLOAD_FILE"].includes(
                            r.action,
                          ) && (
                            <div className="review-actions">
                              <p>
                                {r.clickSent
                                  ? "Đã click; cần kiểm tra nội dung trước khi test lại."
                                  : "Bị chặn trước khi click/nhập. Sửa target và lưu version mới trước khi thử lại."}
                              </p>
                              <button
                                disabled={locked}
                                onClick={() => requestNavigation(() => openRedesign(r))}
                              >
                                Redesign Step bị chặn
                              </button>
                            </div>
                          )}

                        {r.upload && (
                          <p>
                            {r.upload.preview === "confirmed_by_user"
                              ? "Đã xác nhận preview bằng quan sát của người dùng."
                              : `Chưa xác nhận preview. Cần thấy đủ ${r.upload.fileCount} thumbnail ảnh thật, đợi xử lý xong và kiểm tra không có lỗi trước khi hoàn thành Step.`}
                          </p>
                        )}
                        {r.evidenceWarning && <p>{r.evidenceWarning}</p>}
                        {
                          <details className="debug-details">
                            <summary>Debug</summary>
                            <p>{r.message}</p>
                            <p>
                              Step {r.stepId.slice(0, 8)} · v{r.version} ·{" "}
                              {r.source === "override" ? "Override" : "Base"}
                            </p>
                            {r.upload && (
                              <p>
                                Upload: {r.upload.transport} · {r.upload.phase}{" "}
                                · chooser {r.upload.chooserMode ?? "chưa nhận"}{" "}
                                · giao {r.upload.assignedCount}/
                                {r.upload.fileCount} file · preview{" "}
                                {r.upload.preview}. {r.upload.cleanupWarning}
                              </p>
                            )}
                            {r.resolution && (
                              <div className="resolver-trace">
                                <b>
                                  Resolver AUTO · thực dùng:{" "}
                                  {r.resolution.selectedMethod ?? "không chọn"}
                                </b>
                                {r.resolution.legacyMethod && (
                                  <p>
                                    Hint cũ: {r.resolution.legacyMethod} (giữ
                                    trong Base; runtime dùng AUTO).
                                  </p>
                                )}
                                {r.resolution.fallbackReason && (
                                  <p>
                                    Lý do fallback:{" "}
                                    {r.resolution.fallbackReason}
                                  </p>
                                )}
                                {r.resolution.blockedReason && (
                                  <p>
                                    Lý do chặn: {r.resolution.blockedReason}
                                  </p>
                                )}
                                {r.resolution.attempts.map((a, i) => (
                                  <p key={i}>
                                    {a.method}: {a.outcome}
                                    {a.score !== undefined
                                      ? ` · score ${a.score.toFixed(4)}`
                                      : ""}
                                    {a.confidence !== undefined
                                      ? ` · confidence ${a.confidence.toFixed(1)}%`
                                      : ""}
                                    {a.x !== undefined
                                      ? ` · (${a.x.toFixed(1)}, ${a.y?.toFixed(1)}) DIP`
                                      : ""}
                                    . {a.reason}
                                  </p>
                                ))}
                              </div>
                            )}
                            {r.match && (
                              <div className="match-detail">
                                <b>
                                  Đã dùng:{" "}
                                  {r.match.method === "ocr"
                                    ? "OCR text matching"
                                    : "Image Matching"}
                                </b>
                                {r.match.method === "ocr" ? (
                                  <p>
                                    Chữ tìm được: “{r.match.text}” · confidence{" "}
                                    {r.match.confidence?.toFixed(1)}%
                                  </p>
                                ) : (
                                  <>
                                    <p>
                                      Ảnh ROI đã khớp · score{" "}
                                      {r.match.score.toFixed(4)}. Vị trí cuối
                                      cùng chọn bằng ảnh; OCR có thể được dùng
                                      để đối chiếu an toàn.
                                    </p>
                                    <ResultTarget asset={r.targetAsset} />
                                  </>
                                )}
                                <p>
                                  Tọa độ browser: ({r.match.x.toFixed(1)},{" "}
                                  {r.match.y.toFixed(1)}) DIP
                                </p>
                              </div>
                            )}
                            {r.input && (
                              <div className="match-detail">
                                <b>
                                  Phương thức nhập:{" "}
                                  {r.input.method === "clipboard"
                                    ? "Clipboard paste"
                                    : "Keyboard · native text + Shift+Enter"}
                                </b>
                                <p>
                                  Browser focus: {String(r.input.focus.browser)}{" "}
                                  · editor focus: {String(r.input.focus.editor)}{" "}
                                  · route: {r.input.focus.route}. Caret: chưa
                                  kiểm chứng.
                                </p>
                                {r.input.clipboard && (
                                  <p>
                                    Clipboard: {r.input.clipboard}.{" "}
                                    {r.input.warning}
                                  </p>
                                )}
                              </div>
                            )}
                          </details>
                        }
                        {r.review?.verdict === "correct" && (
                          <button disabled={locked} onClick={newStep}>
                            + Tạo Step tiếp theo từ browser hiện tại
                          </button>
                        )}
                        <details className="evidence">
                          <summary>Ảnh & ghi chú</summary>
                          {r.status === "ACTION_SENT" && (
                            <p>
                              Chỉ mới gửi thao tác; chưa xác nhận kết quả nghiệp
                              vụ. Quan sát browser đang hiển thị và chờ giao
                              diện phản hồi.
                            </p>
                          )}
                          {[
                            "CLICK_TARGET",
                            "CLICK_AND_TYPE",
                            "TYPE_ONLY",
                          ].includes(r.action) &&
                            !r.after && (
                              <p>
                                Browser live được giữ nguyên; không tự chụp ảnh
                                sau input để tránh mất focus. Ảnh trước chỉ xem
                                khi bạn yêu cầu. Nếu cần gõ tiếp sau thao tác ở
                                sidebar/chụp ảnh, click thủ công vào ô nhập.
                              </p>
                            )}
                          {!r.before && (
                            <p>
                              Không chụp trước TYPE_ONLY/SCROLL để giữ focus.
                            </p>
                          )}
                          <div className="row">
                            <button
                              disabled={busy || !r.before}
                              onClick={() =>
                                void task(() => inspect(r.before!))
                              }
                            >
                              Ảnh trước
                            </button>
                            <button
                              disabled={busy || !!shot}
                              onClick={() =>
                                void task(async () =>
                                  inspect(
                                    r.after ??
                                      (await invoke<Capture>({
                                        type: "capture",
                                      })),
                                  ),
                                )
                              }
                            >
                              {r.after ? "Ảnh sau" : "Chụp trạng thái hiện tại"}
                            </button>
                          </div>
                        </details>
                      </div>
                    ))}
                  </div>
                  {selected && (
                    <details className="test-help">
                      <summary>Hướng dẫn Test & Test cặp</summary>

                      <p className="hint">
                        Test dùng payload đã lưu. TYPE_ONLY/SCROLL: giữ focus
                        trong web và dùng phím tắt.
                      </p>
                      {[
                        "CLICK_TARGET",
                        "CLICK_AND_TYPE",
                        "UPLOAD_FILE",
                        "WAIT_VERIFY",
                      ].includes(selected.payload.action) && (
                        <p className="hint saved-method">
                          Nhận diện AUTO, áp dụng cả Step cũ. Chỉ cần lưu khi
                          sửa target, nội dung hoặc Action; không cần lưu để đổi
                          engine.
                        </p>
                      )}
                      {selected.payload.action === "TYPE_ONLY" && (
                        <section
                          aria-label="Test hai Step"
                          className="flow-guide"
                        >
                          <b>Test CLICK → TYPE liền nhau</b>
                          <p>
                            Chạy Base đã lưu của Step CLICK ngay trước và Step
                            TYPE này; không về sidebar hoặc chụp ảnh giữa hai
                            Step. CLICK phải mở composer và đặt caret; nếu chỉ
                            mở hộp thoại, hãy tạo CLICK riêng vào ô nhập trước
                            TYPE. Kết quả vẫn cần xác nhận.
                          </p>
                          <label>
                            Đợi sau click (ms)
                            <input
                              aria-label="Đợi sau click"
                              disabled={locked}
                              type="number"
                              min={0}
                              max={10000}
                              value={pairDelay}
                              onChange={(e) =>
                                setPairDelay(Number(e.target.value))
                              }
                            />
                          </label>
                          <button
                            disabled={
                              locked ||
                              !previousClick ||
                              state?.flow?.steps[selectedIndex]?.version !==
                                selected.version
                            }
                            onClick={() =>
                              void task(async () => {
                                setResults([]);
                                const r = await invoke<Result[]>({
                                  type: "testPair",
                                  firstId: previousClick!.id,
                                  secondId: selected.id,
                                  delayMs: pairDelay,
                                });
                                setResults(r);
                                setMessage(r.map((r) => r.message).join("\n"));
                              })
                            }
                          >
                            Test 2 Step · CLICK → TYPE (Base)
                          </button>
                          <p>
                            {previousClick
                              ? `${previousClick.name} v${previousClick.version} → ${selected.name} v${selected.version}. TYPE đã lưu: ${selected.payload.inputMethod ?? "keyboard"}. Override không áp dụng cho cặp này.`
                              : "Cần Step Base CLICK_TARGET ngay trước TYPE_ONLY trong flow. Lưu/pin đúng version trước khi test cặp."}
                          </p>
                        </section>
                      )}
                    </details>
                  )}{" "}
                </>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ResultTarget({ asset }: { asset?: string }) {
  const [image, setImage] = useState("");
  useEffect(() => {
    let active = true;
    setImage("");
    if (asset)
      void window.creator
        .invoke({ type: "targetImage", asset })
        .then((value) => {
          if (active) setImage(value as string);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [asset]);
  return image ? (
    <img className="target" alt="Ảnh target đã dùng khi test" src={image} />
  ) : null;
}
createRoot(document.getElementById("root")!).render(<Creator />);
