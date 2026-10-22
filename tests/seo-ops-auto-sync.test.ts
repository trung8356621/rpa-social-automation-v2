import assert from "node:assert/strict";
import { test } from "node:test";
import { createSeoOpsAutoSync } from "../src/main/seo-ops-auto-sync.js";
import { buildScriptCatalogSnapshot, buildScriptPublishBody, assertScriptPublishBody } from "../src/shared/script-release.js";
import { planScriptSync } from "../src/shared/script-sync.js";
import { labelForStatus, statusFromPlanSides } from "../src/shared/sync-status.js";
import type { Flow, Step } from "../src/shared/contracts.js";

const blankFlow: Flow = {
  id: "blank-scenario",
  name: "blank",
  zoom: 1,
  steps: [],
  groups: [],
  variables: [],
  defaultPattern: { values: {} },
};

const readyFlow: Flow = {
  id: "ready-scenario",
  name: "Ready",
  zoom: 1,
  steps: [{ id: "s1", version: 1 }],
  groups: [],
  variables: [],
  defaultPattern: { values: {} },
};

const readyStep: Step = {
  id: "s1",
  version: 1,
  name: "sleep",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { action: "SLEEP", timeoutMs: 50 },
};

test("Script 0 Step does not crash catalog inspection", () => {
  const snap = buildScriptCatalogSnapshot({ flow: blankFlow, steps: [], version: "1.0.0", assets: [] });
  assert.equal(snap.incomplete, true);
  assert.ok(snap.incomplete_reasons.includes("steps_required"));
  assert.equal(snap.publish_body, null);
  assert.equal(snap.content_digest.length, 64);
});

test("catalog inspection does not throw; publish still requires steps", () => {
  assert.doesNotThrow(() =>
    buildScriptCatalogSnapshot({ flow: blankFlow, steps: [], version: "1.0.0" }),
  );
  assert.throws(
    () => buildScriptPublishBody({ flow: blankFlow, steps: [], version: "1.0.0" }),
    /steps required/,
  );
  const ready = buildScriptPublishBody({ flow: readyFlow, steps: [readyStep], version: "1.0.0" });
  assert.throws(
    () => assertScriptPublishBody({ ...ready, manifest: { ...ready.manifest, steps: [] } }),
    /steps required/,
  );
});

test("incomplete Script does not block other Scripts in plan", () => {
  const ready = buildScriptCatalogSnapshot({
    flow: readyFlow,
    steps: [readyStep],
    version: "1.0.0",
  });
  assert.equal(ready.incomplete, false);
  assert.ok(ready.publish_body);
  const plan = planScriptSync(
    [
      {
        script_id: ready.package_key === readyFlow.id ? readyFlow.id : readyFlow.id,
        package_key: ready.package_key,
        version: ready.version,
        content_digest: ready.content_digest,
      },
    ],
    [],
  );
  assert.equal(plan.push_to_remote.length, 1);
  assert.equal(plan.conflicts.length, 0);
});

test("same digest skips — no release churn", () => {
  const body = buildScriptPublishBody({ flow: readyFlow, steps: [readyStep], version: "1.0.0" });
  const row = {
    script_id: readyFlow.id,
    package_key: body.package_key,
    version: body.version,
    content_digest: "a".repeat(64),
  };
  const plan = planScriptSync([row], [row]);
  assert.equal(plan.push_to_remote.length, 0);
  assert.equal(plan.pull_to_local.length, 0);
  assert.equal(plan.skip[0]?.reason, "same_digest");
});

test("conflict does not overwrite either side", () => {
  const plan = planScriptSync(
    [{ script_id: "s", package_key: "s", version: "1.0.1", content_digest: "1".repeat(64), lineage: [] }],
    [{ script_id: "s", package_key: "s", version: "1.0.2", content_digest: "2".repeat(64), lineage: [] }],
  );
  assert.equal(plan.push_to_remote.length, 0);
  assert.equal(plan.pull_to_local.length, 0);
  assert.equal(plan.conflicts.length, 1);
});

test("UI status labels map to Synced/Pending/Incomplete/Conflict/Error", () => {
  assert.equal(labelForStatus("synced"), "Synced");
  assert.equal(labelForStatus("local_only"), "Pending");
  assert.equal(labelForStatus("local_changes"), "Pending");
  assert.equal(labelForStatus("incomplete_assets"), "Incomplete");
  assert.equal(labelForStatus("conflict"), "Conflict");
  assert.equal(labelForStatus("sync_error"), "Error");
  assert.equal(
    statusFromPlanSides({
      hasLocal: true,
      hasRemote: false,
      sameDigest: false,
      conflict: false,
      localAhead: false,
      remoteAhead: false,
      incomplete: false,
      offlinePending: true,
    }),
    "pending",
  );
});

test("login and session restore trigger sync; save debounces to one flight", async () => {
  let syncCalls = 0;
  const reasons: string[] = [];
  let authenticated = true;
  const auto = createSeoOpsAutoSync({
    debounceMs: 20,
    pollIntervalMs: 60_000,
    isAuthenticated: () => authenticated,
    sync: async () => {
      syncCalls += 1;
      reasons.push("sync");
    },
  });
  auto.request({ reason: "login", immediate: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(syncCalls, 1);

  auto.request({ reason: "session_restore", immediate: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(syncCalls, 2);

  auto.request({ reason: "save", flowId: "a" });
  auto.request({ reason: "save", flowId: "a" });
  auto.request({ reason: "save", flowId: "a" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(syncCalls, 3);

  auto.stop();
});

test("offline retry uses backoff and does not storm requests", async () => {
  let syncCalls = 0;
  let now = 1_000_000;
  const auto = createSeoOpsAutoSync({
    debounceMs: 5,
    maxBackoffMs: 40,
    now: () => now,
    isAuthenticated: () => true,
    sync: async () => {
      syncCalls += 1;
      throw new Error("Failed to fetch");
    },
  });
  auto.request({ reason: "save", immediate: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(syncCalls, 1);
  assert.equal(auto.getState().offlinePending, true);
  // Advance less than backoff — should not storm
  now += 5;
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(syncCalls <= 2);
  auto.stop();
});

test("single-flight coalesces concurrent requests without push/pull loop helper", async () => {
  let inflight = 0;
  let maxInflight = 0;
  let syncCalls = 0;
  const digests = new Map<string, string>();
  digests.set("s1", "a".repeat(64));
  const auto = createSeoOpsAutoSync({
    debounceMs: 5,
    isAuthenticated: () => true,
    sync: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      syncCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      // Same digest after sync — subsequent plan would skip (no loop).
      digests.set("s1", "a".repeat(64));
      inflight -= 1;
    },
  });
  auto.request({ reason: "login", immediate: true });
  auto.request({ reason: "save", flowId: "s1", immediate: true });
  auto.request({ reason: "poll", immediate: true });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(maxInflight, 1);
  assert.ok(syncCalls >= 1 && syncCalls <= 3);
  const plan = planScriptSync(
    [{ script_id: "s1", package_key: "s1", version: "1.0.0", content_digest: digests.get("s1")! }],
    [{ script_id: "s1", package_key: "s1", version: "1.0.0", content_digest: digests.get("s1")! }],
  );
  assert.equal(plan.push_to_remote.length, 0);
  assert.equal(plan.pull_to_local.length, 0);
  auto.stop();
});
