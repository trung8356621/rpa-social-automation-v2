import assert from "node:assert/strict";
import { test } from "node:test";
import { computeExecutionDigest, computeScriptContentDigest } from "../src/shared/script-digest.js";
import { buildScriptPublishBody } from "../src/shared/script-release.js";
import { importScriptRelease } from "../src/shared/script-sync.js";
import { labelForStatus, statusFromPlanSides } from "../src/shared/sync-status.js";
import type { Flow, Step } from "../src/shared/contracts.js";

test("sync status labels cover required UI states", () => {
  for (const code of [
    "local_only",
    "synced",
    "remote_only",
    "local_changes",
    "remote_changes",
    "conflict",
    "incomplete_assets",
    "sync_error",
  ] as const) {
    assert.ok(labelForStatus(code).length > 0);
  }
  assert.equal(
    statusFromPlanSides({
      hasLocal: true,
      hasRemote: true,
      sameDigest: false,
      conflict: true,
      localAhead: false,
      remoteAhead: false,
      incomplete: false,
    }),
    "conflict",
  );
});

test("content digest stable for same publish body; video does not change execution digest", () => {
  const flow: Flow = {
    id: "flow-ui-1",
    name: "UI Flow",
    zoom: 1,
    steps: [{ id: "s1", version: 1 }],
    groups: [],
    variables: [{ id: "v1", key: "text", type: "text" }],
    defaultPattern: { values: {} },
  };
  const steps: Step[] = [
    {
      id: "s1",
      version: 1,
      name: "sleep",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { action: "SLEEP", timeoutMs: 100 },
    },
  ];
  const body = buildScriptPublishBody({ flow, steps, version: "1.0.0", assets: [] });
  const d1 = computeScriptContentDigest(body);
  const d2 = computeScriptContentDigest(body);
  assert.equal(d1, d2);
  const exec1 = computeExecutionDigest(body.manifest);
  const withVideo = {
    ...body.manifest,
    video_demo: {
      artifact_ref: "demo.webm",
      mime: "video/webm" as const,
      test_run_id: "tr1",
      script_version: "1.0.0",
      reviewed: true,
      audio: false as const,
      desktop_capture: false as const,
    },
  };
  assert.equal(exec1, computeExecutionDigest(withVideo));
});

test("import incomplete when ROI asset digest missing", () => {
  const result = importScriptRelease({
    package_key: "flow.ui",
    name: "UI",
    version: "1.0.0",
    content_digest: "a".repeat(64),
    manifest: {
      script_id: "flow-ui-1",
      variables: [{ key: "text", type: "text" }],
      steps: [{ id: "s1", version: 1, action: "CLICK_TARGET", target: { asset: "x.png", roi: { x: 0, y: 0, width: 10, height: 10 } } }],
      assets: [{ path: "x.png", sha256: "not-a-digest", kind: "roi" }],
    },
  });
  assert.equal(result.incomplete, true);
  assert.equal(result.ready_to_execute, false);
  assert.equal(result.flowPayload, null);
});
