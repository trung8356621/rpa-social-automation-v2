import { app, BrowserWindow, WebContentsView, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const artifactDir = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\804a328e-3e91-4435-9fa6-b5efe245ecb5";
const localArtifacts = path.resolve("artifacts");

const mockState = {
  appPage: "scenarios",
  sidebarCollapsed: false,
  networkSettings: {
    mode: "normal",
    presets: {
      fast: { stepDelayMs: 500, sleepDelayMs: 1000 },
      normal: { stepDelayMs: 1000, sleepDelayMs: 2000 },
      slow: { stepDelayMs: 2000, sleepDelayMs: 4000 },
      "very-slow": { stepDelayMs: 4000, sleepDelayMs: 8000 },
    }
  },
  flows: [
    {
      id: "flow-post-v1",
      name: "Group Post v1",
      zoom: 1,
      actionTagKey: "facebook.group.post",
      steps: [{ id: "s1", version: 1 }, { id: "s2", version: 1 }, { id: "s3", version: 1 }],
      variables: [
        { id: "var-1", key: "post_message", type: "text" },
        { id: "var-2", key: "tag_count", type: "integer" },
        { id: "var-3", key: "photo_files", type: "files" }
      ],
      defaultPattern: {
        values: {
          "var-1": "Nội dung bài viết chiến dịch SEO chính thức",
          "var-2": 5,
          "var-3": ["D:\\photos\\banner1.jpg", "D:\\photos\\banner2.jpg"]
        }
      },
      placeholders: {
        "var-1": "[TEST] Thử nghiệm bài đăng nhóm tự động",
        "var-2": 2,
        "var-3": ["D:\\test\\sample.png"]
      }
    },
    {
      id: "flow-post-v2",
      name: "Group Post v2",
      zoom: 1,
      actionTagKey: "facebook.group.post",
      steps: [{ id: "s1", version: 1 }, { id: "s2", version: 1 }],
      variables: [],
      defaultPattern: { values: {} },
      placeholders: {}
    },
    {
      id: "flow-post-v3",
      name: "Group Post v3",
      zoom: 1,
      actionTagKey: "facebook.group.post",
      steps: [{ id: "s1", version: 1 }],
      variables: [],
      defaultPattern: { values: {} },
      placeholders: {}
    },
    {
      id: "flow-comment-v1",
      name: "Group Comment v1",
      zoom: 1,
      actionTagKey: "facebook.group.comment",
      steps: [{ id: "s1", version: 1 }, { id: "s2", version: 1 }],
      variables: [],
      defaultPattern: { values: {} },
      placeholders: {}
    },
    {
      id: "flow-comment-v2",
      name: "Group Comment v2",
      zoom: 1,
      actionTagKey: "facebook.group.comment",
      steps: [{ id: "s1", version: 1 }],
      variables: [],
      defaultPattern: { values: {} },
      placeholders: {}
    }
  ],
  actionTags: [
    { id: 1, tag_key: "facebook.group.post", name: "Đăng bài nhóm Facebook", platform: "facebook", target: "group", action: "post" },
    { id: 2, tag_key: "facebook.group.comment", name: "Bình luận nhóm Facebook", platform: "facebook", target: "group", action: "comment" }
  ],
  activeScriptsByTag: {
    "facebook.group.post": "flow-post-v1",
    "facebook.group.comment": "flow-comment-v1"
  },
  scenarioDemos: {
    "flow-post-v1": { flowId: "flow-post-v1", runId: "r1", status: "ready" },
    "flow-comment-v1": { flowId: "flow-comment-v1", runId: "r2", status: "ready" }
  },
  testLab: {
    groups: [
      { id: "g1", name: "Regression Suite", collapsed: false }
    ],
    cases: [
      {
        id: "case-1",
        name: "Test Group Post v1 - Standard",
        groupId: "g1",
        flowId: "flow-post-v1",
        sessionId: "sess-1",
        startUrl: "https://facebook.com/groups/test",
        values: { "var-1": "[TEST] Thử nghiệm bài đăng nhóm tự động", "var-2": 2 },
        stepVersions: [{ id: "s1", version: 1 }],
        lastResult: {
          status: "PASS",
          startedAt: new Date(Date.now() - 3600000).toISOString(),
          finishedAt: new Date(Date.now() - 3590000).toISOString(),
          message: "All 3 steps completed and verified."
        }
      },
      {
        id: "case-2",
        name: "Test Group Comment v1",
        groupId: "g1",
        flowId: "flow-comment-v1",
        sessionId: "sess-1",
        startUrl: "https://facebook.com/groups/test",
        values: {},
        stepVersions: [{ id: "s1", version: 1 }],
        lastResult: {
          status: "PASS",
          startedAt: new Date(Date.now() - 1800000).toISOString(),
          finishedAt: new Date(Date.now() - 1795000).toISOString(),
          message: "Comment posted."
        }
      }
    ],
    ungroupedCollapsed: false
  },
  browserSessions: [
    { id: "sess-1", name: "Default Session", lastUrl: "https://facebook.com", lastActiveAt: new Date().toISOString() }
  ],
  activeBrowserSessionId: "sess-1",
  steps: [
    { id: "s1", version: 1, payload: { action: "NAVIGATE", url: "https://facebook.com" } },
    { id: "s2", version: 1, payload: { action: "CLICK_TARGET", name: "Composer box" } },
    { id: "s3", version: 1, payload: { action: "TYPE_ONLY", variableId: "var-1" } }
  ],
  flow: null,
  overrides: [],
  invalidSteps: [],
  url: "https://facebook.com",
  zoom: 1,
  browserBounds: { x: 320, y: 0, width: 1040, height: 860 },
  focused: true,
  visible: false,
  dataPath: "D:\\work-app\\new\\.local"
};

mockState.flow = mockState.flows[0];

const drafts = new Map();
const uiLayers = new Map();

ipcMain.on("creator:pointer-enabled", (event) => {
  event.returnValue = false;
});
ipcMain.on("creator:pointer-dom", () => {});

ipcMain.on("creator:draft", (event, request) => {
  if (request.write) {
    const revision = (drafts.get(request.key)?.revision ?? 0) + 1;
    const entry = { revision, value: request.value };
    drafts.set(request.key, entry);
    event.returnValue = entry;
    return;
  }
  const existing = drafts.get(request.key);
  if (existing) {
    event.returnValue = existing;
    return;
  }
  const entry = { revision: 1, value: request.initial };
  drafts.set(request.key, entry);
  event.returnValue = entry;
});

ipcMain.handle("creator:command", async (_event, cmd) => {
  if (cmd.type === "state") return mockState;
  if (cmd.type === "closeUiOverlay") {
    const entry = uiLayers.get(cmd.name);
    if (entry) {
      entry.win.contentView.removeChildView(entry.layer);
      if (!entry.layer.webContents.isDestroyed()) entry.layer.webContents.close();
      uiLayers.delete(cmd.name);
    }
    return mockState;
  }
  if (cmd.type === "appPage") {
    mockState.appPage = cmd.page;
    return mockState;
  }
  if (cmd.type === "activateWorkspace") {
    mockState.appPage = "creator";
    mockState.flow = mockState.flows.find(f => f.id === cmd.flowId) || mockState.flows[0];
    return mockState;
  }
  if (cmd.type === "seoOpsSyncStatus") {
    return {
      rows: [
        { script_id: "flow-post-v1", flow_id: "flow-post-v1", name: "Group Post v1", status: "synced", published_version: "1" },
        { script_id: "flow-post-v2", flow_id: "flow-post-v2", name: "Group Post v2", status: "pending", draft_status: "new" },
        { script_id: "flow-post-v3", flow_id: "flow-post-v3", name: "Group Post v3", status: "missing_demo", draft_status: "new" },
        { script_id: "flow-comment-v1", flow_id: "flow-comment-v1", name: "Group Comment v1", status: "synced", published_version: "1" },
        { script_id: "flow-comment-v2", flow_id: "flow-comment-v2", name: "Group Comment v2", status: "pending", draft_status: "new" },
      ]
    };
  }
  if (cmd.type === "openFlow") {
    mockState.flow = mockState.flows.find(f => f.id === cmd.id) || mockState.flows[0];
    return mockState;
  }
  if (cmd.type === "variables") {
    mockState.flow.variables = cmd.variables;
    mockState.flow.defaultPattern = { values: cmd.values };
    mockState.flow.placeholders = cmd.placeholders || {};
    return mockState;
  }
  if (cmd.type === "validateUploadFiles") {
    return { status: "VALID", validCount: 1, invalidCount: 0, files: [] };
  }
  return mockState;
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true,
    webPreferences: {
      preload: path.resolve("dist/preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== "about:blank" || !/^creator-ui-overlay-[a-f0-9-]+$/.test(frameName)) return { action: "deny" };
    return {
      action: "allow",
      createWindow: (options) => {
        const layer = new WebContentsView(options);
        layer.setBackgroundColor("#00000000");
        const align = () => {
          const [width, height] = win.getContentSize();
          if (!layer.webContents.isDestroyed()) layer.setBounds({ x: 0, y: 0, width, height });
        };
        align();
        win.contentView.addChildView(layer);
        uiLayers.set(frameName, { layer, win });
        return layer.webContents;
      }
    };
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorCode} - ${errorDescription}`);
  });

  await win.loadFile(path.resolve("dist/renderer/index.html"));

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(2000);

  async function saveScreenshot(filename) {
    const winImage = await win.capturePage();
    let buffer = winImage.toPNG();
    if (uiLayers.size > 0) {
      const overlays = [];
      for (const entry of uiLayers.values()) {
        if (!entry.layer.webContents.isDestroyed()) {
          const layerImg = await entry.layer.webContents.capturePage();
          overlays.push({ input: layerImg.toPNG() });
        }
      }
      if (overlays.length > 0) {
        buffer = await sharp(buffer).composite(overlays).png().toBuffer();
      }
    }
    fs.mkdirSync(localArtifacts, { recursive: true });
    fs.writeFileSync(path.join(localArtifacts, filename), buffer);
    if (fs.existsSync(artifactDir)) {
      fs.writeFileSync(path.join(artifactDir, filename), buffer);
    }
    console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
  }

  // 1. Screenshot Scripts List (Tag -> Scripts)
  console.log("Capturing 1: Scripts List...");
  await win.webContents.executeJavaScript(`
    const scriptsSidebar = Array.from(document.querySelectorAll('.sidebar-nav-item')).find(el => el.textContent.includes('Scripts'));
    if (scriptsSidebar) scriptsSidebar.click();
    const scriptsTopTab = Array.from(document.querySelectorAll('.scripts-tab-btn')).find(b => b.textContent.includes('Scripts'));
    if (scriptsTopTab) scriptsTopTab.click();
  `);
  await wait(1200);
  await saveScreenshot("screenshot-1-scripts-list.png");

  // 2. Screenshot Test Lab trong Scripts
  console.log("Capturing 2: Test Lab in Scripts...");
  await win.webContents.executeJavaScript(`
    const testLabBtn = Array.from(document.querySelectorAll('.scripts-tab-btn')).find(b => b.textContent.includes('Test Lab'));
    if (testLabBtn) testLabBtn.click();
  `);
  await wait(1200);
  await saveScreenshot("screenshot-2-test-lab.png");

  // 3. Open Creator for flow 1 and open Variables Drawer - Values Tab
  console.log("Capturing 3: Variables - Values...");
  await win.webContents.executeJavaScript(`
    const scriptsBtn = Array.from(document.querySelectorAll('.scripts-tab-btn')).find(b => b.textContent.includes('Scripts'));
    if (scriptsBtn) scriptsBtn.click();
  `);
  await wait(600);
  const creatorClicked = await win.webContents.executeJavaScript(`
    const openCreatorBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Mở Creator'));
    if (openCreatorBtn) {
      openCreatorBtn.click();
      true;
    } else false;
  `);
  console.log("openCreatorBtn clicked:", creatorClicked);
  await wait(1500);

  // Click "Variables ▾" button to open drawer
  const varInfo = await win.webContents.executeJavaScript(`
    (() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Variables'));
      if (!btn) return { notFound: true, buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent) };
      btn.click();
      return { text: btn.textContent, disabled: btn.disabled, className: btn.className, parent: btn.parentElement?.className };
    })()
  `);
  console.log("varInfo:", varInfo);
  await wait(1000);

  console.log("uiLayers count:", uiLayers.size);
  await saveScreenshot("screenshot-3-variables-values.png");

  // 4. Click "Placeholders" tab in Variables Drawer
  console.log("Capturing 4: Variables - Placeholders...");
  let tabClicked = false;
  for (const [name, entry] of uiLayers.entries()) {
    try {
      const clicked = await entry.layer.webContents.executeJavaScript(`
        (() => {
          const plTab = Array.from(document.querySelectorAll('.variable-tab-btn')).find(b => b.textContent.includes('Placeholders'));
          if (plTab) {
            plTab.click();
            return true;
          }
          return false;
        })()
      `);
      if (clicked) {
        tabClicked = true;
        console.log("Clicked plTab in layer:", name);
        break;
      }
    } catch (e) {
      console.error("Error clicking plTab in layer:", e.message);
    }
  }
  console.log("plTab clicked:", tabClicked);
  await wait(1000);
  await saveScreenshot("screenshot-4-variables-placeholders.png");

  console.log("All 4 screenshots captured successfully!");
  win.close();
  app.quit();
});
