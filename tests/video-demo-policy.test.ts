import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  assertScriptPublishBody,
  buildScriptCatalogSnapshot,
  buildScriptPublishBody,
} from "../src/shared/script-release.js";
import {
  assertDemoBelongsToScript,
  assertExecutionDigestMatches,
  canUseAsScriptDemo,
  hasMissingDemoReason,
  MISSING_DEMO_REASON,
} from "../src/shared/video-demo-policy.js";
import { attachVideoDemo, toScriptVideoDemo } from "../src/shared/video-demo.js";
import { planScriptSync } from "../src/shared/script-sync.js";
import { labelForStatus, statusFromPlanSides } from "../src/shared/sync-status.js";

const flow: Flow = {
  id: "script-a",
  name: "Script A",
  zoom: 1,
  steps: [{ id: "s1", version: 1 }],
  variables: [],
  defaultPattern: { values: {} },
};

const steps: Step[] = [
  {
    id: "s1",
    version: 1,
    name: "sleep",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { action: "SLEEP", timeoutMs: 50 },
  },
];

const caseId = "11111111-1111-1111-1111-111111111111";
const runId = "22222222-2222-2222-2222-222222222222";

function demoFor(scriptId: string, digest: string, version = "1.0.0") {
  return attachVideoDemo({
    scriptId,
    scriptVersion: version,
    caseId,
    testRunId: runId,
    executionDigest: digest,
    sha256: "b".repeat(64),
    thumbnailRef: `${caseId}/${runId}/recording-thumb.jpg`,
    thumbnailSha256: "c".repeat(64),
    reviewed: true,
  });
}

describe("video demo policy", () => {
  it("auto-recording eligibility: success can become demo; failure cannot", () => {
    assert.equal(
      canUseAsScriptDemo({
        status: "PASS",
        runId,
        recordingPath: `${caseId}/${runId}/recording.webm`,
      }).ok,
      true,
    );
    assert.equal(
      canUseAsScriptDemo({
        status: "ERROR",
        runId,
        recordingPath: `${caseId}/${runId}/recording.webm`,
      }).ok,
      false,
    );
    assert.equal(
      canUseAsScriptDemo({
        status: "PASS",
        runId,
        recordingError: "encoder failed",
      }).ok,
      false,
    );
  });

  it("failed run keeps recording evidence viewable but not attachable", () => {
    const failed = canUseAsScriptDemo({
      status: "ERROR",
      runId,
      recordingPath: `${caseId}/${runId}/recording.webm`,
    });
    assert.equal(failed.ok, false);
    assert.match(failed.reason ?? "", /successful Runs/i);
  });

  it("rejects video from a different Script", () => {
    const probe = buildScriptCatalogSnapshot({ flow, steps, version: "1.0.0", assets: [] });
    const foreign = demoFor("script-b", probe.execution_digest);
    assert.throws(() => assertDemoBelongsToScript(foreign, "script-a"), /different Script/);
  });

  it("rejects stale execution digest", () => {
    const attachment = demoFor("script-a", "a".repeat(64));
    assert.throws(
      () => assertExecutionDigestMatches(attachment, "b".repeat(64)),
      /execution changed/i,
    );
  });

  it("catalog marks missing_demo and blocks publish body", () => {
    const snap = buildScriptCatalogSnapshot({ flow, steps, version: "1.0.0", assets: [] });
    assert.equal(snap.incomplete, true);
    assert.ok(hasMissingDemoReason(snap.incomplete_reasons));
    assert.equal(snap.publish_body, null);
  });

  it("valid demo allows publish; missing demo cannot push", () => {
    const probe = buildScriptCatalogSnapshot({ flow, steps, version: "1.0.0", assets: [] });
    const attachment = demoFor(flow.id, probe.execution_digest);
    const demo = toScriptVideoDemo(attachment);
    const ready = buildScriptCatalogSnapshot({
      flow,
      steps,
      version: "1.0.0",
      assets: [],
      videoDemo: demo,
    });
    assert.equal(ready.incomplete, false);
    assert.ok(ready.publish_body);
    assertScriptPublishBody(ready.publish_body!);

    const planReady = planScriptSync(
      [{
        script_id: flow.id,
        package_key: ready.package_key,
        version: ready.version,
        content_digest: ready.content_digest,
        publish_body: ready.publish_body!,
      }],
      [],
    );
    assert.equal(planReady.push_to_remote.length, 1);

    const missing = buildScriptCatalogSnapshot({ flow, steps, version: "1.0.0", assets: [] });
    assert.ok(missing.incomplete_reasons.includes(MISSING_DEMO_REASON));
  });

  it("assertScriptPublishBody requires video demo", () => {
    const body = buildScriptPublishBody({ flow, steps, version: "1.0.0" });
    assert.throws(() => assertScriptPublishBody(body), /missing_demo/);
  });

  it("UI status Missing demo does not look like sync error", () => {
    assert.equal(labelForStatus("missing_demo"), "Missing demo");
    assert.equal(
      statusFromPlanSides({
        hasLocal: true,
        hasRemote: false,
        sameDigest: false,
        conflict: false,
        localAhead: false,
        remoteAhead: false,
        incomplete: true,
        missingDemo: true,
      }),
      "missing_demo",
    );
  });

  it("browser-only silent capture flags stay false (no profile/cookie packaging)", () => {
    const probe = buildScriptCatalogSnapshot({ flow, steps, version: "1.0.0", assets: [] });
    const demo = toScriptVideoDemo(demoFor(flow.id, probe.execution_digest));
    assert.equal(demo.audio, false);
    assert.equal(demo.desktop_capture, false);
    assert.match(demo.artifact_ref, /recording\.webm$/);
    assert.ok(!/cookie|profile|partition/i.test(JSON.stringify(demo)));
  });
});
