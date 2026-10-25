import React, { useState } from "react";
import { UiPopover } from "./ui-popover";
import type { Command, State, Step } from "../shared/contracts";
import {
  summarizeVersionDiff,
  type ScriptHealthReport,
  type ScriptHealthStep,
} from "../shared/script-health";

export function ScriptHealthPanel({
  state,
  locked,
  invoke,
  open,
  onPinned,
}: {
  state?: State;
  locked: boolean;
  invoke: <T>(command: Command) => Promise<T>;
  open: (flowId: string, focus?: { stepId: string; version: number }) => void;
  onPinned: (state: State) => void;
}) {
  const [report, setReport] = useState<ScriptHealthReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{
    flowId: string;
    step: ScriptHealthStep;
    current?: Step;
    proposed?: Step;
  }>();

  async function scan() {
    if (locked || busy) return;
    setBusy(true);
    setError("");
    try {
      setReport(await invoke<ScriptHealthReport>({ type: "scriptHealthScan" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function askUseValid(flowId: string, step: ScriptHealthStep) {
    if (!step.suggestedValidVersion || !state) return;
    const current = state.steps.find(
      (s) => s.id === step.stepId && s.version === step.pinnedVersion,
    );
    const proposed = state.steps.find(
      (s) => s.id === step.stepId && s.version === step.suggestedValidVersion,
    );
    setConfirm({ flowId, step, current, proposed });
  }

  async function confirmPin() {
    if (!confirm?.proposed || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await invoke<State>({
        type: "selectVersion",
        id: confirm.step.stepId,
        version: confirm.proposed.version,
      });
      onPinned(next);
      setConfirm(undefined);
      setReport(await invoke<ScriptHealthReport>({ type: "scriptHealthScan" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled = locked || busy;

  return (
    <section className="script-health" aria-label="Script Health Check">
      <div className="script-health-heading">
        <b>Script Health Check</b>
        <button className="primary" disabled={disabled} onClick={() => void scan()}>
          {report ? "Quét lại" : "Quét kịch bản"}
        </button>
      </div>
      <p className="hint">
        Kiểm tra read-only mọi Step version. Không sửa OCR/Variable và không đổi Match To.
      </p>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p>
            Scripts {report.totals.scenarios} · Pinned hợp lệ {report.totals.pinnedValid} ·
            Pinned lỗi {report.totals.pinnedInvalid} · Cần sửa {report.totals.stepsNeedingFix}
          </p>
          {report.scenarios.map((scenario) => (
            <details
              key={scenario.flowId}
              className="script-health-scenario"
              open={scenario.pinnedInvalidCount > 0}
            >
              <summary>
                <b>{scenario.name}</b>{" "}
                <small>
                  {scenario.pinnedValidCount} ok / {scenario.pinnedInvalidCount} lỗi
                </small>
              </summary>
              {scenario.steps.filter((s) => !s.pinnedValid).length === 0 ? (
                <p className="hint">Mọi pinned version hợp lệ.</p>
              ) : (
                <ul className="script-health-list">
                  {scenario.steps
                    .filter((s) => !s.pinnedValid)
                    .map((step) => (
                      <li key={step.stepId}>
                        <div>
                          <b>{step.pathLabel}</b>
                          <p>{step.pinnedHumanError}</p>
                          <small>
                            Versions:{" "}
                            {step.versions
                              .map(
                                (v) =>
                                  `v${v.version}${v.status === "valid" ? "✓" : "✗"}`,
                              )
                              .join(" · ")}
                            {step.suggestedValidVersion
                              ? ` · Đề xuất v${step.suggestedValidVersion}`
                              : " · Không có version hợp lệ thay thế"}
                          </small>
                        </div>
                        <div className="script-health-actions">
                          <button
                            disabled={disabled}
                            onClick={() =>
                              open(scenario.flowId, {
                                stepId: step.stepId,
                                version: step.pinnedVersion,
                              })
                            }
                          >
                            Open Step
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              open(scenario.flowId, {
                                stepId: step.stepId,
                                version:
                                  step.suggestedValidVersion ?? step.pinnedVersion,
                              })
                            }
                          >
                            View versions
                          </button>
                          {step.suggestedValidVersion && (
                            <button
                              className="primary"
                              disabled={disabled}
                              onClick={() => askUseValid(scenario.flowId, step)}
                            >
                              Use valid version
                            </button>
                          )}
                        </div>
                        <details>
                          <summary>Technical Details</summary>
                          <code>
                            stepId={step.stepId} · pinned=v{step.pinnedVersion} ·
                            flowId={scenario.flowId}
                          </code>
                        </details>
                      </li>
                    ))}
                </ul>
              )}
            </details>
          ))}
        </>
      )}
      {confirm && (
        <UiPopover
          variant="modal"
          label="Use valid version"
          className="unsaved-confirm"
          close={() => !busy && setConfirm(undefined)}
        >
          <div className="popover-heading">
            <b>Ghim version hợp lệ?</b>
            <button disabled={busy} onClick={() => setConfirm(undefined)}>
              ×
            </button>
          </div>
          <p>
            {confirm.step.pathLabel}
            <br />
            Hiện tại: <b>v{confirm.step.pinnedVersion}</b> (không hợp lệ)
            <br />
            Đề xuất: <b>v{confirm.step.suggestedValidVersion}</b>
          </p>
          <ul>
            {summarizeVersionDiff(
              confirm.current?.payload ?? { action: "SLEEP" },
              confirm.proposed?.payload ?? { action: "SLEEP" },
            ).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="hint">
            Chỉ đổi pinned reference. Không sửa/xóa payload version gốc.
          </p>
          <div className="popover-actions">
            <button disabled={busy} onClick={() => setConfirm(undefined)}>
              Hủy
            </button>
            <button className="primary" disabled={busy} onClick={() => void confirmPin()}>
              Xác nhận ghim v{confirm.step.suggestedValidVersion}
            </button>
          </div>
        </UiPopover>
      )}
    </section>
  );
}
