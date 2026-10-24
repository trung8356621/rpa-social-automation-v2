import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { resolveVisualTarget, TargetNotConfident } from "../src/main/target-resolver.js";
import type { OcrResult, OcrSegment, Payload } from "../src/shared/contracts.js";

const selected = {
  confirmed: true as const,
  language: "vie+eng" as const,
  kind: "line" as const,
  text: "Bạn viết gì đi...",
  confidence: 90,
  bbox: { x: 10, y: 10, width: 100, height: 20 },
};

function segment(id: string, text: string, x: number, y: number, width = 120): OcrSegment {
  return { id, text, kind: "line", confidence: 95, bbox: { x, y, width, height: 20 } };
}

function result(segments: OcrSegment[]): OcrResult {
  return { text: segments.map((item) => item.text).join("\n"), confidence: 95, language: "vie+eng", segments };
}

function payload(asset: string): Payload {
  return {
    action: "CLICK_TARGET",
    target: {
      asset,
      roi: { x: 0, y: 0, width: 320, height: 180 },
      ocr: selected,
      matchTo: "top",
    },
  };
}

async function image(color: string) {
  return sharp({ create: { width: 400, height: 260, channels: 3, background: color } }).png().toBuffer();
}

test("exact OCR with valid context matches after relative anchor reflow", async () => {
  const frame = await image("#ffffff");
  const template = await image("#eeeeee");
  const saved = result([
    segment("target", selected.text, 10, 10, 100),
    segment("anchor", "Bài viết ẩn danh", 20, 70, 130),
  ]);
  const live = result([
    segment("target", selected.text, 100, 50, 100),
    // Moved substantially, but remains below/right of the target.
    segment("anchor", "Bài viết ẩn danh", 245, 145, 130),
  ]);
  const resolved = await resolveVisualTarget(frame, template, payload("v3.png"), {
    recognize: async (input) => input === template ? saved : live,
  });
  assert.equal(resolved.method, "ocr");
  assert.equal(resolved.x, 150);
  assert.equal(resolved.y, 60);
  assert.equal(resolved.resolution.context?.[0].confirmed, true);
});

test("duplicated OCR targets without distinguishing context remain blocked", async () => {
  const frame = await image("#ffffff");
  const template = await image("#eeeeee");
  const saved = result([segment("target", selected.text, 10, 10, 100)]);
  const live = result([
    segment("target-1", selected.text, 40, 40, 100),
    segment("target-2", selected.text, 220, 40, 100),
  ]);
  await assert.rejects(
    resolveVisualTarget(frame, template, payload("duplicate.png"), {
      recognize: async (input) => input === template ? saved : live,
    }),
    (error: unknown) => error instanceof TargetNotConfident && error.ambiguous && /context/i.test(error.message),
  );
});

test("redesigned version derives context from its own asset and window modes resolve identically", async () => {
  const normalFrame = await image("#ffffff");
  const maximizedFrame = Buffer.from(normalFrame);
  const oldTemplate = await image("#dddddd");
  const newTemplate = await image("#cccccc");
  const oldSaved = result([segment("target", selected.text, 10, 10, 100), segment("old", "Old context", 10, 70)]);
  const newSaved = result([segment("target", selected.text, 10, 10, 100), segment("new", "New context", 10, 70)]);
  const live = result([segment("target", selected.text, 100, 50, 100), segment("new", "New context", 120, 120)]);
  const recognize = async (input: Buffer) => input === oldTemplate ? oldSaved : input === newTemplate ? newSaved : live;

  const normal = await resolveVisualTarget(normalFrame, newTemplate, payload("v3.png"), { recognize });
  const maximized = await resolveVisualTarget(maximizedFrame, newTemplate, payload("v3.png"), { recognize });
  assert.equal(normal.resolution.context?.[0].anchor, "New context");
  assert.deepEqual(
    { method: normal.method, x: normal.x, y: normal.y },
    { method: maximized.method, x: maximized.x, y: maximized.y },
  );
});
