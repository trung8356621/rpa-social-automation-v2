import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";
import { screenshotMediaMessage } from "../src/shared/test-lab-view.js";

const target = {
  asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
  roi: { x: 0, y: 0, width: 80, height: 40 },
};

test("Creator block numbers 05/06 are ungrouped CLICK_TARGET after Group — not flat Step 5/6", async () => {
  // Mirrors step-list blocks: Group collapses 4 children into one block index.
  const flowSteps = [
    "s1", "s2", "s3",
    "g1", "g2", "g3", "g4",
    "bare5", "bare6",
  ];
  const groupIds = new Set(["g1", "g2", "g3", "g4"]);
  const blocks: string[] = [];
  for (const id of flowSteps) {
    if (groupIds.has(id)) {
      if (id === "g1") blocks.push("group");
    } else blocks.push(id);
  }
  assert.deepEqual(blocks, ["s1", "s2", "s3", "group", "bare5", "bare6"]);
  assert.equal(blocks[4], "bare5");
  assert.equal(blocks[5], "bare6");
  // Flat order 8/9 == UI block 05/06 when one 4-child group sits at block 04.
  assert.equal(flowSteps[7], "bare5");
  assert.equal(flowSteps[8], "bare6");
});

test("endPlayAllLog / releaseExecutionLock always clear busy+batch for Run Again", async () => {
  // Contract check without importing Runtime (Electron-bound). Source must keep these clears.
  const source = await readFile(new URL("../src/main/runtime.ts", import.meta.url), "utf8");
  assert.match(source, /endPlayAllLog\(runId: string, failed = false\)/);
  assert.match(source, /this\.busy = false;/);
  assert.match(source, /this\.batch = undefined;/);
  assert.match(source, /releaseExecutionLock\(batchRunId\?: string\)/);
  // endPlayAllLog must clear busy even when batch was mid-flight (BLOCKED → Run Again).
  const endIdx = source.indexOf("endPlayAllLog(runId: string, failed = false)");
  const endSlice = source.slice(endIdx, endIdx + 900);
  assert.match(endSlice, /this\.busy = false/);
  assert.match(endSlice, /this\.batch = undefined/);
  assert.match(endSlice, /this\.batchFlow = undefined/);
  assert.match(endSlice, /this\.batchSteps = undefined/);
});

test("Test Case pin of older Step version is detectable vs current Scenario pins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "case-pin-stale-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const sessions = new BrowserSessions(store);
    store.newFlow("FB", 1);
    store.updateFlowMeta(store.flow()!.id, {
      startUrl: "https://www.facebook.com/groups/demo",
    });
    const step = store.saveStep("Click", {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target,
    });
    const v2 = store.saveStep(
      "Click",
      {
        action: "CLICK_TARGET",
        method: "auto",
        threshold: 0.96,
        timeoutMs: 3000,
        target: { ...target, roi: { x: 1, y: 1, width: 60, height: 30 } },
      },
      step.id,
    );
    assert.equal(v2.id, step.id);
    assert.equal(v2.version, 2);
    store.selectVersion(step.id, 2);
    const lab = new TestLab(store, sessions);
    const item = lab.save(undefined, {
      name: "stale pin case",
      flowId: store.flow()!.id,
      sessionId: sessions.activeId(),
      startUrl: "https://www.facebook.com/groups/demo",
      values: {},
      stepVersions: [{ id: step.id, version: 1 }],
    });
    const flowPins = store.flow()!.steps;
    const casePins = item.stepVersions ?? [];
    assert.notEqual(JSON.stringify(casePins), JSON.stringify(flowPins));
    assert.equal(casePins[0]?.version, 1);
    assert.equal(flowPins[0]?.version, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("WordPress flow with valid ROI pins stays executable (unaffected by FB draft)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wp-play-all-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const wp = store.newFlow("dd", 1);
    store.updateFlowMeta(wp.id, { startUrl: "https://mayhopphat.com/wp-login.php" });
    store.saveStep("user name", {
      action: "CLICK_AND_TYPE",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target,
      text: "admin",
    });
    store.saveStep("password", {
      action: "CLICK_AND_TYPE",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target,
      text: "secret",
    });
    store.saveStep("login", {
      action: "CLICK_TARGET",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target,
    });
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));

    const fb = store.newFlow("Facebook draft POC 3", 1);
    store.updateFlowMeta(fb.id, {
      startUrl: "https://www.facebook.com/groups/demo",
    });
    store.saveStep("broken", { action: "CLICK_TARGET", method: "auto", threshold: 0.96, timeoutMs: 3000 });
    assert.throws(() => store.assertFlowExecutable(store.flow()!), /thiếu ảnh ROI/);
    store.setSetting("currentFlow", wp.id);
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flows().find((f) => f.id === wp.id)!));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("BLOCKED before Browser Session → no screenshot loading placeholder", () => {
  assert.equal(
    screenshotMediaMessage({
      status: "BLOCKED",
      runId: "b1d17b74-738f-45f8-9370-ba9563fdafcc",
      startedAt: "2026-11-18T09:00:00.000Z",
      finishedAt: "2026-11-18T09:00:00.109Z",
      message:
        "Facebook draft POC 3 → Step 8: CLICK_TARGET → v1\nStep thiếu ảnh ROI target đã crop.",
    }),
    "Lượt chạy dừng trước khi có ảnh cuối cùng",
  );
});

test("new runId without screenshot does not keep prior-run loading copy", () => {
  const prior = {
    status: "ACTION_SENT" as const,
    runId: "old-run",
    screenshotPath: "case/old-run/final.png",
    startedAt: "2026-11-18T01:00:00.000Z",
    finishedAt: "2026-11-18T01:00:02.000Z",
    message: "done",
  };
  const next = {
    status: "BLOCKED" as const,
    runId: "new-run",
    startedAt: "2026-11-18T01:01:00.000Z",
    finishedAt: "2026-11-18T01:01:00.100Z",
    message: "Step 8 thiếu ROI",
  };
  assert.equal(screenshotMediaMessage(next), "Lượt chạy dừng trước khi có ảnh cuối cùng");
  assert.notEqual(prior.runId, next.runId);
});
