import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TestRunEvidence } from "../src/main/test-run-evidence.js";
import { getScenarioSyncBadge } from "../src/renderer/seo-ops-panel.js";
import type { ScriptSyncRow } from "../src/shared/sync-status.js";

test("TestRunEvidence.thumbnail prioritizes screencast frame and falls back to screenshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-evidence-thumb-"));
  const evidence = new TestRunEvidence(root);
  const caseId = "11111111-2222-3333-4444-555555555555";
  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const runDir = path.join(root, caseId, runId);
  await mkdir(runDir, { recursive: true });

  try {
    const dummyJpg = Buffer.from("fake-jpeg-content");
    const dummyPng = Buffer.from("fake-png-content");

    // Case 1: Both exist -> prioritizes recording-thumb.jpg
    await writeFile(path.join(runDir, "recording-thumb.jpg"), dummyJpg);
    await writeFile(path.join(runDir, "final.png"), dummyPng);

    const thumb1 = await evidence.thumbnail(caseId, { runId, caseId });
    assert.equal(thumb1, `data:image/jpeg;base64,${dummyJpg.toString("base64")}`);

    // Case 2: recording-thumb.jpg removed -> falls back to final.png
    await rm(path.join(runDir, "recording-thumb.jpg"));
    const thumb2 = await evidence.thumbnail(caseId, { runId, caseId });
    assert.equal(thumb2, `data:image/png;base64,${dummyPng.toString("base64")}`);

    // Case 3: Neither exists -> throws error
    await rm(path.join(runDir, "final.png"));
    await assert.rejects(
      () => evidence.thumbnail(caseId, { runId, caseId }),
      /Không có thumbnail hoặc screenshot/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getScenarioSyncBadge accurately maps all sync states and distinguishes Demo status", () => {
  const flowId = "flow-demo-1";

  // 1. Synced
  const syncedRows: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "synced" },
  ];
  const b1 = getScenarioSyncBadge(syncedRows, flowId);
  assert.equal(b1.label, "Synced");
  assert.equal(b1.statusKey, "synced");

  // 2. Not synced (local_only, local_changes, pending, unknown)
  for (const st of ["local_only", "local_changes", "remote_only", "pending", "unknown"] as const) {
    const notSyncedRows: ScriptSyncRow[] = [
      { script_id: flowId, package_key: "p1", name: "Demo", status: st },
    ];
    const b = getScenarioSyncBadge(notSyncedRows, flowId);
    assert.equal(b.label, "Not synced");
    assert.equal(b.statusKey, "not-synced");
  }

  // 3. Not synced when row is absent
  const emptyBadge = getScenarioSyncBadge([], "absent-flow");
  assert.equal(emptyBadge.label, "Not synced");
  assert.equal(emptyBadge.statusKey, "not-synced");

  // 4. Sync error
  const errorRows: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "sync_error", message: "Network timeout" },
  ];
  const bErr = getScenarioSyncBadge(errorRows, flowId);
  assert.equal(bErr.label, "Sync error");
  assert.equal(bErr.statusKey, "error");
  assert.equal(bErr.title, "Network timeout");

  // 5. Incomplete assets
  const incompRows: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "incomplete_assets" },
  ];
  const bIncomp = getScenarioSyncBadge(incompRows, flowId);
  assert.equal(bIncomp.label, "Incomplete");
  assert.equal(bIncomp.statusKey, "incomplete");

  // 6. Conflict
  const conflictRows: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "conflict" },
  ];
  const bConflict = getScenarioSyncBadge(conflictRows, flowId);
  assert.equal(bConflict.label, "Conflict");
  assert.equal(bConflict.statusKey, "conflict");

  // 7. Missing demo (blocked)
  const missingDemoRows: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "missing_demo", demo_reason: "Cần test video" },
  ];
  const bBlocked = getScenarioSyncBadge(missingDemoRows, flowId);
  assert.equal(bBlocked.label, "Missing demo");
  assert.equal(bBlocked.statusKey, "blocked");
  assert.equal(bBlocked.title, "Cần test video");

  // 8. Distinction: Demo Ready but Sync Not synced
  // Sync status is derived strictly from syncRows, NOT from demo status
  const demoReadySyncPending: ScriptSyncRow[] = [
    { script_id: flowId, package_key: "p1", name: "Demo", status: "local_changes", demo_status: "ready" },
  ];
  const bDist = getScenarioSyncBadge(demoReadySyncPending, flowId);
  assert.equal(bDist.label, "Not synced");
  assert.equal(bDist.statusKey, "not-synced");
});
