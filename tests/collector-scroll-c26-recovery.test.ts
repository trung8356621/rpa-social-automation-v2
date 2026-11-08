import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clampRoiToImage,
  clientToImageCoords,
  resizeEdgeNavAction,
  scrolledCanvasDisplay,
} from "../src/shared/collectors/roi-preview-interaction.js";
import {
  cssDeltaToScreenshotPx,
  nextScrollCapturePhase,
  SCROLL_CAPTURE_LIMITS,
} from "../src/shared/collectors/scrolling-capture.js";
import { resizeCaptureRoi } from "../src/shared/collector-browser-host.js";

test("C2.6 Capture Mode Toggle ON/OFF contract in CaptureStep JSX", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  // Toggle button must have active class when frozen
  assert.match(capture, /collector-capture-toggle-btn/);
  assert.match(capture, /frozen \? "active collector-capture-active" : ""/);
  assert.match(capture, /aria-pressed=\{frozen\}/);
  // Button must NOT be disabled just because frozen is true (allows toggle OFF)
  assert.doesNotMatch(capture, /disabled=\{[^}]*!opened \|\| frozen\}/);
  assert.match(capture, /disabled=\{[^}]*\(!opened && !frozen\)\}/);
  // Clicking button when frozen cancels freeze; when not frozen begins capture
  assert.match(capture, /if \(frozen\) \{\s*void cancelFreeze\(\);\s*\} else \{\s*void captureRegion\(\);\s*\}/);
  // Must support both Vietnamese and English labels
  assert.match(capture, /Thoát chụp vùng \/ Exit Capture/);
  assert.match(capture, /Capture Region \/ Chụp vùng/);
});

test("C2.6 In-flight extend cannot overwrite committed ROI after pointer release", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  // Check that applyPointerToResizeDrag is guarded by live dragRef.current?.kind === "resize"
  assert.match(capture, /if \(dragRef\.current\?\.kind === "resize" && lastPointerClientRef\.current\)/);
  assert.match(capture, /if \(dragRef\.current\?\.kind !== "resize"\) el\.scrollTop = keepScrollTop;/);
  // Stale 'resizing' closure variable must NOT be used to apply pointer coordinates
  assert.doesNotMatch(capture, /if \(resizing && lastPointerClientRef\.current\)/);
});

test("C2.6 Hidden surface capture wakes visibility safely or uses stayHidden and never hangs CDP", () => {
  const browser = readFileSync(resolve("src/main/browser-core.ts"), "utf8");
  // When visible is false, view is woken temporarily so Chromium compositor generates frames
  assert.match(browser, /const wasHidden = !this\.visible;/);
  assert.match(browser, /if \(wasHidden\)/);
  assert.match(browser, /this\.view\.setVisible\(true\)/);
  assert.match(browser, /this\.view\.setVisible\(false\)/);
  assert.match(browser, /wc\.capturePage\(undefined, \{ stayHidden: true \}\)/);
  // prepareSurfaceCapture must return fast without hanging loop
  assert.match(browser, /prepareSurfaceCapture/);
  assert.doesNotMatch(browser, /for \(let i = 0; i < 2; i\+\+\)/);
});

test("C2.6 scrollBoundContainer returns viewport dimensions for accurate CSS-to-screenshot scale", () => {
  const main = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  assert.match(main, /viewportWidth:\s*innerWidth/);
  assert.match(main, /viewportHeight:\s*innerHeight/);
  assert.match(main, /scroll\.viewportHeight \|\| scroll\.clientHeight \|\| prevGray\.height/);
});

test("C2.6 Pointer capture ownership and release in CaptureStep", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.match(capture, /surface\.setPointerCapture/);
  assert.match(capture, /surfaceRef\.current\.releasePointerCapture/);
  assert.match(capture, /activePointerIdRef/);
  // Canvas must not duplicate pointerMove/pointerUp handlers that bubble to surface
  assert.doesNotMatch(capture, /collector-capture-preview-canvas[\s\S]*onPointerMove=\{onPointerMove\}[\s\S]*onPointerUp=\{onPointerUp\}/);
});

test("C2.6 CSS user-select and touch-action prevent browser native autoscroll/selection interference", () => {
  const css = readFileSync(resolve("src/renderer/style.css"), "utf8");
  assert.match(css, /\.collector-capture-freeze \{[\s\S]*user-select: none;/);
  assert.match(css, /\.collector-capture-preview-scroll \{[\s\S]*user-select: none;/);
  assert.match(css, /\.collector-capture-toggle-btn\.active/);
});

test("C2.6 Viewport CSS height vs element client height scaling math", () => {
  // If container clientHeight is smaller than window innerHeight (modal/feed),
  // scaling MUST use the viewport CSS height (window.innerHeight) to match screenshot pixels.
  const screenshotHeight = 1080;
  const viewportCssHeight = 1080;
  const modalClientHeight = 600;
  const scrollDelta = 280;

  const correctShift = cssDeltaToScreenshotPx(scrollDelta, viewportCssHeight, screenshotHeight);
  const erroneousShift = cssDeltaToScreenshotPx(scrollDelta, modalClientHeight, screenshotHeight);

  assert.equal(correctShift, 280);
  assert.equal(erroneousShift, 504); // 80% error if element height was mistakenly used!
});

test("C2.6 ROI bottom-edge drag: upward shrink reduces height without scrolling preview", () => {
  const anchor = { x: 50, y: 100 };
  const original = { x: 50, y: 100, width: 400, height: 600 };
  // Shrink bottom edge upward from 700 to 300 in image coordinates
  const shrunk = resizeCaptureRoi(original, "bottom", 450, 300, 800, 2000);
  const clamped = clampRoiToImage(shrunk, anchor, 800, 2000);
  assert.equal(clamped.x, 50);
  assert.equal(clamped.y, 100);
  assert.equal(clamped.width, 400);
  assert.equal(clamped.height, 200); // 300 - 100

  // Upward pointer position in viewport does not arm preview autoscroll
  const navAction = resizeEdgeNavAction({
    edge: "bottom",
    pointerClientY: 200,
    viewportTop: 100,
    viewportHeight: 500,
    scrollTop: 100,
    clientHeight: 500,
    scrollHeight: 2000,
  });
  assert.equal(navAction, "none");
});

test("C2.6 Live ROI in render tracks clamped state during resize without jumping", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  // liveRoi must prioritize live clamped roi during resize
  assert.match(capture, /const liveRoi = drag\s*\?\s*drag\.kind === "resize"\s*\?\s*\(roi/);
});
