import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  anchorsFormActionRow,
  detectPostDetailContainer,
  inferAnchorTypeFromLabel,
  selectPrimaryActionRow,
  uniqueAnchorTypes,
  viewportWheelPoint,
} from "../src/shared/post-detail-collector/auto-scan.js";
import {
  defaultScrollCompareRoi,
  inferHorizontalCardBounds,
  isVisualScrollConfirmed,
  measureVisualMotionScore,
} from "../src/shared/post-detail-collector/scroll-motion.js";
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

/** Bright card in center, dark sides — mimics FB modal column profile. */
function cardProfile(width = 1024): Float64Array {
  const cols = new Float64Array(width);
  const left = Math.round(width * 0.22);
  const right = Math.round(width * 0.78);
  for (let x = 0; x < width; x++) {
    cols[x] = x >= left && x <= right ? 220 : 40;
  }
  return cols;
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

test("content-band motion score distinguishes still vs moved frames", () => {
  const w = 100;
  const h = 80;
  const prev = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const next = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < prev.data.length; i += 4) {
    prev.data[i] = 40;
    prev.data[i + 1] = 40;
    prev.data[i + 2] = 40;
    prev.data[i + 3] = 255;
    next.data[i] = 40;
    next.data[i + 1] = 40;
    next.data[i + 2] = 40;
    next.data[i + 3] = 255;
  }
  const still = measureVisualMotionScore(prev, next, defaultScrollCompareRoi(w, h));
  assert.ok(still.score < 1);
  assert.equal(isVisualScrollConfirmed(still.score), false);

  // Shift content band brighter in next frame.
  const roi = defaultScrollCompareRoi(w, h);
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const i = (y * w + x) * 4;
      next.data[i] = 200;
      next.data[i + 1] = 200;
      next.data[i + 2] = 200;
    }
  }
  const moved = measureVisualMotionScore(prev, next, roi);
  assert.ok(moved.score > 6.5);
  assert.equal(isVisualScrollConfirmed(moved.score), true);
});

test("horizontal card bounds inferred from column profile", () => {
  const cols = cardProfile(1024);
  const edge = inferHorizontalCardBounds(cols);
  assert.ok(edge);
  assert.ok(edge!.left < 300);
  assert.ok(edge!.right > 700);
});

test("single Like icon cannot be FOUND container", () => {
  const frames: PostDetailScanFrame[] = [
    {
      frameId: "f1",
      frameIndex: 1,
      scrollDeltaApplied: 0,
      observedScrollPx: 0,
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
    deltaY: -280,
    settleMs: 450,
    maxFrames: 8,
    stoppedReason: "max-frames",
    horizontalProfiles: [{ frameId: "f1", columns: cardProfile() }],
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.containerBounds, null);
});

test("LIKE+COMMENT action row + modal edges yields FOUND; width not icon-union", () => {
  const like = anchor({
    type: "LIKE",
    frameId: "f2",
    frameIndex: 2,
    bbox: { x: 400, y: 380, width: 36, height: 24 },
    score: 0.99,
  });
  const comment = anchor({
    type: "COMMENT",
    frameId: "f2",
    frameIndex: 2,
    bbox: { x: 460, y: 382, width: 40, height: 22 },
    score: 0.95,
  });
  assert.equal(anchorsFormActionRow([like, comment]), true);
  assert.deepEqual(uniqueAnchorTypes([like, comment]).sort(), ["COMMENT", "LIKE"]);

  const frames: PostDetailScanFrame[] = [
    {
      frameId: "f1",
      frameIndex: 1,
      scrollDeltaApplied: 0,
      observedScrollPx: 0,
      width: 1024,
      height: 560,
      anchors: [],
      notes: [],
    },
    {
      frameId: "f2",
      frameIndex: 2,
      scrollDeltaApplied: 280,
      observedScrollPx: 280,
      width: 1024,
      height: 560,
      anchors: [like, comment],
      notes: [],
      diagnostics: {
        frameIndex: 2,
        wheelTarget: { x: 512, y: 280 },
        requestedDeltaY: -280,
        wheelOutcome: "WHEEL_SENT",
        visualMotionScore: 18,
        scrollConfirmed: true,
        scrollConfirmLabel: "VISUAL_SCROLL_CONFIRMED",
        observedScrollPx: 280,
        matchLogs: [],
        containerCandidate: null,
      },
    },
  ];
  const result = detectPostDetailContainer({
    runId: "pd_test2",
    sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
    frames,
    wheelPoint: { x: 512, y: 280 },
    deltaY: -280,
    settleMs: 450,
    maxFrames: 8,
    stoppedReason: "found-container",
    observedScrollPx: 280,
    horizontalProfiles: [
      { frameId: "f1", columns: cardProfile() },
      { frameId: "f2", columns: cardProfile() },
    ],
  });
  assert.equal(result.status, "FOUND");
  assert.ok(result.containerBounds);
  assert.ok(result.containerBounds!.width > 400, "width from modal edges, not icon union");
  assert.ok(result.containerBounds!.width < 700);
  assert.ok(result.containerBounds!.y < like.bbox.y);
});

test("action row without horizontal edges → AMBIGUOUS (not FOUND)", () => {
  const like = anchor({
    type: "LIKE",
    frameId: "f1",
    bbox: { x: 400, y: 380, width: 36, height: 24 },
    score: 0.99,
  });
  const comment = anchor({
    type: "COMMENT",
    frameId: "f1",
    bbox: { x: 460, y: 382, width: 40, height: 22 },
    score: 0.95,
  });
  const result = detectPostDetailContainer({
    runId: "pd_no_edge",
    sourceUrl: "https://www.facebook.com/",
    frames: [
      {
        frameId: "f1",
        frameIndex: 1,
        scrollDeltaApplied: 0,
        observedScrollPx: 0,
        width: 1024,
        height: 560,
        anchors: [like, comment],
        notes: [],
      },
    ],
    wheelPoint: { x: 512, y: 280 },
    deltaY: -280,
    settleMs: 450,
    maxFrames: 5,
    stoppedReason: "max-frames",
    // flat profile → no edges
    horizontalProfiles: [{ frameId: "f1", columns: new Float64Array(1024).fill(128) }],
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.containerBounds, null);
});

test("selectPrimaryActionRow prefers upper main-post band over comment likes", () => {
  const main = [
    anchor({ type: "LIKE", bbox: { x: 400, y: 200, width: 30, height: 20 }, score: 0.9 }),
    anchor({ type: "COMMENT", bbox: { x: 450, y: 202, width: 30, height: 20 }, score: 0.88 }),
  ];
  const commentRow = [
    anchor({ type: "LIKE", bbox: { x: 420, y: 480, width: 24, height: 16 }, score: 0.95, candidateRank: 1 }),
    anchor({ type: "SHARE", bbox: { x: 470, y: 482, width: 24, height: 16 }, score: 0.92, candidateRank: 1 }),
  ];
  const row = selectPrimaryActionRow(main, commentRow);
  assert.ok(row);
  const meanY = row!.reduce((s, a) => s + a.bbox.y, 0) / row!.length;
  assert.ok(meanY < 300);
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
        observedScrollPx: 0,
        width: 1024,
        height: 560,
        anchors: [],
        notes: [],
      },
    ],
    wheelPoint: { x: 512, y: 280 },
    deltaY: -280,
    settleMs: 450,
    maxFrames: 5,
    stoppedReason: "max-frames",
  });
  assert.equal(result.status, "NOT_FOUND");
});

test("wheel dispatch uses mouseMove then mouseWheel; signed delta; visual confirm", () => {
  const browser = read("src/main/browser-core.ts");
  assert.match(browser, /type: "mouseMove"/);
  assert.match(browser, /type: "mouseWheel"/);

  const runner = read("src/renderer/post-detail-collector/auto-scan-runner.ts");
  assert.match(runner, /Frame 1: capture before any wheel/);
  assert.match(runner, /VISUAL_SCROLL_CONFIRMED/);
  assert.match(runner, /SCROLL_NOT_MOVING/);
  assert.match(runner, /collectorCaptureKeepVisible/);
  assert.match(runner, /observedScrollPx/);
  assert.doesNotMatch(runner, /scrollApplied \+= deltaY/);

  const defaults = read("src/shared/post-detail-collector/types.ts");
  assert.match(defaults, /deltaY: -280/);

  const main = read("src/main/main.ts");
  assert.match(main, /WHEEL_SENT/);
  assert.match(main, /WHEEL_BLOCKED/);
});

test("Step 2 UI wires Auto Scan pipeline and Step 3 gate needs container", () => {
  const step2 = read("src/renderer/post-detail-collector/VisualRegionStep.tsx");
  assert.match(step2, /Start Auto Scan/);
  assert.match(step2, /runPostDetailAutoScan/);
  assert.match(step2, /Confirm Container/);
  assert.doesNotMatch(step2, /Capture & Match/);

  const page = read("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx");
  assert.match(page, /containerResult/);
  assert.match(page, /canEnterStep3/);
});
