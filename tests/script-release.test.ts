import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  assertScriptPublishBody,
  buildScriptPublishBody,
  matchToRequiresMissingOcr,
  normalizeImportedVisualTarget,
} from "../src/shared/script-release.js";
import {
  assertNotScreenshot,
  attachVideoDemo,
  toScriptVideoDemo,
} from "../src/shared/video-demo.js";
import { validateScriptSubmission } from "../src/shared/seo-ops-publish.js";
import { importScriptRelease } from "../src/shared/script-sync.js";
import { validatePayload } from "../src/main/storage.js";

const flow: Flow = {
  id: "facebook-group-post",
  name: "Facebook Group Post",
  zoom: 1,
  steps: [{ id: "s1", version: 1 }],
  variables: [
    { id: "v1", key: "text", type: "text", description: "Body" },
    { id: "v2", key: "group_url", type: "text" },
  ],
};

const steps: Step[] = [
  {
    id: "s1",
    version: 1,
    name: "Type",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { action: "CLICK_AND_TYPE", variableId: "v1" },
  },
];

const caseId = "11111111-1111-1111-1111-111111111111";
const runId = "22222222-2222-2222-2222-222222222222";

describe("script-release", () => {
  it("builds SEO-OPS script publish body from scenario", () => {
    const attachment = attachVideoDemo({
      scriptId: flow.id,
      scriptVersion: "1.0.0",
      caseId,
      testRunId: runId,
      executionDigest: "a".repeat(64),
      sha256: "b".repeat(64),
      thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
      thumbnailSha256: "c".repeat(64),
      reviewed: true,
    });
    const body = buildScriptPublishBody({
      flow,
      steps,
      version: "1.0.0",
      packageKey: "facebook.group.post.script",
      videoDemo: toScriptVideoDemo(attachment),
    });
    assert.equal(body.kind, "script");
    assert.equal(body.manifest.script_id, "facebook-group-post");
    assert.equal(body.manifest.variables.length, 2);
    assert.equal(body.manifest.variables[0].id, "v1");
    assert.equal(body.manifest.steps[0].variable_key, "text");
    assert.equal(body.manifest.steps[0].variableId, "v1");
    assertScriptPublishBody(body);
  });

  it("attaches reviewed video demo metadata", () => {
    const attachment = attachVideoDemo({
      scriptId: flow.id,
      scriptVersion: "1.0.0",
      caseId,
      testRunId: runId,
      executionDigest: "a".repeat(64),
      sha256: "b".repeat(64),
      thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
      reviewed: true,
    });
    const demo = toScriptVideoDemo(attachment);
    const body = buildScriptPublishBody({
      flow,
      steps,
      version: "1.0.0",
      packageKey: "facebook.group.post.script",
      videoDemo: demo,
    });
    assert.equal(body.manifest.video_demo?.test_run_id, attachment.testRunId);
    assert.equal(body.manifest.video_demo?.audio, false);
    assert.equal(body.manifest.video_demo?.desktop_capture, false);
    validateScriptSubmission({ body, idempotencyKey: "k1" });
  });

  it("rejects screenshot paths as video demos", () => {
    assert.throws(() => assertNotScreenshot("case/run/final.png"));
    assert.doesNotThrow(() => assertNotScreenshot("case/run/recording.webm"));
  });

  it("requires review before video demo on release", () => {
    const attachment = attachVideoDemo({
      scriptId: flow.id,
      scriptVersion: "1.0.0",
      caseId,
      testRunId: runId,
      executionDigest: "a".repeat(64),
      thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
      reviewed: false,
    });
    assert.throws(() => toScriptVideoDemo(attachment));
  });

  it("exports OCR + execution fields and rejects Match To without OCR (no silent none)", () => {
    const ocr = {
      confirmed: true as const,
      language: "vie+eng" as const,
      kind: "line" as const,
      text: "@ Bạn viết gì đi...",
      confidence: 88,
      bbox: { x: 18, y: 16, width: 168, height: 41 },
    };
    const clickFlow: Flow = {
      ...flow,
      steps: [{ id: "c1", version: 12 }],
      variables: [],
    };
    const clickSteps: Step[] = [
      {
        id: "c1",
        version: 12,
        name: "CLICK_TARGET",
        createdAt: "2026-10-22T09:15:33.747Z",
        payload: {
          action: "CLICK_TARGET",
          method: "auto",
          threshold: 0.96,
          timeoutMs: 3000,
          target: {
            asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
            roi: { x: 164, y: 177, width: 685, height: 132 },
            matchTo: "top",
            ocr,
          },
        },
      },
    ];
    const attachment = attachVideoDemo({
      scriptId: clickFlow.id,
      scriptVersion: "1.0.0",
      caseId,
      testRunId: runId,
      executionDigest: "a".repeat(64),
      sha256: "b".repeat(64),
      thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
      thumbnailSha256: "c".repeat(64),
      reviewed: true,
    });
    const body = buildScriptPublishBody({
      flow: clickFlow,
      steps: clickSteps,
      version: "1.0.0",
      packageKey: "facebook.group.post.script",
      videoDemo: toScriptVideoDemo(attachment),
    });
    const exportedStep = body.manifest.steps[0];
    const exported = exportedStep.target as Record<string, unknown>;
    assert.equal(exported.matchTo, "top");
    assert.deepEqual(exported.ocr, ocr);
    assert.equal(exportedStep.method, "auto");
    assert.equal(exportedStep.threshold, 0.96);
    assert.equal(exportedStep.timeoutMs, 3000);

    const restored = normalizeImportedVisualTarget(exported);
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.target.matchTo, "top");
      assert.deepEqual(restored.target.ocr, ocr);
      validatePayload({
        action: "CLICK_TARGET",
        method: "auto",
        threshold: 0.96,
        timeoutMs: 3000,
        target: restored.target,
      });
    }

    const brokenTarget = {
      asset: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
      roi: { x: 164, y: 177, width: 685, height: 132 },
      matchTo: "top",
    };
    assert.equal(matchToRequiresMissingOcr(brokenTarget), true);
    const rejected = normalizeImportedVisualTarget(brokenTarget);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "invalid_payload");
    // No successful target with matchTo rewritten to none.
    assert.equal("target" in rejected, false);

    const badRelease = importScriptRelease({
      package_key: "legacy.broken",
      name: "Broken",
      version: "1.0.0",
      content_digest: "d".repeat(64),
      manifest: {
        script_id: "legacy-broken",
        variables: [],
        steps: [
          {
            id: "c1",
            version: 12,
            action: "CLICK_TARGET",
            target: brokenTarget,
          },
        ],
        assets: [
          {
            path: "17ddecd0-1e09-4198-a20a-171b8ff0d080.png",
            sha256: "a".repeat(64),
            kind: "roi",
          },
        ],
      },
    });
    assert.equal(badRelease.incomplete, true);
    assert.equal(badRelease.ready_to_execute, false);
    assert.ok(badRelease.incomplete_reasons.includes("invalid_payload"));
    assert.equal(badRelease.flowPayload, null);

    assert.throws(
      () =>
        validatePayload({
          action: "CLICK_TARGET",
          target: brokenTarget as never,
        }),
      /Match To cần OCR đã xác nhận/,
    );
  });
});
