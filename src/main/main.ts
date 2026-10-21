import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  Menu,
  dialog,
  screen,
  clipboard,
} from "electron";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { registerFixtureWorkspace } from "./fixture-ui.js";
import { PointerTrace } from "./pointer-trace.js";
import { ClickMarker } from "./click-marker.js";
import { CreatorOverlays } from "./creator-overlays.js";
import { BrowserCore } from "./browser-core.js";
import { BrowserSessions } from "./browser-sessions.js";
import { BrowserRecording } from "./browser-recording.js";
import { TestRunEvidence } from "./test-run-evidence.js";
import { TestLab } from "./test-lab.js";
import { playSequential } from "../shared/playback.js";
import { validateVariables, resolvePayload } from "../shared/flow-model.js";
import { ScenarioGroups } from "./scenario-groups.js";
import { Store } from "./storage.js";
import { logMainError, logMainEvent, logTestBoundary } from "./main-error-log.js";
import { Runtime } from "./runtime.js";
import { startFixture } from "./fixture.js";
import { localOcr } from "./ocr.js";
import { inspectUploadFiles, IMAGE_EXTENSIONS } from "./upload-files.js";
import {
  WEB_WIDTH,
  WEB_HEIGHT,
  SIDE_WIDTH,
  TOP_HEIGHT,
  validateRect,
  validateZoom,
} from "../shared/geometry.js";
import { effectiveMatchTo, matchToLabel } from "../shared/match-to.js";
import { DRAFT_KEYS } from "../shared/contracts.js";
import type { Command, State, CaseResult, Step } from "../shared/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(root, "..");
const selfTest = process.argv.includes("--self-test");
const phase =
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] || "first";
// All mutable POC data stays inside new/.local; no access to old/.
const dataPath = path.join(
  project,
  ".local",
  selfTest
    ? [
        "creator-ui",
        "creator-native",
        "playback-ui",
        "overlay",
        "ux",
        "ocr",
        "typing",
        "upload",
        "address",
      ].includes(phase)
      ? `test-${phase}-${process.pid}`
      : "test-session"
    : "creator",
);
app.setPath("userData", dataPath);
app.setPath("sessionData", path.join(dataPath, "chromium"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void boot().catch(async (e) => {
    console.error(e);
    if (selfTest) {
      await mkdir(path.join(project, "artifacts"), { recursive: true });
      await writeFile(
        path.join(project, "artifacts", `failure-${phase}.txt`),
        String(e?.stack || e),
      );
    } else dialog.showErrorBox("Creator không khởi động được", String(e));
    app.exit(1);
  });
}

async function boot() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const required = {
    width: SIDE_WIDTH + WEB_WIDTH,
    height: TOP_HEIGHT + WEB_HEIGHT,
  };
  const area = screen.getPrimaryDisplay().workAreaSize;
  await mkdir(dataPath, { recursive: true });
  const assetDir = path.join(dataPath, "targets"),
    evidenceDir = path.join(dataPath, "captures"),
    runDir = path.join(dataPath, "runs");
  for (const dir of [assetDir, evidenceDir, runDir])
    await mkdir(dir, { recursive: true });
  const store = new Store(path.join(dataPath, "creator.sqlite"));
  const browserSessions = new BrowserSessions(store);
  const scenarioGroups = new ScenarioGroups(store);
  const testLab = new TestLab(store, browserSessions);
  const testEvidence = new TestRunEvidence(path.join(dataPath, "test-runs"));
  let runningTestCaseId: string | undefined;
  let switchingWorkspace = false;
  let activeSessionId = browserSessions.activeId();
  let switchingSession = false;
  let sessionError: string | undefined;
  const fixture = await startFixture(
    selfTest
      ? phase === "address"
        ? 47837
        : phase === "upload"
          ? 47836
          : phase === "typing"
            ? 47835
            : phase === "ocr"
              ? 47834
              : phase === "ux"
                ? 47833
                : 47832
      : 47831,
  );
  const window = new BrowserWindow({
    useContentSize: true,
    width: selfTest
      ? required.width
      : Math.min(required.width, area.width - 16),
    height: selfTest
      ? required.height
      : Math.min(required.height, area.height - 40),
    resizable: true,
    minWidth: 640,
    minHeight: 648,
    maximizable: true,
    fullscreenable: true,
    show: false,
    title: "RPA Social Automation V2",
    webPreferences: {
      preload: path.join(root, "preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const uiLayers = new Map<string, { layer: WebContentsView; cleanup: () => void }>();
  const closeUiLayer = (name: string) => {
    const entry = uiLayers.get(name);
    if (!entry) return;
    const { layer, cleanup } = entry;
    cleanup();
    if (!layer.webContents.isDestroyed()) layer.webContents.close();
  };
  // window.open provides the same-origin portal document; createWindow places its
  // WebContentsView above Facebook rather than hiding/reparenting the browser.
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== "about:blank" || !/^creator-ui-overlay-[a-f0-9-]+$/.test(frameName)) return { action: "deny" };
    return { action: "allow", createWindow: (options) => {
      // Electron supplies the window.open guest as options.webContents at runtime.
      // Pass options intact so the view adopts that guest, rather than creating
      // unrelated WebContents (which violates createWindow's identity contract).
      const layer = new WebContentsView(options);
      layer.setBackgroundColor("#00000000");
      const align = () => {
        const [width,height] = window.getContentSize();
        if (!layer.webContents.isDestroyed()) layer.setBounds({ x: 0, y: 0, width, height });
      };
      align();
      window.contentView.addChildView(layer);
      window.on("resize", align);
      layer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const preventNavigation = (event: Electron.Event) => event.preventDefault();
      layer.webContents.on("will-navigate", preventNavigation);
      layer.webContents.on("before-input-event", windowKeys);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        window.removeListener("resize", align);
        layer.webContents.removeListener("will-navigate", preventNavigation);
        layer.webContents.removeListener("before-input-event", windowKeys);
        layer.webContents.removeListener("destroyed", cleanup);
        if (uiLayers.get(frameName)?.layer === layer) {
          uiLayers.delete(frameName);
        }
        if (!window.isDestroyed()) window.contentView.removeChildView(layer);
      };
      uiLayers.set(frameName, { layer, cleanup });
      layer.webContents.once("destroyed", cleanup);
      layer.webContents.focus();
      return layer.webContents;
    } };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const browser = new BrowserCore(
    window,
    evidenceDir,
    browserSessions.get(activeSessionId).partition,
  );
  const overlays = new CreatorOverlays(
    window,
    path.join(root, "preload/index.cjs"),
    browser,
    store.setting("appSidebarCollapsed") === "true",
  );
  const pointerTrace = new PointerTrace(
    window,
    browser,
    overlays,
    process.argv.includes("--pointer-trace"),
    dataPath,
  );
  if (selfTest) {
    registerFixtureWorkspace(window, overlays);
    for (const wc of [
      window.webContents,
      ...overlays.views.map((v) => v.webContents),
    ])
      wc.on("console-message", (event) => {
        if (event.level === "error") console.error("RENDERER", event.message);
      });
  }
  const editors = [
    window.webContents,
    ...overlays.views.map((v) => v.webContents),
  ];
  const trusted = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    editors.includes(event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  const draft = new Map<string, { revision: number; value: unknown }>();
  const keys = new Set<string>(DRAFT_KEYS);
  let revision = 0;
  const publishDraft = (key: string, value: unknown) => {
    const entry = { revision: ++revision, value };
    draft.set(key, entry);
    for (const editor of editors)
      if (!editor.isDestroyed())
        editor.send("creator:draft-update", key, entry);
  };
  ipcMain.on("creator:pointer-enabled", (event) => {
    event.returnValue = trusted(event) && pointerTrace.enabled;
  });
  ipcMain.on("creator:pointer-dom", (event, data) => {
    if (trusted(event) && data && typeof data.type === "string")
      pointerTrace.record({
        kind: "dom",
        view: event.sender === window.webContents ? "shell" : "debug",
        id: event.sender.id,
        type: data.type,
        control: String(data.control).slice(0, 80),
        x: data.x,
        y: data.y,
        trusted: data.trusted,
      });
  });
  ipcMain.on("creator:draft", (event, request) => {
    if (!trusted(event) || !request || !keys.has(request.key)) {
      event.returnValue = null;
      return;
    }
    if (!draft.has(request.key) || request.write) {
      const entry = {
        revision: ++revision,
        value: request.write ? request.value : request.initial,
      };
      draft.set(request.key, entry);
      for (const editor of editors)
        if (editor !== event.sender && !editor.isDestroyed())
          editor.send("creator:draft-update", request.key, entry);
    }
    event.returnValue = draft.get(request.key);
  });
  for (const view of overlays.views) browser.trackEditor(view.webContents);
  // Window and panel changes reposition the fixed viewport without reflowing it.
  window.on("resize", () => {
    overlays.layout();
    publishLayout();
  });
  const creatorDevtools = process.env.CREATOR_DEVTOOLS === "1" &&
    !app.isPackaged && process.env.NODE_ENV !== "production";
  const windowKeys = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" && !input.control && !input.shift && !input.alt && !input.meta) {
      event.preventDefault();
      if (creatorDevtools && !input.isAutoRepeat) {
        const facebook = browser.view.webContents;
        if (facebook.isDevToolsOpened()) facebook.closeDevTools();
        else facebook.openDevTools({ mode: "detach" });
      }
      return;
    }
    if (input.key === "F11") {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (
      input.key === "Escape" &&
      // Shell inputs handle Escape themselves (including inline OCR cancel).
      browser.view.webContents.isFocused() &&
      browser.visible &&
      window.isFullScreen()
    ) {
      event.preventDefault();
      window.setFullScreen(false);
    }
  };
  for (const editor of editors) editor.on("before-input-event", windowKeys);
  browser.onViewCreated(wc => {
    wc.on("before-input-event", windowKeys);
    wc.on("devtools-opened", () => {
      // Detached DevTools receives F12 while its own window has focus.
      wc.devToolsWebContents?.on("before-input-event", (event, input) => {
        if (creatorDevtools && input.type === "keyDown" && input.key === "F12" &&
            !input.control && !input.shift && !input.alt && !input.meta) {
          event.preventDefault();
          if (!input.isAutoRepeat) wc.closeDevTools();
        }
      });
    });
  });
  browser.setZoom(store.flow()?.zoom ?? Number(store.setting("zoom") || 1));
  const marker = new ClickMarker(window, browser);
  const runtime = new Runtime(browser, store, assetDir, runDir, undefined,
    (x, y) => marker.show(x, y),
    (execution) => window.webContents.send("creator:execution-start", execution));
  const recorder = new BrowserRecording(window.webContents, path.join(dataPath, "test-runs"));
  let uiPlayAllRunId: string | undefined;
  let armedTest:
    { stepId: string; version: number; overrideId?: string } | undefined;
  const state = (): State => ({
    testLab: testLab.read(), runningTestCaseId,
    scenarioOrganization: scenarioGroups.read(),
    browserSessions: browserSessions.list(),
    activeBrowserSessionId: activeSessionId,
    sessionError,
    appPage: overlays.page,
    sidebarCollapsed: overlays.sidebarCollapsed,
    networkSettings: store.networkSettings(),
    flow: store.flow(),
    flows: store.flows(),
    steps: store.steps(),
    overrides: store.overrides(),
    url: browser.view.webContents.getURL(),
    zoom: browser.zoom,
    browserBounds: browser.bounds,
    focused: browser.view.webContents.isFocused(),
    visible: browser.visible && overlays.page === "creator",
    dataPath,
  });
  const publishLayout = () => {
    for (const editor of editors)
      if (!editor.isDestroyed())
        editor.send("creator:layout", { ...browser.bounds });
  };
  const captures = new Map<
    string,
    { width: number; height: number; zoom: number }
  >();
  const isIdle = () => {
    if (runningTestCaseId) throw new Error("Đang chạy Test Case; vui lòng đợi.");
    if (switchingWorkspace) throw new Error("Đang chuyển tab; vui lòng đợi.");
    if (runtime.busy) throw new Error("Đang test; đợi tác vụ kết thúc.");
    if (switchingSession) throw new Error("Đang chuyển Browser Session; vui lòng đợi.");
  };
  const publishSessions = () => {
    if (!window.webContents.isDestroyed()) window.webContents.send("creator:browser-sessions", {
      browserSessions: browserSessions.list(), activeBrowserSessionId: activeSessionId, sessionError,
    });
  };
  async function switchBrowserSession(id: string, workspace = false, restoreUrl = true) {
    if (!workspace) isIdle();
    if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi chuyển Session.");
    if (!browser.visible) throw new Error("Thoát crop/ảnh trước khi chuyển Session.");
    const target = browserSessions.get(id);
    if (id === activeSessionId) return state();
    switchingSession = true;
    sessionError = undefined;
    armedTest = undefined;
    try {
      // Successful URLs are persisted by main-frame navigation events before this
      // flush. Do not re-add a manually removed Domain Tag just by leaving a Session.
      await browser.switchPartition(target.partition);
      activeSessionId = id;
      browserSessions.select(id);
      captures.clear();
      browser.setZoom(browser.zoom);
      overlays.layout();
      publishLayout();
      publishUrl();
      publishSessions();
      try {
        if (restoreUrl) {
          if (target.lastUrl) await browser.navigate(target.lastUrl);
          else await browser.view.webContents.loadURL("about:blank");
        }
      } catch (error) {
        sessionError = "Session đã mở nhưng trang chưa tải được. Bạn có thể nhập URL khác.";
        logMainError(runDir, "session-navigation", error, { sessionId: id });
      }
      return state();
    } finally { switchingSession = false; publishSessions(); }
  }
  async function delayBetweenSteps(batchRunId: string, previous: Step, next: Step) {
    if (![previous, next].every(step => store.flow()?.steps.some(ref => ref.id === step.id)))
      throw new Error("Step không thuộc flow.");
    const network = runtime.playAllNetwork(batchRunId);
    const delayMs = network.stepDelayMs;
    const startedAt = Date.now();
    const context = { batchRunId,
      previousStepId: previous.id, previousVersion: previous.version,
      nextStepId: next.id, nextVersion: next.version, delayMs, network };
    logMainEvent(runDir, "play-all-transition-start", context);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    logMainEvent(runDir, "play-all-transition-end", { ...context, elapsedMs: Date.now() - startedAt });
  }
  async function runTestCase(id: string) {
    isIdle();
    if (uiPlayAllRunId || !browser.visible) throw new Error("Đợi Play All kết thúc và thoát crop trước khi chạy Case.");
    const item = testLab.get(id);
    runningTestCaseId = id;
    armedTest = undefined;
    const runId = randomUUID(), startedAt = new Date().toISOString();
    const savedFlow = store.flows().find(flow => flow.id === item.flowId);
    const session = browserSessions.list().find(session => session.id === item.sessionId);
    let batchId: string | undefined;
    let currentStep: Step | undefined;
    let contextReady = false, screenshotAttempted = false;
    let outcome: CaseResult = { runId, caseId: id, caseName: item.name,
      flowId: item.flowId, scenarioName: savedFlow?.name ?? item.flowId,
      sessionId: item.sessionId, sessionName: session?.name ?? item.sessionId, startUrl: item.startUrl,
      status: "RUNNING", startedAt, finishedAt: startedAt, message: "Chuẩn bị Test Run.", steps: [] };
    const publish = () => {
      testLab.result(id, outcome);
      window.webContents.send("creator:case-state", state());
    };
    const screenshot = async () => {
      if (screenshotAttempted) return;
      screenshotAttempted = true;
      if (!contextReady) {
        outcome.screenshotError = "Chưa mở được đúng Browser Session của Case; không chụp Browser của workspace khác.";
        return;
      }
      try { Object.assign(outcome, await testEvidence.capture(browser, id, runId)); }
      catch (error) { outcome.screenshotError = error instanceof Error ? error.message : String(error); }
    };
    try {
      publish();
      const flow = structuredClone(testLab.validate(item, false));
      flow.defaultPattern = { values: structuredClone(item.values) };
      const steps = flow.steps.map(ref => store.step(ref.id, ref.version));
      outcome.steps = steps.map(step => ({ stepId: step.id, name: step.name, version: step.version,
        status: "PENDING", message: "Chưa chạy." }));
      batchId = runtime.startPlayAllLog(flow);
      await switchBrowserSession(item.sessionId, true, false);
      store.setSetting("currentFlow", flow.id);
      browser.setZoom(flow.zoom);
      overlays.setExpanded("editor", false);
      overlays.setPage("creator");
      contextReady = true;
      publishLayout(); publish();
      if (item.recording) {
        try { await recorder.start(browser.view.webContents, id, runId); }
        catch { outcome.recordingError = "Could not start Browser recording; screenshots remain enabled."; }
      }
      // loadURL awaits main-frame load completion. No DOM/login inspection or retries.
      let failedLoad = false;
      const wc = browser.view.webContents;
      const failed = (_event: unknown, _code: number, _description: string, _url: string, main: boolean) => { if (main) failedLoad = true; };
      const response = (_event: unknown, _url: string, status: number) => { if (status >= 400) failedLoad = true; };
      wc.on("did-fail-load", failed); wc.on("did-navigate", response);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          browser.navigate(item.startUrl),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error("Start URL chưa tải xong sau 30 giây; Case chưa gửi thao tác.")); wc.stop(); }, 30000);
          }),
        ]);
        if (failedLoad) throw new Error("Start URL chưa tải thành công; Case chưa gửi thao tác.");
      } finally {
        if (timer) clearTimeout(timer);
        wc.removeListener("did-fail-load", failed); wc.removeListener("did-navigate", response);
      }
      // Values are checked in the Case's Browser, before any Step sends input.
      validateVariables(flow.variables ?? [], item.values);
      for (const step of steps) { currentStep = step; resolvePayload(step.payload, flow); }
      currentStep = undefined;
      let allVerified = true, stopped = false;
      await playSequential(steps, async step => {
        currentStep = step;
        try {
          const results = await runtime.test(step.id, step.version, undefined, batchId);
          if (results.some(result => result.status !== "VERIFIED")) allVerified = false;
          // Capture on failure before progress, cleanup or any further Browser operation.
          if (results.some(result => !result.ok)) await screenshot();
          window.webContents.send("creator:shortcut-result", results);
          return results;
        } catch (error) { await screenshot(); throw error; }
      }, (step, progress) => {
        const entry = outcome.steps!.find(entry => entry.stepId === step.id)!;
        entry.status = progress.status === "running" ? "RUNNING" : progress.status === "blocked" ? "BLOCKED"
          : progress.status === "fail" ? "ERROR" : progress.status === "skipped" ? "SKIPPED"
          : progress.resultStatus === "ACTION_SENT" ? "ACTION_SENT" : "PASS";
        entry.message = progress.message; entry.runtimeStatus = progress.resultStatus;
        outcome.message = `${step.name}: ${progress.message}`;
        if (["blocked", "fail"].includes(progress.status)) {
          stopped = true;
          Object.assign(outcome, { status: entry.status, message: progress.message,
            stepId: step.id, stepName: step.name, version: step.version });
        }
        publish();
      }, undefined, async (previous, next) => { currentStep = next; await delayBetweenSteps(batchId!, previous, next); });
      if (!stopped) Object.assign(outcome, { status: !steps.length ? "SKIPPED" : allVerified ? "PASS" : "ACTION_SENT",
        message: !steps.length ? "Scenario chưa có Step đã lưu; không gửi thao tác."
          : allVerified ? "Runtime xác nhận các Step đã lưu. Hãy tự kiểm tra kết quả nghiệp vụ trên website."
          : "Đã gửi thao tác; cần kiểm tra website. Chưa xác nhận hoàn tất nghiệp vụ." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(outcome, { status: /variable|Default Pattern|type mismatch|Viewport|Zoom|không thuộc flow/i.test(message) || !contextReady ? "BLOCKED" : "ERROR",
        message, stepId: currentStep?.id, stepName: currentStep?.name, version: currentStep?.version });
      if (currentStep) {
        const entry = outcome.steps?.find(entry => entry.stepId === currentStep!.id);
        if (entry) { entry.status = outcome.status === "BLOCKED" ? "BLOCKED" : "ERROR"; entry.message = message; }
      }
      await screenshot();
    } finally {
      try {
        if (!screenshotAttempted && contextReady && batchId && ["PASS", "ACTION_SENT"].includes(outcome.status))
          await new Promise(resolve => setTimeout(resolve, Math.min(500, runtime.playAllNetwork(batchId!).stepDelayMs)));
        await screenshot();
        for (const entry of outcome.steps ?? []) if (entry.status === "PENDING") {
          entry.status = "SKIPPED"; entry.message = "Không chạy vì lượt test đã dừng trước Step này.";
        }
        if (item.recording) {
          try { if (await recorder.stop()) outcome.recordingPath = `${id}/${runId}/recording.webm`; }
          catch { outcome.recordingError = "Could not finalize Browser recording."; }
        }
        outcome.finishedAt = new Date().toISOString();
        try { await testEvidence.metadata(id, outcome); }
        catch (error) { outcome.evidenceError = `Không lưu được metadata ảnh: ${String(error)}`; }
        // Commit the new reference before pruning; never overwrite the previous image while writing.
        testLab.result(id, outcome);
        try { await testEvidence.prune(id, runId); }
        catch (error) { outcome.evidenceError = [outcome.evidenceError, `Chưa dọn được ảnh cũ: ${String(error)}`].filter(Boolean).join(" "); testLab.result(id, outcome); }
      } finally {
        try { if (batchId) runtime.endPlayAllLog(batchId, !["PASS", "ACTION_SENT", "SKIPPED"].includes(outcome.status)); }
        finally {
          runningTestCaseId = undefined; armedTest = undefined;
          overlays.setPage(contextReady ? "creator" : "test-case");
          publishLayout(); window.webContents.send("creator:case-state", state());
        }
      }
    }
    return state();
  }

  ipcMain.handle("creator:command", async (event, command: Command) => {
    if (!trusted(event)) throw new Error("IPC sender không hợp lệ.");
    if (!command || typeof command !== "object")
      throw new Error("Command không hợp lệ.");
    pointerTrace.record({
      kind: "command",
      type: command.type,
      sender: event.sender.id,
    });
    switch (command.type) {
      case "recordingEvent":
        if (event.sender !== window.webContents) throw new Error("Invalid recording sender.");
        await recorder.receive(command.token, command.event, command.data); return;
      case "testCaseVideo": {
        const result = testLab.get(command.caseId).lastResult;
        if (!result || result.runId !== command.runId) throw new Error("Run is no longer current.");
        return testEvidence.video(command.caseId, result);
      }
      case "testCaseScreenshot": {
        const result = testLab.get(command.caseId).lastResult;
        if (!result || result.runId !== command.runId) throw new Error("Screenshot không thuộc Last Result hiện tại.");
        return testEvidence.read(command.caseId, result);
      }
      case "runTestCase":
        if (event.sender !== window.webContents) throw new Error("Invalid Test Case sender");
        return runTestCase(command.id);
      case "saveTestCase":
        isIdle(); testLab.save(command.id, command.config); return state();
      case "deleteTestCase":
        isIdle();
        if (!command.confirmed) throw new Error("Cần xác nhận xóa Test Case.");
        testLab.delete(command.id);
        await testEvidence.prune(command.id, undefined, true).catch(error => logMainError(runDir, "case-evidence-cleanup", error, { caseId: command.id }));
        return state();
      case "moveTestCase":
        isIdle(); testLab.move(command.id, command.groupId); return state();
      case "testGroup":
        isIdle();
        if (command.operation === "delete" && command.confirmed !== true) throw new Error("Cần xác nhận xóa Test Group.");
        testLab.group(command.operation, command.id, command.name, command.collapsed); return state();
      case "collapseUngroupedCases":
        isIdle(); testLab.collapse(command.collapsed); return state();
      case "deleteScenario":
        isIdle();
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi xóa Scenario.");
        if (command.confirmed !== true) throw new Error("Cần xác nhận xóa Scenario.");
        store.deleteFlow(command.id); armedTest = undefined; return state();
      case "createScenarioGroup":
        isIdle();
        scenarioGroups.create(command.name);
        return state();
      case "updateScenarioGroup":
        isIdle();
        scenarioGroups.update(command.id, command);
        return state();
      case "deleteScenarioGroup":
        isIdle();
        if (command.confirmed !== true) throw new Error("Cần xác nhận xóa Scenario Group.");
        scenarioGroups.delete(command.id);
        return state();
      case "moveScenarioToGroup":
        isIdle();
        scenarioGroups.move(command.flowId, command.groupId);
        return state();
      case "collapseUngroupedScenarios":
        isIdle();
        scenarioGroups.collapseUngrouped(command.collapsed);
        return state();
      case "activateWorkspace": {
        isIdle();
        if (event.sender !== window.webContents) throw new Error("Invalid workspace sender");
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi chuyển tab.");
        if (!browser.visible) throw new Error("Thoát crop/ảnh trước khi chuyển tab.");
        const flow = store.flows().find(f => f.id === command.flowId);
        if (!flow) throw new Error("Không tìm thấy Scenario.");
        if (typeof command.editorExpanded !== "boolean") throw new Error("Invalid editor state");
        if (command.sessionId) browserSessions.get(command.sessionId);
        if (command.url && command.url !== "about:blank" && !["http:", "https:"].includes(new URL(command.url).protocol))
          throw new Error("URL tab không hợp lệ.");
        switchingWorkspace = true;
        armedTest = undefined;
        try {
          if (command.sessionId && command.sessionId !== activeSessionId)
            await switchBrowserSession(command.sessionId, true);
          if (command.url && command.url !== browser.view.webContents.getURL()) {
            try {
              if (command.url === "about:blank") await browser.view.webContents.loadURL(command.url);
              else await browser.navigate(command.url);
            } catch (error) {
              sessionError = "Đã chuyển tab nhưng trang chưa tải được. Bạn có thể nhập URL khác.";
              logMainError(runDir, "workspace-navigation", error, { flowId: flow.id });
            }
          }
          store.setSetting("currentFlow", flow.id);
          browser.setZoom(flow.zoom);
          overlays.setExpanded("editor", command.editorExpanded);
          overlays.setPage("creator");
          window.webContents.focus();
          publishLayout();
          return state();
        } finally { switchingWorkspace = false; }
      }
      case "createBrowserSession":
        isIdle();
        browserSessions.create(command.name);
        publishSessions();
        return state();
      case "renameBrowserSession":
        isIdle();
        browserSessions.rename(command.id, command.name);
        publishSessions();
        return state();
      case "deleteBrowserSession":
        isIdle();
        if (testLab.read().cases.some(c => c.sessionId === command.id))
          throw new Error("Test Case đang dùng Session này. Hãy đổi Session hoặc xóa Case trước.");
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi xóa Session.");
        if (command.confirmed !== true) throw new Error("Cần xác nhận xóa Session.");
        browserSessions.delete(command.id, activeSessionId);
        publishSessions();
        return state();
      case "removeSessionDomain":
        isIdle();
        browserSessions.removeDomain(command.id, command.domain);
        publishSessions();
        return state();
      case "switchBrowserSession":
        return switchBrowserSession(command.id);
      case "appPage":
        isIdle();
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi chuyển màn hình.");
        if (event.sender !== window.webContents || !["scenarios", "creator", "browser-sessions", "test-lab", "settings", "test-case"].includes(command.page))
          throw new Error("Invalid app page");
        overlays.setPage(command.page);
        if (command.page !== "creator") armedTest = undefined;
        window.webContents.focus();
        publishLayout();
        return state();
      case "appSidebar":
        isIdle();
        if (event.sender !== window.webContents || typeof command.collapsed !== "boolean") throw new Error("Invalid sidebar setting");
        store.setSetting("appSidebarCollapsed", String(command.collapsed));
        overlays.setSidebarCollapsed(command.collapsed);
        publishLayout();
        return state();
      case "setNetworkSettings":
        store.setNetworkSettings(command.settings);
        return state();
      case "pointerReport":
        return pointerTrace.report();
      case "confirmWindowClose":
        if (event.sender !== window.webContents) throw new Error("Invalid close sender");
        isIdle();
        closeApproved = true;
        setImmediate(() => window.close());
        return;
      case "focusFlow":
        window.webContents.focus();
        window.webContents.send("creator:focus-flow");
        return;
      case "panel":
        if (
          !["editor", "debug"].includes(command.panel) ||
          typeof command.expanded !== "boolean"
        )
          throw new Error("Invalid panel");
        isIdle();
        if (!browser.visible && command.panel === "editor")
          throw new Error("Thoát crop/ảnh trước khi đổi viewport.");
        overlays.setExpanded(command.panel, command.expanded);
        publishDraft(
          command.panel === "editor" ? "editorExpanded" : "debugExpanded",
          command.expanded,
        );
        if (pointerTrace.enabled)
          pointerTrace.record({ kind: "layout", ...pointerTrace.snapshot() });
        publishLayout();
        if (
          !command.expanded &&
          event.sender.isFocused() &&
          (command.panel === "editor" || event.sender !== window.webContents)
        )
          browser.view.webContents.focus();
        return state();
      case "workspaceScroll":
        if (
          closing ||
          window.isDestroyed() ||
          browser.view.webContents.isDestroyed()
        )
          return;
        if (
          event.sender !== window.webContents ||
          !Number.isFinite(command.left) ||
          !Number.isFinite(command.top) ||
          command.left < 0 ||
          command.top < 0
        )
          throw new Error("Invalid workspace scroll");
        overlays.scroll = {
          left: Math.round(command.left),
          top: Math.round(command.top),
        };
        overlays.layout();
        publishLayout();
        return;
      case "state":
        return state();
      case "toggleFullscreen":
        window.setFullScreen(!window.isFullScreen());
        return;
      case "copyUrl": {
        const url = browser.view.webContents.getURL();
        await clipboard.writeText(url);
        return url;
      }
      case "navigate":
        isIdle();
        await browser.navigate(command.url);
        return state();
      case "fixture":
        isIdle();
        await browser.navigate(fixture.url);
        return state();
      case "environment": {
        isIdle();
        if (store.flow()?.steps.length)
          throw new Error("Flow đã có target/step: tạo flow mới để đổi zoom.");
        browser.setZoom(validateZoom(command.zoom));
        store.setSetting("zoom", String(command.zoom));
        const f = store.flow();
        if (f) {
          f.zoom = command.zoom;
          store.saveFlow(f);
        }
        return state();
      }
      case "newFlow":
        isIdle();
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi tạo Scenario.");
        armedTest = undefined;
        store.newFlow(command.name, browser.zoom);
        return state();
      case "openFlow": {
        isIdle();
        if (uiPlayAllRunId) throw new Error("Đợi Play All kết thúc trước khi chuyển Scenario.");
        const f = store.flows().find((f) => f.id === command.id);
        if (!f) throw new Error("Không tìm thấy flow.");
        armedTest = undefined;
        store.setSetting("currentFlow", f.id);
        browser.setZoom(f.zoom);
        return state();
      }
      case "targetImage": {
        if (!/^[a-f0-9-]+\.png$/.test(command.asset))
          throw new Error("Asset không hợp lệ.");
        return `data:image/png;base64,${(await readFile(path.join(assetDir, command.asset))).toString("base64")}`;
      }
      case "ocrTarget": {
        isIdle();
        if (!/^[a-f0-9-]+\.png$/.test(command.asset))
          throw new Error("Asset không hợp lệ.");
        try {
          return await localOcr.recognize(await readFile(path.join(assetDir, command.asset)));
        } catch (error) {
          logMainError(runDir, "ocrTarget", error, { asset: command.asset });
          throw error;
        }
      }
      case "capture": {
        isIdle();
        const image = await browser.capture();
        captures.set(image.id, {
          width: image.width,
          height: image.height,
          zoom: image.zoom,
        });
        if (captures.size > 12) captures.delete(captures.keys().next().value!);
        return { ...image, bounds: { ...browser.bounds } };
      }
      case "pickUploadFiles": {
        isIdle();
        const picked = await dialog.showOpenDialog(window, {
          title: "Chọn ảnh cho UPLOAD_FILE",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Ảnh", extensions: IMAGE_EXTENSIONS }],
        });
        return picked.canceled
          ? undefined
          : inspectUploadFiles(picked.filePaths);
      }
      case "crop": {
        isIdle();
        const environment = captures.get(command.captureId);
        if (!environment) throw new Error("Ảnh đã hết hạn; chụp lại.");
        const roi = validateRect(
          command.roi,
          environment.width,
          environment.height,
        );
        const source = browser.captureBuffer(command.captureId);
        const asset = `${randomUUID()}.png`;
        const cropped = await sharp(source)
          .extract({
            left: roi.x,
            top: roi.y,
            width: roi.width,
            height: roi.height,
          })
          .png()
          .toBuffer();
        await writeFile(path.join(assetDir, asset), cropped);
        return {
          asset,
          roi,
          environment,
          dataUrl: `data:image/png;base64,${cropped.toString("base64")}`,
        };
      }
      case "variables":
        isIdle();
        store.updateVariables(command.variables, command.values);
        return state();
      case "organize":
        isIdle();
        store.organize(command.groups, command.stepIds);
        return state();
      case "saveStep":
        isIdle();
        store.saveStep(command.name, command.payload, command.id);
        return state();
      case "selectVersion":
        isIdle();
        store.selectVersion(command.id, command.version);
        return state();
      case "saveOverride":
        isIdle();
        store.saveOverride(
          command.stepId,
          command.version,
          command.name,
          command.segment,
        );
        return state();
      case "reviewTest":
        isIdle();
        return runtime.review(
          command.runId,
          command.verdict,
          command.previewConfirmed,
        );
      case "closeUiOverlay":
        if (event.sender !== window.webContents || typeof command.name !== "string") throw new Error("Invalid UI layer sender");
        closeUiLayer(command.name);
        window.webContents.focus();
        return;
      case "playAllSkipped": {
        isIdle();
        const step = store.step(command.stepId, command.version);
        if (!store.flow()?.steps.some(ref => ref.id === step.id) || !uiPlayAllRunId || command.batchRunId !== uiPlayAllRunId)
          throw new Error("Step bị skip không thuộc flow/lượt Play All.");
        const runId = randomUUID();
        const matchTo = effectiveMatchTo(step.payload);
        const label = `Step ${step.id} | v${step.version} | Match To ${matchToLabel(matchTo)}`;
        logTestBoundary(runDir, "START", { runId, batchRunId: command.batchRunId, label });
        logMainEvent(runDir, "play-all-step-skipped", { runId, batchRunId: command.batchRunId,
          stepId: step.id, version: step.version, status: "SKIPPED", reason: "UI_MEMORY_BLOCK", matchTo });
        logTestBoundary(runDir, "END", { runId, batchRunId: command.batchRunId, label, status: "SKIPPED", ocrPasses: 0, scrolls: 0 });
        return;
      }
      case "playAllTransition": {
        isIdle();
        if (!uiPlayAllRunId || command.batchRunId !== uiPlayAllRunId)
          throw new Error("Play All log runId không khớp.");
        await delayBetweenSteps(command.batchRunId,
          store.step(command.previousStepId, command.previousVersion), store.step(command.nextStepId, command.nextVersion));
        return;
      }
      case "startPlayAllLog":
        isIdle();
        uiPlayAllRunId = runtime.startPlayAllLog();
        return uiPlayAllRunId;
      case "endPlayAllLog":
        runtime.endPlayAllLog(command.runId, command.failed);
        if (uiPlayAllRunId === command.runId) uiPlayAllRunId = undefined;
        return;
      case "test":
        try {
          isIdle();
          return await runtime.test(command.stepId, command.version, command.overrideId, command.batchRunId);
        } catch (error) {
          logMainError(runDir, "test", error, { stepId: command.stepId, version: command.version });
          throw error;
        }
      case "testPair":
        try {
          isIdle();
          return await runtime.testPair(command.firstId, command.secondId, command.delayMs);
        } catch (error) {
          logMainError(runDir, "testPair", error, { firstId: command.firstId, secondId: command.secondId });
          throw error;
        }
      case "disarmTest":
        armedTest = undefined;
        return;
      case "armTest":
        if (runningTestCaseId || switchingWorkspace || !store.flow()?.steps.some(step => step.id === command.stepId)) {
          armedTest = undefined;
          return;
        }
        store.step(command.stepId, command.version);
        armedTest = {
          stepId: command.stepId,
          version: command.version,
          overrideId: command.overrideId,
        };
        return;
      case "browserVisible":
        isIdle();
        if (command.visible) overlays.layout();
        browser.setVisible(command.visible);
        overlays.setVisible(command.visible);
        if (pointerTrace.enabled)
          pointerTrace.record({
            kind: "visibility",
            ...pointerTrace.snapshot(),
          });
        return state();
      default:
        throw new Error("Command không hỗ trợ.");
    }
  });
  // Browser shortcut does not transfer focus to the editor. TYPE_ONLY can therefore
  // prove keyboard behavior with the same current focus as manual browsing.
  browser.onViewCreated(wc => {
    let pendingShortcut = false;
    wc.on("before-input-event", (event, input) => {
      if (runningTestCaseId || switchingWorkspace || switchingSession || uiPlayAllRunId || overlays.page !== "creator") return;
      if (
        input.type === "keyDown" &&
        input.control &&
        input.shift &&
        input.key.toLowerCase() === "t"
      ) {
        event.preventDefault();
        pendingShortcut = true;
      }
      // Do not inject text while the user still holds Ctrl/Shift from the shortcut.
      const controlHeld = input.control && input.key !== "Control";
      const shiftHeld = input.shift && input.key !== "Shift";
      if (
        pendingShortcut &&
        input.type === "keyUp" &&
        !controlHeld &&
        !shiftHeld
      ) {
        pendingShortcut = false;
        if (selfTest)
          console.log(
            "SHORTCUT_MAIN",
            input.key,
            input.control,
            input.shift,
            browser.view.webContents.isFocused(),
            !!armedTest,
          );
        if (armedTest) {
          const test = armedTest;
          setImmediate(() => {
            if (runningTestCaseId || switchingWorkspace || switchingSession || uiPlayAllRunId || test !== armedTest || wc !== browser.view.webContents || overlays.page !== "creator") return;
            void runtime
              .test(test.stepId, test.version, test.overrideId)
              .then((result) =>
                window.webContents.send("creator:shortcut-result", result),
              )
              .catch((e) => {
                logMainError(runDir, "shortcut-test", e, { stepId: test.stepId, version: test.version });
                window.webContents.send("creator:shortcut-result", {
                  error: String(e.message || e),
                });
              });
          });
        }
      }
    });
  });
  let closing = false;
  let closeApproved = selfTest;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    if (!closeApproved && !window.webContents.isDestroyed()) {
      window.webContents.send("creator:request-close");
      return;
    }
    closing = true;
    for (const name of [...uiLayers.keys()]) closeUiLayer(name);
    void browser
      .flush()
      .catch(console.error)
      .finally(() => {
        overlays?.close();
        browser.close();
        fixture.close();
        store.close();
        void localOcr.close().finally(() => {
          window.destroy();
          app.quit();
        });
      });
  });
  const publishUrl = () => {
    if (!window.webContents.isDestroyed())
      window.webContents.send(
        "creator:navigation",
        browser.view.webContents.getURL(),
      );
  };
  browser.onViewCreated(wc => {
    let pendingSuccess = false;
    let successfulDocument = false;
    const current = () => !closing && wc === browser.view.webContents;
    const record = (url: string) => {
      if (!current()) return;
      try {
        browserSessions.recordVisit(activeSessionId, url);
        sessionError = undefined;
        publishSessions();
      } catch (error) { logMainError(runDir, "session-metadata", error, { sessionId: activeSessionId }); }
    };
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        pendingSuccess = false; successfulDocument = false;
      }
    });
    wc.on("did-navigate", (_event, _url, status) => {
      pendingSuccess = status >= 200 && status < 400;
      if (current()) publishUrl();
    });
    wc.on("did-fail-load", (_event, _code, _description, _url, mainFrame) => {
      if (mainFrame) { pendingSuccess = false; successfulDocument = false; }
    });
    wc.on("did-finish-load", () => {
      if (!current()) return;
      if (pendingSuccess) { successfulDocument = true; pendingSuccess = false; record(wc.getURL()); }
      publishUrl();
    });
    wc.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (!mainFrame || !current()) return;
      if (successfulDocument) record(url);
      publishUrl();
    });
  });
  await window.loadFile(path.join(root, "renderer/index.html"));
  await overlays.load(path.join(root, "renderer/index.html"));
  window.show();
  // Load the web page after its host is shown so Chromium has a live compositor.
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.show();
  const initialSession = browserSessions.get(activeSessionId);
  try {
    if (selfTest || initialSession.lastUrl || initialSession.isDefault)
      await browser.navigate(selfTest ? fixture.url : initialSession.lastUrl || fixture.url);
    else await browser.view.webContents.loadURL("about:blank");
  } catch (error) {
    sessionError = "Chưa tải được URL đã lưu. Bạn có thể nhập URL khác trong Creator.";
    logMainError(runDir, "session-startup-navigation", error, { sessionId: activeSessionId });
    publishSessions();
  }
  window.show();
  if (selfTest) {
    try {
      const { runSelfTest } = await import(
        phase === "playback-ui"
          ? "./playback-ui-self-test.js"
          : ["creator-ui", "creator-native"].includes(phase)
            ? "./creator-ui-self-test.js"
            : phase === "address"
              ? "./address-self-test.js"
              : phase === "upload"
                ? "./upload-self-test.js"
                : phase === "typing"
                  ? "./typing-self-test.js"
                  : phase === "ocr"
                    ? "./ocr-self-test.js"
                    : phase === "ux"
                      ? "./ux-self-test.js"
                      : "./self-test.js"
      );
      await runSelfTest({
        overlays,
        browser,
        store,
        runtime,
        assetDir,
        project,
        phase,
        window,
      });
      await browser.flush();
      window.close();
    } catch (e) {
      console.error(e);
      await writeFile(
        path.join(project, "artifacts", `failure-${phase}.txt`),
        String((e as Error).stack || e),
      );
      app.exit(1);
    }
  }
}
