import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ScrollExtendGate, withTimeout } from "../src/shared/collectors/scroll-extend-gate.js";
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

test("C2.5.1 ScrollExtendGate serializes and coalesces overlapping requests", async () => {
  const gate = new ScrollExtendGate<number>();
  let active = 0;
  let maxActive = 0;
  const runs: number[] = [];
  const run = async (delta: number, _signal: AbortSignal) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    runs.push(delta);
    active--;
    return delta;
  };
  const a = gate.request(100, run);
  const b = gate.request(50, run);
  const c = gate.request(25, run);
  const ra = await a;
  const rb = await b;
  const rc = await c;
  assert.equal(maxActive, 1);
  assert.ok(ra === 100 || ra === 75);
  assert.equal(rb, null);
  assert.equal(rc, null);
  assert.ok(runs.length >= 1);
  assert.ok(runs.length <= 2);
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

test("C2.5.1 CaptureStep wires wheel, real preview scrollbar, edge auto-scroll, timeout", () => {
  const capture = readFileSync(resolve("src/renderer/collectors/CaptureStep.tsx"), "utf8");
  const mainCtrl = readFileSync(resolve("src/main/collector-scroll-capture.ts"), "utf8");
  const css = readFileSync(resolve("src/renderer/style.css"), "utf8");
  assert.match(capture, /ScrollExtendGate/);
  assert.match(capture, /addEventListener\("wheel"/);
  assert.match(capture, /passive:\s*false/);
  assert.match(capture, /shouldExtendFromPreviewScroll/);
  assert.match(capture, /isRoiEdgeAutoScrollArmed/);
  assert.match(capture, /collector-capture-preview-scroll/);
  assert.match(capture, /Preview scrollbar = pan accumulated PNG|pans the PNG/i);
  assert.match(capture, /gateRef\.current\.cancel/);
  assert.match(capture, /extendTimeoutMs/);
  assert.match(mainCtrl, /extendTimeoutMs/);
  assert.match(css, /\.collector-capture-preview-scroll/);
  assert.doesNotMatch(capture, /tallPreview \?/);
  assert.equal(SCROLL_CAPTURE_LIMITS.extendTimeoutMs > 0, true);
});
