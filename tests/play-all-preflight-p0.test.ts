import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { flowUiStepNumbers } from "../src/shared/flow-step-numbers.js";
import {
  PLAY_ALL_PREFLIGHT_BLOCKED,
  formatPlayAllPreflightBlocked,
} from "../src/shared/play-all-preflight.js";
import { playSequential, playbackResult } from "../src/shared/playback.js";
import type { Flow, Result, Step } from "../src/shared/contracts.js";

const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};

function clickPayload(extra: Record<string, unknown> = {}) {
  return {
    action: "CLICK_TARGET" as const,
    method: "auto" as const,
    threshold: 0.96,
    timeoutMs: 3000,
    ...extra,
  };
}

function resultFor(step: Step, status: Result["status"] = "ACTION_SENT"): Result {
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

test("UI block numbers place ungrouped Steps after a Group as 05/06", () => {
  const flow = {
    id: "f1",
    name: "FB",
    zoom: 1,
    steps: [
      { id: "a", version: 1 },
      { id: "b", version: 1 },
      { id: "c", version: 1 },
      { id: "g1", version: 1 },
      { id: "g2", version: 1 },
      { id: "g3", version: 1 },
      { id: "g4", version: 1 },
      { id: "bare5", version: 1 },
      { id: "bare6", version: 1 },
    ],
    groups: [
      { id: "tag", name: "tag", slug: "tag", collapsed: false, stepIds: ["g1", "g2", "g3", "g4"] },
    ],
  } as Flow;
  const ui = flowUiStepNumbers(flow);
  assert.equal(ui.get("a"), "01");
  assert.equal(ui.get("g1"), "04.1");
  assert.equal(ui.get("bare5"), "05");
  assert.equal(ui.get("bare6"), "06");
});

test("listFlowExecutableIssues returns every invalid pinned Step without executing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "play-all-preflight-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://www.facebook.com/groups/demo" });
    // Mirror FB draft layout: 3 ungrouped + Group(4) + 2 ungrouped invalid → UI 05/06.
    const s1 = store.saveStep("Ok1", clickPayload({ target }));
    const s2 = store.saveStep("Ok2", clickPayload({ target }));
    const s3 = store.saveStep("Ok3", clickPayload({ target }));
    const g1 = store.saveStep("G1", clickPayload({ target }));
    const g2 = store.saveStep("G2", { action: "SLEEP", sleepMs: 10 });
    const g3 = store.saveStep("G3", clickPayload({ target }));
    const g4 = store.saveStep("G4", clickPayload({ target }));
    const bad5 = store.saveStep("Bad5", clickPayload());
    const bad6 = store.saveStep("Bad6", clickPayload());
    store.organize(
      [{ id: "g", name: "tag", slug: "tag", collapsed: false, stepIds: [g1.id, g2.id, g3.id, g4.id] }],
      [s1.id, s2.id, s3.id, g1.id, g2.id, g3.id, g4.id, bad5.id, bad6.id],
    );
    const flow = store.flow()!;
    const issues = store.listFlowExecutableIssues(flow);
    assert.equal(issues.length, 2);
    assert.deepEqual(
      issues.map((i) => i.flatOrder),
      [8, 9],
    );
    assert.match(issues[0]!.reason, /thiếu ảnh ROI/);
    const ui = flowUiStepNumbers(flow);
    assert.equal(ui.get(bad5.id), "05");
    assert.equal(ui.get(bad6.id), "06");
    const message = formatPlayAllPreflightBlocked(
      issues.map((issue) => ({
        stepId: issue.stepId,
        version: issue.version,
        name: issue.name,
        flatOrder: issue.flatOrder,
        uiNumber: ui.get(issue.stepId)!,
        reason: issue.reason,
        reasonCode: issue.reasonCode,
      })),
    );
    assert.match(message, new RegExp(PLAY_ALL_PREFLIGHT_BLOCKED));
    assert.match(message, /Chưa thực thi Step nào/);
    assert.match(message, /UI 05 · flat Step 08/);
    assert.match(message, /UI 06 · flat Step 09/);
    // Safety gate still throws on first issue for callers that use assertFlowExecutable.
    assert.throws(() => store.assertFlowExecutable(flow), /thiếu ảnh ROI|→ Step /);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("4 valid Steps execute sequentially 01→02→03→04", async () => {
  const steps = [1, 2, 3, 4].map((i) => ({
    id: `s${i}`,
    version: 1,
    name: `Step ${i}`,
    createdAt: "f",
    payload: clickPayload({ target }),
  }));
  const calls: string[] = [];
  await playSequential(
    steps,
    async (s) => {
      calls.push(s.id);
      return [resultFor(s)];
    },
    () => {},
  );
  assert.deepEqual(calls, ["s1", "s2", "s3", "s4"]);
});

test("preflight-invalid Step 05 means zero executions when Play All is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "play-all-refuse-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    for (let i = 1; i <= 4; i++) store.saveStep(`Ok${i}`, clickPayload({ target }));
    store.saveStep("Bad5", clickPayload());
    const issues = store.listFlowExecutableIssues(store.flow()!);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.flatOrder, 5);
    const executed: string[] = [];
    // Mirrors renderer: on preflight failure, playSequential is never called.
    const preflightBlocked = issues.length > 0;
    if (!preflightBlocked) {
      await playSequential(
        store.flow()!.steps.map((ref) => store.step(ref.id, ref.version)),
        async (s) => {
          executed.push(s.id);
          return [resultFor(s)];
        },
        () => {},
      );
    }
    assert.equal(preflightBlocked, true);
    assert.deepEqual(executed, []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("after fixing invalid Step, Play All order restarts from Step 01", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "play-all-fix-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("POC", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    const ok = [1, 2, 3, 4].map((i) => store.saveStep(`Ok${i}`, clickPayload({ target })));
    const bad = store.saveStep("Bad5", clickPayload());
    assert.equal(store.listFlowExecutableIssues(store.flow()!).length, 1);
    store.saveStep("Bad5", clickPayload({ target }), bad.id);
    assert.equal(store.listFlowExecutableIssues(store.flow()!).length, 0);
    const steps = store.flow()!.steps.map((ref) => store.step(ref.id, ref.version));
    const calls: string[] = [];
    await playSequential(
      steps,
      async (s) => {
        calls.push(s.id);
        return [resultFor(s)];
      },
      () => {},
    );
    assert.deepEqual(calls, [...ok.map((s) => s.id), bad.id]);
    assert.equal(calls[0], ok[0]!.id);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime BLOCKED at Step 02 stops before Step 03", async () => {
  const steps = [1, 2, 3].map((i) => ({
    id: `s${i}`,
    version: 1,
    name: `Step ${i}`,
    createdAt: "f",
    payload: clickPayload({ target }),
  }));
  const calls: string[] = [];
  await playSequential(
    steps,
    async (s) => {
      calls.push(s.id);
      return [resultFor(s, s.id === "s2" ? "BLOCKED" : "ACTION_SENT")];
    },
    () => {},
  );
  assert.deepEqual(calls, ["s1", "s2"]);
});

test("Group children run in flattened flow.steps order", async () => {
  const ordered = ["out", "g-a", "g-b", "after"].map((id, i) => ({
    id,
    version: 1,
    name: id,
    createdAt: "f",
    payload: clickPayload({ target }),
  }));
  const calls: string[] = [];
  await playSequential(
    ordered,
    async (s) => {
      calls.push(s.id);
      return [resultFor(s)];
    },
    () => {},
  );
  assert.deepEqual(calls, ["out", "g-a", "g-b", "after"]);
});

test("single Step play remains independent of Play All preflight list", async () => {
  const step = {
    id: "solo",
    version: 1,
    name: "Solo",
    createdAt: "f",
    payload: clickPayload({ target }),
  };
  const calls: string[] = [];
  await playSequential(
    [step],
    async (s) => {
      calls.push(s.id);
      return [resultFor(s)];
    },
    () => {},
  );
  assert.deepEqual(calls, ["solo"]);
  const state = playbackResult([resultFor(step)]);
  assert.equal(state.status, "pass");
  assert.equal(state.resultStatus, "ACTION_SENT");
});

test("assertFlowExecutable / Test Lab contract still blocks on missing ROI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-lab-contract-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    store.newFlow("Case", 1);
    store.updateFlowMeta(store.flow()!.id, { startUrl: "https://example.com/" });
    store.saveStep("broken", clickPayload());
    assert.throws(() => store.assertFlowExecutable(store.flow()!), /thiếu ảnh ROI/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
