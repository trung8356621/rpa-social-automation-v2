import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  resolveVisualTarget,
  TargetNotConfident,
} from "../src/main/target-resolver.js";
import { Store } from "../src/main/storage.js";
import type { Payload, OcrResult } from "../src/shared/contracts.js";

const roi = { x: 30, y: 30, width: 40, height: 24 };
const selection = {
  confirmed: true as const,
  language: "vie+eng" as const,
  kind: "line" as const,
  text: "Nháp",
  confidence: 95,
  bbox: { x: 10, y: 5, width: 16, height: 10 },
};
const payload: Payload = {
  action: "CLICK_AND_TYPE",
  method: "auto",
  text: "Nháp 👋\nLine",
  target: {
    asset: "00000000-0000-0000-0000-000000000001.png",
    roi,
    ocr: selection,
  },
};
function ocr(x = 40, y = 35, confidence = 95): OcrResult {
  return {
    text: "Nháp",
    confidence,
    language: "vie+eng",
    segments: [
      {
        id: "0",
        text: "Nháp",
        kind: "line",
        confidence,
        bbox: { x, y, width: 16, height: 10 },
      },
    ],
  };
}
async function pixels(duplicate = false) {
  const template = await sharp({
    create: { width: 40, height: 24, channels: 3, background: "#171b31" },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="40" height="24"><rect x="8" y="4" width="14" height="14" fill="white"/><circle cx="30" cy="14" r="4" fill="red"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
  const frame = await sharp({
    create: { width: 160, height: 100, channels: 3, background: "#b5c4d5" },
  })
    .composite([
      { input: template, left: 30, top: 30 },
      ...(duplicate ? [{ input: template, left: 90, top: 30 }] : []),
    ])
    .png()
    .toBuffer();
  const weak = await sharp({
    create: { width: 160, height: 100, channels: 3, background: "#b5c4d5" },
  })
    .png()
    .toBuffer();
  return { template, frame, weak };
}
test("AUTO prefers image, records actual method, and tolerates unreadable/failed OCR with a strong unique image", async () => {
  const { template, frame } = await pixels();
  for (const recognize of [
    async () => ocr(),
    async () => ({ ...ocr(), segments: [] }),
    async () => {
      throw Error("OCR unavailable");
    },
  ]) {
    const result = await resolveVisualTarget(frame, template, payload, {
      recognize,
    });
    assert.equal(result.method, "image");
    assert.equal(result.x, 50);
    assert.equal(result.y, 42);
    assert.equal(result.resolution.selectedMethod, "image");
    assert.equal(result.resolution.fallbackReason, undefined);
    assert.equal(result.resolution.attempts[0].score, 1);
  }
});
test("AUTO falls back to unique confirmed OCR when image is weak and logs confidence/reason", async () => {
  const { template, weak } = await pixels();
  const result = await resolveVisualTarget(weak, template, payload, {
    recognize: async () => ocr(),
  });
  assert.equal(result.method, "ocr");
  assert.equal(result.x, 48);
  assert.equal(result.y, 40);
  assert.equal(result.confidence, 95);
  assert.match(result.resolution.fallbackReason!, /Image score/);
  assert.equal(result.resolution.attempts[1].confidence, 95);
});
test("AUTO blocks both failures, unconfirmed OCR, low confidence and duplicate OCR with structured trace", async () => {
  const { template, weak, frame } = await pixels();
  for (const recognize of [
    async () => ({ ...ocr(), segments: [] }),
    async () => ocr(40, 35, 20),
    async () => {
      throw Error("offline");
    },
  ]) {
    await assert.rejects(
      resolveVisualTarget(weak, template, payload, { recognize }),
      (error: unknown) =>
        error instanceof TargetNotConfident &&
        !!error.resolution?.blockedReason &&
        error.resolution.attempts.length === 2,
    );
  }
  let calls = 0;
  await assert.rejects(
    resolveVisualTarget(
      weak,
      template,
      { ...payload, target: { ...payload.target!, ocr: undefined } },
      {
        recognize: async () => {
          calls++;
          return ocr();
        },
      },
    ),
    /AUTO/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    resolveVisualTarget(frame, template, payload, {
      recognize: async () => {
        const r = ocr();
        return {
          ...r,
          segments: [
            ...r.segments,
            ...r.segments.map((segment) => ({
              ...segment,
              id: `${segment.id}-duplicate`,
              bbox: { ...segment.bbox, x: segment.bbox.x + 60 },
            })),
          ],
        };
      },
    }),
    /nhiều/,
  );
});
test("AUTO rejects image ambiguity before OCR and rejects credible image/OCR disagreement", async () => {
  const { template, frame } = await pixels(true);
  let calls = 0;
  await assert.rejects(
    resolveVisualTarget(frame, template, payload, {
      recognize: async () => {
        calls++;
        return ocr();
      },
    }),
    /nhiều/,
  );
  assert.equal(calls, 0);
  const single = await pixels();
  await assert.rejects(
    resolveVisualTarget(single.frame, template, payload, {
      recognize: async () => ocr(100, 60),
    }),
    (error: unknown) =>
      error instanceof TargetNotConfident &&
      /mâu thuẫn/.test(error.message) &&
      error.resolution!.attempts.every((a) => a.outcome === "matched"),
  );
});
test("legacy method hints run AUTO without mutating Base, Override or step versions", async () => {
  const { template, frame, weak } = await pixels();
  const store = new Store(":memory:");
  try {
    store.newFlow("Legacy", 1);
    const v1 = store.saveStep("Legacy", { ...payload, method: "ocr" });
    const v2 = store.saveStep("Legacy", { ...payload, method: "image" }, v1.id);
    store.saveOverride(v1.id, 1, "Old override", [
      { ...payload, method: "image" },
    ]);
    const before = JSON.stringify({
      steps: store.steps(),
      flow: store.flow(),
      overrides: store.overrides(),
    });
    assert.equal(
      (
        await resolveVisualTarget(
          frame,
          template,
          store.step(v1.id, 1).payload,
          { recognize: async () => ocr() },
        )
      ).method,
      "image",
    );
    const fallback = await resolveVisualTarget(
      weak,
      template,
      store.step(v2.id, 2).payload,
      { recognize: async () => ocr() },
    );
    assert.equal(fallback.method, "ocr");
    assert.equal(fallback.resolution.legacyMethod, "image");
    assert.equal(
      JSON.stringify({
        steps: store.steps(),
        flow: store.flow(),
        overrides: store.overrides(),
      }),
      before,
    );
  } finally {
    store.close();
  }
});
