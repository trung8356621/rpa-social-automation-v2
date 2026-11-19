import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";
import {
  buildTestCaseRerunPrep,
  priorResultPreserved,
  RERUN_PREP_MESSAGE,
} from "../src/shared/test-lab-rerun-prep.js";

const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};

function click() {
  return {
    action: "CLICK_TARGET" as const,
    method: "auto" as const,
    threshold: 0.96,
    timeoutMs: 3000,
    target,
  };
}

test("RERUN_PREP_MESSAGE is the required preparation copy", () => {
  assert.equal(RERUN_PREP_MESSAGE, "Chuẩn bị Browser trước khi chạy lại");
});

test("buildTestCaseRerunPrep keeps prior runId and does not invent a new run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rerun-prep-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const step = store.saveStep("A", click());
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [{ id: step.id, version: step.version }],
    });
    lab.result(item.id, {
      runId: "prior-run",
      caseId: item.id,
      status: "ACTION_SENT",
      startedAt: "2026-11-19T00:00:00.000Z",
      finishedAt: "2026-11-19T00:00:01.000Z",
      message: "prior",
      recordingPath: `${item.id}/prior-run/recording.webm`,
    });
    const fresh = lab.get(item.id);
    const prep = buildTestCaseRerunPrep(fresh);
    assert.equal(prep.caseId, item.id);
    assert.equal(prep.previousRunId, "prior-run");
    assert.equal(prep.flowId, fresh.flowId);
    assert.equal(prep.sessionId, fresh.sessionId);
    // Prep snapshot must not alter lastResult.
    assert.equal(lab.get(item.id).lastResult?.runId, "prior-run");
    assert.equal(lab.get(item.id).lastResult?.recordingPath, `${item.id}/prior-run/recording.webm`);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel prep semantics: priorResultPreserved when lastResult unchanged", () => {
  const prior = {
    runId: "r1",
    status: "PASS" as const,
    startedAt: "a",
    finishedAt: "b",
    message: "ok",
    recordingPath: "c/r1/recording.webm",
  };
  assert.equal(priorResultPreserved(prior, { ...prior }), true);
  assert.equal(
    priorResultPreserved(prior, { ...prior, runId: "r2", status: "ERROR" }),
    false,
  );
});

test("initial Run path remains distinct: prepare does not require overwriting lastResult", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rerun-vs-run-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    store.saveStep("A", click());
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: store.flow()!.steps,
    });
    // Never-run Case can still build prep (Run Again from empty is rare); previousRunId absent.
    const prep = buildTestCaseRerunPrep(lab.get(item.id));
    assert.equal(prep.previousRunId, undefined);
    assert.equal(lab.get(item.id).lastResult, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
