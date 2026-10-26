import test, { after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { localOcr } from "../src/main/ocr.js";
import {
  normalizeTargetText,
  resolveOcrText,
  resolveVisualTarget,
  TargetNotConfident,
} from "../src/main/target-resolver.js";
import { Store, validatePayload } from "../src/main/storage.js";
import type { OcrResult, VisualTarget } from "../src/shared/contracts.js";
after(() => localOcr.close());
const selection: NonNullable<VisualTarget["ocr"]> = {
  text: "Tạo bài viết",
  kind: "line",
  bbox: { x: 10, y: 10, width: 180, height: 30 },
  confidence: 95,
  confirmed: true,
  language: "vie+eng",
};
const segment = {
  id: "0",
  text: selection.text,
  kind: "line" as const,
  bbox: { x: 10, y: 10, width: 180, height: 30 },
  confidence: 95,
};
const recognized: OcrResult = {
  text: selection.text,
  confidence: 95,
  segments: [segment],
  language: "vie+eng",
};
test("local OCR reads Vietnamese accents and English with ROI-relative boxes", async () => {
  const png = await sharp("tests/fixtures/ocr-vie-eng.svg").png().toBuffer();
  const result = await localOcr.recognize(png);
  console.log("OCR_FIXTURE", JSON.stringify(result));
  for (const text of ["Tạo bài viết", "Create post"]) {
    const line = result.segments.find(
      (s) =>
        s.kind === "line" &&
        normalizeTargetText(s.text) === normalizeTargetText(text),
    );
    assert.ok(line, `Missing OCR line: ${text}; got ${result.text}`);
    assert.ok(line.confidence >= 80);
    assert.ok(
      line.bbox.x >= 0 &&
        line.bbox.y >= 0 &&
        line.bbox.x + line.bbox.width <= 600 &&
        line.bbox.y + line.bbox.height <= 150,
    );
  }
  assert.equal(Object.hasOwn(result, "selected"), false);
});
test("local OCR reads low-contrast gray Vietnamese placeholder without normalize crush", async () => {
  const png = await sharp("tests/fixtures/ocr-low-contrast-placeholder.png").png().toBuffer();
  const meta = await sharp(png).metadata();
  const result = await localOcr.recognize(png);
  const expected = "Bạn viết gì đi...";
  const line = result.segments.find(
    (s) =>
      s.kind === "line" &&
      normalizeTargetText(s.text) === normalizeTargetText(expected),
  );
  assert.ok(line, `Missing OCR line: ${expected}; got ${JSON.stringify(result.text)}`);
  assert.ok(line!.confidence >= 80);
  const match = resolveOcrText(
    result,
    {
      text: expected,
      kind: "line",
      bbox: line!.bbox,
      confidence: line!.confidence,
      confirmed: true,
      language: "vie+eng",
    },
    { x: 0, y: 0, width: meta.width!, height: meta.height! },
  );
  assert.equal(normalizeTargetText(match.text!), normalizeTargetText(expected));
});
test("blank/icon ROI returns no text and can remain image-only", async () => {
  const blank = await sharp({
    create: { width: 100, height: 60, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  assert.equal((await localOcr.recognize(blank)).segments.length, 0);
  validatePayload({
    action: "CLICK_TARGET",
    method: "image",
    target: {
      asset: "00000000-0000-0000-0000-000000000001.png",
      roi: { x: 0, y: 0, width: 100, height: 60 },
    },
  });
});
test("OCR exact match preserves accents and maps bbox to viewport, rejecting ambiguity and low confidence", () => {
  const m = resolveOcrText(recognized, selection, {
    x: 320,
    y: 88,
    width: 250,
    height: 100,
  });
  assert.equal(m.x, 420);
  assert.equal(m.y, 113);
  assert.equal(
    normalizeTargetText("  TẠO   BÀI VIẾT "),
    normalizeTargetText(selection.text),
  );
  assert.throws(
    () =>
      resolveOcrText(
        { ...recognized, segments: [{ ...segment, text: "Tao bai viet" }] },
        selection,
        { x: 0, y: 0, width: 250, height: 100 },
      ),
    TargetNotConfident,
  );
  assert.throws(
    () =>
      resolveOcrText(
        {
          ...recognized,
          segments: [
            segment,
            { ...segment, id: "1", bbox: { ...segment.bbox, y: 55 } },
          ],
        },
        selection,
        { x: 0, y: 0, width: 250, height: 100 },
      ),
    /nhiều vị trí/,
  );
  assert.throws(
    () =>
      resolveOcrText(
        { ...recognized, segments: [{ ...segment, confidence: 79 }] },
        selection,
        { x: 0, y: 0, width: 250, height: 100 },
      ),
    /confidence/,
  );
});
test("AUTO blocks when both image and OCR fail; unconfirmed legacy OCR cannot be saved", async () => {
  const target = {
    asset: "00000000-0000-0000-0000-000000000001.png",
    roi: { x: 0, y: 0, width: 250, height: 100 },
    ocr: selection,
  };
  assert.throws(
    () =>
      validatePayload({
        action: "CLICK_TARGET",
        method: "ocr",
        target: { asset: target.asset, roi: target.roi },
      }),
    /xác nhận/,
  );
  const png = await sharp({
    create: { width: 250, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    resolveVisualTarget(
      png,
      png,
      { action: "CLICK_TARGET", method: "ocr", target },
      {
        recognize: async () => {
          throw new Error("Offline model missing");
        },
      },
    ),
    /AUTO/,
  );
});
test("confirmed OCR and method survive step redesign, rollback and override without overwriting Base", () => {
  const store = new Store(":memory:");
  store.newFlow("OCR", 1);
  const target = {
    asset: "00000000-0000-0000-0000-000000000001.png",
    roi: { x: 0, y: 0, width: 250, height: 100 },
    ocr: selection,
  };
  const v1 = store.saveStep("OCR", {
    action: "CLICK_TARGET",
    target,
    method: "image",
  });
  const v2 = store.saveStep(
    "OCR",
    { action: "CLICK_TARGET", target, method: "ocr" },
    v1.id,
  );
  const overlay = store.saveOverride(v1.id, 1, "OCR context", [v2.payload]);
  assert.equal(store.step(v1.id, 1).payload.method, "image");
  assert.deepEqual(store.step(v1.id, 2).payload.target?.ocr, selection);
  assert.equal(overlay.segment[0].method, "ocr");
  store.selectVersion(v1.id, 1);
  assert.equal(store.flow()?.steps[0].version, 1);
  store.close();
});
test("two identical image targets are rejected rather than guessing a click", async () => {
  const template = await sharp({
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
    create: { width: 160, height: 100, channels: 3, background: "white" },
  })
    .composite([
      { input: template, left: 30, top: 30 },
      { input: template, left: 90, top: 30 },
    ])
    .png()
    .toBuffer();
  await assert.rejects(
    resolveVisualTarget(
      frame,
      template,
      {
        action: "CLICK_TARGET",
        method: "image",
        target: {
          asset: "00000000-0000-0000-0000-000000000001.png",
          roi: { x: 30, y: 30, width: 40, height: 24 },
        },
      },
      localOcr,
    ),
    /nhiều vị trí/,
  );
});
