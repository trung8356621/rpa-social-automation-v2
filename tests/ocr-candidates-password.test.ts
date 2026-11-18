import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  findOcrCandidates,
  refineOcrCandidates,
} from "../src/main/ocr-candidates.js";
import { resolveVisualTarget } from "../src/main/target-resolver.js";
import type { OcrResult, Payload } from "../src/shared/contracts.js";

/** Fixture mirrors WordPress login OCR: label Password + Lost your password? */
function wpLoginOcr(): OcrResult {
  return {
    text: "Username or Email Address\nPassword\nLost your password?",
    confidence: 91,
    language: "vie+eng",
    segments: [
      {
        id: "13",
        text: "Password",
        kind: "line",
        confidence: 92,
        bbox: { x: 371, y: 333, width: 56, height: 11 },
      },
      {
        id: "14",
        text: "Password",
        kind: "word",
        confidence: 92,
        bbox: { x: 371, y: 333, width: 56, height: 11 },
      },
      {
        id: "24",
        text: "Lost your password?",
        kind: "line",
        confidence: 95,
        bbox: { x: 370, y: 492, width: 115, height: 15 },
      },
      {
        id: "27",
        text: "password?",
        kind: "word",
        confidence: 95,
        bbox: { x: 426, y: 492, width: 59, height: 15 },
      },
    ],
  };
}

const selection = {
  text: "Password",
  kind: "word" as const,
  bbox: { x: 2, y: 3, width: 56, height: 11 },
  confidence: 92,
  confirmed: true as const,
  language: "vie+eng" as const,
};

test("Password word selection prefers label over Lost your password?", () => {
  const matches = findOcrCandidates(wpLoginOcr(), selection);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "Password");
  assert.equal(matches[0].bbox.y, 333);
  assert.equal(matches[0].confidence, 92);
});

test("refine keeps BLOCK when two equally exact Password labels exist", () => {
  const twin = refineOcrCandidates(
    [
      {
        id: "a",
        text: "Password",
        kind: "word",
        confidence: 92,
        bbox: { x: 100, y: 100, width: 56, height: 11 },
      },
      {
        id: "b",
        text: "Password",
        kind: "word",
        confidence: 93,
        bbox: { x: 100, y: 400, width: 56, height: 11 },
      },
    ],
    selection,
  );
  assert.equal(twin.length, 2);
});

test("Match To middle resolves Password label, not Lost your password?", async () => {
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  // Crop with little independent context → CONTEXT_INSUFFICIENT for both before refine.
  const template = await sharp({
    create: { width: 273, height: 61, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_AND_TYPE",
    text: "fixture_pass",
    inputMethod: "keyboard",
    target: {
      asset: "password.png",
      roi: { x: 369, y: 257, width: 273, height: 61 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "middle",
      ocr: selection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  const live = wpLoginOcr();
  const resolved = await resolveVisualTarget(frame, template, payload, {
    recognize: async (input) => (input === template ? {
      text: "Password",
      confidence: 92,
      language: "vie+eng",
      segments: [
        {
          id: "t",
          text: "Password",
          kind: "word",
          confidence: 92,
          bbox: { x: 2, y: 3, width: 56, height: 11 },
        },
      ],
    } : live),
  }, { x: 0, y: 0, width: 1024, height: 560 });
  assert.equal(resolved.method, "ocr");
  assert.equal(resolved.x, 371 + 56 / 2);
  assert.equal(resolved.y, 333 + 11 / 2);
  assert.equal(resolved.resolution.attempts.filter((a) => a.outcome === "matched").length, 1);
});
