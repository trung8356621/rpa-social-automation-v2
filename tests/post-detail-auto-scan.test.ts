import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  anchorsFormActionRow,
  detectPostDetailContainer,
  inferAnchorTypeFromLabel,
  uniqueAnchorTypes,
  viewportWheelPoint,
} from "../src/shared/post-detail-collector/auto-scan.js";
import type { PostDetailScanFrame, PostDetailVisualAnchor } from "../src/shared/post-detail-collector/types.js";

function read(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

function anchor(
  partial: Partial<PostDetailVisualAnchor> & Pick<PostDetailVisualAnchor, "type" | "bbox" | "score">,
): PostDetailVisualAnchor {
  return {
    frameId: partial.frameId || "frame-001",
    frameIndex: partial.frameIndex || 1,
    templateId: partial.templateId || "t1",
    ...partial,
  };
}

test("viewport wheel point is viewport center (1024×560 → 512,280)", () => {
  assert.deepEqual(viewportWheelPoint({ width: 1024, height: 560 }), { x: 512, y: 280 });
  assert.deepEqual(viewportWheelPoint({ width: 800, height: 600 }), { x: 400, y: 300 });
});

test("inferAnchorTypeFromLabel maps Step 1 labels", () => {
  assert.equal(inferAnchorTypeFromLabel("like"), "LIKE");
  assert.equal(inferAnchorTypeFromLabel("Comment"), "COMMENT");
  assert.equal(inferAnchorTypeFromLabel("share-icon"), "SHARE");
  assert.equal(inferAnchorTypeFromLabel("content-region"), null);
});

test("single Like icon cannot be FOUND container", () => {
  const frames: PostDetailScanFrame[] = [
    {
      frameId: "f1",
      frameIndex: 1,
      scrollDeltaApplied: 0,
      width: 1024,
      height: 560,
      anchors: [anchor({ type: "LIKE", bbox: { x: 100, y: 400, width: 40, height: 20 }, score: 1 })],
      notes: [],
    },
  ];
  const result = detectPostDetailContainer({
    runId: "pd_test",
    sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
    frames,
    wheelPoint: { x: 512, y: 280 },
    deltaY: 280,
    settleMs: 450,
    maxFrames: 8,
    stoppedReason: "max-frames",
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.containerBounds, null);
});

test("LIKE+COMMENT action row yields FOUND container above the row", () => {
  const like = anchor({
    type: "LIKE",
    frameId: "f2",
    frameIndex: 2,
    bbox: { x: 120, y: 380, width: 36, height: 24 },
    score: 0.99,
  });
  const comment = anchor({
    type: "COMMENT",
    frameId: "f2",
    frameIndex: 2,
    bbox: { x: 180, y: 382, width: 40, height: 22 },
    score: 0.95,
  });
  assert.equal(anchorsFormActionRow([like, comment]), true);
  assert.deepEqual(uniqueAnchorTypes([like, comment]).sort(), ["COMMENT", "LIKE"]);

  const frames: PostDetailScanFrame[] = [
    {
      frameId: "f1",
      frameIndex: 1,
      scrollDeltaApplied: 0,
      width: 1024,
      height: 560,
      anchors: [],
      notes: [],
    },
    {
      frameId: "f2",
      frameIndex: 2,
      scrollDeltaApplied: 280,
      width: 1024,
      height: 560,
      anchors: [like, comment],
      notes: [],
    },
  ];
  const result = detectPostDetailContainer({
    runId: "pd_test2",
    sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
    frames,
    wheelPoint: { x: 512, y: 280 },
    deltaY: 280,
    settleMs: 450,
    maxFrames: 8,
    stoppedReason: "found-container",
  });
  assert.equal(result.status, "FOUND");
  assert.ok(result.containerBounds);
  assert.ok(result.containerBounds!.y + result.containerBounds!.height >= like.bbox.y);
  assert.ok(result.containerBounds!.y < like.bbox.y);
  assert.equal(result.frameIds.length, 2);
});

test("no anchors → NOT_FOUND", () => {
  const result = detectPostDetailContainer({
    runId: "pd_empty",
    sourceUrl: "https://www.facebook.com/",
    frames: [
      {
        frameId: "f1",
        frameIndex: 1,
        scrollDeltaApplied: 0,
        width: 1024,
        height: 560,
        anchors: [],
        notes: [],
      },
    ],
    wheelPoint: { x: 512, y: 280 },
    deltaY: 280,
    settleMs: 450,
    maxFrames: 5,
    stoppedReason: "max-frames",
  });
  assert.equal(result.status, "NOT_FOUND");
});

test("auto-scan runner order: capture frame 1 before wheel; cancel checked; no refs throws", () => {
  const runner = read("src/renderer/post-detail-collector/auto-scan-runner.ts");
  assert.match(runner, /Frame 1: capture before any wheel/);
  assert.match(runner, /if \(i > 1\)[\s\S]*collectorPostDetailWheel[\s\S]*collectorFreezeFrame/);
  assert.match(runner, /isCancelled/);
  assert.match(runner, /AUTO_SCAN_NO_REFERENCES/);
  assert.match(runner, /matchFrameAnchors/);
});

test("Step 2 UI wires Auto Scan pipeline and Step 3 gate needs container", () => {
  const step2 = read("src/renderer/post-detail-collector/VisualRegionStep.tsx");
  assert.match(step2, /Start Auto Scan/);
  assert.match(step2, /runPostDetailAutoScan/);
  assert.match(step2, /Confirm Container/);
  assert.match(step2, /postDetailSaveAutoScan/);
  assert.doesNotMatch(step2, /Capture & Match/);

  const page = read("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx");
  assert.match(page, /containerResult/);
  assert.match(page, /canEnterStep3/);
  assert.match(page, /containerResult\?\.containerBounds/);

  const main = read("src/main/main.ts");
  assert.match(main, /case "postDetailWheel"/);
  assert.match(main, /case "postDetailSaveAutoScan"/);
  const browser = read("src/main/browser-core.ts");
  assert.match(browser, /type: "mouseWheel"/);
});
