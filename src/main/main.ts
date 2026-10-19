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
import { CreatorOverlays } from "./creator-overlays.js";
import { BrowserCore } from "./browser-core.js";
import { Store } from "./storage.js";
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
  if (
    !selfTest &&
    (area.width < required.width + 16 || area.height < required.height + 40)
  )
    throw new Error(
      `Màn hình cần work area tối thiểu ${required.width + 16} × ${required.height + 40} DIP. Hiện tại ${area.width} × ${area.height}. Không thu nhỏ viewport.`,
    );
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
    width: required.width,
    height: required.height,
    resizable: false,
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
  // On Windows, construction with resizable:false clears the maximize style.
  // Re-enable the independent window-mode capabilities after initialization.
  window.setMaximizable(true);
  window.setFullScreenable(true);
  // resizable:false also installs a maximum equal to the initial size on
  // Windows. Clear that size cap so native maximize/fullscreen can fill the
  // display; the independent resizable flag still blocks dragging the edges.
  window.setMaximumSize(0, 0);
  if (
    window.getContentSize()[0] !== required.width ||
    window.getContentSize()[1] !== required.height
  )
    throw new Error(
      "Windows đã giới hạn kích thước cửa sổ. Màn hình không đủ cho viewport cố định.",
    );
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
  // Only the outer window changes size. Keep the web viewport and screenshot
  // origin identical in normal, maximized and fullscreen modes.
  window.on("resize", () => browser.view.setBounds(browser.bounds));
  const windowKeys = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (
      input.key === "Escape" &&
      browser.visible &&
      window.isFullScreen()
    ) {
      event.preventDefault();
      window.setFullScreen(false);
    }
  };
  for (const editor of editors) editor.on("before-input-event", windowKeys);
  browser.view.webContents.on("before-input-event", windowKeys);
  browser.setZoom(store.flow()?.zoom ?? Number(store.setting("zoom") || 1));
  const runtime = new Runtime(browser, store, assetDir, runDir);
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
  const isIdle = () => {
    if (runtime.busy) throw new Error("Đang test; đợi tác vụ kết thúc.");
  };
  ipcMain.handle("creator:command", async (event, command: Command) => {
    if (!trusted(event)) throw new Error("IPC sender không hợp lệ.");
    if (!command || typeof command !== "object")
      throw new Error("Command không hợp lệ.");
    switch (command.type) {
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
        overlays.setExpanded(command.panel, command.expanded);
        if (
          !command.expanded &&
          event.sender.isFocused() &&
          event.sender !== window.webContents
        )
          browser.view.webContents.focus();
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
        return localOcr.recognize(
          await readFile(path.join(assetDir, command.asset)),
        );
      }
      case "capture":
        isIdle();
        return browser.capture();
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
        const roi = validateRect(command.roi, WEB_WIDTH, WEB_HEIGHT);
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
          dataUrl: `data:image/png;base64,${cropped.toString("base64")}`,
        };
      }
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
        return runtime.test(
          command.stepId,
          command.version,
          command.overrideId,
        );
      case "testPair":
        return runtime.testPair(
          command.firstId,
          command.secondId,
          command.delayMs,
        );
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
        browser.setVisible(command.visible);
        overlays.setVisible(command.visible);
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
            .catch((e) =>
              window.webContents.send("creator:shortcut-result", {
                error: String(e.message || e),
              }),
            );
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
        ["creator-ui", "creator-native"].includes(phase)
          ? "./creator-ui-self-test.js"
          : phase === "overlay"
            ? "./overlay-self-test.js"
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
