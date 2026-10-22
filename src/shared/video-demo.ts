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
};

/** Promote a Test Lab browser recording into a Script video demo reference. */
export function attachVideoDemo(input: {
  scriptId: string;
  scriptVersion: string;
  caseId: string;
  testRunId: string;
  sha256?: string;
  reviewed?: boolean;
}): VideoDemoAttachment {
  const { scriptId, scriptVersion, caseId, testRunId } = input;
  if (!scriptId || !scriptVersion || !caseId || !testRunId) {
    throw new Error("VIDEO_DEMO: scriptId, scriptVersion, caseId, testRunId required");
  }
  // Screenshots are not video demos.
  const artifactRef = `${caseId}/${testRunId}/recording.webm`;
  return {
    scriptId,
    scriptVersion,
    testRunId,
    caseId,
    artifactRef,
    mime: "video/webm",
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    reviewed: input.reviewed === true,
  };
}

export function toScriptVideoDemo(attachment: VideoDemoAttachment): ScriptVideoDemo {
  if (!attachment.reviewed) {
    throw new Error("VIDEO_DEMO: must be human-reviewed before Script release metadata");
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
