import type { CaseResult } from "./contracts.js";
import type { ScriptVideoDemo } from "./script-release.js";
import type { VideoDemoAttachment } from "./video-demo.js";

const SUCCESS: ReadonlySet<string> = new Set(["PASS", "ACTION_SENT"]);

/** Successful Test Runs may become Script demos; failures remain viewable only. */
export function isSuccessfulTestRun(status?: string): boolean {
  return SUCCESS.has(status ?? "");
}

export function canUseAsScriptDemo(result: Pick<CaseResult, "status" | "recordingPath" | "recordingError" | "runId">): {
  ok: boolean;
  reason?: string;
} {
  if (!result.runId) return { ok: false, reason: "VIDEO_DEMO: missing test_run_id" };
  if (!isSuccessfulTestRun(result.status)) {
    return { ok: false, reason: "VIDEO_DEMO: only successful Runs (PASS / ACTION_SENT) can be Script Demo" };
  }
  if (result.recordingError) {
    return { ok: false, reason: `VIDEO_DEMO: recording failed — ${result.recordingError}` };
  }
  if (!result.recordingPath) {
    return { ok: false, reason: "VIDEO_DEMO: recording incomplete or missing" };
  }
  return { ok: true };
}

export function assertDemoBelongsToScript(
  attachment: Pick<VideoDemoAttachment, "scriptId">,
  scriptId: string,
): void {
  if (attachment.scriptId !== scriptId) {
    throw new Error("VIDEO_DEMO: recording belongs to a different Script");
  }
}

export function assertExecutionDigestMatches(
  attachment: Pick<VideoDemoAttachment, "executionDigest">,
  currentDigest: string,
): void {
  if (!attachment.executionDigest || !currentDigest) {
    throw new Error("VIDEO_DEMO: execution digest required");
  }
  if (attachment.executionDigest.toLowerCase() !== currentDigest.toLowerCase()) {
    throw new Error("VIDEO_DEMO: Script execution changed — run Test Lab again for this version");
  }
}

export function assertPublishVideoDemoReady(demo: ScriptVideoDemo | undefined): asserts demo is ScriptVideoDemo {
  if (!demo) throw new Error("VIDEO_DEMO: missing_demo — open Test Lab, Run, then Use as Script Demo");
  if (!demo.artifact_ref || !demo.test_run_id || !demo.reviewed) {
    throw new Error("VIDEO_DEMO: incomplete demo metadata");
  }
  if (demo.audio !== false || demo.desktop_capture !== false) {
    throw new Error("VIDEO_DEMO: browser-only silent capture required");
  }
}

/** Incomplete reason used by catalog / sync UI. */
export const MISSING_DEMO_REASON = "missing_demo";

export function hasMissingDemoReason(reasons: string[]): boolean {
  return reasons.some((r) => r === MISSING_DEMO_REASON || r.startsWith("missing_demo"));
}
