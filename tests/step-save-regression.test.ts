import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, validateDraftPayload, validatePayload } from "../src/main/storage.js";

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

test("draft Step save allows incomplete target/variable while executable gate still blocks until complete", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "step-draft-regression-"));
  const file = path.join(root, "creator.sqlite");
  let store = new Store(file);
  try {
    const flow = store.newFlow("WordPress Login Draft", 1);
    store.updateVariables(
      [{ id: "u", key: "wp_user", type: "text" }],
      { u: "demo_user" },
    );

    // 1. Non-image actions (SLEEP, SCROLL, TYPE_ONLY) save & execute without crop
    const waitStep = store.saveStep("Wait ready", { action: "SLEEP" });
    const scrollStep = store.saveStep("Scroll form", { action: "SCROLL", deltaY: -200 });
    const typeStep = store.saveStep("Type username", { action: "TYPE_ONLY", variableId: "u", inputMethod: "keyboard" });
    assert.equal(store.invalidSteps().length, 0);
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));

    // 2. Incomplete image-based draft (CLICK_TARGET without crop) saves as Draft v1 and is flagged invalid
    const loginClickDraft = store.saveStep("Click Login", { action: "CLICK_TARGET" });
    assert.equal(loginClickDraft.version, 1);
    assert.equal(loginClickDraft.payload.target, undefined);
    const invalid1 = store.invalidSteps().find(r => r.stepId === loginClickDraft.id && r.version === 1);
    assert.ok(invalid1, "incomplete CLICK_TARGET draft must be flagged in invalidSteps");
    assert.match(invalid1.detail, /Action cần ảnh target được crop/);
    assert.throws(() => store.assertStepExecutable(loginClickDraft.id, 1, store.flow()!), /thiếu ảnh ROI target/);
    assert.throws(() => store.assertFlowExecutable(store.flow()!), /thiếu ảnh ROI target/);

    // 3. Incomplete CLICK_AND_TYPE without crop or variable saves as Draft
    const inputDraft = store.saveStep("Input password", { action: "CLICK_AND_TYPE" });
    assert.ok(store.invalidSteps().some(r => r.stepId === inputDraft.id && r.version === 1));

    // 4. Changing image-based draft -> non-image-based (SLEEP) produces valid v2 while keeping v1 immutable
    const switched = store.saveStep("Wait instead", { action: "SLEEP" }, loginClickDraft.id);
    assert.equal(switched.version, 2);
    assert.equal(store.step(loginClickDraft.id, 1).payload.action, "CLICK_TARGET");
    assert.doesNotThrow(() => store.assertStepExecutable(switched.id, 2, store.flow()!));

    // 5. Completing image-based draft with valid crop produces valid v2
    const validTarget = {
      asset: "00000000-0000-0000-0000-000000000001.png",
      roi: { x: 10, y: 20, width: 120, height: 40 },
    };
    const completedInput = store.saveStep(
      "Input password",
      { action: "CLICK_AND_TYPE", variableId: "u", inputMethod: "keyboard", target: validTarget },
      inputDraft.id,
    );
    assert.equal(completedInput.version, 2);
    assert.doesNotThrow(() => store.assertFlowExecutable(store.flow()!));
    assert.equal(
      store.invalidSteps().some(r => r.stepId === completedInput.id && r.version === 2),
      false,
    );

    // 6. Persistence across Store reload
    store.close();
    store = new Store(file);
    assert.equal(store.flow()!.id, flow.id);
    assert.equal(store.flow()!.steps.length, 5);
    assert.equal(store.step(waitStep.id, 1).payload.action, "SLEEP");
    assert.equal(store.step(scrollStep.id, 1).payload.deltaY, -200);
    assert.equal(store.step(typeStep.id, 1).payload.action, "TYPE_ONLY");
    assert.equal(store.step(completedInput.id, 2).payload.target?.asset, validTarget.asset);
  } finally {
    store.close();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows WAL */ }
  }
});

test("validateDraftPayload still rejects structurally invalid payloads", () => {
  assert.throws(() => validateDraftPayload({ action: "SCROLL", deltaY: 99999 }), /Scroll không hợp lệ/);
  assert.throws(
    () => validateDraftPayload({
      action: "SLEEP",
      target: { asset: "00000000-0000-0000-0000-000000000001.png", roi: { x: 0, y: 0, width: 20, height: 20 } },
    }),
    /SLEEP không dùng target/,
  );
  assert.throws(() => validatePayload({ action: "CLICK_TARGET" }), /Action cần ảnh target được crop/);
  assert.doesNotThrow(() => validateDraftPayload({ action: "CLICK_TARGET" }));
  assert.doesNotThrow(() => validateDraftPayload({ action: "WAIT_VERIFY" }));
  assert.doesNotThrow(() => validateDraftPayload({ action: "CLICK_AND_TYPE" }));
  assert.doesNotThrow(() => validateDraftPayload({ action: "UPLOAD_FILE" }));
  assert.doesNotThrow(() => validateDraftPayload({ action: "QUICK_TAG" }));
});
