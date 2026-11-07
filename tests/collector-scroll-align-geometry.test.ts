import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  alignExtendFrames,
  alignVerticalFrames,
  applyImmutableAnchorRoi,
  cssDeltaToScreenshotPx,
  detectStickyTopPx,
  scoreOverlapRobust,
  type GrayFrame,
} from "../src/shared/collectors/scrolling-capture.js";

function grayFrame(width: number, height: number, fill: (x: number, y: number) => number): GrayFrame {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gray[y * width + x] = fill(x, y) & 255;
  }
  return { width, height, gray };
}

/** Static content that scrolls by `shift` rows; optional sticky; optional center video noise. */
function scrolledPair(opts: {
  width: number;
  height: number;
  shift: number;
  sticky?: number;
  videoNoise?: number;
}) {
  const sticky = opts.sticky ?? 0;
  const noise = opts.videoNoise ?? 0;
  const content = (x: number, y: number) => Math.min(255, 40 + (y - sticky));
  const paint = (frameShift: number, noiseSeed: number) =>
    grayFrame(opts.width, opts.height, (x, y) => {
      if (y < sticky) return 8;
      const mid0 = Math.floor(opts.width * 0.3);
      const mid1 = Math.floor(opts.width * 0.7);
      if (noise > 0 && x >= mid0 && x < mid1) {
        // Animated video region — changes every frame, independent of scroll.
        return (x * 13 + y * 17 + noiseSeed * 91) % 255;
      }
      return content(x, y + frameShift);
    });
  return {
    prev: paint(0, 1),
    next: paint(opts.shift, 2),
    sticky,
    shift: opts.shift,
  };
}

test("C2.5.2 cssDeltaToScreenshotPx scales CSS scroll into screenshot pixels", () => {
  assert.equal(cssDeltaToScreenshotPx(280, 560, 560), 280);
  assert.equal(cssDeltaToScreenshotPx(280, 560, 1120), 560);
  assert.equal(cssDeltaToScreenshotPx(100, 500, 1000), 200);
});

test("C2.5.2 static-page geometry align succeeds for normal scrolling", () => {
  const { prev, next, shift } = scrolledPair({ width: 120, height: 100, shift: 30 });
  const result = alignExtendFrames({
    prev,
    next,
    scrollDeltaCss: 30,
    viewportCssHeight: 100,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.newContentPx, shift);
  assert.equal(result.expectedShiftPx, 30);
  assert.ok(result.strategy === "geometry" || result.strategy === "geometry+stable");
});

test("C2.5.2 sticky header + geometry still appends only new content", () => {
  const { prev, next, shift, sticky } = scrolledPair({
    width: 100,
    height: 100,
    shift: 25,
    sticky: 20,
  });
  assert.equal(detectStickyTopPx(prev, next), sticky);
  const result = alignExtendFrames({
    prev,
    next,
    scrollDeltaCss: 25,
    viewportCssHeight: 100,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stickyPx, sticky);
  assert.equal(result.newContentPx, shift);
});

test("C2.5.2 animated center video does not invalidate geometry+stable sides", () => {
  const { prev, next, shift } = scrolledPair({
    width: 200,
    height: 120,
    shift: 40,
    sticky: 16,
    videoNoise: 1,
  });
  // Pixel-only strict MAD would often fail on video; geometry path must still pass.
  const pixel = alignVerticalFrames(prev, next, { maxMad: 22 });
  const geo = alignExtendFrames({
    prev,
    next,
    scrollDeltaCss: 40,
    viewportCssHeight: 120,
  });
  assert.equal(geo.ok, true);
  if (!geo.ok) return;
  assert.equal(geo.newContentPx, shift);
  // Document that pixel-only can fail while geometry succeeds (runtime MAD 44.5 case).
  if (!pixel.ok) {
    assert.equal(pixel.reason, "ALIGN_FAILED");
  }
});

test("C2.5.2 browser scrolled but screenshot unchanged → NO_NEW_CONTENT / SCREENSHOT_UNCHANGED class", () => {
  const frame = grayFrame(80, 60, (x, y) => (x + y) % 100);
  const result = alignExtendFrames({
    prev: frame,
    next: frame,
    scrollDeltaCss: 40,
    viewportCssHeight: 60,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NO_NEW_CONTENT");
});

test("C2.5.2 layout shift / height mismatch fails closed", () => {
  const prev = grayFrame(100, 80, (_x, y) => y);
  const next = grayFrame(100, 90, (_x, y) => y);
  const result = alignExtendFrames({
    prev,
    next,
    scrollDeltaCss: 20,
    viewportCssHeight: 80,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "LAYOUT_SHIFT");
});

test("C2.5.2 three+ geometry extensions chain without skipping (overlap accounting)", () => {
  let appended = 0;
  const H = 70;
  const W = 90;
  const shift = 28;
  for (let i = 0; i < 3; i++) {
    // prev content starts at i*shift; next at (i+1)*shift → expected append = shift.
    const prev = grayFrame(W, H, (_x, y) => Math.min(255, 40 + i * shift + y));
    const next = grayFrame(W, H, (_x, y) => Math.min(255, 40 + (i + 1) * shift + y));
    const result = alignExtendFrames({
      prev,
      next,
      scrollDeltaCss: shift,
      viewportCssHeight: H,
    });
    assert.equal(result.ok, true, `extension ${i + 1} failed`);
    if (!result.ok) return;
    assert.equal(result.newContentPx, shift);
    appended += result.newContentPx;
  }
  assert.equal(appended, shift * 3);
});

test("C2.5.2 ROI immutable anchor helper still locks top-left", () => {
  assert.deepEqual(
    applyImmutableAnchorRoi({ x: 10, y: 20, width: 30, height: 40 }, { x: 1, y: 2, width: 80, height: 90 }),
    { x: 10, y: 20, width: 80, height: 90 },
  );
});

test("C2.5.2 recovery wiring restores verified scroll on align failure", () => {
  const main = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  assert.match(main, /verifiedScrollTop/);
  assert.match(main, /restoreVerified/);
  assert.match(main, /alignExtendFrames/);
  assert.match(main, /CONTAINER_REPLACED/);
  assert.match(main, /SCREENSHOT_UNCHANGED|ALIGN_FAILED/);
  assert.match(main, /extendGeneration/);
  assert.match(main, /\[collector-scroll-capture\]/);
  assert.doesNotMatch(main, /alignVerticalFrames\(/);
});

test("C2.5.2 scoreOverlapRobust tolerates center noise", () => {
  const { prev, next } = scrolledPair({ width: 200, height: 100, shift: 30, videoNoise: 1 });
  const sticky = detectStickyTopPx(prev, next);
  const overlap = 100 - sticky - 30;
  const stats = scoreOverlapRobust(prev, next, sticky, overlap);
  assert.ok(stats.stableRowFraction > 0.2 || stats.medianMad < 48);
});
