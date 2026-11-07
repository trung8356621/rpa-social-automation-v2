import React, { useState } from "react";
import { discoveryCandidates } from "../../shared/collectors/fixtures";
import {
  applyValidationSimulation,
  auditRecordKey,
  auditStatusCounts,
  confirmedCaptureIds,
  createVariantPattern,
  defaultAuditStateForResult,
  ensureCaptureAudits,
  upsertAuditAction,
} from "../../shared/collectors/ops";
import { markValidationOutdated } from "../../shared/collectors/ops";
import type {
  AuditMatchState,
  CollectorDraft,
  CollectorStrategy,
  ValidationOutcome,
  WizardStepId,
} from "../../shared/collectors/types";

const AUDIT_STATES: AuditMatchState[] = [
  "matched",
  "partial",
  "failed",
  "unresolved",
  "excluded",
];

type StepProps = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
};

export function StepDiscovery({ draft, locked, onChange }: StepProps) {
  const [inspectId, setInspectId] = useState(draft.candidates[0]?.id);
  const active = draft.candidates.find((c) => c.id === inspectId) ?? draft.candidates[0];
  const confirmed = confirmedCaptureIds(draft).length;
  const counts = auditStatusCounts(draft);

  function decide(id: string, decision: "accepted" | "rejected") {
    const candidates = draft.candidates.map((c) => (c.id === id ? { ...c, decision } : c));
    onChange(markValidationOutdated({ ...draft, candidates, dirty: true }));
  }

  function chooseStrategy(strategy: CollectorStrategy) {
    if (draft.strategy === strategy && draft.candidates.length) return;
    onChange(markValidationOutdated({
      ...draft,
      strategy,
      candidates: discoveryCandidates(strategy, draft.classification || "unclassified"),
      dirty: true,
    }));
  }

  return (
    <div className="collector-step collector-scroll-step">
      <p className="hint collector-step-lede">
        Confirmed audits: {confirmed}. Simulated discovery — Pending / Needs Attention / Excluded do not block strategy.
      </p>
      <div className="collector-metrics">
        <div><small>Confirmed</small><b>{counts.confirmed}</b></div>
        <div><small>Proposed</small><b>{counts.proposed}</b></div>
        <div><small>Needs Attention</small><b>{counts.needs_attention}</b></div>
        <div><small>Excluded</small><b>{counts.excluded}</b></div>
        <div><small>Unreviewed</small><b>{counts.unreviewed}</b></div>
      </div>
      <div className="collector-strategy-picker">
        <label>
          Strategy
          <select
            disabled={locked}
            value={draft.strategy}
            onChange={(e) => {
              const value = e.target.value as CollectorStrategy | "";
              if (!value) {
                onChange(markValidationOutdated({ ...draft, strategy: "", candidates: [], dirty: true }));
                return;
              }
              chooseStrategy(value);
            }}
          >
            <option value="">— Select strategy —</option>
            <option value="FEED_NETWORK_JSON">FEED_NETWORK_JSON</option>
            <option value="POST_DETAIL_VISUAL">POST_DETAIL_VISUAL</option>
          </select>
        </label>
      </div>
      {!draft.strategy && (
        <div className="empty-tags-box">Select a strategy to load discovery candidates.</div>
      )}
      {!!draft.strategy && (
        <div className="collector-discovery">
          <div className="collector-candidate-list">
            {draft.candidates.map((cand) => (
              <button
                key={cand.id}
                type="button"
                className={cand.id === active?.id ? "active" : ""}
                disabled={locked}
                onClick={() => setInspectId(cand.id)}
              >
                <b>{cand.title}</b>
                <small>confidence {(cand.confidence * 100).toFixed(0)}% · {cand.decision}</small>
              </button>
            ))}
          </div>
          {active && (
            <div className="collector-candidate-detail">
              <h3>{active.title}</h3>
              <p>{active.evidence}</p>
              <p><small>Matched Variables: {active.matchedVariableKeys.join(", ") || "—"}</small></p>
              {draft.strategy === "FEED_NETWORK_JSON" ? (
                <div className="collector-feed-discovery">
                  <p><b>Request</b> <code>{String(active.detail.requestId ?? "")}</code></p>
                  <p><b>JSON path</b> <code>{String(active.detail.jsonPath ?? "")}</code></p>
                  <p><b>Parent object</b> <code>{String(active.detail.parentObject ?? "")}</code></p>
                  <p><b>Related response IDs</b> <code>{JSON.stringify(active.detail.relatedResponseIds ?? [])}</code></p>
                </div>
              ) : (
                <div className="collector-visual-discovery">
                  <p><b>Visual anchor</b> {String(active.detail.visualAnchor ?? "")}</p>
                  <p><b>Candidate container</b> <code>{String(active.detail.candidateContainer ?? "")}</code></p>
                  <p><b>OCR values</b> {JSON.stringify(active.detail.ocrValues ?? [])}</p>
                  <p><b>HTML / SSR source</b> {String(active.detail.htmlSource ?? "")}</p>
                </div>
              )}
              <div className="collector-raw-json">
                <b>Raw JSON inspector</b>
                <pre>{JSON.stringify(active.detail.rawSnippet ?? active.detail, null, 2)}</pre>
              </div>
              <div className="collector-row-actions">
                <button className="primary" disabled={locked} onClick={() => decide(active.id, "accepted")}>Accept</button>
                <button disabled={locked} onClick={() => decide(active.id, "rejected")}>Reject</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StepValidation({
  draft,
  locked,
  onChange,
  onGotoStep,
}: StepProps & { onGotoStep: (step: WizardStepId) => void }) {
  const [variantLabel, setVariantLabel] = useState("");
  const [variantTag, setVariantTag] = useState("");
  const [variantNotes, setVariantNotes] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const counts = auditStatusCounts(draft);

  const outcomes: Array<{ id: ValidationOutcome; label: string }> = [
    { id: "all_pass", label: "All Pass" },
    { id: "partial", label: "Partial" },
    { id: "failed", label: "Failed" },
    { id: "missing_required", label: "Missing Required Field" },
    { id: "ambiguous_match", label: "Ambiguous Match" },
  ];

  function run(outcome: ValidationOutcome) {
    const next = applyValidationSimulation(draft, outcome);
    const seeded = (next.validation?.records ?? []).reduce((acc, record) => {
      const key = auditRecordKey(record);
      if (acc.auditActions.some((a) => a.recordKey === key)) return acc;
      return upsertAuditAction(acc, key, { state: defaultAuditStateForResult(record.result) });
    }, next);
    setSelectedKeys([]);
    onChange(seeded);
  }

  const validation = draft.validation;
  const lowMatchKeys = new Set(
    (validation?.records ?? [])
      .filter((r) => r.result === "partial" || r.result === "failed")
      .map((r) => auditRecordKey(r)),
  );

  function toggleSelected(key: string) {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function createVariant() {
    if (!selectedKeys.length) return;
    const next = createVariantPattern(draft, {
      label: variantLabel || "Variant pattern",
      tag: variantTag,
      notes: variantNotes || "User-confirmed structural difference (simulated).",
      sourceRecordKeys: selectedKeys,
    });
    setVariantLabel("");
    setVariantTag("");
    setVariantNotes("");
    setSelectedKeys([]);
    onChange(next);
  }

  return (
    <div className="collector-step collector-scroll-step">
      <p className="hint collector-step-lede">
        Simulated validation · Confirmed / Pending / Needs Attention / Excluded — exceptions do not wipe confirmed mappings.
      </p>
      <div className="collector-metrics">
        <div><small>Confirmed</small><b>{counts.confirmed}</b></div>
        <div><small>Pending (unreviewed+proposed)</small><b>{counts.unreviewed + counts.proposed}</b></div>
        <div><small>Needs Attention</small><b>{counts.needs_attention}</b></div>
        <div><small>Excluded</small><b>{counts.excluded}</b></div>
      </div>
      {counts.needs_attention > 0 && (
        <p className="collector-banner warn" role="status">
          {counts.needs_attention} item(s) Need Attention — isolated; confirmed audits remain intact.
        </p>
      )}
      {validation?.outdated && (
        <p className="collector-banner warn" role="status">
          Previous validation is outdated because mappings/discovery changed. Re-run a simulation.
        </p>
      )}
      <div className="collector-validation-actions">
        {outcomes.map((item) => (
          <button key={item.id} disabled={locked} className={item.id === "all_pass" ? "primary" : undefined} onClick={() => run(item.id)}>
            Simulate: {item.label}
          </button>
        ))}
      </div>

      <div className="collector-pattern-summary">
        <div>
          <small>Shared Variables schema</small>
          <b>{draft.variables.length} variables · rev {draft.schemaRevision ?? 1}</b>
        </div>
        <div>
          <small>Capture audits</small>
          <b>{ensureCaptureAudits(draft).length} items</b>
        </div>
        <div>
          <small>Variant patterns</small>
          <b>{(draft.variants ?? []).length}</b>
        </div>
      </div>

      {validation && (
        <div className="collector-validation-dash">
          <div className="collector-metrics">
            <div><small>Matched</small><b>{validation.metrics.matched}</b></div>
            <div><small>Partial</small><b>{validation.metrics.partial}</b></div>
            <div><small>Failed / unmatched</small><b>{validation.metrics.unmatched}</b></div>
            <div><small>Unique</small><b>{validation.metrics.unique}</b></div>
            <div><small>Duplicates</small><b>{validation.metrics.duplicates}</b></div>
            <div><small>Outcome</small><b>{validation.outcome}</b></div>
          </div>
          <div className="collector-record-list">
            {validation.records.map((record) => {
              const key = auditRecordKey(record);
              const action = (draft.auditActions ?? []).find((a) => a.recordKey === key);
              const state = action?.state ?? defaultAuditStateForResult(record.result);
              const isLow = lowMatchKeys.has(key);
              return (
                <div className="collector-record-card" key={key}>
                  <div className="collector-variable-head">
                    <label className="collector-check">
                      {isLow && (
                        <input
                          type="checkbox"
                          disabled={locked}
                          checked={selectedKeys.includes(key)}
                          onChange={() => toggleSelected(key)}
                          aria-label={`Select ${key} for variant`}
                        />
                      )}
                      <b>
                        {record.role}
                        {record.captureItemId ? ` · capture ${record.captureItemId.slice(0, 8)}` : ""}
                        {record.auditStatus ? ` · ${record.auditStatus}` : ""}
                        {" · "}
                        {record.sampleId}
                      </b>
                    </label>
                    <span className={`script-badge badge-${state === "matched" ? "active" : "draft"}`}>
                      {state}
                    </span>
                  </div>
                  <p className="hint">
                    Provenance: simulated {record.role} record · raw result {record.result}
                  </p>
                  <div className="collector-expected-actual">
                    <div>
                      <small>Expected</small>
                      <pre>{JSON.stringify(record.expected, null, 2)}</pre>
                    </div>
                    <div>
                      <small>Actual</small>
                      <pre>{JSON.stringify(record.actual, null, 2)}</pre>
                    </div>
                  </div>
                  {!!record.missingRequired.length && (
                    <p className="collector-warn">Missing required: {record.missingRequired.join(", ")}</p>
                  )}
                  <div className="collector-audit-actions">
                    <label>
                      Audit state
                      <select
                        disabled={locked}
                        value={state}
                        onChange={(e) => onChange(upsertAuditAction(draft, key, {
                          state: e.target.value as AuditMatchState,
                        }))}
                      >
                        {AUDIT_STATES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => onChange(upsertAuditAction(draft, key, {
                        mappingIssue: true,
                        state: state === "matched" ? "partial" : state,
                        note: "Marked as mapping issue — not a new Post Type.",
                      }))}
                    >
                      Mark mapping issue
                    </button>
                    <button disabled={locked} onClick={() => onGotoStep(2)}>
                      Go to Review &amp; Mapping
                    </button>
                  </div>
                  {action?.note && <p className="hint">{action.note}</p>}
                </div>
              );
            })}
          </div>

          <div className="collector-variant-create">
            <h3>Create Variant Pattern (optional)</h3>
            <p className="hint">
              Only after audit confirms a meaningful structural difference. Never auto-created from confidence.
            </p>
            <label>
              Label
              <input
                disabled={locked || !selectedKeys.length}
                value={variantLabel}
                placeholder="e.g. Shared-post container"
                onChange={(e) => setVariantLabel(e.target.value)}
              />
            </label>
            <label>
              Optional tag
              <input
                disabled={locked || !selectedKeys.length}
                value={variantTag}
                placeholder="user-defined tag"
                onChange={(e) => setVariantTag(e.target.value)}
              />
            </label>
            <label>
              Notes
              <textarea
                disabled={locked || !selectedKeys.length}
                rows={2}
                value={variantNotes}
                onChange={(e) => setVariantNotes(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary"
              disabled={locked || !selectedKeys.length}
              onClick={createVariant}
            >
              Create Variant from selected low-match records ({selectedKeys.length})
            </button>
          </div>

          <div className="collector-raw-json">
            <b>Raw JSON</b>
            <pre>{JSON.stringify(validation.rawJson, null, 2)}</pre>
          </div>
          <div>
            <b>Evidence</b>
            <ul>{validation.evidence.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        </div>
      )}
    </div>
  );
}
