export const PLAY_ALL_PREFLIGHT_BLOCKED = "PLAY_ALL_PREFLIGHT_BLOCKED";

export type PlayAllInvalidStep = {
  stepId: string;
  version: number;
  name: string;
  flatOrder: number;
  uiNumber: string;
  reason: string;
  reasonCode?: string;
};

export type PlayAllBeginResult =
  | { ok: true; attemptId: string; batchRunId: string }
  | {
      ok: false;
      attemptId: string;
      code: typeof PLAY_ALL_PREFLIGHT_BLOCKED;
      message: string;
      invalidSteps: PlayAllInvalidStep[];
    };

export function formatPlayAllPreflightBlocked(
  invalidSteps: PlayAllInvalidStep[],
): string {
  const lines = [
    PLAY_ALL_PREFLIGHT_BLOCKED,
    "Chưa thực thi Step nào.",
    `Có ${invalidSteps.length} Step cấu hình không hợp lệ (pinned):`,
    ...invalidSteps.map(
      (step) =>
        `- UI ${step.uiNumber} · flat Step ${String(step.flatOrder).padStart(2, "0")}: ${step.name} · v${step.version} — ${step.reason}`,
    ),
    "Sửa ROI / ghim version hợp lệ rồi Play All lại từ Step đầu.",
  ];
  return lines.join("\n");
}
