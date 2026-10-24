import test from "node:test";
import assert from "node:assert/strict";
import { assertIpcSerializable, executeManualSync, syncIpcDiagnostic } from "../src/shared/sync-ipc.js";

const cloneableResult = () => ({
  plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
  results: [{ script_id: "script-1", action: "skip", ok: true, message: "same_digest" }],
  rows: [{ script_id: "script-1", package_key: "script-1", name: "Script 1", status: "synced" as const }],
});

test("manual Sync IPC returns a structured-clone-compatible success payload", async () => {
  assert.doesNotThrow(() => assertIpcSerializable({ type: "seoOpsSyncFlow", flowId: "script-1", version: "1.0.0" }));
  const response = await executeManualSync(async () => cloneableResult());
  assert.equal(response.ok, true);
  assert.doesNotThrow(() => structuredClone(response));
  if (response.ok) assert.equal(response.rows[0].status, "synced");
});

test("regression: the former label function is identified as the exact clone failure", () => {
  assert.throws(() => assertIpcSerializable({ ...cloneableResult(), label: () => "Synced" }), (error: unknown) => {
    assert.equal((error as { path?: string }).path, "$.label");
    assert.match((error as Error).message, /unsupported function/);
    return true;
  });
});

test("manual Sync serializes unsupported return values into a safe plain diagnostic", async () => {
  let loggedPath = "";
  const response = await executeManualSync(async () => ({ ...cloneableResult(), bad: Symbol("bad") } as never),
    (_error, detail) => { loggedPath = detail.path ?? ""; });
  assert.deepEqual(response.ok, false);
  assert.doesNotThrow(() => structuredClone(response));
  if (!response.ok) {
    assert.equal(response.error.code, "IPC_SERIALIZATION");
    assert.equal(response.error.path, "$.bad");
    assert.equal(response.error.message, "Dữ liệu Sync không thể chuyển về giao diện.");
  }
  assert.equal(loggedPath, "$.bad");
});

test("manual Sync errors distinguish network, authentication and sync failures", async () => {
  for (const [message, code] of [
    ["Failed to fetch", "NETWORK_FAILURE"],
    ["SEO_OPS_SYNC: unauthenticated", "AUTHENTICATION_FAILURE"],
    ["SEO_OPS_SYNC: plan failed", "SYNC_FAILURE"],
  ] as const) {
    const response = await executeManualSync(async () => { throw new Error(message); });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, code);
  }
  assert.equal(syncIpcDiagnostic(new Error("An object could not be cloned.")).code, "IPC_SERIALIZATION");
});
