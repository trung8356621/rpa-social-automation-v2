import React, { useEffect, useMemo, useState } from "react";
import { cryptoRandomId, previewSrc, sampleById } from "../../shared/collectors/fixtures";
import {
  applyAuditActionAndAdvance,
  auditForCapture,
  bumpSharedSchemaRevision,
  ensureCaptureAudits,
  getMapping,
  markValidationOutdated,
  nextPendingReviewCaptureId,
  proposeMappingsForCapture,
  restoreExcludedCapture,
  setCaptureMapping,
} from "../../shared/collectors/ops";
import type {
  CaptureAuditStatus,
  CollectorDraft,
  CollectorSource,
  CollectorValueType,
  CollectorVariable,
} from "../../shared/collectors/types";
import { isRealCapture } from "../../shared/collectors/types";
import {
  collectorLoadImageAsset,
  isElectronBrowserCoreAvailable,
  type CollectorInvoke,
} from "./browser-capture";

const VALUE_TYPES: CollectorValueType[] = [
  "string", "text", "number", "boolean", "url", "datetime", "array", "object",
];
const SOURCES: CollectorSource[] = [
  "network_json", "visual_dom", "ocr_image", "manual", "derived",
];

const STATUS_LABEL: Record<CaptureAuditStatus, string> = {
  unreviewed: "Unreviewed",
  proposed: "Proposed",
  confirmed: "Confirmed",
  needs_attention: "Needs Attention",
  excluded: "Excluded",
};

const SUGGESTED_EXCLUDE_TAGS = ["recruitment", "special-layout", "unknown-structure"];

type Props = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
  invoke?: CollectorInvoke;
};

function SampleValueRow({
  label,
  value,
  channel,
  source,
}: {
  label: string;
  value: string;
  channel: string;
  source: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > 72;
  const shown = expanded || !long ? value : `${value.slice(0, 72)}…`;
  return (
    <div
      className={`collector-sample-kv channel-${channel === "image_ocr" ? "ocr" : channel === "post_body" ? "body" : "network"}`}
    >
      <div className="collector-sample-kv-key">
        <b>{label}</b>
        <small title="Simulated fixture field — not live Facebook extraction">{source}</small>
      </div>
      <div className="collector-sample-kv-val">
        <code title={value}>{shown}</code>
        <div className="collector-sample-kv-actions">
          {long && (
            <button type="button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Less" : "More"}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(value);
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

export function StepReviewMapping({ draft, locked, onChange, invoke }: Props) {
  const captures = draft.captures ?? [];
  const audits = ensureCaptureAudits(draft);
  const activeId =
    draft.activeReviewCaptureId && captures.some((c) => c.id === draft.activeReviewCaptureId)
      ? draft.activeReviewCaptureId
      : captures[0]?.id;
  const activeIndex = Math.max(0, captures.findIndex((c) => c.id === activeId));
  const active = activeId ? captures[activeIndex] : undefined;
  const audit = active ? auditForCapture(draft, active.id) : undefined;
  const realCapture = active ? isRealCapture(active) : false;
  const mock =
    active && !realCapture && active.linkedMockSampleId
      ? sampleById(active.linkedMockSampleId)
      : undefined;
  const [realImageUrl, setRealImageUrl] = useState<string>();
  const isTeaching =
    Boolean(active) &&
    (draft.teachingCaptureId === active!.id ||
      (!draft.teachingCaptureId && activeIndex === 0));
  const [editingId, setEditingId] = useState<string>();
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [excludeReason, setExcludeReason] = useState("");
  const [excludeCustom, setExcludeCustom] = useState("");
  const [completionNote, setCompletionNote] = useState<string>();
  const [confirmError, setConfirmError] = useState<string>();
  const [quarantineOpen, setQuarantineOpen] = useState(false);

  const excludedItems = useMemo(
    () => captures.filter((c) => auditForCapture(draft, c.id).status === "excluded"),
    [captures, draft],
  );

  useEffect(() => {
    if (!activeId) return;
    if (draft.activeReviewCaptureId === activeId) return;
    onChange({ ...draft, activeReviewCaptureId: activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync active id once when captures change
  }, [activeId, captures.length]);

  const schemaStale = Boolean(
    audit?.status === "confirmed" &&
      audit.schemaRevisionAtConfirm != null &&
      audit.schemaRevisionAtConfirm < (draft.schemaRevision ?? 1),
  );

  function selectCapture(id: string) {
    setCompletionNote(undefined);
    setConfirmError(undefined);
    setExcludeOpen(false);
    onChange({ ...draft, activeReviewCaptureId: id, dirty: true });
  }

  function goRelative(delta: number) {
    const next = captures[activeIndex + delta];
    if (next) selectCapture(next.id);
  }

  function updateVariable(id: string, patch: Partial<CollectorVariable>) {
    const variables = draft.variables.map((v) => (v.id === id ? { ...v, ...patch } : v));
    let next = markValidationOutdated({ ...draft, variables, dirty: true });
    if (draft.teachingCaptureId || audits.some((a) => a.status === "confirmed")) {
      next = bumpSharedSchemaRevision(next);
    }
    onChange(next);
  }

  function addVariable() {
    const variable: CollectorVariable = {
      id: cryptoRandomId(),
      key: `custom_${draft.variables.length + 1}`,
      label: "Custom Variable",
      valueType: "string",
      required: false,
      source: "manual",
      mappings: [],
    };
    let next = markValidationOutdated({
      ...draft,
      variables: [...draft.variables, variable],
      dirty: true,
    });
    if (draft.teachingCaptureId) next = bumpSharedSchemaRevision(next);
    onChange(next);
    setEditingId(variable.id);
  }

  function removeVariable(id: string) {
    let next = markValidationOutdated({
      ...draft,
      variables: draft.variables.filter((v) => v.id !== id),
      dirty: true,
    });
    if (draft.teachingCaptureId) next = bumpSharedSchemaRevision(next);
    onChange(next);
  }

  function runAuditAction(action: "confirm" | "needs_attention" | "exclude") {
    if (!active) return;
    setConfirmError(undefined);
    const result = applyAuditActionAndAdvance(
      draft,
      active.id,
      action,
      action === "exclude"
        ? {
            tags: [
              ...excludeTags,
              ...excludeCustom
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            ],
            reason: excludeReason,
          }
        : undefined,
    );
    if (action === "confirm" && !result.advanced && !result.completed &&
        auditForCapture(result.draft, active.id).status !== "confirmed") {
      setConfirmError("Confirm blocked — map or mark Not Present for all required variables.");
      onChange(result.draft);
      return;
    }
    setExcludeOpen(false);
    setExcludeTags([]);
    setExcludeReason("");
    setExcludeCustom("");
    if (result.completed) {
      setCompletionNote(
        result.advanced
          ? "No Unreviewed/Proposed items remain — advanced to next capture. Confirmed mappings unchanged."
          : "Review actions complete for this library. Confirmed mappings unchanged.",
      );
    } else {
      setCompletionNote(undefined);
    }
    onChange(result.draft);
  }

  useEffect(() => {
    let cancelled = false;
    setRealImageUrl(undefined);
    if (!active?.imageAsset || !invoke || !isElectronBrowserCoreAvailable()) return;
    void collectorLoadImageAsset(invoke, active.imageAsset)
      .then((url) => {
        if (!cancelled) setRealImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setRealImageUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.imageAsset, invoke]);

  const previewSrcUrl = useMemo(() => {
    if (realCapture) return realImageUrl;
    const asset = active?.previewAssetId ?? mock?.previewAssetId;
    return asset ? previewSrc(asset) : undefined;
  }, [realCapture, realImageUrl, active?.previewAssetId, mock?.previewAssetId]);

  const pendingLeft = nextPendingReviewCaptureId(draft, null);

  if (!captures.length) {
    return (
      <div className="collector-step collector-review-step">
        <div className="empty-tags-box">Capture Feed Items in Step 1 first.</div>
      </div>
    );
  }

  return (
    <div className="collector-step collector-review-step">
      <div className="collector-review-toolbar">
        <button type="button" disabled={locked || activeIndex <= 0} onClick={() => goRelative(-1)}>
          ← Prev
        </button>
        <button
          type="button"
          disabled={locked || activeIndex >= captures.length - 1}
          onClick={() => goRelative(1)}
        >
          Next →
        </button>
        <span className="hint collector-review-hint" title="Teaching item defines schema; later items get simulated proposals. Proposed ≠ Confirmed.">
          Item {activeIndex + 1}/{captures.length}
          {isTeaching ? " · Teaching" : " · Simulated match"}
        </span>
        {excludedItems.length > 0 && (
          <button type="button" disabled={locked} onClick={() => setQuarantineOpen((v) => !v)}>
            Quarantine ({excludedItems.length})
          </button>
        )}
      </div>

      {completionNote && (
        <p className="collector-banner ok" role="status">{completionNote}</p>
      )}
      {confirmError && (
        <p className="collector-banner warn" role="alert">{confirmError}</p>
      )}
      {schemaStale && active && (
        <p className="collector-banner warn" role="status">
          Shared schema changed after this confirm (rev {audit?.schemaRevisionAtConfirm} →{" "}
          {draft.schemaRevision}). Mappings preserved — re-confirm explicitly if needed.
        </p>
      )}

      {quarantineOpen && (
        <div className="collector-quarantine-panel" role="region" aria-label="Excluded quarantine">
          <div className="collector-mapping-toolbar">
            <b>Excluded quarantine</b>
            <button type="button" onClick={() => setQuarantineOpen(false)}>Close</button>
          </div>
          <p className="hint">
            Local isolation only — items stay recoverable. Cross-Collector reuse deferred (needs shared persistence contract).
          </p>
          <ul className="collector-quarantine-list">
            {excludedItems.map((item) => {
              const a = auditForCapture(draft, item.id);
              const idx = captures.findIndex((c) => c.id === item.id);
              return (
                <li key={item.id}>
                  <span>#{idx + 1}</span>
                  {a.excludeTags?.length ? (
                    <small className="mono">{a.excludeTags.join(", ")}</small>
                  ) : (
                    <small>no tags</small>
                  )}
                  {a.excludeReason && <small>{a.excludeReason}</small>}
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      onChange(restoreExcludedCapture(draft, item.id));
                      setQuarantineOpen(false);
                    }}
                  >
                    Restore
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="collector-review-tabs" role="tablist" aria-label="Captured items">
        {captures.map((item, index) => {
          const st = auditForCapture(draft, item.id).status;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === activeId}
              className={`collector-review-tab status-${st}${item.id === activeId ? " active" : ""}`}
              disabled={locked}
              onClick={() => selectCapture(item.id)}
            >
              <span>#{index + 1}</span>
              <small>{STATUS_LABEL[st]}</small>
            </button>
          );
        })}
      </div>

      {active && audit && (
        <div className="collector-review-workspace collector-review-workspace-3col">
          {/* Column 1 — Feed Preview (~50%) */}
          <div className="collector-review-image-pane" aria-label="Feed preview">
            <div className="collector-review-image-frame">
              {previewSrcUrl ? (
                <img
                  src={previewSrcUrl}
                  alt={
                    realCapture
                      ? `Real capture #${activeIndex + 1}`
                      : `Capture #${activeIndex + 1} mock preview`
                  }
                />
              ) : (
                <div className="collector-sample-empty">
                  {realCapture ? "Real image unavailable in this preview" : "No preview asset"}
                </div>
              )}
            </div>
            <small className="collector-mock-preview-label">
              {realCapture
                ? "Real Browser Core capture · screenshot only (not extraction)"
                : "Legacy mock preview · not a live screenshot"}
            </small>
          </div>

          {/* Column 2 — Sample Data (~20%) */}
          <div className="collector-review-sample-pane" aria-label="Sample data">
            <div className="collector-mapping-toolbar">
              <b>Sample Data</b>
            </div>
            {realCapture ? (
              <>
                <p className="hint">
                  Screenshot captured — fields below are Not Extracted until Network/DOM/OCR engines exist.
                </p>
                <div className="collector-sample-kv-list">
                  {["post_id", "post_url", "author", "content", "has_see_more"].map((key) => (
                    <SampleValueRow
                      key={key}
                      label={key}
                      value="Unknown / Not Extracted"
                      channel="meta"
                      source="not_extracted"
                    />
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="hint">Simulated fixture values — not live Facebook extraction.</p>
                {mock ? (
                  <div className="collector-sample-kv-list">
                    {mock.observedValues.map((obs) => (
                      <SampleValueRow
                        key={obs.id}
                        label={obs.label}
                        value={obs.value}
                        channel={obs.channel}
                        source={obs.source}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-tags-box">No linked fixture data.</div>
                )}
              </>
            )}
          </div>

          {/* Column 3 — Variables (~30%) */}
          <div className="collector-review-editor-pane" aria-label="Variables">
            <div className="collector-mapping-toolbar">
              <b>Variables</b>
              {isTeaching && (
                <button type="button" disabled={locked} onClick={addVariable}>
                  + Variable
                </button>
              )}
              {!isTeaching && !realCapture && audit.status === "unreviewed" && (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onChange(proposeMappingsForCapture(draft, active.id))}
                >
                  Run simulated auto-match
                </button>
              )}
            </div>
            {realCapture ? (
              <p className="collector-banner warn" role="status">
                Real screenshot — map manually or Mark Not Present. No automatic extraction.
              </p>
            ) : (
              !isTeaching && (
                <p className="collector-banner warn" role="status">
                  Simulated matching only — not live Network / DOM / OCR extraction.
                </p>
              )
            )}
            {audit.note && audit.status !== "excluded" && (
              <p className="hint">{audit.note}</p>
            )}
            {audit.status === "excluded" && (
              <p className="hint">
                Excluded{audit.excludeTags?.length ? `: ${audit.excludeTags.join(", ")}` : ""}.
                {audit.excludeReason ? ` ${audit.excludeReason}` : ""}
              </p>
            )}

            <div className="collector-variable-list">
              {draft.variables.map((variable) => {
                const mapping = getMapping(variable, active);
                const open = editingId === variable.id;
                return (
                  <div className="collector-variable-card" key={variable.id}>
                    <div className="collector-variable-head">
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => setEditingId(open ? undefined : variable.id)}
                      >
                        {open ? "▾" : "▸"} {variable.label} <code>{variable.key}</code>
                      </button>
                      <span className="variable-type-tag">{variable.valueType}</span>
                      <span className="script-badge badge-draft">
                        {variable.required ? "Required" : "Optional"}
                      </span>
                      {mapping?.simulatedProposal && !mapping.confirmed && (
                        <span className="script-badge badge-draft">Proposed</span>
                      )}
                      {mapping?.confirmed && (
                        <span className="script-badge badge-active">Mapped</span>
                      )}
                      {isTeaching && (
                        <button type="button" disabled={locked} onClick={() => removeVariable(variable.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="collector-variable-body">
                        {isTeaching && (
                          <>
                            <label>
                              Key
                              <input
                                disabled={locked}
                                value={variable.key}
                                onChange={(e) => updateVariable(variable.id, { key: e.target.value })}
                              />
                            </label>
                            <label>
                              Label
                              <input
                                disabled={locked}
                                value={variable.label}
                                onChange={(e) => updateVariable(variable.id, { label: e.target.value })}
                              />
                            </label>
                            <label>
                              Type
                              <select
                                disabled={locked}
                                value={variable.valueType}
                                onChange={(e) =>
                                  updateVariable(variable.id, {
                                    valueType: e.target.value as CollectorValueType,
                                  })
                                }
                              >
                                {VALUE_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Source / provenance
                              <select
                                disabled={locked}
                                value={variable.source ?? "manual"}
                                onChange={(e) =>
                                  updateVariable(variable.id, {
                                    source: e.target.value as CollectorSource,
                                  })
                                }
                              >
                                {SOURCES.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="collector-check">
                              <input
                                type="checkbox"
                                disabled={locked}
                                checked={variable.required}
                                onChange={(e) =>
                                  updateVariable(variable.id, { required: e.target.checked })
                                }
                              />
                              Required
                            </label>
                          </>
                        )}
                        <div className="collector-map-controls">
                          <label>
                            Map from Sample Data
                            <select
                              disabled={locked}
                              value={mapping?.observedValueId ?? ""}
                              onChange={(e) =>
                                onChange(
                                  setCaptureMapping(
                                    draft,
                                    active.id,
                                    variable.id,
                                    e.target.value ? "mapped" : "unmapped",
                                    e.target.value || undefined,
                                    false,
                                  ),
                                )
                              }
                            >
                              <option value="">— Select —</option>
                              {mock?.observedValues.map((obs) => (
                                <option key={obs.id} value={obs.id}>
                                  {obs.label}: {obs.value.slice(0, 40)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {!isTeaching && (
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() =>
                                onChange(
                                  setCaptureMapping(
                                    draft,
                                    active.id,
                                    variable.id,
                                    "not_present",
                                    undefined,
                                    false,
                                  ),
                                )
                              }
                            >
                              Mark Not Present
                            </button>
                          )}
                          <small>
                            Status: {mapping?.presence ?? "unmapped"}
                            {mapping?.confirmed
                              ? " · confirmed"
                              : mapping?.simulatedProposal
                                ? " · simulated proposal"
                                : " · pending"}
                          </small>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="collector-review-confirm-bar">
              <button
                type="button"
                className="primary"
                disabled={locked || audit.status === "excluded"}
                onClick={() => runAuditAction("confirm")}
              >
                Confirm Audit
              </button>
              <button
                type="button"
                disabled={locked || audit.status === "excluded"}
                onClick={() => runAuditAction("needs_attention")}
              >
                Mark Needs Attention
              </button>
              <button
                type="button"
                disabled={locked || audit.status === "excluded"}
                onClick={() => setExcludeOpen((v) => !v)}
              >
                Exclude Item
              </button>
            </div>

            {excludeOpen && (
              <div className="collector-exclude-panel" role="dialog" aria-label="Exclude item">
                <p className="hint">Optional organizational tags (not Post Type classification).</p>
                <div className="collector-exclude-tags">
                  {SUGGESTED_EXCLUDE_TAGS.map((tag) => {
                    const on = excludeTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={on ? "primary" : undefined}
                        disabled={locked}
                        onClick={() =>
                          setExcludeTags((prev) =>
                            on ? prev.filter((t) => t !== tag) : [...prev, tag],
                          )
                        }
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
                <label>
                  Custom tags (comma-separated)
                  <input
                    disabled={locked}
                    value={excludeCustom}
                    onChange={(e) => setExcludeCustom(e.target.value)}
                    placeholder="e.g. temp-skip"
                  />
                </label>
                <label>
                  Reason (optional)
                  <input
                    disabled={locked}
                    value={excludeReason}
                    onChange={(e) => setExcludeReason(e.target.value)}
                    placeholder="Why isolate this capture?"
                  />
                </label>
                <div className="collector-row-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={locked}
                    onClick={() => runAuditAction("exclude")}
                  >
                    Confirm Exclude
                  </button>
                  <button type="button" disabled={locked} onClick={() => setExcludeOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!pendingLeft && (
              <p className="hint">No pending review items remain.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
