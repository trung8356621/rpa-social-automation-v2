import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScriptCatalogSnapshot,
  isScriptHealthWarningReason,
} from "../src/shared/script-release.js";
import { canUseAsScriptDemo } from "../src/shared/video-demo-policy.js";
import {
  formatAttachDemoSyncMessage,
  interpretSyncForFlow,
} from "../src/shared/attach-demo-sync.js";
import type { Flow, Step } from "../src/shared/contracts.js";
import type { ManualSyncResponse } from "../src/shared/sync-ipc.js";
import { toScriptVideoDemo, attachVideoDemo } from "../src/shared/video-demo.js";

const flow: Flow = {
  id: "48f48584-75b8-4e01-8bff-20a95be2daba",
  name: "Facebook draft POC 3",
  zoom: 1,
  steps: [
    { id: "ok-step", version: 1 },
    { id: "076fa189-83ed-497c-860e-e82e665d429d", version: 1 },
  ],
  variables: [],
  defaultPattern: { values: {} },
};

const steps: Step[] = [
  {
    id: "ok-step",
    version: 1,
    name: "ok",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.9,
      timeoutMs: 1000,
      target: { asset: "a.png", roi: { x: 0, y: 0, width: 10, height: 10 } },
    },
  },
  {
    id: "076fa189-83ed-497c-860e-e82e665d429d",
    version: 1,
    name: "broken",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { action: "CLICK_TARGET", method: "auto", threshold: 0.9, timeoutMs: 1000 },
  },
];

test("1. BLOCKED Test Run with valid video → can select Demo", () => {
  assert.equal(
    canUseAsScriptDemo({
      status: "BLOCKED",
      runId: "r1",
      recordingPath: "c/r1/recording.webm",
    }).ok,
    true,
  );
});

test("2. Selected Demo + invalid Step → package prepared; health is warning not incomplete_reason", () => {
  const probe = buildScriptCatalogSnapshot({
    flow,
    steps,
    version: "1",
    assets: [{ path: "a.png", sha256: "a".repeat(64), kind: "roi" }],
  });
  const attachment = attachVideoDemo({
    scriptId: flow.id,
    scriptVersion: "1",
    caseId: "case",
    testRunId: "run",
    executionDigest: probe.execution_digest,
    sha256: "b".repeat(64),
    thumbnailRef: "demos/x/thumb.jpg",
    thumbnailSha256: "c".repeat(64),
    reviewed: true,
    artifactRef: "demos/x/recording.webm",
    stepVersions: flow.steps,
  });
  const demo = toScriptVideoDemo(attachment);
  const snap = buildScriptCatalogSnapshot({
    flow,
    steps,
    version: "1",
    assets: [{ path: "a.png", sha256: "a".repeat(64), kind: "roi" }],
    videoDemo: demo,
  });
  assert.equal(snap.incomplete, false);
  assert.ok(snap.publish_body);
  assert.deepEqual(snap.incomplete_reasons, []);
  // Broken step ships without fabricated ROI.
  const broken = snap.publish_body!.manifest.steps.find(
    (s) => (s as { id?: string }).id === "076fa189-83ed-497c-860e-e82e665d429d",
  ) as { target?: unknown };
  assert.equal(broken?.target, undefined);
  assert.ok(!isScriptHealthWarningReason("missing_demo"));
  assert.ok(isScriptHealthWarningReason("invalid_step:076fa189:Action cần ảnh"));
});

test("3. Deleted Step absent from current Flow → excluded from release", () => {
  const deletedId = "5e7baf90-c16c-423f-a36e-b0e510f29d9e";
  const probe = buildScriptCatalogSnapshot({ flow, steps, version: "1", assets: [] });
  const demo = toScriptVideoDemo(
    attachVideoDemo({
      scriptId: flow.id,
      scriptVersion: "1",
      caseId: "case",
      testRunId: "run",
      executionDigest: probe.execution_digest,
      thumbnailRef: "t.jpg",
      reviewed: true,
      artifactRef: "r.webm",
      // Historical pins still mention deleted Step — release must ignore them.
      stepVersions: [...flow.steps, { id: deletedId, version: 1 }],
    }),
  );
  const ready = buildScriptCatalogSnapshot({
    flow,
    steps,
    version: "1",
    assets: [],
    videoDemo: demo,
  });
  const ids = ready.publish_body!.manifest.steps.map((s) => (s as { id: string }).id);
  assert.ok(!ids.includes(deletedId));
  assert.deepEqual(ids.sort(), flow.steps.map((s) => s.id).sort());
});

test("published with health warnings shows distinct message; remote failure is not Published", () => {
  const flowId = flow.id;
  const published: ManualSyncResponse = {
    ok: true,
    plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
    results: [{ script_id: flowId, action: "push", ok: true, message: "pushed+video" }],
    rows: [{
      script_id: flowId,
      flow_id: flowId,
      package_key: flowId,
      name: "Facebook",
      status: "synced",
      published_version: "2",
      health_status: "invalid_steps",
      health_warnings: ["invalid_step:076fa189:Action cần ảnh target được crop."],
    }],
  };
  const outcome = interpretSyncForFlow(flowId, published);
  assert.equal(outcome.kind, "published");
  assert.match(formatAttachDemoSyncMessage(outcome), /Published v2/);
  assert.match(formatAttachDemoSyncMessage(outcome), /Step cần cấu hình trước khi thực thi/);

  const rejected: ManualSyncResponse = {
    ok: true,
    plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
    results: [{ script_id: flowId, action: "push", ok: false, message: "Laravel: validation failed" }],
    rows: [],
  };
  assert.equal(interpretSyncForFlow(flowId, rejected).kind, "failed");
  assert.match(
    formatAttachDemoSyncMessage(interpretSyncForFlow(flowId, rejected)),
    /Sync blocked: Laravel/,
  );
});
