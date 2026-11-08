import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canConfirmCapture,
  canStartExtend,
  nextScrollCapturePhase,
  SCROLL_CAPTURE_LIMITS,
} from "../src/shared/collectors/scrolling-capture.js";

test("C2.5.6 canStartExtend / canConfirmCapture exclude in-flight phases", () => {
  for (const p of ["ROI_SELECTED", "READY", "RECOVERABLE_ERROR", "FAILED"] as const) {
    assert.equal(canStartExtend(p), true);
    assert.equal(canConfirmCapture(p), true);
  }
  for (const p of ["EXTENDING", "SETTLING", "CONFIRMING", "IDLE", "INITIAL_FRAME"] as const) {
    assert.equal(canStartExtend(p), false);
  }
  assert.equal(canConfirmCapture("EXTENDING"), false);
  assert.equal(canConfirmCapture("SETTLING"), false);
});

test("C2.5.6 lifecycle: extendStart only from idle-capable phases", () => {
  assert.equal(nextScrollCapturePhase("READY", "extendStart"), "EXTENDING");
  assert.equal(nextScrollCapturePhase("RECOVERABLE_ERROR", "extendStart"), "EXTENDING");
  assert.equal(nextScrollCapturePhase("EXTENDING", "extendStart"), "EXTENDING");
  assert.equal(nextScrollCapturePhase("SETTLING", "extendFail"), "RECOVERABLE_ERROR");
});

test("C2.5.6 main single-flight + stage instrumentation + no renderer double-timeout", () => {
  const main = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  const browser = readFileSync(resolve("src/main/browser-core.ts"), "utf8");
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  assert.match(main, /inFlightExtend/);
  assert.match(main, /rejected_busy|singleFlight/);
  assert.match(main, /currentStage/);
  assert.match(main, /timeoutStage/);
  assert.match(main, /operationId/);
  assert.match(main, /stageDurations/);
  assert.match(main, /prepareSurfaceCapture/);
  assert.match(main, /surface_ready/);
  assert.match(main, /bodyPromise\.catch/);
  assert.match(main, /mark\("scroll"\)/);
  assert.match(main, /mark\("settle"\)/);
  assert.match(main, /mark\("screenshot"\)/);
  assert.match(main, /mark\("decode"\)/);
  assert.match(main, /mark\("align"\)/);
  assert.match(main, /mark\("stitch"\)/);
  assert.match(main, /canStartExtend|canConfirmCapture/);
  assert.match(main, /Cannot confirm while an extend is still in progress/);
  assert.match(main, /light:\s*true/);
  assert.match(browser, /prepareSurfaceCapture/);
  assert.match(browser, /captureGate/);
  assert.match(browser, /Page\.enable/);
  assert.doesNotMatch(capture, /withTimeout\(\s*collectorScrollCaptureExtend/);
  assert.match(capture, /RECOVERABLE_ERROR/);
  assert.equal(SCROLL_CAPTURE_LIMITS.extendTimeoutMs, 12_000);
});

test("C2.5.6 cold Capture Mode: surface prime before first extend (no warm-up retries)", () => {
  const main = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  // begin() must prime while view is already hidden — not defer to first extend.
  assert.match(main, /prepareSurfaceCapture\(\)/);
  assert.match(main, /event: "surface_ready"/);
});

test("C2.5.6 retry after recoverable failure is a legal transition", () => {
  let p = nextScrollCapturePhase("READY", "extendStart");
  p = nextScrollCapturePhase(p, "extendFail");
  assert.equal(p, "RECOVERABLE_ERROR");
  p = nextScrollCapturePhase(p, "extendStart");
  assert.equal(p, "EXTENDING");
  p = nextScrollCapturePhase(p, "extendSettle");
  p = nextScrollCapturePhase(p, "extendOk");
  assert.equal(p, "READY");
  p = nextScrollCapturePhase(p, "confirm");
  assert.equal(p, "CONFIRMING");
});
