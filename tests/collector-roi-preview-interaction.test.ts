import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resizeCaptureRoi } from "../src/shared/collector-browser-host.js";
import {
  clampRoiToImage,
  clientToImageCoords,
  resizeEdgeNavAction,
  scrolledCanvasDisplay,
} from "../src/shared/collectors/roi-preview-interaction.js";
import { SCROLL_CAPTURE_LIMITS } from "../src/shared/collectors/scrolling-capture.js";

test("C2.5.4 client→image mapping includes preview scroll offsets", () => {
  const box = { width: 400, height: 800 };
  // Without scroll: mid-viewport → mid of visible band
  const a = clientToImageCoords(
    100 + 200,
    50 + 100,
    { left: 100, top: 50, scrollLeft: 0, scrollTop: 0 },
    box,
    800,
    1600,
  );
  assert.equal(a.x, 400);
  assert.equal(a.y, 200);

  // Same client point after scrolling down 200 CSS → image Y increases
  const b = clientToImageCoords(
    100 + 200,
    50 + 100,
    { left: 100, top: 50, scrollLeft: 0, scrollTop: 200 },
    box,
    800,
    1600,
  );
  assert.equal(b.x, 400);
  assert.equal(b.y, 600);
});

test("C2.5.4 clampRoiToImage never auto-grows height after stitch", () => {
  const roi = { x: 10, y: 20, width: 100, height: 80 };
  const anchor = { x: 10, y: 20 };
  assert.deepEqual(clampRoiToImage(roi, anchor, 400, 2000), roi);
  assert.deepEqual(clampRoiToImage(roi, anchor, 50, 60), {
    x: 10,
    y: 20,
    width: 40,
    height: 40,
  });
});

test("C2.5.4 shrink ROI upward does not require browser extend", () => {
  const original = { x: 5, y: 10, width: 200, height: 400 };
  const shrunk = resizeCaptureRoi(original, "bottom", 999, 110, 800, 2000);
  assert.equal(shrunk.x, 5);
  assert.equal(shrunk.y, 10);
  assert.equal(shrunk.width, 200);
  assert.equal(shrunk.height, 100);
  assert.equal(
    resizeEdgeNavAction({
      edge: "bottom",
      pointerClientY: 300,
      viewportTop: 100,
      viewportHeight: 400,
      scrollTop: 500,
      clientHeight: 400,
      scrollHeight: 2000,
    }),
    "none",
  );
});

test("C2.5.4 held bottom edge: preview_down then browser_extend at content end", () => {
  assert.equal(
    resizeEdgeNavAction({
      edge: "bottom",
      pointerClientY: 490,
      viewportTop: 100,
      viewportHeight: 400,
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 1200,
      zonePx: 28,
    }),
    "preview_down",
  );
  assert.equal(
    resizeEdgeNavAction({
      edge: "bottom",
      pointerClientY: 490,
      viewportTop: 100,
      viewportHeight: 400,
      scrollTop: 800,
      clientHeight: 400,
      scrollHeight: 1200,
      zonePx: 28,
    }),
    "browser_extend",
  );
  assert.equal(
    resizeEdgeNavAction({
      edge: "bottom",
      pointerClientY: 110,
      viewportTop: 100,
      viewportHeight: 400,
      scrollTop: 200,
      clientHeight: 400,
      scrollHeight: 1200,
      zonePx: 28,
    }),
    "none",
    "upward/top zone must not auto-scroll (C2.5.5 jitter)",
  );
  assert.equal(
    resizeEdgeNavAction({
      edge: "right",
      pointerClientY: 490,
      viewportTop: 100,
      viewportHeight: 400,
      scrollTop: 800,
      clientHeight: 400,
      scrollHeight: 1200,
    }),
    "none",
  );
});

test("C2.5.4 scrolled canvas display subtracts scroll offsets", () => {
  assert.deepEqual(
    scrolledCanvasDisplay({ left: 40, top: 80, scrollLeft: 10, scrollTop: 25 }, { width: 500, height: 900 }),
    { left: 30, top: 55, width: 500, height: 900 },
  );
});

test("C2.5.4 CaptureStep separates image / scroll / ROI; no growRoiForSession; edge rAF", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.doesNotMatch(capture, /growRoiForSession/);
  assert.doesNotMatch(capture, /Scroll & append/);
  assert.match(capture, /clampRoiToImage/);
  assert.match(capture, /resizeEdgeNavAction/);
  assert.match(capture, /startEdgeNavLoop|tickEdgeNav/);
  assert.match(capture, /requestAnimationFrame\(tickEdgeNav\)/);
  assert.match(capture, /dragRef\.current\?\.kind === "resize"/);
  assert.match(capture, /clientToImageCoords/);
  assert.doesNotMatch(capture, /session\.height - prevRoi\.y/);
  assert.equal(SCROLL_CAPTURE_LIMITS.edgePreviewScrollPx > 0, true);
});

test("C2.5.4 expand beyond one viewport then shrink preserves immutable anchor", () => {
  const anchor = { x: 40, y: 60 };
  let roi = { x: 40, y: 60, width: 300, height: 200 };
  // Simulate three stitch growths without auto-growing ROI
  for (const h of [600, 1000, 1400]) {
    roi = clampRoiToImage(roi, anchor, 800, h);
    assert.equal(roi.x, 40);
    assert.equal(roi.y, 60);
    assert.equal(roi.height, 200);
  }
  // User expands intentionally
  roi = resizeCaptureRoi(roi, "bottom", 400, 900, 800, 1400);
  assert.deepEqual(roi, { x: 40, y: 60, width: 300, height: 840 });
  // User shrinks
  roi = resizeCaptureRoi(roi, "bottom", 400, 200, 800, 1400);
  assert.deepEqual(roi, { x: 40, y: 60, width: 300, height: 140 });
});
