import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertRoiFitsCapture,
  clientPointToCaptureCoords,
  collectorBrowseRestoreCommands,
  domRectToShellBounds,
  dragToCaptureRoi,
  fitCaptureImageInDisplay,
  nextCollectorCapturePhase,
  normalizeCollectorHost,
  resolveBrowserViewBounds,
  resizeCaptureRoi,
  sameCollectorHost,
  sameRect,
  shellBoundsToCssFixed,
  shouldShowBrowserForPage,
} from "../src/shared/collector-browser-host.js";
import {
  collectorReportBrowserHost,
  resetCollectorBrowserHostReportCache,
} from "../src/renderer/collectors/browser-capture.js";
import { claimCollectorHostOwner } from "../src/renderer/collectors/collector-host-owner.js";
import {
  createRafHostPublishScheduler,
  sameHostClientRect,
} from "../src/renderer/post-detail-collector/publish-browser-host.js";
import { clipHostRectToVisibleArea } from "../src/renderer/collectors/publish-collector-host.js";

test("C2.2 browser visible only for Creator or active Collector Capture host", () => {
  assert.equal(
    shouldShowBrowserForPage({ page: "creator", browserVisible: true, collectorHostActive: false }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "studio-run", browserVisible: true, collectorHostActive: false }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "collectors", browserVisible: true, collectorHostActive: true }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "collectors", browserVisible: true, collectorHostActive: false }),
    false,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "collectors", browserVisible: false, collectorHostActive: true }),
    false,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "visual-match-lab", browserVisible: true, collectorHostActive: true }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "visual-match-lab", browserVisible: true, collectorHostActive: false }),
    false,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "settings", browserVisible: true, collectorHostActive: true }),
    false,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "browser-sessions", browserVisible: true, collectorHostActive: true }),
    false,
  );
});

test("Collector ROI resize locks top-left and clamps right/bottom edges", () => {
  const origin = { x: 72, y: 120, width: 680, height: 267 };
  assert.deepEqual(resizeCaptureRoi(origin, "right", 800, 10, 832, 420), { ...origin, width: 728 });
  assert.deepEqual(resizeCaptureRoi(origin, "bottom", 0, 400, 832, 420), { ...origin, height: 280 });
  assert.deepEqual(resizeCaptureRoi(origin, "corner", 9999, 9999, 832, 420), { x: 72, y: 120, width: 760, height: 300 });
  assert.deepEqual(resizeCaptureRoi(origin, "corner", 0, 0, 832, 420), { x: 72, y: 120, width: 4, height: 4 });
  assert.deepEqual(origin, { x: 72, y: 120, width: 680, height: 267 });
});

test("C2.2 collectors use measured host bounds; Creator keeps workspaceLayout browser", () => {
  const creator = { x: 208, y: 88, width: 1024, height: 560 };
  const host = { x: 240, y: 160, width: 900, height: 480, active: true };
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "creator", collectorHost: host, creatorBrowser: creator }),
    creator,
  );
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "collectors", collectorHost: host, creatorBrowser: creator }),
    { x: 240, y: 160, width: 900, height: 480 },
  );
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "visual-match-lab", collectorHost: host, creatorBrowser: creator }),
    { x: 240, y: 160, width: 900, height: 480 },
  );
  assert.deepEqual(
    resolveBrowserViewBounds({
      page: "collectors",
      collectorHost: { ...host, active: false },
      creatorBrowser: creator,
    }),
    creator,
  );
});

test("C2.2 DOM rect accounts for admin CSS zoom", () => {
  assert.deepEqual(
    domRectToShellBounds({ left: 200, top: 100, width: 800, height: 400 }, 2),
    { x: 100, y: 50, width: 400, height: 200 },
  );
});

test("C2.3 freeze CSS fixed matches shell DIP under admin UI zoom", () => {
  assert.deepEqual(
    shellBoundsToCssFixed({ x: 240, y: 120, width: 1100, height: 500 }, 1),
    { x: 240, y: 120, width: 1100, height: 500 },
  );
  assert.deepEqual(
    shellBoundsToCssFixed({ x: 240, y: 120, width: 1100, height: 500 }, 1.1),
    { x: 264, y: 132, width: 1210, height: 550 },
  );
  assert.deepEqual(
    shellBoundsToCssFixed({ x: 200, y: 100, width: 800, height: 400 }, 0.9),
    { x: 180, y: 90, width: 720, height: 360 },
  );
});

test("C2.3 pointer on freeze maps to capture image coordinates", () => {
  const display = { left: 100, top: 50, width: 1100, height: 500 };
  assert.deepEqual(
    clientPointToCaptureCoords(100, 50, display, 1100, 500),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    clientPointToCaptureCoords(650, 300, display, 1100, 500),
    { x: 550, y: 250 },
  );
  // Display scaled (admin zoom) while image stays capture pixels:
  assert.deepEqual(
    clientPointToCaptureCoords(100 + 550, 50 + 275, { left: 100, top: 50, width: 1100, height: 550 }, 1100, 500),
    { x: 550, y: 250 },
  );
});

test("C2.3 drag ROI rejects tiny selections and fits capture", () => {
  assert.equal(dragToCaptureRoi(10, 10, 12, 12), null);
  assert.deepEqual(dragToCaptureRoi(10, 20, 110, 80), { x: 10, y: 20, width: 100, height: 60 });
  assert.deepEqual(
    assertRoiFitsCapture({ x: 10, y: 20, width: 100, height: 60 }, 1100, 500),
    { x: 10, y: 20, width: 100, height: 60 },
  );
  assert.throws(() => assertRoiFitsCapture({ x: 10, y: 20, width: 2000, height: 60 }, 1100, 500));
});

test("C2.4 browse → freeze → confirm/cancel → browse; leave step clears freeze", () => {
  assert.equal(nextCollectorCapturePhase("browse", "captureRegion"), "frozen");
  assert.equal(nextCollectorCapturePhase("frozen", "confirm"), "browse");
  assert.equal(nextCollectorCapturePhase("frozen", "cancel"), "browse");
  assert.equal(nextCollectorCapturePhase("frozen", "leaveStep"), "browse");
  assert.equal(nextCollectorCapturePhase("browse", "leaveStep"), "browse");
  // Repeated captures in one session:
  let phase = nextCollectorCapturePhase("browse", "captureRegion");
  phase = nextCollectorCapturePhase(phase, "confirm");
  phase = nextCollectorCapturePhase(phase, "captureRegion");
  phase = nextCollectorCapturePhase(phase, "cancel");
  assert.equal(phase, "browse");
});

test("C2.4 confirm/cancel restore browse via visibility only (scroll preserved)", () => {
  const cmds = collectorBrowseRestoreCommands();
  assert.deepEqual(cmds, [{ type: "browserVisible", visible: true }]);
  assert.equal(cmds.some((c) => (c as { type: string }).type === "navigate"), false);
  const adapter = readFileSync(resolve("src/renderer/collectors/browser-capture.ts"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.match(adapter, /collectorFreezeFrame[\s\S]*browserVisible[\s\S]*visible:\s*false/);
  assert.match(capture, /async function restoreBrowse/);
  assert.match(capture, /collectorSetBrowserVisible\(invoke, true\)/);
  assert.match(capture, /collectorScrollCaptureCancel/);
  assert.match(capture, /same page and scroll preserved/);
  assert.match(capture, /async function confirmCapture/);
  assert.match(capture, /collectorScrollCaptureConfirm/);
  // Confirm path must not re-navigate (openUrl alone may still call collectorNavigate).
  const confirmIdx = capture.indexOf("async function confirmCapture");
  const confirmChunk = capture.slice(confirmIdx, confirmIdx + 800);
  assert.doesNotMatch(confirmChunk, /collectorNavigate/);
});

test("C2.4 Script Capture path and Browser Session isolation remain intact", () => {
  const mainTs = readFileSync(resolve("src/main/main.ts"), "utf8");
  const scriptUi = readFileSync(resolve("src/renderer/main.tsx"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const adapter = readFileSync(resolve("src/renderer/collectors/browser-capture.ts"), "utf8");
  assert.match(scriptUi, /async function capture\(/);
  assert.match(scriptUi, /setCropMode\(true\)/);
  assert.match(scriptUi, /browserVisible\",\s*visible:\s*false/);
  assert.match(mainTs, /withCanonicalViewport\(async \(\) => \{\s*const image = await browser\.capture\(\)/);
  assert.match(adapter, /Does not create a second browser engine or session store/);
  assert.match(capture, /activeBrowserSessionId|onSelectSession/);
  assert.match(capture, /browserSessionId:\s*activeSessionId/);
  assert.doesNotMatch(capture, /WEB_WIDTH|1024\s*\*\s*560|assertCanonicalScreenshot/);
});

test("C2.4 fitCaptureImageInDisplay preserves aspect; pointer maps through content box", () => {
  // Matching aspect → fill host (viewport parity, no letterbox).
  assert.deepEqual(fitCaptureImageInDisplay(1100, 500, 1100, 500), {
    x: 0, y: 0, width: 1100, height: 500,
  });
  // 2× DPR image in same-aspect host → still fill.
  assert.deepEqual(fitCaptureImageInDisplay(1100, 500, 2200, 1000), {
    x: 0, y: 0, width: 1100, height: 500,
  });
  // Mismatched aspect → contain (no stretch).
  const contained = fitCaptureImageInDisplay(1000, 500, 1000, 1000);
  assert.equal(contained.width, 500);
  assert.equal(contained.height, 500);
  assert.equal(contained.x, 250);
  assert.equal(contained.y, 0);

  const display = { left: 100, top: 50, width: 1000, height: 500 };
  // Click center of letterboxed image → image center.
  assert.deepEqual(
    clientPointToCaptureCoords(100 + 500, 50 + 250, display, 1000, 1000, contained),
    { x: 500, y: 500 },
  );
});

test("C2.4 viewport host bounds differ by window size; Creator canonical unchanged", () => {
  const creator = { x: 208, y: 88, width: 1024, height: 560 };
  const host1366 = { x: 56, y: 120, width: 1050, height: 520, active: true };
  const host1920 = { x: 64, y: 100, width: 1600, height: 860, active: true };
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "collectors", collectorHost: host1366, creatorBrowser: creator }),
    { x: 56, y: 120, width: 1050, height: 520 },
  );
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "collectors", collectorHost: host1920, creatorBrowser: creator }),
    { x: 64, y: 100, width: 1600, height: 860 },
  );
  assert.deepEqual(
    resolveBrowserViewBounds({ page: "creator", collectorHost: host1920, creatorBrowser: creator }),
    creator,
  );
  const main = readFileSync(resolve("src/main/main.ts"), "utf8");
  assert.match(main, /page === \"collectors\"[\s\S]*requireCanonical:\s*false/);
  assert.match(main, /withCanonicalViewport[\s\S]*browser\.capture\(\)/);
});

test("C2.4 Capture Region button replaces Capture mode checkbox", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.match(capture, /Capture Region \/ Chụp vùng/);
  assert.match(capture, /captureRegion|collectorFreezeFrame/);
  assert.doesNotMatch(capture, /Capture mode/);
  assert.doesNotMatch(capture, /captureMode|setCaptureMode/);
  assert.doesNotMatch(capture, /type=\"checkbox\"/);
});

test("Host bounds normalization, dedupe, and owner reset prevent stale/duplicate IPC", async () => {
  const a = normalizeCollectorHost({ x: 220.4, y: 140.6, width: 1024, height: 560, active: true });
  const b = normalizeCollectorHost({ x: 220.1, y: 141.2, width: 1024, height: 560, active: true });
  assert.deepEqual(a, { x: 220, y: 141, width: 1024, height: 560, active: true });
  assert.equal(sameCollectorHost(a, b), true);
  assert.equal(sameRect({ x: 10.2, y: 20.4, width: 100, height: 50 }, { x: 10.4, y: 20.1, width: 100, height: 50 }), true);
  assert.equal(
    sameHostClientRect(
      { left: 220.2, top: 140.4, width: 1024, height: 560 },
      { left: 220.4, top: 140.1, width: 1024, height: 560 },
    ),
    true,
  );

  const g = globalThis as unknown as { window?: unknown };
  const prevWindow = g.window;
  const sent: Array<unknown> = [];
  g.window = { creator: {} };
  try {
    resetCollectorBrowserHostReportCache();
    claimCollectorHostOwner("pdc-step2");
    const invoke = async (cmd: unknown) => {
      sent.push(cmd);
      return undefined as never;
    };
    const host = { x: 220, y: 150, width: 1024, height: 560, active: true };
    await collectorReportBrowserHost(invoke, host);
    await collectorReportBrowserHost(invoke, { ...host });
    assert.equal(sent.length, 1);

    await collectorReportBrowserHost(invoke, { ...host, y: 155 });
    assert.equal(sent.length, 2);

    claimCollectorHostOwner("pdc-step3");
    await collectorReportBrowserHost(invoke, { ...host, y: 155 });
    assert.equal(sent.length, 3);
  } finally {
    resetCollectorBrowserHostReportCache();
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
  }
});

test("clipHostRectToVisibleArea clips host to sidebar, scroll container, and viewport", () => {
  const g = globalThis as unknown as {
    window?: { innerWidth: number; innerHeight: number };
    document?: { querySelector: (sel: string) => unknown };
    getComputedStyle?: (el: unknown) => { overflow: string; overflowX: string; overflowY: string };
  };
  const prevWindow = g.window;
  const prevDoc = g.document;
  const prevComputed = g.getComputedStyle;
  g.window = { innerWidth: 1366, innerHeight: 768 };
  g.document = {
    querySelector: (sel: string) =>
      sel === ".app-sidebar"
        ? { getBoundingClientRect: () => ({ left: 0, top: 0, right: 208, bottom: 768, width: 208, height: 768 }) }
        : null,
  };
  g.getComputedStyle = () => ({ overflow: "auto", overflowX: "auto", overflowY: "auto" });
  try {
    const contentArea = {
      parentElement: null,
      getBoundingClientRect: () => ({ left: 220, top: 120, right: 1354, bottom: 760, width: 1134, height: 640 }),
    };
    const hostEl = {
      parentElement: contentArea,
      closest: (sel: string) => (sel === ".app-page" ? {} : null),
    } as unknown as HTMLElement;

    // Scrolled up and left into header & sidebar -> clipped cleanly inside contentArea & right of sidebar
    const clipped = clipHostRectToVisibleArea(hostEl, {
      left: 150,
      top: 60,
      right: 150 + 1024,
      bottom: 60 + 560,
      width: 1024,
      height: 560,
    });
    assert.equal(clipped.left, 220);
    assert.equal(clipped.top, 120);
    assert.equal(clipped.width, 150 + 1024 - 220);
    assert.equal(clipped.height, 60 + 560 - 120);

    // Scrolled completely off-screen above header -> width/height collapse to 0
    const offscreen = clipHostRectToVisibleArea(hostEl, {
      left: 220,
      top: -600,
      right: 1244,
      bottom: -40,
      width: 1024,
      height: 560,
    });
    assert.equal(offscreen.height, 0);

    // Canonical .rpa-browser-host keeps exact 1024x560 even when drawer or window is narrower
    const canonicalHost = {
      parentElement: contentArea,
      classList: { contains: (cls: string) => cls === "rpa-browser-host" },
      closest: (sel: string) => (sel === ".app-page" ? {} : null),
    } as unknown as HTMLElement;
    const canonicalClipped = clipHostRectToVisibleArea(canonicalHost, {
      left: 220,
      top: 120,
      right: 220 + 1024,
      bottom: 120 + 560,
      width: 1024,
      height: 560,
    });
    assert.equal(canonicalClipped.left, 220);
    assert.equal(canonicalClipped.width, 1024);
    assert.equal(canonicalClipped.height, 560);
  } finally {
    g.window = prevWindow;
    g.document = prevDoc;
    g.getComputedStyle = prevComputed;
  }
});

test("createRafHostPublishScheduler coalesces multiple calls into one animation frame", () => {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const prevRaf = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  g.requestAnimationFrame = (cb) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
  };
  try {
    let count = 0;
    const scheduler = createRafHostPublishScheduler(() => {
      count += 1;
    });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(callbacks.size, 1);
    for (const [id, cb] of [...callbacks.entries()]) {
      callbacks.delete(id);
      cb(16);
    }
    assert.equal(count, 1);
    scheduler.schedule();
    scheduler.cancel();
    assert.equal(callbacks.size, 0);
  } finally {
    g.requestAnimationFrame = prevRaf;
    g.cancelAnimationFrame = prevCancel;
  }
});

test("fitCaptureImageInDisplay keeps 1:1 DIP scale without stretching clipped captures", () => {
  // Full 1024x560 capture at DPR 1 and DPR 1.25 -> 1024x560
  const full1x = fitCaptureImageInDisplay(1024, 560, 1024, 560);
  assert.equal(full1x.width, 1024);
  assert.equal(full1x.height, 560);
  const full125x = fitCaptureImageInDisplay(1024, 560, 1280, 700);
  assert.equal(full125x.width, 1024);
  assert.equal(full125x.height, 560);

  // Drawer-clipped capture (700x560 at DPR 1 or 875x700 at DPR 1.25) -> 700x560 (not 1024x819)
  const clipped1x = fitCaptureImageInDisplay(1024, 560, 700, 560);
  assert.equal(clipped1x.width, 700);
  assert.equal(clipped1x.height, 560);
  const clipped125x = fitCaptureImageInDisplay(1024, 560, 875, 700);
  assert.equal(clipped125x.width, 700);
  assert.equal(clipped125x.height, 560);

  // 1920x1080 @ 150% DPI (1280x720 DIP), drawer open: hostShell 748x482, image 1122x723 -> 748x482
  const clipped150x = fitCaptureImageInDisplay(748, 482, 1122, 723);
  assert.equal(clipped150x.width, 748);
  assert.equal(clipped150x.height, 482);
});
