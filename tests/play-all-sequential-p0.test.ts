import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";
import { playSequential } from "../src/shared/playback.js";
import type { Result, Step } from "../src/shared/contracts.js";

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
    ...extra,
  };
}

function okResult(step: Step, status: Result["status"] = "ACTION_SENT"): Result {
  return {
    id: `${step.id}-${status}`,
    stepId: step.id,
    version: step.version,
    action: step.payload.action,
    ok: status === "ACTION_SENT" || status === "VERIFIED",
    status,
    message: status,
    source: "base",
  };
}

/** Mirrors Creator Play All: validate current Step only, then execute. */
async function playAllSequential(
  store: Store,
  steps: Step[],
  execute: (step: Step) => Promise<Result[]>,
) {
  const flow = store.flow()!;
  const calls: string[] = [];
  const events: string[] = [];
  await playSequential(
    steps,
    async (step) => {
      store.assertStepExecutable(step.id, step.version, flow);
      calls.push(step.id);
      return execute(step);
    },
    (step, state) => events.push(`${step.id}:${state.status}`),
  );
  return { calls, events };
}

test("Test 1: valid 01–04 then invalid 05 — execute through 04, BLOCKED at 05, never 06", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seq-t1-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const s = [
      store.saveStep("S1", click({ target })),
      store.saveStep("S2", click({ target })),
      store.saveStep("S3", click({ target })),
      store.saveStep("S4", click({ target })),
      store.saveStep("S5", click()),
      store.saveStep("S6", click({ target })),
    ];
    // Full-flow gate must NOT be required for sequential authoring.
    assert.throws(() => store.assertFlowExecutable(store.flow()!), /thiếu ảnh ROI/);
    const steps = s.map((ref) => store.step(ref.id, ref.version));
    const { calls, events } = await playAllSequential(store, steps, async (step) => [
      okResult(step, step.name === "S4" ? "VERIFIED" : "ACTION_SENT"),
    ]);
    assert.deepEqual(calls, [s[0]!.id, s[1]!.id, s[2]!.id, s[3]!.id]);
    assert.ok(events.some((e) => e.startsWith(`${s[4]!.id}:blocked`)));
    assert.ok(!calls.includes(s[5]!.id));
    assert.match(events.at(-1) ?? "", /blocked/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 2: invalid Step 01 — no execution, BLOCKED at 01", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seq-t2-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const bad = store.saveStep("Bad", click());
    const ok = store.saveStep("Ok", click({ target }));
    const steps = [bad, ok].map((ref) => store.step(ref.id, ref.version));
    const { calls, events } = await playAllSequential(store, steps, async (step) => [okResult(step)]);
    assert.deepEqual(calls, []);
    assert.equal(events.at(-1), `${bad.id}:blocked`);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 3: runtime BLOCKED at Step 03 — no Step 04", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seq-t3-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const s = [1, 2, 3, 4].map((i) => store.saveStep(`S${i}`, click({ target })));
    const steps = s.map((ref) => store.step(ref.id, ref.version));
    const { calls } = await playAllSequential(store, steps, async (step) => [
      okResult(step, step.id === s[2]!.id ? "BLOCKED" : "ACTION_SENT"),
    ]);
    assert.deepEqual(calls, [s[0]!.id, s[1]!.id, s[2]!.id]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 4: Group children execute in exact Flow order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seq-t4-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const out = store.saveStep("Out", click({ target }));
    const g = [1, 2, 3, 4].map((i) => store.saveStep(`G${i}`, click({ target })));
    const after = store.saveStep("After", click({ target }));
    store.organize(
      [{ id: "tag", name: "tag", slug: "tag", collapsed: false, stepIds: g.map((x) => x.id) }],
      [out.id, ...g.map((x) => x.id), after.id],
    );
    const steps = store.flow()!.steps.map((ref) => store.step(ref.id, ref.version));
    const { calls } = await playAllSequential(store, steps, async (step) => [okResult(step)]);
    assert.deepEqual(calls, [out.id, ...g.map((x) => x.id), after.id]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 5: Test Lab partial — Cases may pin invalid later Steps; listFlowExecutableIssues still reports them but Case must not require full-flow assert before Session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "seq-t5-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const ok1 = store.saveStep("S1", click({ target }));
    const bad = store.saveStep("S2", click());
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "partial",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [
        { id: ok1.id, version: ok1.version },
        { id: bad.id, version: bad.version },
      ],
    });
    // Case config validates without assertFlowExecutable.
    assert.doesNotThrow(() => lab.validate(item, false));
    assert.throws(() => store.assertFlowExecutable(store.flow()!), /thiếu ảnh ROI/);
    // Sequential Case execution: first Step ok, second blocked — never PASS overall.
    const steps = item.stepVersions!.map((ref) => store.step(ref.id, ref.version));
    const { calls, events } = await playAllSequential(store, steps, async (step) => [okResult(step, "VERIFIED")]);
    assert.deepEqual(calls, [ok1.id]);
    assert.match(events.at(-1) ?? "", /blocked/);
    assert.notEqual(events.at(-1), `${bad.id}:pass`);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 6: Delete unreferenced Step keeps Flow order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-t6-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    const a = store.saveStep("A", click({ target }));
    const b = store.saveStep("B", click({ target }));
    const c = store.saveStep("C", click({ target }));
    store.removeFlowStep(b.id);
    assert.deepEqual(
      store.flow()!.steps.map((ref) => ref.id),
      [a.id, c.id],
    );
    // Immutable version row still readable.
    assert.equal(store.step(b.id, b.version).name, "B");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 7: Delete Step referenced by Test Case requires detach; history lastResult kept", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "del-t7-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const step = store.saveStep("Pinned", click({ target }));
    const other = store.saveStep("Keep", click({ target }));
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "hist",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://example.com/",
      values: {},
      stepVersions: [{ id: step.id, version: step.version }],
    });
    lab.result(item.id, {
      runId: "old-run",
      caseId: item.id,
      status: "ACTION_SENT",
      startedAt: "2026-11-18T00:00:00.000Z",
      finishedAt: "2026-11-18T00:00:01.000Z",
      message: "historical",
      steps: [{ stepId: step.id, name: "Pinned", version: 1, status: "ACTION_SENT", message: "ok" }],
    });
    const refs = lab.casesReferencingStep(store.flow()!.id, step.id);
    assert.equal(refs.length, 1);
    lab.detachStepFromCases(store.flow()!.id, step.id);
    store.removeFlowStep(step.id);
    const after = lab.get(item.id);
    assert.equal((after.stepVersions ?? []).length, 0);
    assert.equal(after.lastResult?.runId, "old-run");
    assert.equal(after.lastResult?.steps?.[0]?.stepId, step.id);
    assert.ok(store.flow()!.steps.some((ref) => ref.id === other.id));
    assert.equal(store.step(step.id, step.version).name, "Pinned");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Test 8: WordPress-like valid Flow remains fully executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wp-t8-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("dd", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://mayhopphat.com/wp-login.php" });
    store.saveStep("user", { action: "CLICK_AND_TYPE", method: "auto", threshold: 0.96, timeoutMs: 3000, target, text: "admin" });
    store.saveStep("pass", { action: "CLICK_AND_TYPE", method: "auto", threshold: 0.96, timeoutMs: 3000, target, text: "secret" });
    store.saveStep("login", click({ target }));
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));
    const steps = store.flow()!.steps.map((ref) => store.step(ref.id, ref.version));
    const { calls } = await playAllSequential(store, steps, async (step) => [okResult(step)]);
    assert.equal(calls.length, 3);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
