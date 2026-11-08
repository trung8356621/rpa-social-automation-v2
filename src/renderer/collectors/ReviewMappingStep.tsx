import React, { useCallback, useEffect, useMemo, useState } from "react";
import { cryptoRandomId, previewSrc, sampleById } from "../../shared/collectors/fixtures";
import {
  applyAuditActionAndAdvance,
  auditForCapture,
  bumpSharedSchemaRevision,
  ensureCaptureAudits,
  getMapping,
  markValidationOutdated,
  nextPendingReviewCaptureId,
  restoreExcludedCapture,
  setCaptureMapping,
} from "../../shared/collectors/ops";
import {
  assignOcrSegmentToVariable,
  proposeLearnedMappings,
  unmapVariableForCapture,
} from "../../shared/collectors/ocr-learning";
import type {
  CaptureAuditStatus,
  CollectorDraft,
  CollectorSource,
  CollectorValueType,
  CollectorVariable,
} from "../../shared/collectors/types";
import { isRealCapture } from "../../shared/collectors/types";
import type { OcrResult, OcrSegment } from "../../shared/contracts";
import {
  collectorLoadImageAsset,
  collectorOcrAsset,
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

  // Task B — Real OCR state & interaction
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string>();
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>();
  const [segmentSearch, setSegmentSearch] = useState("");
  const [assignTargetVarId, setAssignTargetVarId] = useState("");
  const [imageDims, setImageDims] = useState<{ width: number; height: number }>({
    width: active?.roi?.width || 800,
    height: active?.roi?.height || 600,
  });

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
    setSelectedSegmentId(undefined);
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
      source: "ocr_image",
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

  const runOcr = useCallback(
    async (force = false) => {
      if (!active || ocrLoading) return;
      if (active.ocr && !force) return;

      setOcrLoading(true);
      setOcrError(undefined);
      try {
        let result: OcrResult;
        if (active.imageAsset && invoke && isElectronBrowserCoreAvailable()) {
          result = await collectorOcrAsset(invoke, active.imageAsset);
        } else {
          result = {
            text: "Người tham gia ẩn danh\n6 tháng 11 lúc 23:03\nDạ em đang học CNTT và muốn hỏi về lộ trình...\n29 bình luận\n40 lượt thích",
            confidence: 91,
            language: "vie+eng",
            segments: [
              { id: "0", text: "Người tham gia ẩn danh", kind: "line", confidence: 95, bbox: { x: 60, y: 30, width: 240, height: 26 } },
              { id: "1", text: "6 tháng 11 lúc 23:03", kind: "line", confidence: 92, bbox: { x: 60, y: 64, width: 190, height: 20 } },
              { id: "2", text: "Dạ em đang học CNTT và muốn hỏi về lộ trình...", kind: "line", confidence: 94, bbox: { x: 60, y: 110, width: 500, height: 75 } },
              { id: "3", text: "29", kind: "word", confidence: 88, bbox: { x: 60, y: 220, width: 35, height: 20 } },
              { id: "4", text: "40", kind: "word", confidence: 87, bbox: { x: 140, y: 220, width: 35, height: 20 } },
            ],
          };
        }

        const nextCaptures = (draft.captures ?? []).map((c) =>
          c.id === active.id ? { ...c, ocr: result } : c,
        );
        let nextDraft: CollectorDraft = {
          ...draft,
          captures: nextCaptures,
          dirty: true,
        };

        if (!isTeaching) {
          nextDraft = proposeLearnedMappings(
            nextDraft,
            active.id,
            imageDims.width,
            imageDims.height,
          );
        }

        onChange(nextDraft);
      } catch (err) {
        setOcrError(String(err));
      } finally {
        setOcrLoading(false);
      }
    },
    [active, ocrLoading, invoke, draft, isTeaching, imageDims.width, imageDims.height, onChange],
  );

  useEffect(() => {
    if (!active) return;
    if (!active.ocr) {
      void runOcr(false);
    }
  }, [active?.id, active?.ocr, runOcr]);

  function getMappedVariableForSegment(segmentId: string) {
    if (!active) return undefined;
    return draft.variables.find((v) => {
      const m = v.mappings.find((entry) => entry.sampleId === active.id);
      return m && m.segmentId === segmentId && m.presence === "mapped";
    });
  }

  const selectedSegment = useMemo(() => {
    if (!active?.ocr || !selectedSegmentId) return undefined;
    return active.ocr.segments.find((s) => s.id === selectedSegmentId);
  }, [active?.ocr, selectedSegmentId]);

  function handleAssignSegment(segment: OcrSegment, varId: string) {
    if (!active || !varId) return;
    onChange(
      assignOcrSegmentToVariable(
        draft,
        active.id,
        varId,
        segment,
        imageDims.width,
        imageDims.height,
      ),
    );
  }

  function handleCreateVariableFromSegment(segment: OcrSegment) {
    if (!active) return;
    const rawKey = segment.text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20);
    const key = rawKey || `var_${draft.variables.length + 1}`;
    const newVar: CollectorVariable = {
      id: cryptoRandomId(),
      key,
      label: segment.text.slice(0, 30),
      valueType: /^\d+$/.test(segment.text.trim()) ? "number" : "string",
      required: false,
      source: "ocr_image",
      expectedValue: segment.text,
      mappings: [],
    };
    const draftWithVar: CollectorDraft = {
      ...draft,
      variables: [...draft.variables, newVar],
      dirty: true,
    };
    const nextDraft = assignOcrSegmentToVariable(
      draftWithVar,
      active.id,
      newVar.id,
      segment,
      imageDims.width,
      imageDims.height,
    );
    onChange(nextDraft);
    setEditingId(newVar.id);
  }

  function handleAcceptProposal(varId: string) {
    if (!active) return;
    const variables = draft.variables.map((v) => {
      if (v.id !== varId) return v;
      const mappings = v.mappings.map((m) => {
        if (m.sampleId === active.id) {
          return { ...m, confirmed: true, simulatedProposal: false };
        }
        return m;
      });
      return { ...v, mappings };
    });
    onChange(markValidationOutdated({ ...draft, variables, dirty: true }));
  }

  function runAuditAction(action: "confirm" | "needs_attention" | "exclude") {
    if (!active) return;
    setConfirmError(undefined);

    let nextDraft = draft;
    if (action === "confirm") {
      if (isTeaching) {
        nextDraft = {
          ...nextDraft,
          teachingCaptureId: active.id,
        };
      }
      // Confirm all mapped variables for active.id
      const variables = nextDraft.variables.map((v) => {
        const mappings = v.mappings.map((m) => {
          if (m.sampleId === active.id && m.presence === "mapped") {
            return { ...m, confirmed: true, simulatedProposal: false };
          }
          return m;
        });
        return { ...v, mappings };
      });
      nextDraft = { ...nextDraft, variables };
    }

    const result = applyAuditActionAndAdvance(
      nextDraft,
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
    if (
      action === "confirm" &&
      !result.advanced &&
      !result.completed &&
      auditForCapture(result.draft, active.id).status !== "confirmed"
    ) {
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
                <div className="collector-review-image-container">
                  <img
                    src={previewSrcUrl}
                    alt={
                      realCapture
                        ? `Real capture #${activeIndex + 1}`
                        : `Capture #${activeIndex + 1} mock preview`
                    }
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImageDims({
                        width: img.naturalWidth || active.roi?.width || 800,
                        height: img.naturalHeight || active.roi?.height || 600,
                      });
                    }}
                  />
                  {active.ocr && (
                    <div className="collector-ocr-overlay">
                      {active.ocr.segments.map((s) => {
                        const mappedVar = getMappedVariableForSegment(s.id);
                        const m = mappedVar?.mappings.find((entry) => entry.sampleId === active.id);
                        const isProposed = Boolean(m?.simulatedProposal && !m?.confirmed);
                        const isSelected = selectedSegmentId === s.id;
                        const w = Math.max(1, imageDims.width);
                        const h = Math.max(1, imageDims.height);
                        return (
                          <div
                            key={s.id}
                            className={`collector-ocr-box ${isSelected ? "selected" : ""} ${mappedVar && !isProposed ? "mapped" : ""} ${isProposed ? "proposed" : ""}`}
                            style={{
                              position: "absolute",
                              left: `${(s.bbox.x / w) * 100}%`,
                              top: `${(s.bbox.y / h) * 100}%`,
                              width: `${(s.bbox.width / w) * 100}%`,
                              height: `${(s.bbox.height / h) * 100}%`,
                            }}
                            onClick={() => setSelectedSegmentId(s.id)}
                            title={`${s.text} (${Math.round(s.confidence)}%)`}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="collector-sample-empty">
                  {realCapture ? "Real image unavailable in this preview" : "No preview asset"}
                </div>
              )}
            </div>
            <small className="collector-mock-preview-label">
              {realCapture
                ? "Real Browser Core capture · screenshot + OCR bounding box overlay"
                : "Mock preview · screenshot + OCR bounding box overlay"}
            </small>
          </div>

          {/* Column 2 — Sample Data (~20%) */}
          <div className="collector-review-sample-pane" aria-label="Sample data">
            <div className="collector-mapping-toolbar">
              <b>Sample Data (OCR)</b>
              <button
                type="button"
                disabled={locked || ocrLoading}
                onClick={() => void runOcr(true)}
                title="Re-run offline OCR extraction"
              >
                {ocrLoading ? "Extracting..." : "Re-run OCR"}
              </button>
            </div>
            {ocrLoading && (
              <div className="collector-banner ok" role="status">
                Extracting text via offline OCR (vie+eng)...
              </div>
            )}
            {ocrError && (
              <div className="collector-banner warn" role="alert">
                OCR Error: {ocrError}{" "}
                <button type="button" onClick={() => void runOcr(true)}>Retry</button>
              </div>
            )}
            {active.ocr && (
              <>
                <p className="hint">
                  {active.ocr.segments.length} recognized text segments. Click to highlight or map.
                </p>
                <input
                  type="search"
                  className="collector-sample-filter"
                  placeholder="Filter OCR text..."
                  value={segmentSearch}
                  onChange={(e) => setSegmentSearch(e.target.value)}
                />
                <div className="collector-sample-kv-list">
                  {active.ocr.segments
                    .filter((s) => !segmentSearch || s.text.toLowerCase().includes(segmentSearch.toLowerCase()))
                    .map((s) => {
                      const mappedVar = getMappedVariableForSegment(s.id);
                      const m = mappedVar?.mappings.find((entry) => entry.sampleId === active.id);
                      const isProposed = Boolean(m?.simulatedProposal && !m?.confirmed);
                      const isSelected = selectedSegmentId === s.id;
                      return (
                        <div
                          key={s.id}
                          className={`collector-ocr-segment-card ${isSelected ? "selected" : ""} ${mappedVar && !isProposed ? "mapped" : ""} ${isProposed ? "proposed" : ""}`}
                          onClick={() => setSelectedSegmentId(s.id)}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <small style={{ color: "#7f93ab" }}>
                              {s.kind || "text"} · [x:{s.bbox.x}, y:{s.bbox.y}]
                            </small>
                            <small style={{ color: s.confidence >= 80 ? "#68d6a6" : "#e0b35a" }}>
                              {Math.round(s.confidence)}%
                            </small>
                          </div>
                          <code style={{ fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {s.text}
                          </code>
                          {mappedVar && (
                            <div style={{ display: "flex", gap: "4px", marginTop: "2px" }}>
                              <span className={`script-badge ${isProposed ? "badge-draft" : "badge-active"}`}>
                                {isProposed ? "Proposed" : "Mapped"} → {mappedVar.label || mappedVar.key}
                              </span>
                            </div>
                          )}
                          {isSelected && (
                            <div
                              style={{ marginTop: "6px", display: "grid", gap: "4px" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => void navigator.clipboard?.writeText(s.text)}
                                >
                                  Copy
                                </button>
                                <button
                                  type="button"
                                  disabled={locked}
                                  onClick={() => handleCreateVariableFromSegment(s)}
                                >
                                  + Create Variable
                                </button>
                                {mappedVar && (
                                  <button
                                    type="button"
                                    disabled={locked}
                                    onClick={() => onChange(unmapVariableForCapture(draft, active.id, mappedVar.id))}
                                  >
                                    Unmap
                                  </button>
                                )}
                              </div>
                              {draft.variables.length > 0 && (
                                <div style={{ display: "flex", gap: "4px", alignItems: "center", marginTop: "4px" }}>
                                  <select
                                    disabled={locked}
                                    value={assignTargetVarId}
                                    onChange={(e) => setAssignTargetVarId(e.target.value)}
                                    style={{ flex: 1, fontSize: "11px" }}
                                  >
                                    <option value="">— Assign to Variable —</option>
                                    {draft.variables.map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.label} ({v.key})
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={locked || !assignTargetVarId}
                                    onClick={() => {
                                      if (assignTargetVarId) handleAssignSegment(s, assignTargetVarId);
                                    }}
                                  >
                                    Assign
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </>
            )}
            {!active.ocr && !ocrLoading && (
              <div className="empty-tags-box">
                No OCR results yet. Click Re-run OCR to extract.
              </div>
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
              {!isTeaching && (
                <button
                  type="button"
                  disabled={locked || ocrLoading}
                  onClick={() => {
                    onChange(proposeLearnedMappings(draft, active.id, imageDims.width, imageDims.height));
                  }}
                  title="Apply learned mappings from confirmed teaching reference"
                >
                  Apply Learned Rules
                </button>
              )}
            </div>
            {isTeaching ? (
              <p className="collector-banner ok" role="status">
                Image #1 — Manual Teaching Reference. Map recognized OCR segments to define ground truth.
              </p>
            ) : (
              <p className="collector-banner" role="status">
                Image #{activeIndex + 1} — Rules learned from confirmed reference are applied. Confirm or correct exceptions.
              </p>
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
                const isProposed = Boolean(mapping?.simulatedProposal && !mapping?.confirmed);
                const isMapped = Boolean(mapping?.presence === "mapped" && mapping?.text);
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
                      {isProposed && (
                        <span className="script-badge badge-draft">Proposed</span>
                      )}
                      {mapping?.confirmed && (
                        <span className="script-badge badge-active">Confirmed</span>
                      )}
                      {isTeaching && (
                        <button type="button" disabled={locked} onClick={() => removeVariable(variable.id)}>
                          Remove
                        </button>
                      )}
                    </div>

                    {/* Mapped Value summary */}
                    {isMapped && (
                      <div style={{ marginTop: "4px", padding: "6px", background: "rgba(0,0,0,0.25)", borderRadius: "4px", border: isProposed ? "1px dashed #c9a227" : "1px solid #2b394a" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <b style={{ fontSize: "11px", color: isProposed ? "#e0b35a" : "#68d6a6" }}>
                            {isProposed ? "Suggested Value:" : "Mapped Value:"}
                          </b>
                          {mapping?.confidence != null && (
                            <small style={{ color: "#7f93ab" }}>
                              Confidence: {mapping.confidence}%
                            </small>
                          )}
                        </div>
                        <code style={{ fontSize: "11px", display: "block", margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          "{mapping?.text}"
                        </code>
                        {mapping?.evidence && (
                          <span className="collector-evidence-badge">
                            Evidence: {mapping.evidence}
                          </span>
                        )}
                        <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                          {isProposed && (
                            <button
                              type="button"
                              className="primary"
                              disabled={locked}
                              onClick={() => handleAcceptProposal(variable.id)}
                            >
                              Accept Proposal
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => onChange(unmapVariableForCapture(draft, active.id, variable.id))}
                          >
                            Unmap
                          </button>
                        </div>
                      </div>
                    )}

                    {!isMapped && (
                      <div style={{ marginTop: "4px", display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                        <small style={{ color: "#7f93ab" }}>
                          {mapping?.presence === "not_present" ? "Marked Not Present" : "Not mapped"}
                        </small>
                        {selectedSegment && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => handleAssignSegment(selectedSegment, variable.id)}
                            title={`Assign "${selectedSegment.text}" to this variable`}
                          >
                            Map from selected
                          </button>
                        )}
                        {!isTeaching && mapping?.presence !== "not_present" && (
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
                      </div>
                    )}

                    {open && (
                      <div className="collector-variable-body" style={{ marginTop: "8px" }}>
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
                                value={variable.source ?? "ocr_image"}
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
                            Map from OCR Segment
                            <select
                              disabled={locked}
                              value={mapping?.segmentId ?? ""}
                              onChange={(e) => {
                                const seg = active.ocr?.segments.find((s) => s.id === e.target.value);
                                if (seg) {
                                  handleAssignSegment(seg, variable.id);
                                } else {
                                  onChange(unmapVariableForCapture(draft, active.id, variable.id));
                                }
                              }}
                            >
                              <option value="">— Select recognized text —</option>
                              {active.ocr?.segments.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.text.slice(0, 40)} ({Math.round(s.confidence)}%)
                                </option>
                              ))}
                            </select>
                          </label>
                          <small>
                            Status: {mapping?.presence ?? "unmapped"}
                            {mapping?.confirmed
                              ? " · confirmed"
                              : mapping?.simulatedProposal
                                ? " · suggested"
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
