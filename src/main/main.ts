import {
  app,
  BrowserWindow,
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
import { Store } from "./storage.js";
import { logMainError } from "./main-error-log.js";
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
import { DRAFT_KEYS } from "../shared/contracts.js";
import type { Command, State } from "../shared/contracts.js";

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
    title: "RPA Creator V2 · POC",
    webPreferences: {
      preload: path.join(root, "preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const browser = new BrowserCore(
    window,
    evidenceDir,
    "persist:creator-default",
  );
  const overlays = new CreatorOverlays(
    window,
    path.join(root, "preload/index.cjs"),
    browser,
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
  browser.view.webContents.on("before-input-event", windowKeys);
  browser.view.webContents.on("devtools-opened", () => {
    // Detached DevTools receives F12 while its own window has focus.
    browser.view.webContents.devToolsWebContents?.on("before-input-event", (event, input) => {
      if (creatorDevtools && input.type === "keyDown" && input.key === "F12" &&
          !input.control && !input.shift && !input.alt && !input.meta) {
        event.preventDefault();
        if (!input.isAutoRepeat) browser.view.webContents.closeDevTools();
      }
    });
  });
  browser.setZoom(store.flow()?.zoom ?? Number(store.setting("zoom") || 1));
  const marker = new ClickMarker(window, browser);
  const runtime = new Runtime(browser, store, assetDir, runDir, undefined,
    (x, y) => marker.show(x, y));
  let armedTest:
    { stepId: string; version: number; overrideId?: string } | undefined;
  const state = (): State => ({
    flow: store.flow(),
    flows: store.flows(),
    steps: store.steps(),
    overrides: store.overrides(),
    url: browser.view.webContents.getURL(),
    zoom: browser.zoom,
    browserBounds: browser.bounds,
    focused: browser.view.webContents.isFocused(),
    visible: browser.visible,
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
    if (runtime.busy) throw new Error("Đang test; đợi tác vụ kết thúc.");
  };
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
      case "pointerReport":
        return pointerTrace.report();
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
        armedTest = undefined;
        store.newFlow(command.name, browser.zoom);
        return state();
      case "openFlow": {
        isIdle();
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
      case "test":
        try {
          return await runtime.test(command.stepId, command.version, command.overrideId);
        } catch (error) {
          logMainError(runDir, "test", error, { stepId: command.stepId, version: command.version });
          throw error;
        }
      case "testPair":
        try {
          return await runtime.testPair(command.firstId, command.secondId, command.delayMs);
        } catch (error) {
          logMainError(runDir, "testPair", error, { firstId: command.firstId, secondId: command.secondId });
          throw error;
        }
      case "disarmTest":
        armedTest = undefined;
        return;
      case "armTest":
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
  let pendingShortcut = false;
  browser.view.webContents.on("before-input-event", (event, input) => {
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
  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
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
  browser.view.webContents.on("did-navigate", publishUrl);
  browser.view.webContents.on(
    "did-navigate-in-page",
    (_event, _url, isMainFrame) => {
      if (isMainFrame) publishUrl();
    },
  );
  await window.loadFile(path.join(root, "renderer/index.html"));
  await overlays.load(path.join(root, "renderer/index.html"));
  window.show();
  // Load the web page after its host is shown so Chromium has a live compositor.
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.show();
  await browser.navigate(
    selfTest ? fixture.url : store.setting("lastUrl") || fixture.url,
  );
  browser.view.webContents.on("did-navigate", (_event, url) =>
    store.setSetting("lastUrl", url),
  );
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
