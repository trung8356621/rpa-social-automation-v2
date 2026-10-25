import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";

test("new and edited Steps persist immutable versions across reload without changing Script release", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "step-save-regression-"));
  const file = path.join(root, "creator.sqlite");
  let store = new Store(file);
  try {
    const flow = store.newFlow("Draft v1", 1);
    store.setSetting(`seoOpsVersion:${flow.id}`, "1");
    const v1 = store.saveStep("Scroll", { action: "SCROLL", deltaY: -100 });
    const v2 = store.saveStep("Scroll changed", { action: "SCROLL", deltaY: -250 }, v1.id);
    assert.equal(v2.version, 2);
    assert.equal(store.step(v1.id, 1).payload.deltaY, -100);
    assert.equal(store.flow()!.steps[0].version, 2);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");
    store.close();

    store = new Store(file);
    assert.equal(store.flow()!.steps[0].version, 2);
    assert.equal(store.step(v1.id, 2).payload.deltaY, -250);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Step save rolls back both new version and Scenario pin", () => {
  const store = new Store(":memory:");
  try {
    store.newFlow("Atomic", 1);
    const v1 = store.saveStep("Scroll", { action: "SCROLL", deltaY: -100 });
    store.db.exec("CREATE TRIGGER reject_flow_update BEFORE UPDATE ON flows BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => store.saveStep("Broken", { action: "SCROLL", deltaY: -200 }, v1.id), /injected/);
    assert.equal(store.steps().filter(step => step.id === v1.id).length, 1);
    assert.equal(store.flow()!.steps[0].version, 1);
  } finally {
    store.close();
  }
});
