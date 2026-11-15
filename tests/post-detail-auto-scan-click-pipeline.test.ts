import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AutoScanStartError, runAutoScanClickPipeline, validateAutoScanStart, type AutoScanDiagnosticEvent } from "../src/renderer/post-detail-collector/auto-scan-click-pipeline.js";
import type { PostDetailAnchorType, PostDetailContainerResult, PostDetailScanFrame, VisualReferenceSample } from "../src/shared/post-detail-collector/types.js";

const ref = (id: string, semanticRole?: PostDetailAnchorType): VisualReferenceSample => ({ sampleId: id, semanticRole, label: semanticRole || "legacy", dataUrl: "data:image/png;base64,x", width: 20, height: 20, bbox: { x: 0, y: 0, width: 20, height: 20 }, createdAt: "2026-11-16T00:00:00.000Z" });
const validRefs = () => [ref("like", "LIKE"), ref("comment", "COMMENT"), ref("share", "SHARE")];
const frame: PostDetailScanFrame = { frameId: "frame-001", frameIndex: 1, scrollDeltaApplied: 0, observedScrollPx: 0, width: 1024, height: 560, anchors: [], notes: [] };
const container: PostDetailContainerResult = { status: "AMBIGUOUS", containerBounds: null, frameIds: [frame.frameId], visualAnchors: [], confidence: null, evidenceRefs: [], runId: "run", sourceUrl: "https://www.facebook.com/groups/g/posts/1/", mainActionRow: null, scrollMetadata: { wheelPoint: { x: 512, y: 280 }, deltaY: -100, settleMs: 550, maxFrames: 20, framesCaptured: 1, stoppedReason: "completed", requestedScrollPx: 0, observedScrollPx: 0, visualScrollConfirmedFrames: 0 }, notes: [] };

function harness(overrides: Partial<Parameters<typeof runAutoScanClickPipeline>[0]> = {}) {
  const events: AutoScanDiagnosticEvent[] = [];
  const locks: boolean[] = [];
  let runCalls = 0;
  const input: Parameters<typeof runAutoScanClickPipeline>[0] = {
    browserCoreAvailable: true,
    alreadyRunning: false,
    visualReferences: validRefs(),
    probe: async () => ({ url: container.sourceUrl }),
    assertSocialPage: () => undefined,
    fallbackUrl: container.sourceUrl,
    publishHost: () => undefined,
    setInputLock: async locked => { locks.push(locked); return { ok: true, locked }; },
    runScan: async onFrame => { runCalls++; onFrame(frame, [frame]); return { runId: "run", frames: [frame], container }; },
    onFrame: () => undefined,
    isCancelled: () => false,
    onDiagnostic: event => events.push(event),
    ...overrides,
  };
  return { input, events, locks, runCalls: () => runCalls };
}

test("valid LIKE/COMMENT/SHARE click locks input, starts scan, captures frame and completes", async () => {
  const h = harness();
  await runAutoScanClickPipeline(h.input);
  assert.deepEqual(h.events.map(event => event.stage), ["CLICK_RECEIVED", "VALIDATION_PASS", "INPUT_LOCKED", "SCAN_STARTED", "FRAME_CAPTURED", "SCAN_COMPLETED", "INPUT_UNLOCKED"]);
  assert.deepEqual(h.locks, [true, false]);
  assert.equal(h.runCalls(), 1);
});

test("legacy, duplicate, missing roles and unavailable BrowserCore reject with explicit codes before IPC", async () => {
  const cases = [
    { refs: [ref("a"), ref("b"), ref("c")], available: true, code: "LEGACY_REFERENCE_ROLE" },
    { refs: [ref("a", "LIKE"), ref("b", "LIKE"), ref("c", "SHARE")], available: true, code: "DUPLICATE_REFERENCE_ROLE" },
    { refs: [ref("a", "LIKE"), ref("b", "COMMENT")], available: true, code: "MISSING_REFERENCE_ROLE" },
    { refs: validRefs(), available: false, code: "BROWSER_CORE_UNAVAILABLE" },
  ] as const;
  for (const item of cases) {
    const gate = validateAutoScanStart({ browserCoreAvailable: item.available, alreadyRunning: false, visualReferences: [...item.refs] });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.failureCode, item.code);
    const h = harness({ browserCoreAvailable: item.available, visualReferences: [...item.refs] });
    await assert.rejects(runAutoScanClickPipeline(h.input), (error: unknown) => error instanceof AutoScanStartError && error.failureCode === item.code);
    assert.equal(h.runCalls(), 0);
    assert.deepEqual(h.locks, []);
    assert.equal(h.events.at(-1)?.failureCode, item.code);
  }
});

test("IPC rejection is surfaced and input lock is always cleaned up", async () => {
  const h = harness({ runScan: async () => { throw new Error("IPC_CAPTURE_REJECTED"); } });
  await assert.rejects(runAutoScanClickPipeline(h.input), (error: unknown) => error instanceof AutoScanStartError && error.failureCode === "SCAN_IPC_REJECTED" && /IPC_CAPTURE_REJECTED/.test(error.message));
  assert.deepEqual(h.locks, [true, false]);
  assert.equal(h.events.find(event => event.stage === "FAILED")?.failureCode, "SCAN_IPC_REJECTED");
});

test("probe, social-page and input-lock failures keep their exact stage codes", async () => {
  const cases: Array<{ code: string; overrides: Partial<Parameters<typeof runAutoScanClickPipeline>[0]> }> = [
    { code: "POST_PROBE_UNAVAILABLE", overrides: { probe: async () => null } },
    { code: "POST_PROBE_REJECTED", overrides: { probe: async () => { throw new Error("probe ipc"); } } },
    { code: "INVALID_SOCIAL_PAGE", overrides: { assertSocialPage: () => { throw new Error("not social"); } } },
    { code: "INPUT_LOCK_FAILED", overrides: { setInputLock: async () => ({ ok: false, locked: false }) } },
  ];
  for (const item of cases) {
    const h = harness(item.overrides);
    await assert.rejects(runAutoScanClickPipeline(h.input), (error: unknown) => error instanceof AutoScanStartError && error.failureCode === item.code);
    assert.equal(h.events.find(event => event.stage === "FAILED")?.failureCode, item.code);
    assert.equal(h.runCalls(), 0);
  }
});

test("cancelled scan emits cancellation and releases input without completion", async () => {
  let cancelled = false;
  const h = harness({
    isCancelled: () => cancelled,
    runScan: async onFrame => { onFrame(frame, [frame]); cancelled = true; return { runId: "run", frames: [frame], container }; },
  });
  await runAutoScanClickPipeline(h.input);
  assert.ok(h.events.some(event => event.stage === "SCAN_CANCELLED"));
  assert.ok(!h.events.some(event => event.stage === "SCAN_COMPLETED"));
  assert.deepEqual(h.locks, [true, false]);
});

test("VisualRegionStep displays coded errors and pipeline diagnostics from the real click handler", () => {
  const source = readFileSync("src/renderer/post-detail-collector/VisualRegionStep.tsx", "utf8");
  assert.match(source, /onClick=\{\(\) => void startAutoScan\(\)\}/);
  assert.match(source, /runAutoScanClickPipeline/);
  assert.match(source, /Auto Scan Pipeline Diagnostics/);
  assert.match(source, /\[\$\{code\}\]/);
  assert.match(source, /phase: "running"/);
});
