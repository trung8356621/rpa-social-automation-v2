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
  addRegionToDraft,
  updateRegionInDraft,
  deleteRegionFromDraft,
  confirmRegionInDraft,
  regionsForCapture,
} from "../../shared/collectors/ops";
import {
  assignOcrSegmentToVariable,
  getSegmentsByLevel,
  normalizeVietnameseText,
  proposeLearnedMappings,
  unmapVariableForCapture,
  type OcrGroupingLevel,
} from "../../shared/collectors/ocr-learning";
import {
  createCollectorRegion,
  matchLearnedRegions,
  findVerifiedPostContainer,
  extractDynamicHtmlFromContainer,
  denormalizeGeometry,
} from "../../shared/collectors/regions";
import type {
  CaptureAuditStatus,
  CollectorDraft,
  CollectorRegion,
  CollectorRegionRole,
  CollectorRegionType,
  CollectorVariable,
  DynamicHtmlExtractionResult,
  LayoutContextKind,
  VerifiedPostContainer,
} from "../../shared/collectors/types";
import { isRealCapture } from "../../shared/collectors/types";
import type { OcrResult, OcrSegment, Rect } from "../../shared/contracts";
import {
  collectorInspectDom,
  collectorLoadImageAsset,
  collectorOcrAsset,
  isElectronBrowserCoreAvailable,
  type CollectorInvoke,
} from "./browser-capture";

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

  // Task B & C2.7.1 — Real OCR state & interaction
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string>();
  const [groupingLevel, setGroupingLevel] = useState<OcrGroupingLevel>("block");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>();
  const [segmentSearch, setSegmentSearch] = useState("");
  const [assignTargetVarId, setAssignTargetVarId] = useState("");
  const [imageDims, setImageDims] = useState<{ width: number; height: number }>({
    width: active?.roi?.width || 800,
    height: active?.roi?.height || 600,
  });

  // C2.8 — Internal Review Mode: "regions" vs "fields"
  const [reviewMode, setReviewMode] = useState<"regions" | "fields">("regions");
  const [layoutContext, setLayoutContext] = useState<LayoutContextKind>(draft.layoutContext || "FEED_ITEM");
  const [selectedRegionId, setSelectedRegionId] = useState<string>();

  // Region drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [newRegionBox, setNewRegionBox] = useState<Rect | null>(null);
  const [newRegionType, setNewRegionType] = useState<CollectorRegionType>("STATIC");
  const [newRegionRole, setNewRegionRole] = useState<CollectorRegionRole>("header");
  const [newRegionLabel, setNewRegionLabel] = useState("");
  const [newRegionVars, setNewRegionVars] = useState<string[]>([]);
  const [newRegionOcrText, setNewRegionOcrText] = useState("");

  // DOM container verification & dynamic extraction state
  const [domLoading, setDomLoading] = useState(false);
  const [domError, setDomError] = useState<string>();
  const [verifiedContainer, setVerifiedContainer] = useState<VerifiedPostContainer | null>(active?.postContainer ?? null);
  const [dynamicExtraction, setDynamicExtraction] = useState<DynamicHtmlExtractionResult | null>(active?.dynamicExtraction ?? null);

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

  const activeSegments = useMemo(() => {
    if (!active?.ocr) return [];
    return getSegmentsByLevel(active.ocr, groupingLevel, imageDims.width, imageDims.height);
  }, [active?.ocr, groupingLevel, imageDims.width, imageDims.height]);

  function getMappedVariableForSegment(segment: OcrSegment) {
    if (!active) return undefined;
    return draft.variables.find((v) => {
      const m = v.mappings.find((entry) => entry.sampleId === active.id);
      if (!m || m.presence !== "mapped") return false;
      if (m.segmentId === segment.id) return true;
      if (m.text && segment.text && m.text.trim() === segment.text.trim()) return true;
      return false;
    });
  }

  const selectedSegment = useMemo(() => {
    if (!selectedSegmentId) return undefined;
    return activeSegments.find((s) => s.id === selectedSegmentId);
  }, [activeSegments, selectedSegmentId]);

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

  const activeRegions = useMemo(() => {
    if (!active) return [];
    return regionsForCapture(draft, active.id);
  }, [draft, active?.id]);

  const selectedRegion = useMemo(() => {
    if (!selectedRegionId) return undefined;
    return activeRegions.find((r) => r.id === selectedRegionId);
  }, [activeRegions, selectedRegionId]);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (reviewMode !== "regions" || locked) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(imageDims.width, ((e.clientX - rect.left) / rect.width) * imageDims.width));
    const y = Math.max(0, Math.min(imageDims.height, ((e.clientY - rect.top) / rect.height) * imageDims.height));
    setIsDrawing(true);
    setDrawStart({ x, y });
    setDrawCurrent({ x, y });
    setNewRegionBox(null);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isDrawing || !drawStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(imageDims.width, ((e.clientX - rect.left) / rect.width) * imageDims.width));
    const y = Math.max(0, Math.min(imageDims.height, ((e.clientY - rect.top) / rect.height) * imageDims.height));
    setDrawCurrent({ x, y });
  }

  function handleMouseUp() {
    if (!isDrawing || !drawStart || !drawCurrent) {
      setIsDrawing(false);
      return;
    }
    setIsDrawing(false);
    const x = Math.round(Math.min(drawStart.x, drawCurrent.x));
    const y = Math.round(Math.min(drawStart.y, drawCurrent.y));
    const width = Math.round(Math.abs(drawCurrent.x - drawStart.x));
    const height = Math.round(Math.abs(drawCurrent.y - drawStart.y));

    if (width >= 20 && height >= 15) {
      const box = { x, y, width, height };
      setNewRegionBox(box);
      const isTop = y < imageDims.height * 0.35;
      const isBottom = y > imageDims.height * 0.65;
      setNewRegionType(isTop || isBottom ? "STATIC" : "DYNAMIC");
      setNewRegionRole(isTop ? "header" : isBottom ? "footer" : "content");
      setNewRegionLabel(isTop ? "Header Anchor" : isBottom ? "Footer Anchor" : "Dynamic Post Body");
      setNewRegionVars([]);
      setNewRegionOcrText("");
    }
    setDrawStart(null);
    setDrawCurrent(null);
  }

  function handleCreateRegionFromOcr(seg: OcrSegment, type: CollectorRegionType = "STATIC", role: CollectorRegionRole = "header") {
    if (!active) return;
    setNewRegionBox(seg.bbox);
    setNewRegionType(type);
    setNewRegionRole(role);
    setNewRegionLabel(role === "header" ? "Header Anchor" : role === "footer" ? "Footer Anchor" : "Dynamic Content");
    setNewRegionOcrText(seg.text);
    setNewRegionVars([]);
  }

  function handleSaveRegion() {
    if (!active || !newRegionBox) return;
    const region = createCollectorRegion({
      captureItemId: active.id,
      type: newRegionType,
      label: newRegionLabel,
      role: newRegionRole,
      box: newRegionBox,
      imageWidth: imageDims.width,
      imageHeight: imageDims.height,
      candidateVariableKeys: newRegionVars,
      ocrText: newRegionOcrText || undefined,
    });
    onChange(addRegionToDraft(draft, region));
    setNewRegionBox(null);
    setSelectedRegionId(region.id);
  }

  function handleConfirmRegion(id: string) {
    onChange(confirmRegionInDraft(draft, id));
  }

  function handleDeleteRegion(id: string) {
    onChange(deleteRegionFromDraft(draft, id));
    if (selectedRegionId === id) setSelectedRegionId(undefined);
  }

  async function handleVerifyPostContainer() {
    if (!active) return;
    setDomLoading(true);
    setDomError(undefined);
    try {
      let snapshot = active.domSnapshot;
      if (!snapshot && invoke && isElectronBrowserCoreAvailable()) {
        snapshot = await collectorInspectDom(invoke, active.captureUrl, layoutContext);
      }
      if (!snapshot) {
        snapshot = {
          url: active.captureUrl || "https://facebook.com/group/feed",
          capturedAt: active.capturedAt || new Date().toISOString(),
          viewport: { width: imageDims.width, height: imageDims.height, scrollX: 0, scrollY: 0, dpr: 1 },
          elements: (active.ocr?.segments ?? []).map((s, idx) => ({
            id: `elem_${idx}`,
            tagName: s.kind === "block" ? "DIV" : "SPAN",
            rect: s.bbox,
            textSnippet: s.text,
            attributes: {},
            childrenIds: [],
            depth: s.kind === "block" ? 3 : 4,
            isArticleOrCard: s.kind === "block" && s.bbox.height > 100,
          })),
        };
      }

      const activeRegs = regionsForCapture(draft, active.id);
      const container = findVerifiedPostContainer(
        activeRegs,
        snapshot,
        imageDims.width,
        imageDims.height,
        layoutContext,
        active.roi,
      );

      const extraction = container.containerId
        ? extractDynamicHtmlFromContainer(container, snapshot, activeRegs)
        : null;

      setVerifiedContainer(container);
      setDynamicExtraction(extraction);

      const nextCaptures = (draft.captures ?? []).map((c) =>
        c.id === active.id
          ? { ...c, postContainer: container, dynamicExtraction: extraction ?? undefined, domSnapshot: snapshot, layoutContext }
          : c,
      );
      onChange({ ...draft, captures: nextCaptures, dirty: true });
    } catch (err) {
      setDomError(String(err));
    } finally {
      setDomLoading(false);
    }
  }

  function handleApplyLearnedAnchors() {
    if (!active || isTeaching) return;
    const refCaptures = (draft.captures ?? []).filter(
      (c) => c.id !== active.id && auditForCapture(draft, c.id).status === "confirmed",
    );
    const refRegions = (draft.regions ?? []).filter((r) =>
      refCaptures.some((c) => c.id === r.captureItemId && r.confirmed),
    );
    const matched = matchLearnedRegions(
      active.id,
      refRegions,
      active.ocr?.text ?? "",
      imageDims.width,
      imageDims.height,
    );
    if (!matched.length) {
      setConfirmError("No matching static anchor patterns found from confirmed references.");
      return;
    }
    let nextDraft = draft;
    for (const r of matched) {
      nextDraft = addRegionToDraft(nextDraft, r);
    }
    onChange(nextDraft);
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
      // Also confirm all regions for active.id
      const regions = (nextDraft.regions ?? []).map((r) =>
        r.captureItemId === active.id ? { ...r, confirmed: true, simulatedProposal: false } : r,
      );
      nextDraft = { ...nextDraft, variables, regions };
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
        <div className="collector-review-workspace collector-review-workspace-3col collector-review-workspace-2pane">
          {/* Left Pane (~68%) — Screenshot & Overlay */}
          <div className="collector-review-image-pane" aria-label="Sample Data & OCR Mapping">
            <div className="collector-mapping-toolbar" style={{ marginBottom: "6px", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
              {/* Internal Mode Toggle: DOM Regions vs OCR Fields */}
              <div className="collector-mode-toggle" role="group" aria-label="Review mode">
                <button
                  type="button"
                  className={reviewMode === "regions" ? "active" : ""}
                  onClick={() => setReviewMode("regions")}
                >
                  DOM Regions
                </button>
                <button
                  type="button"
                  className={reviewMode === "fields" ? "active" : ""}
                  onClick={() => setReviewMode("fields")}
                >
                  OCR Fields
                </button>
              </div>

              {reviewMode === "regions" && (
                <>
                  <div className="collector-level-toggle" role="group" aria-label="Layout context">
                    <button
                      type="button"
                      className={layoutContext === "FEED_ITEM" ? "active" : ""}
                      onClick={() => {
                        setLayoutContext("FEED_ITEM");
                        onChange({ ...draft, layoutContext: "FEED_ITEM" });
                      }}
                    >
                      Feed Item
                    </button>
                    <button
                      type="button"
                      className={layoutContext === "POST_DETAIL" ? "active" : ""}
                      onClick={() => {
                        setLayoutContext("POST_DETAIL");
                        onChange({ ...draft, layoutContext: "POST_DETAIL" });
                      }}
                    >
                      Post Detail
                    </button>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={locked || domLoading}
                    onClick={() => void handleVerifyPostContainer()}
                  >
                    {domLoading ? "Verifying DOM..." : "Verify Post Container"}
                  </button>
                </>
              )}

              {reviewMode === "fields" && (
                <>
                  <div className="collector-level-toggle" role="group" aria-label="OCR grouping level">
                    {(["block", "line", "word"] as OcrGroupingLevel[]).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        className={groupingLevel === lvl ? "active" : ""}
                        onClick={() => {
                          setGroupingLevel(lvl);
                          setSelectedSegmentId(undefined);
                        }}
                      >
                        {lvl.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <input
                    type="search"
                    className="collector-toolbar-search"
                    placeholder="Search text on image..."
                    value={segmentSearch}
                    onChange={(e) => setSegmentSearch(e.target.value)}
                  />
                  <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                    {ocrLoading && <small style={{ color: "#68d6a6" }}>Extracting OCR...</small>}
                    {ocrError && <small style={{ color: "#e05a5a" }}>OCR failed</small>}
                    <button
                      type="button"
                      disabled={locked || ocrLoading}
                      onClick={() => void runOcr(true)}
                      title="Re-run offline OCR extraction"
                    >
                      {ocrLoading ? "Extracting..." : "Re-run OCR"}
                    </button>
                  </div>
                </>
              )}
              <span className="hint" style={{ fontSize: "11px", color: "#7f93ab" }}>Sample Data</span>
            </div>

            <div className="collector-review-image-frame">
              {previewSrcUrl ? (
                <div
                  className="collector-review-image-container"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  style={{ cursor: reviewMode === "regions" ? "crosshair" : "default" }}
                >
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

                  {/* Regions Overlay (in "regions" mode) */}
                  {reviewMode === "regions" && (
                    <div className="collector-ocr-overlay" style={{ pointerEvents: isDrawing ? "none" : "auto" }}>
                      {/* Active regions */}
                      {activeRegions.map((r) => {
                        const isSelected = selectedRegionId === r.id;
                        return (
                          <div
                            key={r.id}
                            className={`collector-region-box ${r.type.toLowerCase()} ${isSelected ? "selected" : ""}`}
                            style={{
                              left: `${r.geometry.relX * 100}%`,
                              top: `${r.geometry.relY * 100}%`,
                              width: `${r.geometry.relW * 100}%`,
                              height: `${r.geometry.relH * 100}%`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRegionId(r.id);
                              setNewRegionBox(null);
                            }}
                            title={`${r.label} (${r.type} · ${r.role || "region"})`}
                          >
                            <span className={`collector-region-tag ${r.type.toLowerCase()}`}>
                              {r.role ? `${r.role.toUpperCase()} (${r.type})` : r.type}
                            </span>
                          </div>
                        );
                      })}

                      {/* Current drawing rectangle */}
                      {isDrawing && drawStart && drawCurrent && (
                        <div
                          className="collector-region-box drawing"
                          style={{
                            left: `${(Math.min(drawStart.x, drawCurrent.x) / imageDims.width) * 100}%`,
                            top: `${(Math.min(drawStart.y, drawCurrent.y) / imageDims.height) * 100}%`,
                            width: `${(Math.abs(drawCurrent.x - drawStart.x) / imageDims.width) * 100}%`,
                            height: `${(Math.abs(drawCurrent.y - drawStart.y) / imageDims.height) * 100}%`,
                          }}
                        />
                      )}

                      {/* Subtle OCR boxes in regions mode to allow clicking OCR blocks into anchors */}
                      {!isDrawing &&
                        activeSegments.map((s) => {
                          const w = Math.max(1, imageDims.width);
                          const h = Math.max(1, imageDims.height);
                          return (
                            <div
                              key={s.id}
                              className="collector-ocr-box"
                              style={{
                                position: "absolute",
                                left: `${(s.bbox.x / w) * 100}%`,
                                top: `${(s.bbox.y / h) * 100}%`,
                                width: `${(s.bbox.width / w) * 100}%`,
                                height: `${(s.bbox.height / h) * 100}%`,
                                opacity: 0.35,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const isTop = s.bbox.y < imageDims.height * 0.35;
                                const isBottom = s.bbox.y > imageDims.height * 0.65;
                                handleCreateRegionFromOcr(
                                  s,
                                  isTop || isBottom ? "STATIC" : "DYNAMIC",
                                  isTop ? "header" : isBottom ? "footer" : "content",
                                );
                              }}
                              title={`Click to create region from "${s.text.slice(0, 30)}"`}
                            />
                          );
                        })}
                    </div>
                  )}

                  {/* OCR Fields Overlay (in "fields" mode) */}
                  {reviewMode === "fields" && active.ocr && (
                    <div className="collector-ocr-overlay">
                      {activeSegments.map((s) => {
                        const mappedVar = getMappedVariableForSegment(s);
                        const m = mappedVar?.mappings.find((entry) => entry.sampleId === active.id);
                        const isProposed = Boolean(m?.simulatedProposal && !m?.confirmed);
                        const isSelected = selectedSegmentId === s.id;
                        const isSearchMatch =
                          !segmentSearch.trim() ||
                          normalizeVietnameseText(s.text).includes(normalizeVietnameseText(segmentSearch.trim()));
                        const w = Math.max(1, imageDims.width);
                        const h = Math.max(1, imageDims.height);
                        return (
                          <div
                            key={s.id}
                            className={`collector-ocr-box ${isSelected ? "selected" : ""} ${mappedVar && !isProposed ? "mapped" : ""} ${isProposed ? "proposed" : ""} ${!isSearchMatch ? "dimmed" : ""}`}
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

            {/* Docked inspectors below the screenshot */}
            {reviewMode === "regions" && newRegionBox && (
              <div className="collector-selected-segment-dock">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <b>Define New Region</b>
                    <small style={{ color: "#7f93ab" }}>
                      [{newRegionBox.width}×{newRegionBox.height} at x:{newRegionBox.x}, y:{newRegionBox.y}]
                    </small>
                  </div>
                  <button type="button" className="close-btn" onClick={() => setNewRegionBox(null)}>✕</button>
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" }}>
                  <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "11px" }}>
                    <b>Type:</b>
                    <select
                      value={newRegionType}
                      onChange={(e) => setNewRegionType(e.target.value as CollectorRegionType)}
                    >
                      <option value="STATIC">STATIC ANCHOR</option>
                      <option value="DYNAMIC">DYNAMIC SCOPE</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "11px" }}>
                    <b>Role:</b>
                    <select
                      value={newRegionRole}
                      onChange={(e) => setNewRegionRole(e.target.value as CollectorRegionRole)}
                    >
                      <option value="header">Header</option>
                      <option value="footer">Footer</option>
                      <option value="content">Content Body</option>
                      <option value="actions">Actions</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "11px", flex: 1 }}>
                    <b>Label:</b>
                    <input
                      type="text"
                      value={newRegionLabel}
                      placeholder="e.g. Header Anchor"
                      onChange={(e) => setNewRegionLabel(e.target.value)}
                      style={{ flex: 1, padding: "2px 6px", fontSize: "11px" }}
                    />
                  </label>
                </div>
                {draft.variables.length > 0 && (
                  <div style={{ marginTop: "4px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <small style={{ color: "#7f93ab" }}>Candidate Variables:</small>
                    {draft.variables.map((v) => {
                      const checked = newRegionVars.includes(v.key);
                      return (
                        <label key={v.id} style={{ fontSize: "11px", display: "inline-flex", gap: "3px" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setNewRegionVars((prev) =>
                                checked ? prev.filter((k) => k !== v.key) : [...prev, v.key],
                              )
                            }
                          />
                          {v.label}
                        </label>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                  <button type="button" className="primary" onClick={handleSaveRegion}>
                    Save Region
                  </button>
                  <button type="button" onClick={() => setNewRegionBox(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {reviewMode === "regions" && !newRegionBox && selectedRegion && (
              <div className="collector-selected-segment-dock">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <span className={`script-badge ${selectedRegion.type === "STATIC" ? "badge-active" : "badge-draft"}`}>
                      {selectedRegion.type} · {selectedRegion.role?.toUpperCase()}
                    </span>
                    <b>{selectedRegion.label}</b>
                    <small style={{ color: "#7f93ab" }}>
                      [relX: {Math.round(selectedRegion.geometry.relX * 100)}%, relY: {Math.round(selectedRegion.geometry.relY * 100)}%]
                    </small>
                  </div>
                  <button type="button" className="close-btn" onClick={() => setSelectedRegionId(undefined)}>✕</button>
                </div>
                {selectedRegion.candidateVariableKeys.length > 0 && (
                  <div style={{ fontSize: "11px", color: "#9fb3c8" }}>
                    Variables: {selectedRegion.candidateVariableKeys.join(", ")}
                  </div>
                )}
                {selectedRegion.evidence && (
                  <span className="collector-evidence-badge">
                    Evidence: {selectedRegion.evidence}
                  </span>
                )}
                <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                  {!selectedRegion.confirmed && (
                    <button type="button" className="primary" onClick={() => handleConfirmRegion(selectedRegion.id)}>
                      Confirm Anchor
                    </button>
                  )}
                  <button type="button" onClick={() => handleDeleteRegion(selectedRegion.id)}>
                    Delete Region
                  </button>
                  <button type="button" onClick={() => setSelectedRegionId(undefined)}>
                    Deselect
                  </button>
                </div>
              </div>
            )}

            {reviewMode === "regions" && !newRegionBox && !selectedRegion && (
              <div className="collector-dock-placeholder">
                <span>Drag mouse on the screenshot to define a <b>STATIC</b> anchor or <b>DYNAMIC</b> content scope. Or click any OCR text block.</span>
              </div>
            )}

            {/* In "fields" mode: Existing OCR Selected Segment Dock */}
            {reviewMode === "fields" && (
              selectedSegment ? (
                <div className="collector-selected-segment-dock">
                  <div className="collector-dock-head">
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <span className="script-badge badge-active">
                        {selectedSegment.kind?.toUpperCase() || groupingLevel.toUpperCase()}
                      </span>
                      <small style={{ color: selectedSegment.confidence >= 80 ? "#68d6a6" : "#e0b35a" }}>
                        {Math.round(selectedSegment.confidence)}% confidence
                      </small>
                      <small style={{ color: "#7f93ab" }}>
                        [{selectedSegment.bbox.width}×{selectedSegment.bbox.height} at x:{selectedSegment.bbox.x}, y:{selectedSegment.bbox.y}]
                      </small>
                    </div>
                    <button
                      type="button"
                      className="close-btn"
                      onClick={() => setSelectedSegmentId(undefined)}
                      title="Deselect"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="collector-dock-text">
                    {selectedSegment.text}
                  </div>
                  <div className="collector-dock-assign-row">
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard?.writeText(selectedSegment.text)}
                    >
                      Copy
                    </button>
                    {isTeaching && (
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => handleCreateVariableFromSegment(selectedSegment)}
                      >
                        + Create Variable
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => handleCreateRegionFromOcr(selectedSegment, "STATIC", "header")}
                    >
                      + Make Static Anchor
                    </button>
                    {draft.variables.length > 0 && (
                      <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: 1 }}>
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
                          className="primary"
                          disabled={locked || !assignTargetVarId}
                          onClick={() => {
                            if (assignTargetVarId) handleAssignSegment(selectedSegment, assignTargetVarId);
                          }}
                        >
                          Assign
                        </button>
                      </div>
                    )}
                    {(() => {
                      const mappedVar = getMappedVariableForSegment(selectedSegment);
                      if (mappedVar) {
                        return (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => onChange(unmapVariableForCapture(draft, active.id, mappedVar.id))}
                          >
                            Unmap ({mappedVar.label})
                          </button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </div>
              ) : (
                <div className="collector-dock-placeholder">
                  <span>Click any text <b>{groupingLevel}</b> on the screenshot to inspect, copy, or assign to a variable.</span>
                </div>
              )
            )}

            <small className="collector-mock-preview-label" style={{ marginTop: "4px" }}>
              {realCapture
                ? `Real Browser Core capture · screenshot + ${reviewMode === "regions" ? "DOM region bounds" : "OCR overlay"}`
                : `Mock preview · screenshot + ${reviewMode === "regions" ? "DOM region bounds" : "OCR overlay"}`}
            </small>
          </div>

          {/* Right Pane (~32%) */}
          <div className="collector-review-editor-pane" aria-label="Variables & Mappings">
            {reviewMode === "regions" ? (
              <>
                <div className="collector-mapping-toolbar">
                  <b>Visual &amp; DOM Regions</b>
                  {!isTeaching && (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={handleApplyLearnedAnchors}
                      title="Apply confirmed static anchors from teaching reference"
                    >
                      Apply Learned Anchors
                    </button>
                  )}
                </div>

                {isTeaching ? (
                  <p className="collector-banner ok" role="status">
                    Image #1 — Manual Teaching Reference. Define STATIC anchors (e.g. Header, Footer) and DYNAMIC content scopes.
                  </p>
                ) : (
                  <p className="collector-banner" role="status">
                    Image #{activeIndex + 1} — Matching learned static anchors across examples.
                  </p>
                )}

                {/* Region list */}
                <div className="collector-variable-list" style={{ maxHeight: "260px" }}>
                  {activeRegions.length === 0 ? (
                    <div className="empty-tags-box" style={{ padding: "12px", textAlign: "center" }}>
                      No regions defined yet. Drag on the screenshot to create a region or click an OCR block.
                    </div>
                  ) : (
                    activeRegions.map((r) => {
                      const isSel = selectedRegionId === r.id;
                      return (
                        <div key={r.id} className={`collector-region-card ${r.type.toLowerCase()} ${isSel ? "selected" : ""}`}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                              <span className={`script-badge ${r.type === "STATIC" ? "badge-active" : "badge-draft"}`}>
                                {r.type}
                              </span>
                              <b>{r.label}</b>
                            </div>
                            <small style={{ color: "#7f93ab" }}>{r.role || "region"}</small>
                          </div>
                          <div style={{ fontSize: "11px", color: "#9fb3c8" }}>
                            Geometry: [x: {Math.round(r.geometry.relX * 100)}%, y: {Math.round(r.geometry.relY * 100)}%, w: {Math.round(r.geometry.relW * 100)}%, h: {Math.round(r.geometry.relH * 100)}%]
                          </div>
                          {r.candidateVariableKeys.length > 0 && (
                            <div style={{ fontSize: "11px", color: "#7f93ab" }}>
                              Variables: {r.candidateVariableKeys.join(", ")}
                            </div>
                          )}
                          {r.evidence && (
                            <span className="collector-evidence-badge">
                              {r.evidence}
                            </span>
                          )}
                          <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                            {!r.confirmed && (
                              <button type="button" className="primary" onClick={() => handleConfirmRegion(r.id)}>
                                Confirm
                              </button>
                            )}
                            {r.confirmed && (
                              <span className="script-badge badge-active">Confirmed</span>
                            )}
                            <button type="button" onClick={() => handleDeleteRegion(r.id)}>
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Post Container Verification & Dynamic HTML Output */}
                <div className={`collector-container-card ${verifiedContainer?.containerId ? "verified" : verifiedContainer?.rejectionReason ? "rejected" : "needs_attention"}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <b>Post Container Verification</b>
                    <span className={`script-badge ${verifiedContainer?.containerId ? "badge-active" : "badge-draft"}`}>
                      {verifiedContainer?.containerId ? "Verified" : verifiedContainer?.rejectionReason ? "Rejected" : "Unverified"}
                    </span>
                  </div>

                  {domError && <div className="collector-banner warn">{domError}</div>}

                  {verifiedContainer?.containerId ? (
                    <>
                      <div style={{ fontSize: "12px", color: "#68d6a6" }}>
                        Container: <code>&lt;{verifiedContainer.selector}&gt;</code> (Confidence: {verifiedContainer.confidence}%)
                      </div>
                      <ul style={{ margin: "2px 0 6px 16px", padding: 0, fontSize: "11px", color: "#9fb3c8" }}>
                        {verifiedContainer.evidence.map((ev, i) => <li key={i}>{ev}</li>)}
                      </ul>
                      {dynamicExtraction && (
                        <div style={{ background: "#090e15", padding: "6px", borderRadius: "4px", border: "1px solid #1f2c3d" }}>
                          <b style={{ fontSize: "11px", color: "#68d6a6" }}>Extracted Dynamic Subtree:</b>
                          <div style={{ fontSize: "11px", marginTop: "4px", color: "#fff" }}>
                            {dynamicExtraction.extractedText?.slice(0, 150) || "No text"}
                          </div>
                          <div style={{ fontSize: "10px", color: "#7f93ab", marginTop: "4px" }}>
                            Media: {dynamicExtraction.mediaUrls?.length ?? 0} · Links: {dynamicExtraction.linkPreviews?.length ?? 0}
                            {dynamicExtraction.hasCollapsedText && " · (Collapsed 'See more' detected)"}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="hint">
                        {verifiedContainer?.rejectionReason
                          ? `Rejection: ${verifiedContainer.rejectionReason}`
                          : "Define static anchors (Header, Footer) and click below to verify the single-post DOM container."}
                      </p>
                      <button
                        type="button"
                        className="primary"
                        disabled={locked || domLoading}
                        onClick={() => void handleVerifyPostContainer()}
                      >
                        {domLoading ? "Verifying DOM..." : "Verify Post Container & Dynamic HTML"}
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              /* Fields Mode: Existing Variables list */
              <>
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
                    Image #1 — Manual Teaching Reference. Click OCR blocks on the screenshot to assign variables.
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
                          {isMapped && !isProposed && (
                            <span className="script-badge badge-active">Mapped</span>
                          )}
                          {isProposed && (
                            <span className="script-badge badge-draft">Proposed</span>
                          )}
                          {mapping?.presence === "not_present" && (
                            <span className="script-badge">Not Present</span>
                          )}
                          {!isMapped && mapping?.presence !== "not_present" && (
                            <span className="script-badge" style={{ opacity: 0.6 }}>Unmapped</span>
                          )}
                          {isTeaching && (
                            <button type="button" disabled={locked} onClick={() => removeVariable(variable.id)}>
                              Remove
                            </button>
                          )}
                        </div>

                        {/* Mapped Value preview */}
                        {isMapped && (
                          <div className="collector-compact-var-text" style={{ borderColor: isProposed ? "#c9a227" : "#2b394a" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <b style={{ fontSize: "11px", color: isProposed ? "#e0b35a" : "#68d6a6" }}>
                                {isProposed ? "Suggested Value:" : "Mapped Value:"}
                              </b>
                              {mapping?.confidence != null && (
                                <small style={{ color: "#7f93ab" }}>
                                  {mapping.confidence}% match
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
                          <div className="collector-compact-var-unmapped">
                            <small style={{ color: "#7f93ab" }}>
                              {mapping?.presence === "not_present" ? "Marked Not Present" : "Not mapped"}
                            </small>
                            {selectedSegment && (
                              <button
                                type="button"
                                disabled={locked}
                                onClick={() => handleAssignSegment(selectedSegment, variable.id)}
                                title={`Assign "${selectedSegment.text}" to ${variable.label}`}
                              >
                                Map Selected {groupingLevel.toUpperCase()}
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
                              </>
                            )}
                            <div className="collector-map-controls">
                              <label>
                                Map from OCR {groupingLevel.toUpperCase()}
                                <select
                                  disabled={locked}
                                  value={mapping?.segmentId ?? ""}
                                  onChange={(e) => {
                                    const seg = activeSegments.find((s) => s.id === e.target.value);
                                    if (seg) {
                                      handleAssignSegment(seg, variable.id);
                                    } else {
                                      onChange(unmapVariableForCapture(draft, active.id, variable.id));
                                    }
                                  }}
                                >
                                  <option value="">— Select recognized text ({groupingLevel}) —</option>
                                  {activeSegments.map((s) => (
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
              </>
            )}

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
