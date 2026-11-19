import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";
const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};

function click(extra: Record<string, unknown> = {}) {
  return {
    action: "CLICK_TARGET" as const,
    method: "auto" as const,
    threshold: 0.96,
    timeoutMs: 3000,
    target,
    ...extra,
  };
}

/** Mirrors main.ts deleteFlowStep commit order (Flow first, then detach). */
function deleteFlowStepCommit(
  store: Store,
  lab: TestLab,
  stepId: string,
  opts: { confirmed: boolean; detachFromTestCases?: boolean },
) {
  if (!opts.confirmed) throw new Error("Cần xác nhận trước khi xóa Step.");
  const flow = store.flow();
  if (!flow) throw new Error("Tạo Flow trước.");
  if (!flow.steps.some((ref) => ref.id === stepId))
    throw new Error("Step không thuộc Flow đang mở.");
  const refs = lab.casesReferencingStep(flow.id, stepId);
  if (refs.length && !opts.detachFromTestCases) {
    throw new Error(
      `STEP_REFERENCED_BY_TEST_CASES: Step đang được ghim bởi ${refs.length} Test Case (${refs.map((c) => c.name).join(", ")}).`,
    );
  }
  const flowBefore = structuredClone(flow);
  store.removeFlowStep(stepId);
  if (refs.length && opts.detachFromTestCases) {
    try {
      lab.detachStepFromCases(flow.id, stepId);
    } catch (error) {
      store.saveFlow(flowBefore);
      throw error;
    }
  }
  return { flow: store.flow()!, refsDetached: refs.map((c) => c.id) };
}

test("Delete unreferenced Step removes from Flow + Group; history version kept", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-unref-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    const a = store.saveStep("A", click());
    const b = store.saveStep("B", click());
    const c = store.saveStep("C", click());
    store.organize(
      [{ id: "g1", name: "G", slug: "g", stepIds: [a.id, b.id], collapsed: false }],
      [a.id, b.id, c.id],
    );
    const result = deleteFlowStepCommit(store, new TestLab(store, new BrowserSessions(store)), b.id, {
      confirmed: true,
    });
    assert.deepEqual(
      result.flow.steps.map((ref) => ref.id),
      [a.id, c.id],
    );
    assert.deepEqual(result.flow.groups?.[0]?.stepIds, [a.id]);
    assert.equal(store.step(b.id, b.version).name, "B");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Delete referenced Step without detach → IPC reject; Flow unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-ref-block-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const step = store.saveStep("Pinned", click());
    const keep = store.saveStep("Keep", click());
    const lab = new TestLab(store, sessions);
    lab.save(undefined, {
      name: "case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [
        { id: step.id, version: step.version },
        { id: keep.id, version: keep.version },
      ],
    });
    assert.throws(
      () => deleteFlowStepCommit(store, lab, step.id, { confirmed: true }),
      /STEP_REFERENCED_BY_TEST_CASES/,
    );
    assert.deepEqual(
      store.flow()!.steps.map((ref) => ref.id),
      [step.id, keep.id],
    );
    assert.equal(lab.casesReferencingStep(store.flow()!.id, step.id).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Delete referenced Step with detach → Flow + Case pins updated; lastResult kept", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-ref-ok-"));
  const dbPath = path.join(root, "creator.sqlite");
  const store = new Store(dbPath);
  let stepId = "";
  let keepId = "";
  let caseId = "";
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const step = store.saveStep("Pinned", click());
    const keep = store.saveStep("Keep", click());
    stepId = step.id;
    keepId = keep.id;
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [
        { id: step.id, version: step.version },
        { id: keep.id, version: keep.version },
      ],
    });
    caseId = item.id;
    lab.result(item.id, {
      runId: "hist-run",
      caseId: item.id,
      status: "ACTION_SENT",
      startedAt: "2026-11-19T00:00:00.000Z",
      finishedAt: "2026-11-19T00:00:01.000Z",
      message: "historical",
      steps: [
        {
          stepId: step.id,
          name: "Pinned",
          version: 1,
          status: "ACTION_SENT",
          message: "ok",
        },
      ],
    });
    const outcome = deleteFlowStepCommit(store, lab, step.id, {
      confirmed: true,
      detachFromTestCases: true,
    });
    assert.deepEqual(
      outcome.flow.steps.map((ref) => ref.id),
      [keep.id],
    );
    assert.equal(lab.casesReferencingStep(store.flow()!.id, step.id).length, 0);
    const after = lab.get(item.id);
    assert.deepEqual(
      (after.stepVersions ?? []).map((ref) => ref.id),
      [keep.id],
    );
    assert.equal(after.lastResult?.runId, "hist-run");
    assert.equal(after.lastResult?.steps?.[0]?.stepId, step.id);
    assert.equal(store.step(step.id, step.version).name, "Pinned");
  } finally {
    store.close();
  }

  // Reopen SQLite: deleted Step stays absent; history version still readable.
  const reopened = new Store(dbPath);
  try {
    assert.deepEqual(
      reopened.flow()!.steps.map((ref) => ref.id),
      [keepId],
    );
    assert.ok(!reopened.flow()!.steps.some((ref) => ref.id === stepId));
    assert.equal(reopened.step(stepId, 1).name, "Pinned");
    const lab = new TestLab(reopened, new BrowserSessions(reopened));
    assert.equal(lab.get(caseId).lastResult?.runId, "hist-run");
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cancel path: confirmed=false leaves Flow and pins unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-cancel-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const step = store.saveStep("Pinned", click());
    const lab = new TestLab(store, sessions);
    lab.save(undefined, {
      name: "case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [{ id: step.id, version: step.version }],
    });
    assert.throws(
      () => deleteFlowStepCommit(store, lab, step.id, { confirmed: false }),
      /Cần xác nhận/,
    );
    assert.equal(store.flow()!.steps.length, 1);
    assert.equal(lab.casesReferencingStep(store.flow()!.id, step.id).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
