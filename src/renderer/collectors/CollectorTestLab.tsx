import React, { useMemo, useState } from "react";
import { applyValidationSimulation, activeRuleVersionLabel } from "../../shared/collectors/ops";
import { cryptoRandomId } from "../../shared/collectors/fixtures";
import type {
  CollectorDraft,
  CollectorTestCase,
  ValidationOutcome,
} from "../../shared/collectors/types";

type Props = {
  collectors: CollectorDraft[];
  testCases: CollectorTestCase[];
  locked: boolean;
  initialCollectorId?: string;
  onSaveCollector: (draft: CollectorDraft) => void;
  onSaveTestCase: (testCase: CollectorTestCase) => void;
};

type LabTab = "records" | "raw" | "evidence";

export function CollectorTestLab({
  collectors,
  testCases,
  locked,
  initialCollectorId,
  onSaveCollector,
  onSaveTestCase,
}: Props) {
  const [collectorId, setCollectorId] = useState(initialCollectorId ?? collectors[0]?.id ?? "");
  const [versionId, setVersionId] = useState("");
  const [mockCaseId, setMockCaseId] = useState("");
  const [tab, setTab] = useState<LabTab>("records");
  const [outcome, setOutcome] = useState<ValidationOutcome>("all_pass");

  const collector = collectors.find((c) => c.id === collectorId);
  const relatedCases = useMemo(
    () => testCases.filter((t) => t.collectorId === collectorId),
    [testCases, collectorId],
  );

  React.useEffect(() => {
    if (initialCollectorId) setCollectorId(initialCollectorId);
  }, [initialCollectorId]);

  function runSimulated() {
    if (!collector) return;
    const next = applyValidationSimulation(collector, outcome);
    onSaveCollector(next);
    const testCase: CollectorTestCase = {
      id: mockCaseId || cryptoRandomId(),
      name: `Sim ${outcome} · ${new Date().toLocaleString()}`,
      collectorId: collector.id,
      versionId: versionId || collector.activeVersionId,
      strategy: collector.strategy,
      outcome,
    };
    onSaveTestCase(testCase);
    setMockCaseId(testCase.id);
  }

  const validation = collector?.validation;

  return (
    <section className="collector-test-lab" aria-label="Collector Test Lab">
      <div className="page-heading">
        <small>Prototype · simulated metrics only</small>
        <h1>Collector Test Lab</h1>
        <p>
          Separate from Script Test Lab. No live Facebook data. Collector prototype localStorage is not
          part of Script Full Backup.
        </p>
      </div>

      {!collectors.length && (
        <div className="empty-tags-box">Tạo Collector trước khi chạy Test Lab.</div>
      )}

      {!!collectors.length && (
        <>
          <div className="scenario-toolbar collector-toolbar">
            <label>
              Collector
              <select
                disabled={locked}
                value={collectorId}
                onChange={(e) => {
                  setCollectorId(e.target.value);
                  setVersionId("");
                  setMockCaseId("");
                }}
              >
                {collectors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label>
              Rule version
              <select
                disabled={locked || !collector}
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
              >
                <option value="">{collector ? `Working draft (${activeRuleVersionLabel(collector)})` : "—"}</option>
                {collector?.versions.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}{v.active ? " · active" : ""}</option>
                ))}
              </select>
            </label>
            <label>
              Strategy
              <input disabled value={collector?.strategy ?? ""} readOnly />
            </label>
            <label>
              Mock test case
              <select
                disabled={locked}
                value={mockCaseId}
                onChange={(e) => {
                  setMockCaseId(e.target.value);
                  const found = relatedCases.find((t) => t.id === e.target.value);
                  if (found) setOutcome(found.outcome);
                }}
              >
                <option value="">New simulation…</option>
                {relatedCases.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label>
              Simulate outcome
              <select
                disabled={locked}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as ValidationOutcome)}
              >
                <option value="all_pass">All Pass</option>
                <option value="partial">Partial</option>
                <option value="failed">Failed</option>
                <option value="missing_required">Missing Required</option>
                <option value="ambiguous_match">Ambiguous Match</option>
              </select>
            </label>
            <button className="primary" disabled={locked || !collector} onClick={runSimulated}>
              Run simulated test
            </button>
          </div>

          <div className="scripts-top-tabs" role="tablist">
            {([
              ["records", "Records"],
              ["raw", "Raw JSON"],
              ["evidence", "Evidence"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`scripts-tab-btn${tab === id ? " active" : ""}`}
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {validation?.outdated && (
            <p className="collector-banner warn">Validation result is outdated relative to current draft mappings.</p>
          )}

          {validation ? (
            <>
              <div className="collector-metrics" aria-label="Simulated metrics">
                <div><small>Matched records (sim)</small><b>{validation.metrics.matched}</b></div>
                <div><small>Partial records (sim)</small><b>{validation.metrics.partial}</b></div>
                <div><small>Unmatched records (sim)</small><b>{validation.metrics.unmatched}</b></div>
                <div><small>Unique records (sim)</small><b>{validation.metrics.unique}</b></div>
                <div><small>Duplicate records (sim)</small><b>{validation.metrics.duplicates}</b></div>
              </div>
              {tab === "records" && (
                <div className="collector-record-list">
                  {validation.records.map((record) => (
                    <div className="collector-record-card" key={`${record.sampleId}:${record.role}`}>
                      <b>{record.role}{record.slot ? ` ${record.slot}` : ""} · {record.result}</b>
                      <pre>{JSON.stringify(record.actual, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              )}
              {tab === "raw" && (
                <div className="collector-raw-json">
                  <pre>{JSON.stringify(validation.rawJson, null, 2)}</pre>
                </div>
              )}
              {tab === "evidence" && (
                <ul>{validation.evidence.map((line) => <li key={line}>{line}</li>)}</ul>
              )}
            </>
          ) : (
            <div className="empty-tags-box">Chưa có kết quả simulated. Chọn outcome và Run.</div>
          )}
        </>
      )}
    </section>
  );
}
