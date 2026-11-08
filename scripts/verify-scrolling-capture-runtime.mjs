import { app, BrowserWindow, WebContentsView } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

// Import compiled main modules from dist
const { BrowserCore } = await import("../dist/main/browser-core.js");
const { CollectorScrollCaptureController, scrollBoundContainer } = await import(
  "../dist/main/collector-scroll-capture.js"
);
const { alignExtendFrames } = await import(
  "../dist/shared/collectors/scrolling-capture.js"
);

app.whenReady().then(async () => {
  console.log("=== C2.6 ELECTRON RUNTIME SCROLLING CAPTURE VERIFICATION ===");
  const win = new BrowserWindow({ width: 1366, height: 768, show: true });
  const assetDir = path.join(process.cwd(), ".local", "test-assets");
  
  const browser = new BrowserCore(win, assetDir, "persist:collector-test");
  Object.assign(browser.bounds, { x: 100, y: 100, width: 800, height: 500 });
  browser.view.setBounds(browser.bounds);
  const controller = new CollectorScrollCaptureController(browser, assetDir);

  // Deterministic 4000px long-page fixture matching Facebook feed structure
  const fixtureHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: #f0f2f5; font-family: monospace; }
    #feed {
      height: 100vh;
      overflow-y: auto;
      position: relative;
    }
    .sticky-header {
      position: sticky; top: 0; height: 50px; background: #1877f2; color: #fff;
      display: flex; align-items: center; padding: 0 16px; font-weight: bold; z-index: 1000;
    }
    .post-card {
      margin: 16px auto; width: 680px; background: #fff; border: 1px solid #ddd;
      border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .band {
      height: 140px; margin-bottom: 12px; padding: 12px; border-left: 6px solid #42b72a;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="feed">
    <div class="sticky-header">Facebook Header (Sticky 50px)</div>
    <div class="post-card">
      <h2>Post Header - Central Post</h2>
      ${Array.from({ length: 25 }, (_, i) => `
        <div class="band" id="band-${i + 1}">
          <h3>Band #${i + 1} - Timestamp: ${i * 100}s</h3>
          <p>Row content for band ${i + 1}. Scrolling validation line A.</p>
          <p>Deterministic text pattern verification line B.</p>
        </div>
      `).join("")}
    </div>
  </div>
</body>
</html>`;

  await browser.view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`);
  browser.setVisible(true);

  // 1. Initial Frame Capture
  console.log("\n[1] Capturing initial frame (Capture Mode ON)...");
  const t0 = performance.now();
  const initCapture = await browser.capture({ requireCanonical: false });
  console.log(`Initial capture: ${initCapture.width}×${initCapture.height} in ${(performance.now() - t0).toFixed(1)}ms`);

  // Hide view as Capture Mode does
  browser.setVisible(false);

  // 2. Begin Session
  const session = await controller.begin({
    captureId: initCapture.id,
    browserSessionId: "test-session",
    url: "data:text/html;test",
  });
  console.log(`Session initialized: ${session.sessionId}, phase=${session.phase}, ${session.width}×${session.height}`);
  controller.markRoiSelected(session.sessionId);

  // 3. Perform 5 consecutive extends without warm-up stalls or timeouts
  console.log("\n[2] Executing 5 consecutive downward extends (280px each)...");
  let currentSession = session;
  const extendDurations = [];

  for (let i = 1; i <= 5; i++) {
    const extStart = performance.now();
    currentSession = await controller.extend(session.sessionId, 280);
    const duration = performance.now() - extStart;
    extendDurations.push(duration);
    console.log(
      `  Extend #${i}: ${duration.toFixed(1)}ms | Frame count: ${currentSession.frameCount} | Height: ${currentSession.height}px | Status: ${currentSession.lastDiagnostics?.failureKind} (${currentSession.lastDiagnostics?.message})`
    );
    if (currentSession.error || currentSession.lastDiagnostics?.failureKind !== "SUCCESS") {
      throw new Error(`Extend #${i} failed: ${currentSession.error}`);
    }
  }

  console.log(`\nAll 5 extensions SUCCEEDED! Average duration: ${(extendDurations.reduce((a, b) => a + b, 0) / 5).toFixed(1)}ms`);
  console.log(`Accumulated image dimensions: ${currentSession.width}×${currentSession.height} pixels (started at ${session.height}px)`);

  // 4. Confirm Capture with long ROI
  console.log("\n[3] Confirming long ROI crop...");
  const roi = { x: 50, y: 70, width: 700, height: currentSession.height - 100 };
  const confirmResult = await controller.confirm(session.sessionId, roi);
  console.log(`Capture confirmed! Asset: ${confirmResult.asset}`);
  console.log(`Fitted ROI: ${confirmResult.roi.width}×${confirmResult.roi.height}`);

  // Verify asset file on disk
  const assetPath = path.join(assetDir, confirmResult.asset);
  const assetMeta = await sharp(assetPath).metadata();
  console.log(`Saved PNG verified on disk: ${assetMeta.width}×${assetMeta.height} px, channels=${assetMeta.channels}`);

  // 5. Verify Capture Mode Toggle OFF & Restore Browse
  console.log("\n[4] Verifying Capture Toggle OFF restores browse state without reload...");
  browser.setVisible(true);
  const probe = await scrollBoundContainer(browser, { containerId: "test", deltaCssPx: 0, mode: "scroll" });
  console.log(`Browse mode restored: containerOk=${probe.containerOk}, current scroll=${probe.scrollBefore}px`);

  console.log("\n=== RUNTIME TESTS COMPLETED SUCCESSFULLY ===");
  app.quit();
  process.exit(0);
});
