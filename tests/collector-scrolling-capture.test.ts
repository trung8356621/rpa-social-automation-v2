import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SCROLL_CAPTURE_LIMITS,
  alignVerticalFrames,
  applyImmutableAnchorRoi,
  assertWithinScrollCaptureLimits,
  detectStickyTopPx,
  growRoiBottom,
  nextScrollCapturePhase,
} from "../src/shared/collectors/scrolling-capture.js";
import { resizeCaptureRoi } from "../src/shared/collector-browser-host.js";
import { shellBoundsToCssFixed, clientPointToCaptureCoords } from "../src/shared/collector-browser-host.js";

function grayFrame(width: number, height: number, fill: (x: number, y: number) => number): {
  width: number;
  height: number;
  gray: Uint8Array;
} {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gray[y * width + x] = fill(x, y) & 255;
  }
  return { width, height, gray };
}

/** Content that scrolls by `shift` rows between frames; optional sticky top band. */
function scrolledPair(opts: {
  width: number;
  height: number;
  shift: number;
  sticky?: number;
}) {
  const sticky = opts.sticky ?? 0;
  // Unique per-row values so overlap search cannot alias.
  const prev = grayFrame(opts.width, opts.height, (_x, y) =>
    y < sticky ? 8 : Math.min(255, 40 + (y - sticky)),
  );
  const next = grayFrame(opts.width, opts.height, (_x, y) =>
    y < sticky ? 8 : Math.min(255, 40 + (y - sticky + opts.shift)),
  );
  return { prev, next, sticky, shift: opts.shift };
}

test("C2.5 immutable top-left anchor; resize right/bottom/corner only", () => {
  const first = { x: 40, y: 60, width: 100, height: 80 };
  const moved = applyImmutableAnchorRoi(first, { x: 10, y: 10, width: 180, height: 200 });
  assert.deepEqual(moved, { x: 40, y: 60, width: 180, height: 200 });
  assert.deepEqual(
    resizeCaptureRoi(first, "right", 200, 999, 400, 400),
    { x: 40, y: 60, width: 160, height: 80 },
  );
  assert.deepEqual(
    resizeCaptureRoi(first, "bottom", 999, 200, 400, 400),
    { x: 40, y: 60, width: 100, height: 140 },
  );
  assert.deepEqual(
    resizeCaptureRoi(first, "corner", 220, 220, 400, 400),
    { x: 40, y: 60, width: 180, height: 160 },
  );
});

test("C2.5 phase machine covers browse→roi→extend→confirm and cancel paths", () => {
  let p = nextScrollCapturePhase("IDLE", "begin");
  assert.equal(p, "INITIAL_FRAME");
  p = nextScrollCapturePhase(p, "selectRoi");
  assert.equal(p, "ROI_SELECTED");
  p = nextScrollCapturePhase(p, "extendStart");
  assert.equal(p, "EXTENDING");
  p = nextScrollCapturePhase(p, "extendOk");
  assert.equal(p, "READY");
  p = nextScrollCapturePhase(p, "confirm");
  assert.equal(p, "CONFIRMED");

  assert.equal(nextScrollCapturePhase("EXTENDING", "extendFail"), "FAILED");
  assert.equal(nextScrollCapturePhase("READY", "cancel"), "CANCELLED");
  assert.equal(nextScrollCapturePhase("ROI_SELECTED", "sessionChange"), "CANCELLED");
  assert.equal(nextScrollCapturePhase("EXTENDING", "navigateAway"), "CANCELLED");
  assert.equal(nextScrollCapturePhase("INITIAL_FRAME", "resetRoi"), "INITIAL_FRAME");
});

test("C2.5 single-viewport: perfect overlap of identical frames → NO_NEW_CONTENT", () => {
  const frame = grayFrame(120, 80, (x, y) => (x + y) % 180);
  const result = alignVerticalFrames(frame, frame);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NO_NEW_CONTENT");
});

test("C2.5 multiple overlapping viewports: overlap removed; new band appended", () => {
  const { prev, next, shift } = scrolledPair({ width: 100, height: 80, shift: 30 });
  const result = alignVerticalFrames(prev, next);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.overlapPx, 80 - shift);
  assert.equal(result.newContentPx, shift);
  assert.equal(result.stickyPx, 0);
  assert.ok(result.score <= SCROLL_CAPTURE_LIMITS.maxMad);
});

test("C2.5 sticky header excluded from append accounting", () => {
  const { prev, next, shift, sticky } = scrolledPair({
    width: 100,
    height: 100,
    shift: 25,
    sticky: 20,
  });
  assert.equal(detectStickyTopPx(prev, next), sticky);
  const result = alignVerticalFrames(prev, next);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stickyPx, sticky);
  assert.equal(result.newContentPx, shift);
  assert.equal(result.overlapPx, 100 - sticky - shift);
});

test("C2.5 scroll displacement differs from a guessed delta — alignment uses pixels", () => {
  // Requested delta might be 280 CSS; actual content shift is 41 px in screenshot space.
  const { prev, next } = scrolledPair({ width: 90, height: 70, shift: 41 });
  const result = alignVerticalFrames(prev, next);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.newContentPx, 41);
  assert.notEqual(result.newContentPx, SCROLL_CAPTURE_LIMITS.defaultScrollCssPx);
});

test("C2.5 no new scroll content / boundary", () => {
  const { prev, next } = scrolledPair({ width: 80, height: 60, shift: 2 });
  const result = alignVerticalFrames(prev, next, { minNewContent: 8 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NO_NEW_CONTENT");
});

test("C2.5 lazy-load / content shift → ALIGN_FAILED keeps prior image (caller)", () => {
  const prev = grayFrame(80, 60, (x, y) => (x + y) % 100);
  const next = grayFrame(80, 60, (x, y) => (x * 7 + y * 13) % 255); // unrelated
  const result = alignVerticalFrames(prev, next);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "ALIGN_FAILED");
    assert.match(result.message, /Last valid image kept|Could not verify/);
  }
});

test("C2.5 width mismatch and resource limits", () => {
  const a = grayFrame(100, 50, () => 10);
  const b = grayFrame(90, 50, () => 10);
  const mismatch = alignVerticalFrames(a, b);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, "WIDTH_MISMATCH");

  assert.equal(
    assertWithinScrollCaptureLimits({
      frameCount: SCROLL_CAPTURE_LIMITS.maxFrames + 1,
      width: 100,
      height: 100,
      bufferBytes: 10,
    })?.reason,
    "LIMIT_FRAMES",
  );
  assert.equal(
    assertWithinScrollCaptureLimits({
      frameCount: 2,
      width: 100,
      height: SCROLL_CAPTURE_LIMITS.maxHeightPx + 1,
      bufferBytes: 10,
    })?.reason,
    "LIMIT_HEIGHT",
  );
  assert.equal(
    assertWithinScrollCaptureLimits({
      frameCount: 2,
      width: 100,
      height: 100,
      bufferBytes: SCROLL_CAPTURE_LIMITS.maxBufferBytes + 1,
    })?.reason,
    "LIMIT_MEMORY",
  );
});

test("C2.5 UI zoom / DPI geometry helpers remain independent of stitch math", () => {
  const css = shellBoundsToCssFixed({ x: 100, y: 80, width: 800, height: 400 }, 1.25);
  assert.deepEqual(css, { x: 125, y: 100, width: 1000, height: 500 });
  // Pointer on zoomed display maps to image pixels (stitch uses image space only).
  assert.deepEqual(
    clientPointToCaptureCoords(125, 100, { left: 125, top: 100, width: 1000, height: 500 }, 800, 400),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    clientPointToCaptureCoords(625, 350, { left: 125, top: 100, width: 1000, height: 500 }, 800, 400),
    { x: 400, y: 200 },
  );
});

test("C2.5 final crop ROI fits accumulated size; grow bottom helper", () => {
  const roi = { x: 10, y: 20, width: 50, height: 40 };
  assert.deepEqual(growRoiBottom(roi, 200), { x: 10, y: 20, width: 50, height: 180 });
});

test("C2.5 wiring: Collector IPC + Script Capture untouched + session isolation", () => {
  const main = readFileSync(resolve("src/main/main.ts"), "utf8");
  const contracts = readFileSync(resolve("src/shared/contracts.ts"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const adapter = readFileSync(resolve("src/renderer/collectors/browser-capture.ts"), "utf8");
  const scriptUi = readFileSync(resolve("src/renderer/main.tsx"), "utf8");
  const controller = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");

  assert.match(contracts, /collectorScrollCaptureBegin/);
  assert.match(contracts, /collectorScrollCaptureExtend/);
  assert.match(contracts, /collectorScrollCaptureConfirm/);
  assert.match(main, /CollectorScrollCaptureController/);
  assert.match(main, /Scrolling capture is Collector-only/);
  assert.match(main, /scrollCapture\.cancelAll/);
  assert.match(main, /withCanonicalViewport\(async \(\) => \{\s*const image = await browser\.capture\(\)/);
  assert.match(scriptUi, /async function capture\(/);
  assert.match(scriptUi, /setCropMode\(true\)/);
  assert.doesNotMatch(scriptUi, /collectorScrollCapture/);
  assert.match(adapter, /collectorScrollCaptureExtend/);
  assert.doesNotMatch(capture, /Scroll & append/);
  assert.match(capture, /collector-capture-preview-scroll/);
  assert.match(capture, /scheduleWheelExtend|Đang mở rộng vùng chụp/);
  assert.match(controller, /lastViewportPng/);
  assert.match(controller, /alignExtendFrames/);
  assert.match(controller, /scrollBoundContainer|scrollNestedContainer/);
  assert.match(controller, /cancelAll/);
  assert.match(controller, /verifiedScrollTop|restoreVerified/);
  assert.doesNotMatch(controller, /localStorage/);
});
