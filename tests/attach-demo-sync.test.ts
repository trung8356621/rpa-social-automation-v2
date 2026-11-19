import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAttachDemoSyncMessage,
  interpretSyncForFlow,
} from "../src/shared/attach-demo-sync.js";
import { canUseAsScriptDemo } from "../src/shared/video-demo-policy.js";
import type { ManualSyncResponse } from "../src/shared/sync-ipc.js";

const flowId = "48f48584-75b8-4e01-8bff-20a95be2daba";

test("BLOCKED run with recording is selectable as Script Demo", () => {
  assert.equal(
    canUseAsScriptDemo({
      status: "BLOCKED",
      runId: "run-1",
      recordingPath: "case/run-1/recording.webm",
    }).ok,
    true,
  );
});

test("interpretSyncForFlow: published / already synced / blocked / connection", () => {
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
      local_version: "2",
      published_version: "2",
    }],
  };
  assert.equal(interpretSyncForFlow(flowId, published).kind, "published");
  assert.equal(
    formatAttachDemoSyncMessage(interpretSyncForFlow(flowId, published)),
    "Demo saved → Published v2",
  );

  const unchanged: ManualSyncResponse = {
    ok: true,
    plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
    results: [{ script_id: flowId, action: "unchanged", ok: true, message: "same_digest" }],
    rows: [],
  };
  assert.equal(interpretSyncForFlow(flowId, unchanged).kind, "already_synced");
  assert.equal(
    formatAttachDemoSyncMessage(interpretSyncForFlow(flowId, unchanged)),
    "Demo saved → Already synchronized",
  );

  const blocked: ManualSyncResponse = {
    ok: true,
    plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
    results: [{
      script_id: flowId,
      action: "publish_blocked",
      ok: true,
      message: "Invalid Step — 076fa189:Action cần ảnh target được crop.",
    }],
    rows: [],
  };
  const blockedOutcome = interpretSyncForFlow(flowId, blocked);
  assert.equal(blockedOutcome.kind, "blocked");
  assert.match(
    formatAttachDemoSyncMessage(blockedOutcome),
    /^Demo saved → Sync blocked:/,
  );

  const offline: ManualSyncResponse = {
    ok: false,
    error: {
      code: "NETWORK_FAILURE",
      category: "network",
      message: "Không kết nối được SEO-OPS.",
      technicalMessage: "failed to fetch",
    },
  };
  assert.equal(interpretSyncForFlow(flowId, offline).kind, "connection_failed");
  assert.equal(
    formatAttachDemoSyncMessage(interpretSyncForFlow(flowId, offline)),
    "Demo saved → Connection failed: Retry Sync",
  );
});

test("one Script result does not invent outcomes for other Scripts", () => {
  const sync: ManualSyncResponse = {
    ok: true,
    plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
    results: [
      { script_id: "other-script", action: "push", ok: true, message: "pushed" },
      { script_id: flowId, action: "publish_blocked", ok: true, message: "missing_demo" },
    ],
    rows: [],
  };
  assert.equal(interpretSyncForFlow(flowId, sync).kind, "blocked");
  assert.equal(interpretSyncForFlow("other-script", sync).kind, "published");
});
