import { desktopCapturer, screen } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserCore } from "./browser-core.js";
import type { CreatorOverlays } from "./creator-overlays.js";
import type { BrowserWindow } from "electron";
export async function runSelfTest({
  browser,
  overlays,
  window,
  project,
}: {
  browser: BrowserCore;
  overlays?: CreatorOverlays;
  window: BrowserWindow;
  project: string;
}) {
  assert.ok(overlays, "Overlay proof must run with native panel views");
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await writeFile(
    path.join(project, "artifacts/browser-overlay.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: "incomplete",
        passedCount: 0,
        pendingCount: 1,
        fixtureOnly: true,
        facebookTested: false,
        reason:
          "Native overlay proof has not completed; do not proceed to UI refactor.",
      },
      null,
      2,
    ),
  );
  const bounds = browser.view.getBounds();
  const wc = browser.view.webContents;
  const zoom = wc.getZoomFactor();
  let navigations = 0;
  wc.on("did-start-navigation", () => navigations++);
  window.show();
  window.focus();
  window.setAlwaysOnTop(true);
  for (const [i, view] of overlays.views.entries()) {
    await view.webContents.loadURL(
      `data:text/html,<body style="margin:0;background:%23172940;color:white"><button onclick="window.hits=(window.hits||0)+1" style="height:36px">${i ? "Test %26 Debug" : "Step Editor"}</button><p>Native overlay proof</p></body>`,
    );
  }
  await new Promise((r) => setTimeout(r, 400));
  const nativeClick = async (x: number, y: number) => {
    const origin = window.getContentBounds();
    await promisify(execFile)("powershell.exe", [
      "-NoProfile",
      "-File",
      path.join(project, "scripts/native-click.ps1"),
      "-X",
      String(
        Math.round(
          (origin.x + x) * screen.getDisplayMatching(origin).scaleFactor,
        ),
      ),
      "-Y",
      String(
        Math.round(
          (origin.y + y) * screen.getDisplayMatching(origin).scaleFactor,
        ),
      ),
    ]);
    await new Promise((r) => setTimeout(r, 150));
  };
  for (const view of overlays.views) {
    const b = view.getBounds();
    await nativeClick(b.x + 40, b.y + 18);
    assert.equal(
      await view.webContents.executeJavaScript("window.hits"),
      1,
      "OS click reaches panel above native browser",
    );
  }
  await nativeClick(bounds.x + 270, bounds.y + 152);
  await new Promise((r) => setTimeout(r, 150));
  const before = await wc.executeJavaScript("window.fixtureRead()");
  assert.ok(before.clicks > 0);
  const focused = wc.isFocused();
  for (let i = 0; i < 4; i++)
    for (const panel of ["editor", "debug"] as const) {
      overlays.toggle(panel);
      assert.deepEqual(browser.view.getBounds(), bounds);
      assert.equal(wc.getZoomFactor(), zoom);
      assert.equal(wc.isFocused(), focused);
    }
  assert.equal(navigations, 0);
  assert.deepEqual(window.contentView.children.slice(-2), overlays.views);
  // BrowserWindow.capturePage captures only the shell webContents. Capture the desktop
  // to inspect actual native sibling composition instead.
  await mkdir(path.join(project, "artifacts"), { recursive: true });
  await new Promise((r) => setTimeout(r, 500));
  const [desktop] = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  assert.ok(
    desktop && !desktop.thumbnail.isEmpty(),
    "Desktop compositor capture unavailable; visual overlay proof incomplete",
  );
  await writeFile(
    path.join(project, "artifacts/overlay-proof.png"),
    desktop.thumbnail.toPNG(),
  );
  const report = {
    timestamp: new Date().toISOString(),
    status: "passed",
    passedCount: 5,
    pendingCount: 0,
    fixtureOnly: true,
    facebookTested: false,
    bounds,
    zoom,
    checks: [
      "native stacking",
      "uncovered browser input",
      "stable viewport",
      "no navigation",
      "toggle preserves browser focus",
    ],
  };
  await writeFile(
    path.join(project, "artifacts/browser-overlay.json"),
    JSON.stringify(report, null, 2),
  );
}
