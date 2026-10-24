import type { Result, Step } from "./contracts.js";
export type StepPlayback = {
  status: "running" | "pass" | "fail" | "blocked" | "skipped";
  message: string;
  resultStatus?: Result["status"];
  error?: Result["error"];
};
export function playbackResult(results: Result[]): StepPlayback {
  const failed = results.find((r) => !r.ok),
    last = failed ?? results.at(-1);
  if (!last) return { status: "fail", message: "Test returned no result." };
  return {
    status: last.status === "BLOCKED" ? "blocked" : last.ok ? "pass" : "fail",
    message: last.message,
    resultStatus: last.status,
    error: last.error,
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
      progress(step, { status: "skipped", message: "SKIPPED · Blocked for Play All (memory only)" });
      continue;
    }
    if (previousPassed && betweenSteps) await betweenSteps(previousPassed, step);
    progress(step, { status: "running", message: "Running" });
    let state: StepPlayback;
    try {
      state = playbackResult(await execute(step));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        status:
          /variable|Default Pattern|type mismatch|sai kiểu|Zoom|Viewport|không thuộc flow/i.test(
            message,
          )
            ? "blocked"
            : "fail",
        message,
      };
    }
    progress(step, state);
    if (state.status !== "pass") return;
    previousPassed = step;
  }
}
