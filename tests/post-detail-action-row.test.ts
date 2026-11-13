import test from "node:test";
import assert from "node:assert/strict";
import {
  actionRowOrderOk,
  clusterActionRows,
  shouldStopForActionRow,
  pickBestActionRowCandidate,
} from "../src/shared/post-detail-collector/action-row.js";
import { detectPostDetailContainer } from "../src/shared/post-detail-collector/auto-scan.js";
import type { PostDetailVisualAnchor } from "../src/shared/post-detail-collector/types.js";

function a(
  type: PostDetailVisualAnchor["type"],
  x: number,
  y: number,
  score = 0.95,
): PostDetailVisualAnchor {
  return {
    type,
    frameId: "f1",
    frameIndex: 1,
    bbox: { x, y, width: 36, height: 24 },
    score,
    templateId: `t-${type}`,
  };
}

test("action row requires Like→Comment→Share order", () => {
  assert.equal(actionRowOrderOk([a("LIKE", 100, 200), a("COMMENT", 160, 200), a("SHARE", 220, 200)]), true);
  assert.equal(actionRowOrderOk([a("SHARE", 100, 200), a("LIKE", 160, 200)]), false);
});

test("clusterActionRows forms STRONG row from three ordered icons", () => {
  const clusters = clusterActionRows([
    a("LIKE", 400, 300, 0.98),
    a("COMMENT", 460, 302, 0.96),
    a("SHARE", 520, 301, 0.94),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.types.length, 3);
  assert.equal(clusters[0]!.orderOk, true);
  assert.equal(shouldStopForActionRow(clusters[0]!), true);
});

test("mixed template heights still form one Like→Comment→Share row", () => {
  const like: PostDetailVisualAnchor = {
    type: "LIKE",
    frameId: "f5",
    frameIndex: 5,
    bbox: { x: 138, y: 267, width: 42, height: 26 },
    score: 1,
    templateId: "like",
  };
  const comment: PostDetailVisualAnchor = {
    type: "COMMENT",
    frameId: "f5",
    frameIndex: 5,
    bbox: { x: 199, y: 265, width: 41, height: 31 },
    score: 1,
    templateId: "comment",
  };
  const share: PostDetailVisualAnchor = {
    type: "SHARE",
    frameId: "f5",
    frameIndex: 5,
    bbox: { x: 256, y: 266, width: 43, height: 28 },
    score: 0.897,
    templateId: "share",
  };
  const clusters = clusterActionRows([like, comment, share]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0]!.types.sort(), ["COMMENT", "LIKE", "SHARE"]);
  assert.equal(shouldStopForActionRow(clusters[0]!), true);
});

test("single Like does not form action row cluster", () => {
  assert.equal(clusterActionRows([a("LIKE", 400, 300, 1)]).length, 0);
});

test("earlier main-post cluster is not replaced by later comment row", () => {
  const main = clusterActionRows([
    a("LIKE", 400, 200, 0.9),
    a("COMMENT", 460, 200, 0.9),
    a("SHARE", 520, 200, 0.9),
  ])[0]!;
  const comment = clusterActionRows([
    a("LIKE", 400, 480, 0.99),
    a("COMMENT", 460, 480, 0.99),
  ])[0]!;
  const picked = pickBestActionRowCandidate(main, comment, 5, 2);
  assert.ok(picked);
  assert.equal(picked!.frameIndex, 2);
  assert.ok(picked!.cluster.bbox.y < 300);
});

test("detectPostDetailContainer retains MAIN_ACTION_ROW_CANDIDATE without modal edges", () => {
  const anchors = [
    a("LIKE", 400, 300, 0.98),
    a("COMMENT", 460, 302, 0.96),
    a("SHARE", 520, 301, 0.94),
  ];
  const result = detectPostDetailContainer({
    runId: "pd_row",
    sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
    frames: [
      {
        frameId: "frame-001",
        frameIndex: 1,
        scrollDeltaApplied: 0,
        observedScrollPx: 0,
        width: 1024,
        height: 560,
        anchors,
        notes: [],
      },
    ],
    wheelPoint: { x: 512, y: 280 },
    deltaY: -100,
    settleMs: 550,
    maxFrames: 20,
    stoppedReason: "MAIN_ACTION_ROW_CANDIDATE",
    // flat profile → no edges
    horizontalProfiles: [{ frameId: "frame-001", columns: new Float64Array(1024).fill(128) }],
  });
  assert.ok(result.mainActionRow);
  assert.equal(result.mainActionRow!.status, "MAIN_ACTION_ROW_CANDIDATE");
  assert.equal(result.mainActionRow!.types.length, 3);
  // Container may stay AMBIGUOUS without edges — Phase A still keeps the row.
  assert.equal(result.status, "AMBIGUOUS");
});
