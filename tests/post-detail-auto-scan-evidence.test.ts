import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostDetailRunStorage } from "../src/main/post-detail-storage.js";
import type { PostDetailContainerResult } from "../src/shared/post-detail-collector/types.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function container(runId: string): PostDetailContainerResult {
  return {
    status: "AMBIGUOUS",
    containerBounds: null,
    frameIds: ["frame-001"],
    visualAnchors: [
      {
        type: "LIKE",
        frameId: "frame-001",
        frameIndex: 1,
        bbox: { x: 10, y: 20, width: 30, height: 12 },
        score: 0.9,
        templateId: "tpl-like",
      },
    ],
    confidence: 0.9,
    evidenceRefs: ["frame:frame-001"],
    runId,
    sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
    scrollMetadata: {
      wheelPoint: { x: 512, y: 280 },
      deltaY: -100,
      settleMs: 450,
      maxFrames: 5,
      framesCaptured: 1,
      stoppedReason: "max-frames",
      requestedScrollPx: 0,
      observedScrollPx: 0,
      visualScrollConfirmedFrames: 0,
    },
    notes: ["single like"],
    mainActionRow: null,
  };
}

test("auto-scan evidence writes once and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pdc-autoscan-"));
  try {
    const storage = new PostDetailRunStorage(root);
    const runId = "pd_evidence_once";
    const first = await storage.saveAutoScan({
      runId,
      sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
      visualReferences: [
        {
          sampleId: "tpl-like",
          label: "like",
          dataUrl: tinyPng,
          width: 1,
          height: 1,
          sourceCaptureId: "c1",
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          createdAt: new Date().toISOString(),
        },
      ],
      frames: [
        {
          frameId: "frame-001",
          frameIndex: 1,
          scrollDeltaApplied: 0,
          observedScrollPx: 0,
          width: 1024,
          height: 560,
          anchors: container(runId).visualAnchors,
          notes: [],
          screenshotDataUrl: tinyPng,
        },
      ],
      container: container(runId),
    });
    assert.equal(first.ok, true);
    assert.equal(first.frameCount, 1);

    const manifest = JSON.parse(await readFile(first.autoScanManifestPath, "utf8"));
    assert.equal(manifest.kind, "POST_DETAIL_AUTO_SCAN");
    assert.equal(manifest.containerStatus, "AMBIGUOUS");
    assert.ok(manifest.scrollMetadata);

    await assert.rejects(
      () =>
        storage.saveAutoScan({
          runId,
          sourceUrl: "https://www.facebook.com/groups/x/posts/1/",
          visualReferences: [],
          frames: [],
          container: container(runId),
        }),
      /POST_DETAIL_AUTO_SCAN_EXISTS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
