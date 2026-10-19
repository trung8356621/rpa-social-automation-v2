import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceLayout,
  WEB_WIDTH,
  WEB_HEIGHT,
  EDITOR_WIDTH,
} from "../src/shared/geometry.js";
import {
  assertVisualEnvironment,
  targetEnvironment,
} from "../src/shared/visual-environment.js";
import { Store, validatePayload } from "../src/main/storage.js";
import type { Payload } from "../src/shared/contracts.js";
const env = { width: WEB_WIDTH - EDITOR_WIDTH, height: WEB_HEIGHT, zoom: 0.9 };
const target = {
  asset: "00000000-0000-0000-0000-000000000001.png",
  roi: { x: 120, y: 120, width: 300, height: 64 },
  environment: env,
};
test("Editor occupies only the column beside Step List; Debug collapse frees the entire former native body", () => {
  for (const editor of [true, false])
    for (const debug of [true, false])
      for (const size of [
        [1344, 648],
        [1920, 1080],
      ]) {
        const layout = workspaceLayout(
          editor,
          debug,
          ...(size as [number, number]),
        );
        assert.equal(layout.browser.height, 560);
        assert.equal(layout.browser.width, 1024);
        assert.equal(layout.browser.x, editor && size[0] >= 1696 ? 672 : 320);
        assert.equal(layout.debug.x, layout.browser.x);
        assert.equal(layout.debug.y + layout.debug.height, size[1]);
        assert.equal(layout.debug.height, debug ? 200 : 36);
        assert.equal(layout.debug.width, size[0] - layout.browser.x);
      }
});
test("visual preflight rejects mismatched width, height and zoom for every visual action, without scaling ROI", () => {
  for (const action of [
    "CLICK_TARGET",
    "CLICK_AND_TYPE",
    "UPLOAD_FILE",
    "WAIT_VERIFY",
  ] as const) {
    const payload: Payload = { action, target };
    assert.doesNotThrow(() => assertVisualEnvironment(payload, 0.9, env));
    for (const mismatch of [
      { ...env, width: 1024 },
      { ...env, height: 559 },
      { ...env, zoom: 1 },
    ])
      assert.throws(
        () => assertVisualEnvironment(payload, 0.9, mismatch),
        /Viewport không khớp/,
      );
    assert.deepEqual(payload.target!.roi, {
      x: 120,
      y: 120,
      width: 300,
      height: 64,
    });
  }
  for (const action of ["TYPE_ONLY", "SCROLL"] as const)
    assert.doesNotThrow(() =>
      assertVisualEnvironment({ action }, 0.9, { ...env, width: 1024 }),
    );
});
test("legacy targets retain 1024x560 at the flow zoom and never inherit current editor width", () => {
  const { environment, ...legacy } = target;
  assert.deepEqual(
    targetEnvironment({ action: "CLICK_TARGET", target: legacy }, 0.8),
    { width: 1024, height: 560, zoom: 0.8 },
  );
  assert.throws(
    () =>
      assertVisualEnvironment({ action: "CLICK_TARGET", target: legacy }, 0.8, {
        ...env,
        zoom: 0.8,
      }),
    /Crop lại/,
  );
  assert.doesNotThrow(() =>
    assertVisualEnvironment({ action: "CLICK_TARGET", target: legacy }, 0.8, {
      width: 1024,
      height: 560,
      zoom: 0.8,
    }),
  );
});
test("crop viewport metadata survives immutable versions, Override and version pinning; ROI must fit saved environment", () => {
  const store = new Store(":memory:");
  store.newFlow("viewport", 0.9);
  const v1 = store.saveStep("click", { action: "CLICK_TARGET", target });
  const wide = { ...target, environment: { ...env, width: 1024 } };
  const v2 = store.saveStep(
    "redesign",
    { action: "CLICK_TARGET", target: wide },
    v1.id,
  );
  const override = store.saveOverride(v1.id, 1, "wide", [
    { action: "CLICK_TARGET", target: wide },
  ]);
  store.selectVersion(v1.id, 1);
  assert.deepEqual(store.step(v1.id, 1).payload.target!.environment, env);
  assert.equal(
    store.step(v1.id, v2.version).payload.target!.environment!.width,
    1024,
  );
  assert.equal(override.segment[0].target!.environment!.width, 1024);
  assert.throws(
    () =>
      validatePayload({
        action: "CLICK_TARGET",
        target: { ...target, roi: { x: 650, y: 10, width: 40, height: 20 } },
      }),
    /ROI/,
  );
  assert.throws(
    () =>
      validatePayload({
        action: "CLICK_TARGET",
        target: { ...target, environment: { ...env, width: 900 } },
      }),
    /Viewport/,
  );
  store.close();
});
