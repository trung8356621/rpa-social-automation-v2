import type { Result, Step } from "./contracts.js";
export type StepPlayback = {
  /** `invalid` = configuration/preflight (Step never executed). `blocked` = runtime. */
  status: "running" | "pass" | "fail" | "blocked" | "skipped" | "invalid";
  message: string;
  resultStatus?: Result["status"];
  error?: Result["error"];
  /** Correlates UI chip to a specific run — prevents stale cross-run readout. */
  runId?: string;
  at?: string;
  source?: "play-all" | "step" | "test-lab" | "preflight";
  flatOrder?: number;
  uiNumber?: string;
};
export type PlaybackMeta = Pick<StepPlayback, "runId" | "at" | "source">;
export function playbackMeta(
  source: NonNullable<StepPlayback["source"]>,
  runId?: string,
  at = new Date().toISOString(),
): PlaybackMeta {
  return { source, at, ...(runId ? { runId } : {}) };
}
export function playbackResult(results: Result[], meta?: PlaybackMeta): StepPlayback {
  const failed = results.find((r) => !r.ok),
    last = failed ?? results.at(-1);
  if (!last) return { status: "fail", message: "Test returned no result.", ...meta };
  return {
    status: last.status === "BLOCKED" ? "blocked" : last.ok ? "pass" : "fail",
    message: last.message,
    resultStatus: last.status,
    error: last.error,
    ...meta,
  };
}
/** UI sequencing only: every action is still sent through the existing Test API. */
export async function playSequential(
  steps: Step[],
  execute: (step: Step) => Promise<Result[]>,
  progress: (step: Step, state: StepPlayback) => void,
  skip?: (step: Step) => Promise<boolean>,
  betweenSteps?: (previous: Step, next: Step) => Promise<void>,
) {
  let previousPassed: Step | undefined;
  for (const step of steps) {
    if (skip && await skip(step)) {
      progress(step, {
        status: "skipped",
        message: "SKIPPED · Blocked for Play All (memory only)",
        at: new Date().toISOString(),
        source: "play-all",
      });
      continue;
    }
    if (previousPassed && betweenSteps) await betweenSteps(previousPassed, step);
    progress(step, { status: "running", message: "Running", at: new Date().toISOString() });
    let state: StepPlayback;
    try {
      state = playbackResult(await execute(step));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        status:
          /variable|Default Pattern|type mismatch|sai kiểu|Zoom|Viewport|không thuộc flow|thiếu ảnh ROI|Match To|Invalid Step|Ghim version|→ Step |UI \d+/i.test(
            message,
          )
            ? "blocked"
            : "fail",
        message,
        at: new Date().toISOString(),
      };
    }
    progress(step, state);
    if (state.status !== "pass") return;
    previousPassed = step;
  }
}
