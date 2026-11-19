import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import {
  findOcrCandidates,
  normalizeOcrText,
} from "../src/main/ocr-candidates.js";
import { resolveVisualTarget, OcrNotFound } from "../src/main/target-resolver.js";
import type { OcrResult, Payload, Rect } from "../src/shared/contracts.js";

/** Exact OCR segments from failing run bc72a906 pass 3 (May Hợp Phát WP admin). */
function wordpressSaveDraftOcr(): OcrResult {
  return {
    text: "| Lưu nháp |",
    confidence: 86,
    language: "vie+eng",
    segments: [
      {
        id: "174",
        text: "| Lưu nháp |",
        kind: "line",
        confidence: 92,
        bbox: { x: 720, y: 353, width: 89, height: 38 },
      },
      {
        id: "175",
        text: "|",
        kind: "word",
        confidence: 96,
        bbox: { x: 720, y: 353, width: 1, height: 38 },
      },
      {
        id: "176",
        text: "Lưu",
        kind: "word",
        confidence: 93,
        bbox: { x: 738, y: 368, width: 20, height: 9 },
      },
      {
        id: "177",
        text: "nháp",
        kind: "word",
        confidence: 92,
        bbox: { x: 764, y: 367, width: 28, height: 13 },
      },
      {
        id: "178",
        text: "|",
        kind: "word",
        confidence: 95,
        bbox: { x: 808, y: 353, width: 1, height: 38 },
      },
      // Nearby toolbar noise that previously split Lưu/nháp into different word rows.
      {
        id: "173",
        text: "2",
        kind: "word",
        confidence: 93,
        bbox: { x: 605, y: 366, width: 17, height: 17 },
      },
      {
        id: "181",
        text: "Xem",
        kind: "word",
        confidence: 96,
        bbox: { x: 900, y: 368, width: 25, height: 9 },
      },
      {
        id: "182",
        text: "trước",
        kind: "word",
        confidence: 96,
        bbox: { x: 930, y: 368, width: 31, height: 9 },
      },
      {
        id: "201",
        text: "nháp",
        kind: "word",
        confidence: 93,
        bbox: { x: 836, y: 408, width: 28, height: 13 },
      },
    ],
  };
}

const saveDraftSelection = {
  text: "Lưu nháp",
  kind: "line" as const,
  bbox: { x: 10, y: 10, width: 70, height: 20 },
  confidence: 91,
  confirmed: true as const,
  language: "vie+eng" as const,
};

const viewport: Rect = { x: 0, y: 0, width: 1024, height: 560 };

test("normalize strips decorative pipes around Lưu nháp", () => {
  assert.equal(normalizeOcrText("| Lưu nháp |"), "lưu nháp");
  assert.equal(normalizeOcrText("Lưu nháp"), "lưu nháp");
});

test("WordPress | Lưu nháp | line matches saved OCR despite pipe chrome and row noise", () => {
  const hits = findOcrCandidates(wordpressSaveDraftOcr(), saveDraftSelection);
  assert.equal(hits.length, 1);
  assert.match(normalizeOcrText(hits[0].text), /^lưu nháp$/);
  assert.equal(hits[0].confidence >= 80, true);
  // Center stays on the save-draft control, not Preview / status "nháp".
  assert.ok(hits[0].bbox.x + hits[0].bbox.width / 2 >= 720);
  assert.ok(hits[0].bbox.x + hits[0].bbox.width / 2 <= 809);
  assert.ok(hits[0].bbox.y + hits[0].bbox.height / 2 >= 353);
  assert.ok(hits[0].bbox.y + hits[0].bbox.height / 2 <= 391);
});

test("Match To middle resolves visible Lưu nháp without requiring scroll", async () => {
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  const template = await sharp({
    create: { width: 89, height: 38, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "luu-nhap.png",
      roi: { x: 720, y: 353, width: 89, height: 38 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "middle",
      ocr: saveDraftSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  const live = wordpressSaveDraftOcr();
  const resolved = await resolveVisualTarget(
    frame,
    template,
    payload,
    { recognize: async () => live },
    viewport,
  );
  assert.equal(resolved.method, "ocr");
  assert.equal(resolved.resolution.selectedMethod, "ocr");
  assert.ok(resolved.x >= 720 && resolved.x <= 809);
  assert.ok(resolved.y >= 353 && resolved.y <= 391);
});

test("OCR outside searchRegion stays OUTSIDE_SCROLL_CONTAINER", async () => {
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  const template = await sharp({
    create: { width: 89, height: 38, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "luu-nhap.png",
      roi: { x: 720, y: 353, width: 89, height: 38 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "middle",
      ocr: saveDraftSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  await assert.rejects(
    () =>
      resolveVisualTarget(
        frame,
        template,
        payload,
        { recognize: async () => wordpressSaveDraftOcr() },
        { x: 0, y: 0, width: 400, height: 200 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof OcrNotFound);
      assert.equal(
        error.resolution?.attempts?.some((a) => a.reason === "OUTSIDE_SCROLL_CONTAINER"),
        true,
      );
      return true;
    },
  );
});

test("duplicate Lưu nháp labels remain ambiguous (no click)", async () => {
  const twin: OcrResult = {
    text: "Lưu nháp\nLưu nháp",
    confidence: 90,
    language: "vie+eng",
    segments: [
      {
        id: "a",
        text: "Lưu nháp",
        kind: "line",
        confidence: 92,
        bbox: { x: 100, y: 100, width: 80, height: 20 },
      },
      {
        id: "b",
        text: "Lưu nháp",
        kind: "line",
        confidence: 91,
        bbox: { x: 100, y: 300, width: 80, height: 20 },
      },
    ],
  };
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  const template = await sharp({
    create: { width: 80, height: 20, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "luu-nhap.png",
      roi: { x: 100, y: 100, width: 80, height: 20 },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "middle",
      ocr: saveDraftSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  await assert.rejects(
    () =>
      resolveVisualTarget(frame, template, payload, { recognize: async () => twin }, viewport),
    /CONTEXT_AMBIGUOUS|nhiều mục tiêu/i,
  );
});

test("Match To None path unchanged: runtime still skips advanceOcrSearch for none", () => {
  const runtimePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/main/runtime.ts",
  );
  const source = readFileSync(runtimePath, "utf8");
  assert.match(source, /VIEWPORT_FIRST/);
  assert.match(source, /pendingScanReset/);
  assert.match(source, /mode === "none" \? undefined : mode/);
  assert.match(source, /ocr-scan-reset/);
  // None must never enter Match To scroll binding.
  assert.doesNotMatch(
    source,
    /const matchTo = mode === "none" \? mode/,
  );
});

test("absent target leaves Match To scroll path intact after viewport miss", () => {
  const runtimePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/main/runtime.ts",
  );
  const scrollPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/main/ocr-match-scroll.ts",
  );
  const source = readFileSync(runtimePath, "utf8");
  const scroll = readFileSync(scrollPath, "utf8");
  // After viewport miss: reset then forward scroll via existing advanceOcrSearch.
  assert.match(source, /pendingScanReset = false/);
  assert.match(source, /ocr-scan-reset/);
  assert.match(source, /ocr-scroll/);
  assert.match(scroll, /SCROLL_CONTAINER_CHANGED/);
  assert.match(scroll, /fraction.*middle.*2\/3/);
});
