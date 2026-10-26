import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import type { Variable, Flow } from "../src/shared/contracts.js";
import { buildScriptCatalogSnapshot } from "../src/shared/script-release.js";

test("Tag-based scripts and active script safety", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-tag-test-"));
  const dbFile = path.join(tmpDir, "test.db");
  const store = new Store(dbFile);

  await t.test("allows multiple scripts within the same tag", () => {
    const flow1 = store.newFlow("Group Post v1", 1, { actionTagKey: "facebook.group.post" });
    const flow2 = store.newFlow("Group Post v2", 1, { actionTagKey: "facebook.group.post" });
    const flow3 = store.newFlow("Group Comment v1", 1, { actionTagKey: "facebook.group.comment" });

    assert.equal(flow1.actionTagKey, "facebook.group.post");
    assert.equal(flow2.actionTagKey, "facebook.group.post");
    assert.equal(flow3.actionTagKey, "facebook.group.comment");

    const all = store.flows();
    const fbPostScripts = all.filter(f => f.actionTagKey === "facebook.group.post");
    assert.equal(fbPostScripts.length, 2);
  });

  await t.test("tracks only one active script per tag in settings", () => {
    const tagKey = "facebook.group.post";
    const flows = store.flows().filter(f => f.actionTagKey === tagKey);
    const flow1 = flows[0];
    const flow2 = flows[1];

    // Initially assign flow1 as active
    let activeByTag: Record<string, string> = {};
    activeByTag[tagKey] = flow1.id;
    store.setSetting("activeScriptsByTag", JSON.stringify(activeByTag));

    assert.equal(JSON.parse(store.setting("activeScriptsByTag")!)[tagKey], flow1.id);

    // Switching active script to flow2 updates the tag to flow2 only (exactly one active)
    activeByTag[tagKey] = flow2.id;
    store.setSetting("activeScriptsByTag", JSON.stringify(activeByTag));

    const updated = JSON.parse(store.setting("activeScriptsByTag")!);
    assert.equal(updated[tagKey], flow2.id);
    assert.notEqual(updated[tagKey], flow1.id);
  });

  await t.test("draft deletion works and safe backup snapshot preserves tag info", () => {
    const draftFlow = store.newFlow("Draft Post", 1, { actionTagKey: "facebook.group.post" });
    assert.ok(store.flows().some(f => f.id === draftFlow.id));

    // Delete draft
    store.deleteFlow(draftFlow.id);
    assert.ok(!store.flows().some(f => f.id === draftFlow.id));

    // Full snapshot roundtrip
    const snapshot = store.backupSnapshot();
    assert.ok(snapshot.flows);
    assert.ok(snapshot.settings);

    const store2 = new Store(path.join(tmpDir, "test2.db"));
    store2.restoreSnapshot(snapshot);
    const restoredFlows = store2.flows();
    assert.equal(restoredFlows.length, store.flows().length);
    assert.equal(store2.setting("activeScriptsByTag"), store.setting("activeScriptsByTag"));
    store2.db.close();
  });

  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Variables: Values and Placeholders duality & isolation", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-var-test-"));
  const dbFile = path.join(tmpDir, "test.db");
  const store = new Store(dbFile);

  const flow = store.newFlow("Test Flow", 1);

  await t.test("saves both values and placeholders synchronously", () => {
    const var1: Variable = { id: "var-1", key: "message", type: "text" };
    const var2: Variable = { id: "var-2", key: "count", type: "integer" };
    const vars = [var1, var2];

    const values = {
      "var-1": "Production Title",
      "var-2": 5,
    };

    const placeholders = {
      "var-1": "Test Title for Manual Lab",
      "var-2": 1,
    };

    store.updateVariables(vars, values, placeholders);

    const savedFlow = store.flow()!;
    assert.deepEqual(savedFlow.variables, vars);
    assert.deepEqual(savedFlow.defaultPattern?.values, values);
    assert.deepEqual(savedFlow.placeholders, placeholders);
  });

  await t.test("values and placeholders do not overwrite each other", () => {
    const savedFlow = store.flow()!;
    assert.equal(savedFlow.defaultPattern?.values["var-1"], "Production Title");
    assert.equal(savedFlow.placeholders?.["var-1"], "Test Title for Manual Lab");

    // Updating only values does not alter placeholders
    const updatedValues = {
      "var-1": "Updated Production Message",
      "var-2": 10,
    };
    store.updateVariables(savedFlow.variables!, updatedValues, savedFlow.placeholders);

    const refreshed = store.flow()!;
    assert.equal(refreshed.defaultPattern?.values["var-1"], "Updated Production Message");
    assert.equal(refreshed.placeholders?.["var-1"], "Test Title for Manual Lab");
  });

  await t.test("renaming variable key preserves placeholder mapping by stable ID", () => {
    const current = store.flow()!;
    const renamedVars: Variable[] = current.variables!.map(v =>
      v.id === "var-1" ? { ...v, key: "new_message_key" } : v
    );

    store.updateVariables(renamedVars, current.defaultPattern!.values, current.placeholders);

    const reloaded = store.flow()!;
    assert.equal(reloaded.variables?.find(v => v.id === "var-1")?.key, "new_message_key");
    assert.equal(reloaded.placeholders?.["var-1"], "Test Title for Manual Lab");
  });

  await t.test("deleting a variable removes its placeholder synchronously", () => {
    const current = store.flow()!;
    const remainingVars = current.variables!.filter(v => v.id !== "var-2");
    const nextVals = { ...current.defaultPattern!.values };
    delete nextVals["var-2"];
    const nextPlaceholders = { ...current.placeholders };
    delete nextPlaceholders["var-2"];

    store.updateVariables(remainingVars, nextVals, nextPlaceholders);

    const reloaded = store.flow()!;
    assert.equal(reloaded.variables?.length, 1);
    assert.equal(reloaded.defaultPattern?.values["var-2"], undefined);
    assert.equal(reloaded.placeholders?.["var-2"], undefined);
    assert.equal(reloaded.placeholders?.["var-1"], "Test Title for Manual Lab");
  });

  await t.test("production publish manifest NEVER includes placeholders", () => {
    const current = store.flow()!;
    const snapshot = buildScriptCatalogSnapshot({
      flow: current,
      version: "1",
      steps: [],
      assets: [],
    });

    // Verify manifest JSON NEVER has placeholder data
    const jsonStr = JSON.stringify(snapshot);
    assert.ok(!jsonStr.includes("Test Title for Manual Lab"));
    assert.ok(!jsonStr.includes("placeholders"));
  });

  await t.test("SQLite backup/restore snapshot retains placeholders accurately", () => {
    const snapshot = store.backupSnapshot();
    const store2 = new Store(path.join(tmpDir, "restore.db"));
    store2.restoreSnapshot(snapshot);

    const restoredFlow = store2.flow()!;
    assert.equal(restoredFlow.placeholders?.["var-1"], "Test Title for Manual Lab");
    store2.db.close();
  });

  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
