import type { CaseResult } from "./contracts.js";

export type TestCaseViewMode = "configure" | "result";
export type ResultMedia = "video" | "screenshot";

export function initialTestCaseMode(result?: CaseResult): TestCaseViewMode {
  return result ? "result" : "configure";
}

export function initialResultMedia(result: CaseResult): ResultMedia {
  return result.recordingError || (!result.recordingPath && result.status !== "RUNNING")
    ? "screenshot"
    : "video";
}

export function stepStatusLabel(status: string) {
  if (status === "PASS") return "SUCCESS";
  if (status === "ERROR") return "FAILED";
  return status;
}
