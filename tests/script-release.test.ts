import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  assertScriptPublishBody,
  buildScriptPublishBody,
} from "../src/shared/script-release.js";
import {
  assertNotScreenshot,
  attachVideoDemo,
  toScriptVideoDemo,
} from "../src/shared/video-demo.js";
import { validateScriptSubmission } from "../src/shared/seo-ops-publish.js";

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
    assert.equal(body.manifest.steps[0].variable_key, "text");
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
});
