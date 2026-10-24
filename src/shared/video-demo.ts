import type { ScriptVideoDemo } from "./script-release.js";

export type VideoDemoAttachment = {
  scriptId: string;
  scriptVersion: string;
  testRunId: string;
  caseId: string;
  /** Relative evidence path: {caseId}/{runId}/recording.webm */
  artifactRef: string;
  mime: "video/webm";
  sha256?: string;
  reviewed: boolean;
  /** Digest of Script execution (steps/vars/assets) at attach time. */
  executionDigest: string;
  /** Relative path to JPEG from last valid browser frame. */
  thumbnailRef?: string;
  thumbnailSha256?: string;
  /** Exact pinned Step versions represented by this recording. */
  stepVersions?: Array<{ id: string; version: number }>;
  selectedAt?: string;
};

/** Promote a Test Lab browser recording into a Script video demo reference. */
export function attachVideoDemo(input: {
  scriptId: string;
  scriptVersion: string;
  caseId: string;
  testRunId: string;
  executionDigest: string;
  sha256?: string;
  reviewed?: boolean;
  thumbnailRef?: string;
  thumbnailSha256?: string;
  artifactRef?: string;
  stepVersions?: Array<{ id: string; version: number }>;
  selectedAt?: string;
}): VideoDemoAttachment {
  const { scriptId, scriptVersion, caseId, testRunId, executionDigest } = input;
  if (!scriptId || !scriptVersion || !caseId || !testRunId) {
    throw new Error("VIDEO_DEMO: scriptId, scriptVersion, caseId, testRunId required");
  }
  if (!executionDigest || !/^[a-f0-9]{64}$/i.test(executionDigest)) {
    throw new Error("VIDEO_DEMO: executionDigest required (64-hex)");
  }
  // Screenshots are not video demos.
  const artifactRef = input.artifactRef ?? `${caseId}/${testRunId}/recording.webm`;
  return {
    scriptId,
    scriptVersion,
    testRunId,
    caseId,
    artifactRef,
    mime: "video/webm",
    executionDigest: executionDigest.toLowerCase(),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.thumbnailRef ? { thumbnailRef: input.thumbnailRef } : {}),
    ...(input.thumbnailSha256 ? { thumbnailSha256: input.thumbnailSha256 } : {}),
    reviewed: input.reviewed === true,
    ...(input.stepVersions ? { stepVersions: input.stepVersions.map(step => ({ ...step })) } : {}),
    ...(input.selectedAt ? { selectedAt: input.selectedAt } : {}),
  };
}

export function toScriptVideoDemo(attachment: VideoDemoAttachment): ScriptVideoDemo {
  if (!attachment.reviewed) {
    throw new Error("VIDEO_DEMO: must be human-reviewed before Script release metadata");
  }
  if (!attachment.thumbnailRef) {
    throw new Error("VIDEO_DEMO: thumbnail required — last browser frame missing");
  }
  return {
    artifact_ref: attachment.artifactRef,
    mime: "video/webm",
    ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
    test_run_id: attachment.testRunId,
    script_version: attachment.scriptVersion,
    reviewed: true,
    audio: false,
    desktop_capture: false,
    execution_digest: attachment.executionDigest,
    thumbnail_ref: attachment.thumbnailRef,
    ...(attachment.thumbnailSha256 ? { thumbnail_sha256: attachment.thumbnailSha256 } : {}),
  };
}

/** Reject treating a screenshot path as a video demo. */
export function assertNotScreenshot(path: string) {
  if (/\.(png|jpe?g|gif|webp)$/i.test(path) || path.endsWith("/final.png")) {
    throw new Error("VIDEO_DEMO: screenshots are not video demos");
  }
  if (!/\.webm$/i.test(path) && !/\.mp4$/i.test(path)) {
    throw new Error("VIDEO_DEMO: expected .webm or .mp4");
  }
}
