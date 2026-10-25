import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { BrowserSessions } from "../src/main/browser-sessions.js";
import { TestLab } from "../src/main/test-lab.js";

test("Scenario Test Cases snapshot pins and Quick Acceptance is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scenario-test-integration-"));
  const store = new Store(path.join(root, "creator.sqlite"));
  try {
    const flow = store.newFlow("Publish draft", 1);
    const firstStep = store.saveStep("Wait", { action: "SLEEP", sleepMs: 10 });
    const lab = new TestLab(store, new BrowserSessions(store));
    const first = lab.ensureForScenario(flow.id, true);
    const repeated = lab.ensureForScenario(flow.id, true);
    assert.equal(repeated.id, first.id);
    assert.equal(lab.read().cases.length, 1);
    assert.deepEqual(first.stepVersions, [{ id: firstStep.id, version: firstStep.version }]);

    const nextStep = store.saveStep("Wait", { action: "SLEEP", sleepMs: 20 }, firstStep.id);
    assert.equal(store.flow()!.steps[0].version, nextStep.version);
    assert.equal(lab.validate(first, false).steps[0].version, firstStep.version,
      "historical Test Case keeps its original pins after Scenario changes");

    const refreshed = lab.ensureForScenario(flow.id, true);
    assert.equal(refreshed.id, first.id);
    assert.equal(refreshed.stepVersions?.[0].version, nextStep.version,
      "Quick Acceptance reloads current pins without creating a duplicate");

    const additional = lab.ensureForScenario(flow.id, false);
    assert.equal(additional.stepVersions?.[0].version, nextStep.version);
    assert.equal(lab.read().cases.length, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
