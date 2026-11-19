import type { CaseResult } from "./contracts.js";

export type TestCaseViewMode = "configure" | "result";
export type ResultMedia = "video" | "screenshot";

const TERMINAL_NO_SHOT = new Set(["BLOCKED", "ERROR", "FAILED"]);
const SUCCESS_LIKE = new Set(["PASS", "ACTION_SENT", "SKIPPED"]);

export function initialTestCaseMode(result?: CaseResult): TestCaseViewMode {
  return result ? "result" : "configure";
}

export function initialResultMedia(result: CaseResult): ResultMedia {
  return result.recordingError || (!result.recordingPath && result.status !== "RUNNING")
    ? "screenshot"
    : "video";
}

/** Placeholder when screenshot tab has no image for the current runId. */
export function screenshotMediaMessage(result: CaseResult, imageError = ""): string {
  if (result.screenshotError) return result.screenshotError;
  if (imageError) return imageError;
  if (result.status === "RUNNING") return "Đang chuẩn bị ảnh cuối cùng";
  if (TERMINAL_NO_SHOT.has(result.status)) return "Lượt chạy dừng trước khi có ảnh cuối cùng";
  if (SUCCESS_LIKE.has(result.status)) return "Không có ảnh cuối cùng cho lượt chạy này";
  return "Không có ảnh cuối cùng cho lượt chạy này";
}

/** Placeholder when video tab has no source for the current runId. */
export function videoMediaMessage(result: CaseResult, videoError = ""): string {
  if (videoError) return videoError;
  if (result.recordingError) return result.recordingError;
  if (result.status === "RUNNING" || result.recordingPath) return "Đang chuẩn bị video";
  return "Không có video cho lượt chạy này";
}

export function stepStatusLabel(status: string) {
  if (status === "PASS") return "SUCCESS";
  if (status === "ERROR") return "FAILED";
  return status;
}
