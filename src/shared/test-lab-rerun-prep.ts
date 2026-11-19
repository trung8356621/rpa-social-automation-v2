import type { CaseResult, TestCase, TestCaseRerunPrep } from "./contracts.js";

export type { TestCaseRerunPrep };

export const RERUN_PREP_MESSAGE = "Chuẩn bị Browser trước khi chạy lại";

/** Build prep snapshot from a saved Case. Does not mutate lastResult. */
export function buildTestCaseRerunPrep(item: TestCase): TestCaseRerunPrep {
  return {
    caseId: item.id,
    caseName: item.name,
    flowId: item.flowId,
    sessionId: item.sessionId,
    previousRunId: item.lastResult?.runId,
  };
}

/** Cancel / leave prep must leave the prior Case result untouched. */
export function priorResultPreserved(
  before: CaseResult | undefined,
  after: CaseResult | undefined,
): boolean {
  if (!before && !after) return true;
  if (!before || !after) return false;
  return before.runId === after.runId && before.status === after.status;
}
