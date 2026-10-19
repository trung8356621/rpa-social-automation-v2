import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  WEB_WIDTH,
  validateRect,
  imageToInput,
  validateZoom,
} from "../src/shared/geometry.js";
import { Store, validatePayload } from "../src/main/storage.js";
import { matchTemplate } from "../src/main/visual.js";
test("crop and input reject out-of-bounds and map image pixels to view DIPs", () => {
  assert.equal(WEB_WIDTH, 1024);
  assert.deepEqual(
    imageToInput(1024, 640, 2048, 1280, {
      x: 320,
      y: 88,
      width: 1024,
      height: 640,
    }),
    { x: 512, y: 320 },
  );
  assert.throws(() =>
    validateRect({ x: 1000, y: 10, width: 40, height: 20 }, 1024, 640),
  );
  assert.throws(() =>
    imageToInput(NaN, 0, 1024, 640, { x: 0, y: 0, width: 1024, height: 640 }),
  );
  assert.throws(() => validateZoom(0.75));
});
test("redesign preserves original, rollback pins version, override is bound to base", () => {
  const store = new Store(":memory:");
  store.newFlow("draft", 1);
  const v1 = store.saveStep("Type", { action: "TYPE_ONLY", text: "original" });
  const v2 = store.saveStep(
    "Type",
    { action: "TYPE_ONLY", text: "redesigned" },
    v1.id,
  );
  assert.equal(v2.version, 2);
  assert.equal(v2.id, v1.id);
  assert.equal(store.step(v1.id, 1).payload.text, "original");
  assert.equal(store.flow()?.steps[0].version, 2);
  const override = store.saveOverride(v1.id, 1, "English UI", [
    { action: "TYPE_ONLY", text: "override" },
  ]);
  assert.equal(override.baseVersion, 1);
  assert.equal(store.step(v1.id, 1).payload.text, "original");
  store.selectVersion(v1.id, 1);
  assert.equal(store.flow()?.steps[0].version, 1);
  store.close();
});
test("action-first payload requires target only for click and verify", () => {
  validatePayload({ action: "TYPE_ONLY", text: "draft" });
  validatePayload({ action: "SCROLL", deltaY: -400 });
  assert.throws(() => validatePayload({ action: "CLICK_TARGET" }));
  assert.throws(() => validatePayload({ action: "WAIT_VERIFY" }));
  assert.throws(() =>
    validatePayload({
      action: "CLICK_TARGET",
      target: {
        asset: "../session.png",
        roi: { x: 0, y: 0, width: 30, height: 30 },
      },
    }),
  );
});
test("image resolver locates a displaced target and rejects uniform image", async () => {
  const target = await sharp({
    create: { width: 40, height: 24, channels: 3, background: "#df2848" },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="40" height="24"><rect x="8" y="4" width="14" height="14" fill="white"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  const frame = await sharp({
    create: { width: 160, height: 100, channels: 3, background: "#eeeeee" },
  })
    .composite([{ input: target, left: 74, top: 42 }])
    .png()
    .toBuffer();
  const found = await matchTemplate(frame, target, {
    x: 60,
    y: 30,
    width: 40,
    height: 24,
  });
  assert.ok(found.score > 0.999);
  assert.equal(found.x, 94);
  assert.equal(found.y, 54);
  const blank = await sharp({
    create: { width: 40, height: 24, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    matchTemplate(frame, blank, { x: 60, y: 30, width: 40, height: 24 }),
    /ít chi tiết/,
  );
  const solidColor = await sharp({
    create: { width: 40, height: 24, channels: 3, background: "#df2848" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    matchTemplate(frame, solidColor, { x: 60, y: 30, width: 40, height: 24 }),
    /ít chi tiết/,
  );
});
