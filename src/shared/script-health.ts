import type { Flow, InvalidStepRef, Payload, Step } from "./contracts.js";
import { matchToLabel } from "./match-to.js";

export type ScriptHealthVersionStatus = {
  version: number;
  status: "valid" | "invalid";
  reasonCode?: InvalidStepRef["reason"];
  reason?: string;
  humanReason?: string;
};

export type ScriptHealthStep = {
  stepId: string;
  name: string;
  order: number;
  action: string;
  pinnedVersion: number;
  versions: ScriptHealthVersionStatus[];
  pinnedValid: boolean;
  suggestedValidVersion?: number;
  pinnedHumanError?: string;
  pathLabel: string;
};

export type ScriptHealthScenario = {
  flowId: string;
  name: string;
  pinnedValidCount: number;
  pinnedInvalidCount: number;
  steps: ScriptHealthStep[];
};

export type ScriptHealthReport = {
  scannedAt: string;
  scenarios: ScriptHealthScenario[];
  totals: {
    scenarios: number;
    pinnedValid: number;
    pinnedInvalid: number;
    stepsNeedingFix: number;
  };
};

export type ScriptHealthIssue = {
  reasonCode: InvalidStepRef["reason"];
  detail: string;
  variableId?: string;
};

export type VersionProbe = {
  version: number;
  name: string;
  payload: Payload;
  issue: ScriptHealthIssue | null;
};

/** Map validator detail → human Vietnamese copy (UUID kept out of primary text). */
export function humanReasonForIssue(
  issue: ScriptHealthIssue,
  payload?: Payload,
): string {
  const detail = issue.detail;
  if (
    issue.reasonCode === "missing_variable" ||
    /Referenced variable is missing/i.test(detail)
  )
    return "Step tham chiếu Variable không còn trong Scenario (orphan Variable ID).";
  if (issue.reasonCode === "legacy_incomplete")
    return "Action nhập liệu thiếu Variable và không còn giá trị inline để khôi phục.";
  if (/Match To cần OCR đã xác nhận/i.test(detail)) {
    const stored = payload?.target?.matchTo;
    const label =
      stored === "top" || stored === "middle" || stored === "bottom"
        ? matchToLabel(stored)
        : "Top/Middle/Bottom";
    return `Match To ${label} yêu cầu OCR confirmed nhưng version này thiếu OCR.`;
  }
  if (/Action cần ảnh target được crop/i.test(detail))
    return "Step thiếu ảnh ROI target đã crop.";
  if (/Chữ OCR xác nhận/i.test(detail))
    return "OCR đã gắn nhưng dữ liệu chữ/bounding box không hợp lệ.";
  if (/QUICK_TAG/i.test(detail)) return detail;
  if (issue.reasonCode === "override_invalid")
    return `Override không hợp lệ: ${detail.replace(/^Override [^:]+:\s*/, "")}`;
  return detail;
}

export function formatStepPath(input: {
  scenarioName: string;
  order: number;
  stepName: string;
  version: number;
}): string {
  return `${input.scenarioName} → Step ${input.order}: ${input.stepName} → v${input.version}`;
}

export function formatHumanStepError(input: {
  scenarioName: string;
  flowId?: string;
  stepId?: string;
  order: number;
  stepName: string;
  version: number;
  issue: ScriptHealthIssue;
  payload?: Payload;
}): { headline: string; reason: string; technical: string } {
  const headline = formatStepPath(input);
  const reason = humanReasonForIssue(input.issue, input.payload);
  const technical = [
    input.flowId ? `flowId=${input.flowId}` : "",
    input.stepId ? `stepId=${input.stepId}` : "",
    `stepOrder=${input.order}`,
    `version=${input.version}`,
    `reasonCode=${input.issue.reasonCode}`,
    `detail=${input.issue.detail}`,
    input.issue.variableId ? `variableId=${input.issue.variableId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { headline, reason, technical };
}

/** Important fields only — for Use valid version confirmation. */
export function summarizeVersionDiff(
  current: Payload,
  proposed: Payload,
): string[] {
  const lines: string[] = [];
  if (current.action !== proposed.action)
    lines.push(`Action: ${current.action} → ${proposed.action}`);
  const cMatch = current.target?.matchTo ?? "(unset)";
  const pMatch = proposed.target?.matchTo ?? "(unset)";
  if (cMatch !== pMatch) lines.push(`Match To: ${cMatch} → ${pMatch}`);
  const cOcr = current.target?.ocr?.confirmed
    ? `yes (“${current.target.ocr.text.slice(0, 40)}”)`
    : "no";
  const pOcr = proposed.target?.ocr?.confirmed
    ? `yes (“${proposed.target.ocr.text.slice(0, 40)}”)`
    : "no";
  if (cOcr !== pOcr) lines.push(`OCR confirmed: ${cOcr} → ${pOcr}`);
  if ((current.variableId ?? "") !== (proposed.variableId ?? ""))
    lines.push(
      `Variable: ${current.variableId ? "bound" : "missing"} → ${proposed.variableId ? "bound" : "missing"}`,
    );
  const cRoi = current.target?.roi
    ? `${current.target.roi.width}×${current.target.roi.height}`
    : "none";
  const pRoi = proposed.target?.roi
    ? `${proposed.target.roi.width}×${proposed.target.roi.height}`
    : "none";
  if (cRoi !== pRoi) lines.push(`ROI size: ${cRoi} → ${pRoi}`);
  if (!lines.length) lines.push("Không có khác biệt Match To / OCR / Variable / ROI chính.");
  return lines;
}

export function scanScriptHealth(input: {
  flows: Flow[];
  steps: Step[];
  probe: (flow: Flow, step: Step) => ScriptHealthIssue | null;
}): ScriptHealthReport {
  const scenarios: ScriptHealthScenario[] = [];
  let pinnedValid = 0;
  let pinnedInvalid = 0;
  let stepsNeedingFix = 0;

  for (const flow of input.flows) {
    const ownedIds = new Set(flow.steps.map((r) => r.id));
    const byId = new Map<string, Step[]>();
    for (const step of input.steps) {
      if (!ownedIds.has(step.id)) continue;
      const list = byId.get(step.id) ?? [];
      list.push(step);
      byId.set(step.id, list);
    }
    const healthSteps: ScriptHealthStep[] = [];
    flow.steps.forEach((ref, index) => {
      const versions = (byId.get(ref.id) ?? [])
        .slice()
        .sort((a, b) => a.version - b.version);
      const statuses: ScriptHealthVersionStatus[] = versions.map((step) => {
        const issue = input.probe(flow, step);
        return issue
          ? {
              version: step.version,
              status: "invalid" as const,
              reasonCode: issue.reasonCode,
              reason: issue.detail,
              humanReason: humanReasonForIssue(issue, step.payload),
            }
          : { version: step.version, status: "valid" as const };
      });
      const pinned = versions.find((s) => s.version === ref.version);
      const pinnedIssue = pinned ? input.probe(flow, pinned) : {
        reasonCode: "invalid_payload" as const,
        detail: "Không tìm thấy version đã ghim.",
      };
      const pinnedValidFlag = !pinnedIssue;
      if (pinnedValidFlag) pinnedValid++;
      else {
        pinnedInvalid++;
        stepsNeedingFix++;
      }
      const suggested = [...statuses]
        .reverse()
        .find((v) => v.status === "valid" && v.version !== ref.version);
      const name = pinned?.name || versions.at(-1)?.name || ref.id.slice(0, 8);
      const action = pinned?.payload.action || versions.at(-1)?.payload.action || "?";
      const order = index + 1;
      const pathLabel = formatStepPath({
        scenarioName: flow.name,
        order,
        stepName: name,
        version: ref.version,
      });
      healthSteps.push({
        stepId: ref.id,
        name,
        order,
        action,
        pinnedVersion: ref.version,
        versions: statuses,
        pinnedValid: pinnedValidFlag,
        suggestedValidVersion: suggested?.version,
        pinnedHumanError: pinnedIssue
          ? humanReasonForIssue(pinnedIssue, pinned?.payload)
          : undefined,
        pathLabel,
      });
    });
    scenarios.push({
      flowId: flow.id,
      name: flow.name,
      pinnedValidCount: healthSteps.filter((s) => s.pinnedValid).length,
      pinnedInvalidCount: healthSteps.filter((s) => !s.pinnedValid).length,
      steps: healthSteps,
    });
  }

  return {
    scannedAt: new Date().toISOString(),
    scenarios,
    totals: {
      scenarios: scenarios.length,
      pinnedValid,
      pinnedInvalid,
      stepsNeedingFix,
    },
  };
}
