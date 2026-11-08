import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ScrollExtendGate,
  userFacingExtendError,
  withTimeout,
} from "../src/shared/collectors/scroll-extend-gate.js";
import {
  isRoiEdgeAutoScrollArmed,
  shouldExtendFromPreviewScroll,
  SCROLL_CAPTURE_LIMITS,
} from "../src/shared/collectors/scrolling-capture.js";

test("C2.5.1 preview wheel at end extends; mid-preview pans only", () => {
  assert.equal(
    shouldExtendFromPreviewScroll({ deltaY: 80, scrollTop: 0, clientHeight: 400, scrollHeight: 1200 }),
    "preview",
  );
  assert.equal(
    shouldExtendFromPreviewScroll({ deltaY: 80, scrollTop: 800, clientHeight: 400, scrollHeight: 1200 }),
    "extend",
  );
  assert.equal(
    shouldExtendFromPreviewScroll({ deltaY: -40, scrollTop: 100, clientHeight: 400, scrollHeight: 1200 }),
    "preview",
  );
  assert.equal(
    shouldExtendFromPreviewScroll({ deltaY: -40, scrollTop: 0, clientHeight: 400, scrollHeight: 1200 }),
    "ignore",
  );
});

test("C2.5.1 ROI bottom/corner edge arms auto-scroll; right edge does not", () => {
  assert.equal(
    isRoiEdgeAutoScrollArmed({
      edge: "bottom",
      pointerClientY: 500,
      viewportTop: 100,
      viewportHeight: 400,
      zonePx: 28,
    }),
    true,
  );
  assert.equal(
    isRoiEdgeAutoScrollArmed({
      edge: "corner",
      pointerClientY: 490,
      viewportTop: 100,
      viewportHeight: 400,
      zonePx: 28,
    }),
    true,
  );
  assert.equal(
    isRoiEdgeAutoScrollArmed({
      edge: "bottom",
      pointerClientY: 200,
      viewportTop: 100,
      viewportHeight: 400,
      zonePx: 28,
    }),
    false,
  );
  assert.equal(
    isRoiEdgeAutoScrollArmed({
      edge: "right",
      pointerClientY: 500,
      viewportTop: 100,
      viewportHeight: 400,
    }),
    false,
  );
});

test("C2.5.3 ScrollExtendGate drops while busy — no coalesce chain", async () => {
  const gate = new ScrollExtendGate<number>();
  let active = 0;
  let maxActive = 0;
  const runs: number[] = [];
  const run = async (delta: number, _signal: AbortSignal) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 40));
    runs.push(delta);
    active--;
    return delta;
  };
  const a = gate.request(100, run);
  const b = await gate.request(50, run);
  const c = await gate.request(25, run);
  const ra = await a;
  assert.equal(maxActive, 1);
  assert.equal(ra, 100);
  assert.equal(b, null);
  assert.equal(c, null);
  assert.deepEqual(runs, [100]);
});

test("C2.5.3 wheel debounce: five rapid schedules → one extend", async () => {
  const gate = new ScrollExtendGate<number>(30);
  const runs: number[] = [];
  const run = async (delta: number) => {
    runs.push(delta);
    await new Promise((r) => setTimeout(r, 20));
    return delta;
  };
  assert.equal(gate.scheduleWheelExtend(100, run), "debounced");
  assert.equal(gate.scheduleWheelExtend(100, run), "debounced");
  assert.equal(gate.scheduleWheelExtend(100, run), "debounced");
  assert.equal(gate.scheduleWheelExtend(100, run), "debounced");
  assert.equal(gate.scheduleWheelExtend(100, run), "debounced");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(runs, [100]);
});

test("C2.5.3 wheel during busy → dropped_busy and no post-align chain", async () => {
  const gate = new ScrollExtendGate<number>(20);
  const runs: number[] = [];
  const run = async (delta: number) => {
    runs.push(delta);
    await new Promise((r) => setTimeout(r, 60));
    return delta;
  };
  const first = gate.request(10, run);
  assert.equal(gate.busy, true);
  assert.equal(gate.scheduleWheelExtend(99, run), "dropped_busy");
  assert.equal(gate.scheduleWheelExtend(98, run), "dropped_busy");
  await first;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(runs, [10]);
});

test("C2.5.1 ScrollExtendGate cancel clears busy; new requests can run", async () => {
  const gate = new ScrollExtendGate<string>();
  const p = gate.request(10, async (_d, signal) => {
    await new Promise((r) => setTimeout(r, 80));
    if (signal.aborted) throw new Error("Extend cancelled.");
    return "ok";
  });
  assert.equal(gate.busy, true);
  gate.cancel();
  assert.equal(gate.busy, false);
  await p.catch(() => undefined);
  assert.equal(gate.busy, false);
  const next = await gate.request(1, async () => "next");
  assert.equal(next, "next");
});

test("C2.5.1 withTimeout rejects and clears", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => undefined), 40, "timed out"),
    /timed out/,
  );
});

test("C2.5.3 userFacingExtendError hides MAD/IPC/geometry jargon", () => {
  assert.match(userFacingExtendError("align failed [ALIGN_FAILED] MAD 44.5"), /Không xác minh/);
  assert.doesNotMatch(userFacingExtendError("align failed MAD 44.5"), /MAD|IPC|geometry/i);
  assert.equal(userFacingExtendError("Extend cancelled."), "");
});

test("C2.5.3 CaptureStep gesture UX — no Scroll & append; debounce; progress; scroll continuity", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const mainCtrl = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  const css = readFileSync(resolve("src/renderer/style.css"), "utf8");
  assert.match(capture, /ScrollExtendGate/);
  assert.match(capture, /scheduleWheelExtend/);
  assert.match(capture, /addEventListener\("wheel"/);
  assert.match(capture, /passive:\s*false/);
  assert.match(capture, /shouldExtendFromPreviewScroll/);
  assert.match(capture, /resizeEdgeNavAction|startEdgeNavLoop/);
  assert.match(capture, /collector-capture-preview-scroll/);
  assert.match(capture, /Đang mở rộng vùng chụp/);
  assert.match(capture, /keepScrollTop/);
  assert.match(capture, /userFacingExtendError/);
  assert.doesNotMatch(capture, /Scroll & append/);
  assert.doesNotMatch(capture, /scrollTop\s*=\s*el\.scrollHeight/);
  assert.doesNotMatch(capture, /growRoiForSession/);
  assert.doesNotMatch(capture, /\bMAD\b|\bIPC\b|geometry \+/);
  assert.match(capture, /gateRef\.current\.cancel/);
  assert.match(capture, /extendTimeoutMs/);
  assert.match(mainCtrl, /extendTimeoutMs/);
  assert.match(css, /\.collector-capture-preview-scroll/);
  assert.match(css, /\.collector-capture-extend-progress/);
  assert.doesNotMatch(capture, /tallPreview \?/);
  assert.equal(SCROLL_CAPTURE_LIMITS.extendTimeoutMs > 0, true);
  assert.equal(SCROLL_CAPTURE_LIMITS.wheelDebounceMs, 200);
});
