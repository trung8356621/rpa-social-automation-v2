import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOcrClickOffset,
  predictedClickInAsset,
  suggestBelowLabelOffset,
} from "../src/shared/click-anchor.js";
import { Store } from "../src/main/storage.js";
import type { Payload } from "../src/shared/contracts.js";

test("predicted click shows ROI center, OCR center, and offset click point", () => {
  const target = {
    asset: "a.png",
    roi: { x: 0, y: 0, width: 200, height: 100 },
    ocr: {
      confirmed: true as const,
      language: "vie+eng" as const,
      kind: "line" as const,
      text: "Username or Email Address",
      confidence: 91,
      bbox: { x: 10, y: 8, width: 160, height: 20 },
    },
    clickOffset: { x: 0, y: 36 },
  };
  const predicted = predictedClickInAsset(target);
  assert.deepEqual(predicted.imageCenter, { x: 100, y: 50 });
  assert.deepEqual(predicted.ocrCenter, { x: 90, y: 18 });
  assert.deepEqual(predicted.clickPoint, { x: 90, y: 54 });
  assert.equal(predicted.via, "ocr-offset");
  assert.deepEqual(suggestBelowLabelOffset(target.ocr.bbox), { x: 0, y: 24 });
  assert.deepEqual(applyOcrClickOffset(10, 20, { x: 1, y: 2 }), { x: 11, y: 22 });
});

test("saveStep keeps OCR none/line and clickOffset across v7→v8 without overwriting v7", () => {
  const store = new Store(":memory:");
  try {
    store.newFlow("WP login OCR", 1);
    store.updateVariables(
      [{ id: "u", key: "username", type: "text" }],
      { u: "demo" },
    );
    const base: Payload = {
      action: "CLICK_AND_TYPE",
      variableId: "u",
      inputMethod: "keyboard",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset: "00000000-0000-0000-0000-000000000099.png",
        roi: { x: 10, y: 10, width: 220, height: 80 },
        environment: { width: 1024, height: 560, zoom: 1 },
      },
    };
    let step = store.saveStep("user name", base);
    for (let v = 2; v <= 7; v++) {
      step = store.saveStep("user name", base, step.id);
      assert.equal(step.version, v);
    }
    assert.equal(step.version, 7);
    const withOcr: Payload = {
      ...base,
      target: {
        ...base.target!,
        ocr: {
          confirmed: true,
          language: "vie+eng",
          kind: "line",
          text: "Username or Email Address",
          confidence: 91,
          bbox: { x: 12, y: 6, width: 180, height: 18 },
        },
        clickOffset: { x: 0, y: 28 },
      },
    };
    const v8 = store.saveStep("user name", withOcr, step.id);
    assert.equal(v8.version, 8);
    assert.equal(store.step(step.id, 7).payload.target?.ocr, undefined);
    assert.equal(store.step(step.id, 8).payload.target?.ocr?.kind, "line");
    assert.deepEqual(store.step(step.id, 8).payload.target?.clickOffset, { x: 0, y: 28 });

    const cleared: Payload = {
      ...base,
      target: { ...base.target! },
    };
    const v9 = store.saveStep("user name", cleared, step.id);
    assert.equal(v9.version, 9);
    assert.equal(v9.payload.target?.ocr, undefined);
    assert.equal(v9.payload.target?.clickOffset, undefined);
    assert.equal(store.step(step.id, 8).payload.target?.ocr?.kind, "line");
  } finally {
    store.close();
  }
});
