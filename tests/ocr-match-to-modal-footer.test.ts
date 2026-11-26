import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import {
  chooseOcrScrollCandidateIndex,
  computeOcrSearchRegion,
} from "../src/main/ocr-scroll-region.js";
import { resolveVisualTarget, OcrNotFound } from "../src/main/target-resolver.js";
import type { OcrResult, Payload } from "../src/shared/contracts.js";

/**
 * Facebook Sandbox Create-post shape:
 * - scrollable <dialog>
 * - nested focused .editor (max-height ~240, overflow auto)
 * - Publish in dialog chrome/footer, outside the editor pane
 */
const modalBox = { left: 200, top: 40, right: 780, bottom: 520 };
const editorBox = { left: 220, top: 120, right: 760, bottom: 360 };
const publishBbox = { x: 640, y: 470, width: 80, height: 28 };

function publishOcr(): OcrResult {
  return {
    text: "Publish",
    confidence: 92,
    language: "vie+eng",
    segments: [
      {
        id: "p1",
        text: "Publish",
        kind: "line",
        confidence: 92,
        bbox: publishBbox,
      },
      {
        id: "p2",
        text: "Publish",
        kind: "word",
        confidence: 92,
        bbox: publishBbox,
      },
    ],
  };
}

const publishSelection = {
  text: "Publish",
  kind: "line" as const,
  bbox: { x: 10, y: 10, width: 70, height: 20 },
  confidence: 91,
  confirmed: true as const,
  language: "vie+eng" as const,
};

test("Match To Bottom prefers scrollable modal over focused nested editor", () => {
  const index = chooseOcrScrollCandidateIndex([
    { isModal: true, containsFocus: false, visibleArea: 400 * 480 },
    { isModal: false, containsFocus: true, visibleArea: 540 * 240 },
  ]);
  assert.equal(index, 0);
});

test("without modal, focused nested scroll container still wins", () => {
  const index = chooseOcrScrollCandidateIndex([
    { isModal: false, containsFocus: false, visibleArea: 900 * 500 },
    { isModal: false, containsFocus: true, visibleArea: 400 * 200 },
  ]);
  assert.equal(index, 1);
});

test("modal searchRegion includes Publish footer outside nested editor pane", () => {
  const editorOnly = computeOcrSearchRegion({
    zoom: 1,
    viewportWidth: 1024,
    viewportHeight: 560,
    modalBox: null,
    scrollBox: editorBox,
    scrollIsPageRoot: false,
  });
  const modalRegion = computeOcrSearchRegion({
    zoom: 1,
    viewportWidth: 1024,
    viewportHeight: 560,
    modalBox,
    scrollBox: editorBox,
    scrollIsPageRoot: false,
  });
  const publishCenterY = publishBbox.y + publishBbox.height / 2;
  assert.equal(
    publishCenterY >= editorOnly.y && publishCenterY <= editorOnly.y + editorOnly.height,
    false,
    "Publish sits outside the nested editor pane",
  );
  assert.equal(
    publishCenterY >= modalRegion.y && publishCenterY <= modalRegion.y + modalRegion.height,
    true,
    "Publish stays inside modal OCR searchRegion",
  );
});

test("Match To Bottom resolves visible Publish with modal searchRegion", async () => {
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  const template = await sharp({
    create: { width: 80, height: 28, channels: 3, background: "#1877f2" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "publish.png",
      roi: { ...publishBbox },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "bottom",
      ocr: publishSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  const modalRegion = computeOcrSearchRegion({
    zoom: 1,
    viewportWidth: 1024,
    viewportHeight: 560,
    modalBox,
    scrollBox: editorBox,
    scrollIsPageRoot: false,
  });
  const resolved = await resolveVisualTarget(
    frame,
    template,
    payload,
    { recognize: async () => publishOcr() },
    modalRegion,
  );
  assert.equal(resolved.method, "ocr");
  assert.ok(resolved.x >= publishBbox.x && resolved.x <= publishBbox.x + publishBbox.width);
  assert.ok(resolved.y >= publishBbox.y && resolved.y <= publishBbox.y + publishBbox.height);
});

test("Publish outside editor-only searchRegion stays OUTSIDE_SCROLL_CONTAINER", async () => {
  const frame = await sharp({
    create: { width: 1024, height: 560, channels: 3, background: "#f0f0f1" },
  })
    .png()
    .toBuffer();
  const template = await sharp({
    create: { width: 80, height: 28, channels: 3, background: "#1877f2" },
  })
    .png()
    .toBuffer();
  const payload: Payload = {
    action: "CLICK_TARGET",
    target: {
      asset: "publish.png",
      roi: { ...publishBbox },
      environment: { width: 1024, height: 560, zoom: 1 },
      matchTo: "bottom",
      ocr: publishSelection,
      clickOffset: { x: 0, y: 0 },
    },
  };
  const editorOnly = computeOcrSearchRegion({
    zoom: 1,
    viewportWidth: 1024,
    viewportHeight: 560,
    modalBox: null,
    scrollBox: editorBox,
    scrollIsPageRoot: false,
  });
  await assert.rejects(
    () =>
      resolveVisualTarget(
        frame,
        template,
        payload,
        { recognize: async () => publishOcr() },
        editorOnly,
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

test("ocr-match-scroll injects modal-aware scroll/region helpers", () => {
  const scrollPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/main/ocr-match-scroll.ts",
  );
  const source = readFileSync(scrollPath, "utf8");
  assert.match(source, /chooseOcrScrollCandidateIndex/);
  assert.match(source, /computeOcrSearchRegion/);
  assert.match(source, /modalBox:\s*state\.modal/);
  assert.doesNotMatch(
    source,
    /const pool = focused\.length \? focused : candidates/,
  );
});
