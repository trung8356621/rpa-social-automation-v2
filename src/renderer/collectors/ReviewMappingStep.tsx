import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  denormalizeGeometry,
  normalizeGeometry,
  verifyAnchorGroups,
  normalizeCollectorRegions,
} from "../../shared/collectors/regions";
import type {
  CaptureAuditStatus,
  CollectorDraft,
  CollectorRegion,
  CollectorRegionRole,
  CollectorRegionType,
  CollectorVariable,
  LayoutContextKind,
} from "../../shared/collectors/types";
import { isRealCapture } from "../../shared/collectors/types";
import type { OcrResult, OcrSegment, Rect } from "../../shared/contracts";
import {
  collectorLoadImageAsset,
  collectorOcrAsset,
  isElectronBrowserCoreAvailable,
  type CollectorInvoke,
} from "./browser-capture";
import { UiPopover } from "../ui-popover";

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

function cropRegionReference(imgElement: HTMLImageElement | null, box: Rect): string | undefined {
  if (!imgElement || box.width <= 0 || box.height <= 0) return undefined;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width);
    canvas.height = Math.round(box.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(
      imgElement,
      Math.round(box.x),
      Math.round(box.y),
      Math.round(box.width),
      Math.round(box.height),
      0,
      0,
      Math.round(box.width),
      Math.round(box.height),
    );
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
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

  // C2.8.1 — Sequential Step 2 Stages: 2A (Region Teaching) -> 2B (Field Mapping)
  const [step2Stage, setStep2Stage] = useState<"regions" | "fields">("regions");
  // FEED_ITEM / POST_DETAIL is frozen: maintained in data/state but UI selector is hidden
  const [layoutContext] = useState<LayoutContextKind>(draft.layoutContext || "FEED_ITEM");

  // C2.8.1 — Region Teaching explicit interaction modes: VIEW | DRAW | EDIT
  const [regionInteractionMode, setRegionInteractionMode] = useState<"view" | "draw" | "edit">("view");
  const [selectedRegionId, setSelectedRegionId] = useState<string>();

  // Pointer drag drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [creationError, setCreationError] = useState<string>();

  // Region editor dock state
  const [newRegionBox, setNewRegionBox] = useState<Rect | null>(null);
  const [newRegionType, setNewRegionType] = useState<CollectorRegionType>("BEGIN");
  const [newRegionGroupTag, setNewRegionGroupTag] = useState<string>("post-main");
  const [newRegionRole, setNewRegionRole] = useState<CollectorRegionRole>("header");
  const [newRegionLabel, setNewRegionLabel] = useState("");
  const [newRegionVars, setNewRegionVars] = useState<string[]>([]);
  const [newRegionOcrText, setNewRegionOcrText] = useState("");

  // Edit mode drag/resize state
  const [resizingHandle, setResizingHandle] = useState<"nw" | "ne" | "sw" | "se" | null>(null);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; initialBox: Rect } | null>(null);

  // Safe region deletion confirmation state
  const [regionPendingDelete, setRegionPendingDelete] = useState<CollectorRegion | null>(null);

  const imageContainerRef = useRef<HTMLDivElement>(null);

  const excludedItems = useMemo(
    () => captures.filter((c) => auditForCapture(draft, c.id).status === "excluded"),
    [captures, draft],
  );

  useEffect(() => {
    if (!activeId) return;
    if (draft.activeReviewCaptureId === activeId) return;
    onChange({ ...draft, activeReviewCaptureId: activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, captures.length]);

  const schemaStale = Boolean(
    audit?.status === "confirmed" &&
      audit.schemaRevisionAtConfirm != null &&
      audit.schemaRevisionAtConfirm < (draft.schemaRevision ?? 1),
  );

  function selectCapture(id: string) {
    setCompletionNote(undefined);
    setConfirmError(undefined);
    setCreationError(undefined);
    setExcludeOpen(false);
    setSelectedSegmentId(undefined);
    setSelectedRegionId(undefined);
    setNewRegionBox(null);
    setIsDrawing(false);
    setDrawStart(null);
    setDrawCurrent(null);
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



  const activeRegions = useMemo(() => {
    if (!active) return [];
    return regionsForCapture(draft, active.id);
  }, [draft, active?.id]);

  const selectedRegion = useMemo(() => {
    if (!selectedRegionId) return undefined;
    return activeRegions.find((r) => r.id === selectedRegionId);
  }, [activeRegions, selectedRegionId]);

  const groupAnalysis = useMemo(() => {
    return verifyAnchorGroups(activeRegions);
  }, [activeRegions]);

  const deletionWarning = useMemo(() => {
    if (!regionPendingDelete) return null;
    const tag = regionPendingDelete.groupTag || "default";
    if (regionPendingDelete.type === "BEGIN") {
      const hasOtherBegin = activeRegions.some(
        (r) => r.id !== regionPendingDelete.id && r.type === "BEGIN" && (r.groupTag || "default") === tag,
      );
      if (!hasOtherBegin) {
        return `Deleting this anchor will leave group "${tag}" without a BEGIN anchor reference.`;
      }
    } else if (regionPendingDelete.type === "END") {
      const hasOtherEnd = activeRegions.some(
        (r) => r.id !== regionPendingDelete.id && r.type === "END" && (r.groupTag || "default") === tag,
      );
      if (!hasOtherEnd) {
        return `Deleting this anchor will leave group "${tag}" without an END anchor reference.`;
      }
    }
    return null;
  }, [regionPendingDelete, activeRegions]);

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
            text: "Dạ em đang học CNTT và muốn hỏi về lộ trình...\n29 bình luận\n40 lượt thích",
            confidence: 91,
            language: "vie+eng",
            segments: [
              { id: "0", text: "Dạ em đang học CNTT và muốn hỏi về lộ trình...", kind: "line", confidence: 94, bbox: { x: 50, y: 120, width: 600, height: 75 } },
              { id: "1", text: "29", kind: "word", confidence: 88, bbox: { x: 50, y: 220, width: 35, height: 20 } },
              { id: "2", text: "40", kind: "word", confidence: 87, bbox: { x: 110, y: 220, width: 35, height: 20 } },
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
    if (step2Stage === "fields" && !active.ocr) {
      void runOcr(false);
    }
  }, [active?.id, active?.ocr, step2Stage, runOcr]);

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

  // Pointer coordinate calculation helper
  function getCoordsFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return {
      x: Math.round(normX * imageDims.width),
      y: Math.round(normY * imageDims.height),
    };
  }

  // DRAW MODE: Pointer Drag handlers
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (step2Stage !== "regions" || locked) return;

    if (regionInteractionMode === "draw") {
      e.preventDefault();
      e.stopPropagation();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      const coords = getCoordsFromPointer(e);
      setIsDrawing(true);
      setDrawStart(coords);
      setDrawCurrent(coords);
      setNewRegionBox(null);
      setCreationError(undefined);
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (step2Stage !== "regions" || locked) return;

    if (isDrawing && drawStart) {
      e.preventDefault();
      e.stopPropagation();
      const coords = getCoordsFromPointer(e);
      setDrawCurrent(coords);
    } else if (resizingHandle && resizeStart && selectedRegion) {
      e.preventDefault();
      e.stopPropagation();
      const coords = getCoordsFromPointer(e);
      const dx = coords.x - resizeStart.x;
      const dy = coords.y - resizeStart.y;
      const b = resizeStart.initialBox;
      let nextBox = { ...b };

      if (resizingHandle === "se") {
        nextBox.width = Math.max(10, b.width + dx);
        nextBox.height = Math.max(10, b.height + dy);
      } else if (resizingHandle === "sw") {
        const w = Math.max(10, b.width - dx);
        nextBox.x = b.x + (b.width - w);
        nextBox.width = w;
        nextBox.height = Math.max(10, b.height + dy);
      } else if (resizingHandle === "ne") {
        nextBox.width = Math.max(10, b.width + dx);
        const h = Math.max(10, b.height - dy);
        nextBox.y = b.y + (b.height - h);
        nextBox.height = h;
      } else if (resizingHandle === "nw") {
        const w = Math.max(10, b.width - dx);
        const h = Math.max(10, b.height - dy);
        nextBox.x = b.x + (b.width - w);
        nextBox.y = b.y + (b.height - h);
        nextBox.width = w;
        nextBox.height = h;
      }

      handleUpdateRegionGeometry(selectedRegion.id, nextBox);
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (step2Stage !== "regions") return;

    if (isDrawing && drawStart && drawCurrent) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setIsDrawing(false);

      const x = Math.round(Math.min(drawStart.x, drawCurrent.x));
      const y = Math.round(Math.min(drawStart.y, drawCurrent.y));
      const width = Math.round(Math.abs(drawCurrent.x - drawStart.x));
      const height = Math.round(Math.abs(drawCurrent.y - drawStart.y));

      setDrawStart(null);
      setDrawCurrent(null);

      // Validate dimensions: reject only tiny invalid gesture (< 8px) with clear feedback
      if (width < 8 || height < 8) {
        setCreationError("Region selection too small (< 8px). Drag a larger box on the screenshot to define an anchor.");
        setNewRegionBox(null);
        return;
      }

      // Valid region creation
      const box = { x, y, width, height };
      setNewRegionBox(box);
      setCreationError(undefined);

      const defaultTag = "post-main";
      const hasBegin = activeRegions.some((r) => r.type === "BEGIN" && (r.groupTag || "default") === defaultTag);
      const isTop = y < imageDims.height * 0.45;
      const suggestedType: CollectorRegionType = !hasBegin || isTop ? "BEGIN" : "END";
      setNewRegionType(suggestedType);
      setNewRegionGroupTag(defaultTag);
      setNewRegionRole(suggestedType === "BEGIN" ? "header" : "footer");
      setNewRegionLabel(suggestedType === "BEGIN" ? `${defaultTag} Begin` : `${defaultTag} End`);
      setNewRegionVars([]);
      setNewRegionOcrText("");
    } else {
      setIsDrawing(false);
      setDrawStart(null);
      setDrawCurrent(null);
    }

    if (resizingHandle) {
      setResizingHandle(null);
      setResizeStart(null);
    }
  }

  function handlePointerCancel() {
    setIsDrawing(false);
    setDrawStart(null);
    setDrawCurrent(null);
    setResizingHandle(null);
    setResizeStart(null);
  }

  function handleSaveRegion() {
    if (!active || !newRegionBox) return;
    const imgEl = imageContainerRef.current?.querySelector("img") as HTMLImageElement | null;
    const refImg = cropRegionReference(imgEl, newRegionBox);
    const region = createCollectorRegion({
      captureItemId: active.id,
      type: newRegionType,
      label: newRegionLabel.trim(),
      groupTag: newRegionType !== "FREE" ? newRegionGroupTag.trim() || "default" : undefined,
      role: newRegionRole,
      box: newRegionBox,
      imageWidth: imageDims.width,
      imageHeight: imageDims.height,
      candidateVariableKeys: newRegionVars,
      ocrText: newRegionOcrText || undefined,
      referenceImage: refImg,
    });
    onChange(addRegionToDraft(draft, region));
    setNewRegionBox(null);
    setSelectedRegionId(region.id);
    setRegionInteractionMode("view");
    setCreationError(undefined);
  }

  function handleUpdateRegionProps(regionId: string, patch: Partial<CollectorRegion>) {
    const updated = updateRegionInDraft(draft, regionId, patch);
    onChange(updated);
  }

  function handleUpdateRegionGeometry(regionId: string, box: Rect) {
    const imgEl = imageContainerRef.current?.querySelector("img") as HTMLImageElement | null;
    const refImg = cropRegionReference(imgEl, box);
    const updated = updateRegionInDraft(draft, regionId, {
      originalRoi: box,
      geometry: normalizeGeometry(box, imageDims.width, imageDims.height),
      ...(refImg ? { referenceImage: refImg } : {}),
    });
    onChange(updated);
  }

  function handleConfirmRegion(id: string) {
    onChange(confirmRegionInDraft(draft, id));
  }

  function handleDeleteRegion(id: string) {
    onChange(deleteRegionFromDraft(draft, id));
    if (selectedRegionId === id) setSelectedRegionId(undefined);
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

  // Audit Confirmation Gate
  function runAuditAction(action: "confirm" | "needs_attention" | "exclude") {
    if (!active) return;
    setConfirmError(undefined);

    // GATE: Region confirmation vs Capture Audit separation
    // Prevent falsely confirming capture whose required Region Teaching work is incomplete
    if (action === "confirm") {
      const activeStaticAnchors = activeRegions.filter(
        (r) => r.type === "BEGIN" || r.type === "END" || r.type === "STATIC" || r.type === "FREE",
      );
      if (isTeaching && activeStaticAnchors.length === 0) {
        setConfirmError(
          "Confirm blocked — Region Teaching incomplete. Define and verify at least one STATIC anchor before confirming audit.",
        );
        return;
      }
    }

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
      {/* Top Toolbar: Navigation & Sequential Stage Indicator */}
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

        {/* Sequential Stages: 2A Region Teaching ➔ 2B Field Mapping */}
        <div className="collector-stage-indicator" role="tablist" aria-label="Review stages">
          <button
            type="button"
            className={`collector-stage-pill ${step2Stage === "regions" ? "active" : ""}`}
            onClick={() => setStep2Stage("regions")}
          >
            <span className="stage-num">2A</span> Region Teaching
          </button>
          <span className="collector-stage-arrow">➔</span>
          <button
            type="button"
            className={`collector-stage-pill ${step2Stage === "fields" ? "active" : ""}`}
            onClick={() => setStep2Stage("fields")}
          >
            <span className="stage-num">2B</span> Field Mapping
          </button>
        </div>

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
      {creationError && (
        <p className="collector-banner warn" role="alert">{creationError}</p>
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
              {/* STAGE 2A Toolbar: Explicit VIEW / DRAW / EDIT Modes */}
              {step2Stage === "regions" && (
                <div className="collector-mode-toggle" role="group" aria-label="Region interaction mode">
                  <button
                    type="button"
                    className={regionInteractionMode === "view" ? "active" : ""}
                    onClick={() => {
                      setRegionInteractionMode("view");
                      setIsDrawing(false);
                      setDrawStart(null);
                      setDrawCurrent(null);
                      setCreationError(undefined);
                    }}
                    title="Normal navigation & scrolling"
                  >
                    🔍 VIEW
                  </button>
                  <button
                    type="button"
                    className={regionInteractionMode === "draw" ? "active" : ""}
                    onClick={() => {
                      setRegionInteractionMode("draw");
                      setSelectedRegionId(undefined);
                      setDrawStart(null);
                      setDrawCurrent(null);
                      setCreationError(undefined);
                    }}
                    title="Drag on screenshot to draw an anchor rectangle"
                  >
                    ✏️ DRAW
                  </button>
                  <button
                    type="button"
                    className={regionInteractionMode === "edit" ? "active" : ""}
                    disabled={activeRegions.length === 0}
                    onClick={() => {
                      setRegionInteractionMode("edit");
                      if (!selectedRegionId && activeRegions.length > 0) {
                        setSelectedRegionId(activeRegions[0].id);
                      }
                      setIsDrawing(false);
                      setDrawStart(null);
                      setDrawCurrent(null);
                      setCreationError(undefined);
                    }}
                    title="Move or resize selected region"
                  >
                    📐 EDIT
                  </button>
                </div>
              )}

              {/* STAGE 2B Toolbar: OCR Word/Line/Block + Search */}
              {step2Stage === "fields" && (
                <>
                  <button
                    type="button"
                    onClick={() => setStep2Stage("regions")}
                    title="Return to Region Teaching"
                  >
                    ← Back to Regions
                  </button>
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

              <span className="hint" style={{ fontSize: "11px", color: "#7f93ab", marginLeft: "auto" }}>Sample Data</span>
            </div>

            <div className="collector-review-image-frame">
              {previewSrcUrl ? (
                <div
                  ref={imageContainerRef}
                  className={`collector-review-image-container mode-${regionInteractionMode}`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  style={{
                    touchAction: regionInteractionMode === "draw" ? "none" : "auto",
                    userSelect: "none",
                  }}
                >
                  <img
                    src={previewSrcUrl}
                    alt={
                      realCapture
                        ? `Real capture #${activeIndex + 1}`
                        : `Capture #${activeIndex + 1} mock preview`
                    }
                    draggable={false}
                    style={{
                      userSelect: "none",
                      pointerEvents: "none",
                      display: "block",
                      width: "100%",
                      height: "auto",
                    }}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImageDims({
                        width: img.naturalWidth || active.roi?.width || 800,
                        height: img.naturalHeight || active.roi?.height || 600,
                      });
                    }}
                  />



                  {/* STAGE 2A — Regions Overlay */}
                  {step2Stage === "regions" && (
                    <div
                      className="collector-ocr-overlay"
                      style={{ pointerEvents: regionInteractionMode === "draw" && isDrawing ? "none" : "auto" }}
                    >
                      {/* Active defined regions */}
                      {activeRegions.map((r) => {
                        const isSelected = selectedRegionId === r.id;
                        const originalBox = denormalizeGeometry(r.geometry, imageDims.width, imageDims.height);
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
                              if (regionInteractionMode === "draw") return;
                              e.stopPropagation();
                              setSelectedRegionId(r.id);
                              setNewRegionBox(null);
                            }}
                            title={`${r.label} (${r.type} · ${r.role || "region"})`}
                          >
                            <span className={`collector-region-tag ${r.type.toLowerCase()}`}>
                              {r.type === "FREE" ? "FREE" : `${r.type}${r.groupTag ? ` · ${r.groupTag}` : ""}`}
                            </span>

                            {/* Resize handles in EDIT mode */}
                            {isSelected && regionInteractionMode === "edit" && (
                              <>
                                <div
                                  className="collector-resize-handle nw"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setResizingHandle("nw");
                                    const coords = getCoordsFromPointer(e);
                                    setResizeStart({ x: coords.x, y: coords.y, initialBox: originalBox });
                                  }}
                                />
                                <div
                                  className="collector-resize-handle ne"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setResizingHandle("ne");
                                    const coords = getCoordsFromPointer(e);
                                    setResizeStart({ x: coords.x, y: coords.y, initialBox: originalBox });
                                  }}
                                />
                                <div
                                  className="collector-resize-handle sw"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setResizingHandle("sw");
                                    const coords = getCoordsFromPointer(e);
                                    setResizeStart({ x: coords.x, y: coords.y, initialBox: originalBox });
                                  }}
                                />
                                <div
                                  className="collector-resize-handle se"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setResizingHandle("se");
                                    const coords = getCoordsFromPointer(e);
                                    setResizeStart({ x: coords.x, y: coords.y, initialBox: originalBox });
                                  }}
                                />
                              </>
                            )}
                          </div>
                        );
                      })}

                      {/* Live dragging rectangle */}
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

                      {/* Pending confirmed new region box */}
                      {!isDrawing && newRegionBox && (
                        <div
                          className={`collector-region-box ${newRegionType.toLowerCase()} selected`}
                          style={{
                            left: `${(newRegionBox.x / imageDims.width) * 100}%`,
                            top: `${(newRegionBox.y / imageDims.height) * 100}%`,
                            width: `${(newRegionBox.width / imageDims.width) * 100}%`,
                            height: `${(newRegionBox.height / imageDims.height) * 100}%`,
                          }}
                        >
                          <span className={`collector-region-tag ${newRegionType.toLowerCase()}`}>
                            NEW {newRegionType}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* STAGE 2B — OCR Field Mapping Overlay */}
                  {step2Stage === "fields" && active.ocr && (
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

            {/* STAGE 2A — Docked Region Editor (New Region Creation) */}
            {step2Stage === "regions" && newRegionBox && (
              <div className="collector-selected-segment-dock">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <b>Define Region Anchor</b>
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
                      onChange={(e) => {
                        const t = e.target.value as CollectorRegionType;
                        setNewRegionType(t);
                        if (t === "BEGIN") {
                          setNewRegionRole("header");
                          setNewRegionLabel(newRegionGroupTag ? `${newRegionGroupTag} Begin` : "Begin Anchor");
                        } else if (t === "END") {
                          setNewRegionRole("footer");
                          setNewRegionLabel(newRegionGroupTag ? `${newRegionGroupTag} End` : "End Anchor");
                        } else {
                          setNewRegionRole("custom");
                          setNewRegionLabel("Free Region");
                        }
                      }}
                    >
                      <option value="BEGIN">BEGIN ANCHOR</option>
                      <option value="END">END ANCHOR</option>
                      <option value="FREE">FREE REGION</option>
                    </select>
                  </label>
                  {newRegionType !== "FREE" && (
                    <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "11px" }}>
                      <b>Group Tag:</b>
                      <input
                        type="text"
                        value={newRegionGroupTag}
                        placeholder="e.g. post-main"
                        onChange={(e) => {
                          const tag = e.target.value;
                          setNewRegionGroupTag(tag);
                          if (newRegionType === "BEGIN") setNewRegionLabel(`${tag} Begin`);
                          if (newRegionType === "END") setNewRegionLabel(`${tag} End`);
                        }}
                        style={{ width: "110px", padding: "2px 6px", fontSize: "11px" }}
                      />
                    </label>
                  )}
                  <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "11px", flex: 1, minWidth: "150px" }}>
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

                {/* Candidate Variable Checkbox UI — Compact Responsive Grid */}
                {draft.variables.length > 0 && (
                  <div style={{ marginTop: "6px" }}>
                    <small style={{ color: "#7f93ab" }}>Candidate Variables:</small>
                    <div className="collector-var-checkbox-grid">
                      {draft.variables.map((v) => {
                        const checked = newRegionVars.includes(v.key);
                        return (
                          <label
                            key={v.id}
                            className={`collector-var-checkbox-item ${checked ? "checked" : ""}`}
                            title={`${v.label} (${v.key})`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setNewRegionVars((prev) =>
                                  checked ? prev.filter((k) => k !== v.key) : [...prev, v.key],
                                )
                              }
                            />
                            <span>{v.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                  <button type="button" className="primary" onClick={handleSaveRegion}>
                    Save Region
                  </button>
                  <button type="button" onClick={() => setNewRegionBox(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2A — Selected Region Editor in Dock (Requirement 2) */}
            {step2Stage === "regions" && !newRegionBox && selectedRegion && (
              <div className="collector-selected-segment-dock">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <span className={`script-badge ${selectedRegion.type === "BEGIN" ? "badge-active" : selectedRegion.type === "END" ? "badge-draft" : ""}`}>
                      {selectedRegion.type}
                    </span>
                    {selectedRegion.groupTag && (
                      <span className="collector-group-badge">
                        Group: {selectedRegion.groupTag}
                      </span>
                    )}
                    <b>{selectedRegion.label}</b>
                    <small style={{ color: "#7f93ab" }}>
                      [relX: {Math.round(selectedRegion.geometry.relX * 100)}%, relY: {Math.round(selectedRegion.geometry.relY * 100)}%]
                    </small>
                  </div>
                  <button type="button" className="close-btn" onClick={() => setSelectedRegionId(undefined)}>✕</button>
                </div>

                {/* Editable Properties Grid: Type, Group Tag, Label */}
                <div className="collector-region-edit-grid">
                  <div className="collector-region-edit-row">
                    <label>
                      <b>Type:</b>
                      <select
                        value={selectedRegion.type}
                        onChange={(e) => {
                          const nextType = e.target.value as CollectorRegionType;
                          handleUpdateRegionProps(selectedRegion.id, {
                            type: nextType,
                            groupTag: nextType === "FREE" ? undefined : (selectedRegion.groupTag || "post-main"),
                            role: nextType === "BEGIN" ? "header" : nextType === "END" ? "footer" : "custom",
                          });
                        }}
                      >
                        <option value="BEGIN">BEGIN ANCHOR</option>
                        <option value="END">END ANCHOR</option>
                        <option value="FREE">FREE REGION</option>
                        {selectedRegion.type === "STATIC" && <option value="STATIC">STATIC (Legacy)</option>}
                        {selectedRegion.type === "DYNAMIC" && <option value="DYNAMIC">DYNAMIC (Legacy)</option>}
                      </select>
                    </label>

                    {selectedRegion.type !== "FREE" && (
                      <label>
                        <b>Group Tag:</b>
                        <input
                          type="text"
                          value={selectedRegion.groupTag ?? ""}
                          placeholder="e.g. post-main"
                          onChange={(e) =>
                            handleUpdateRegionProps(selectedRegion.id, {
                              groupTag: e.target.value.trim() || undefined,
                            })
                          }
                          style={{ width: "110px", padding: "2px 6px", fontSize: "11px" }}
                        />
                      </label>
                    )}

                    <label style={{ flex: 1, minWidth: "150px" }}>
                      <b>Label:</b>
                      <input
                        type="text"
                        value={selectedRegion.label}
                        onChange={(e) =>
                          handleUpdateRegionProps(selectedRegion.id, { label: e.target.value })
                        }
                        style={{ flex: 1, padding: "2px 6px", fontSize: "11px" }}
                      />
                    </label>
                  </div>

                  {/* Candidate Variables Checkbox Grid (Requirement 3) */}
                  {draft.variables.length > 0 && (
                    <div>
                      <small style={{ color: "#7f93ab" }}>Candidate Variables:</small>
                      <div className="collector-var-checkbox-grid">
                        {draft.variables.map((v) => {
                          const checked = selectedRegion.candidateVariableKeys.includes(v.key);
                          return (
                            <label
                              key={v.id}
                              className={`collector-var-checkbox-item ${checked ? "checked" : ""}`}
                              title={`${v.label} (${v.key})`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const nextKeys = checked
                                    ? selectedRegion.candidateVariableKeys.filter((k) => k !== v.key)
                                    : [...selectedRegion.candidateVariableKeys, v.key];
                                  handleUpdateRegionProps(selectedRegion.id, {
                                    candidateVariableKeys: nextKeys,
                                  });
                                }}
                              />
                              <span>{v.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {selectedRegion.evidence && (
                    <span className="collector-evidence-badge">
                      Evidence: {selectedRegion.evidence}
                    </span>
                  )}
                  {selectedRegion.referenceImage && (
                    <div style={{ marginTop: "6px" }}>
                      <small style={{ color: "#7f93ab", display: "block", marginBottom: "2px" }}>
                        Anchor Reference Crop:
                      </small>
                      <img
                        src={selectedRegion.referenceImage}
                        alt={`${selectedRegion.label} reference crop`}
                        style={{
                          maxWidth: "180px",
                          maxHeight: "60px",
                          objectFit: "contain",
                          borderRadius: "3px",
                          border: "1px solid #1e3a5f",
                          background: "#0b131e",
                          display: "block",
                        }}
                      />
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                  {!selectedRegion.confirmed && (
                    <button type="button" className="primary" onClick={() => handleConfirmRegion(selectedRegion.id)}>
                      Confirm Anchor
                    </button>
                  )}
                  <button type="button" onClick={() => setRegionPendingDelete(selectedRegion)}>
                    Delete Region
                  </button>
                  <button type="button" onClick={() => setSelectedRegionId(undefined)}>
                    Deselect
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2A — Dock Placeholder */}
            {step2Stage === "regions" && !newRegionBox && !selectedRegion && (
              <div className="collector-dock-placeholder">
                <span>
                  Switch to <b>DRAW (✏️)</b> to drag an anchor rectangle on the screenshot, or select an existing region in <b>VIEW (🔍)</b> / <b>EDIT (📐)</b> mode.
                </span>
              </div>
            )}

            {/* STAGE 2B — Docked Selected OCR Segment */}
            {step2Stage === "fields" && (
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
                ? `Real Browser Core capture · screenshot + ${step2Stage === "regions" ? "DOM region bounds" : "OCR overlay"}`
                : `Mock preview · screenshot + ${step2Stage === "regions" ? "DOM region bounds" : "OCR overlay"}`}
            </small>
          </div>

          {/* Right Pane (~32%) */}
          <div className="collector-review-editor-pane" aria-label="Variables & Mappings">
            {/* STAGE 2A — Region Teaching Sidebar */}
            {step2Stage === "regions" ? (
              <>
                <div className="collector-mapping-toolbar">
                  <b>Region Teaching (2A)</b>
                  {!isTeaching && (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={handleApplyLearnedAnchors}
                      title="Apply confirmed anchors from teaching reference"
                    >
                      Apply Learned Anchors
                    </button>
                  )}
                </div>

                {isTeaching ? (
                  <p className="collector-banner ok" role="status">
                    Teaching Reference: Draw <b>BEGIN</b> and <b>END</b> anchors with matching group tags on the screenshot to discover the post container.
                  </p>
                ) : (
                  <p className="collector-banner" role="status">
                    Matching learned anchor groups across examples.
                  </p>
                )}

                {/* Section A: Defined Region List */}
                <div className="collector-variable-list" style={{ maxHeight: "250px" }}>
                  {activeRegions.length === 0 ? (
                    <div className="empty-tags-box" style={{ padding: "12px", textAlign: "center" }}>
                      No regions defined. Switch to DRAW (✏️) to draw an anchor on the screenshot.
                    </div>
                  ) : (
                    activeRegions.map((r) => {
                      const isSel = selectedRegionId === r.id;
                      return (
                        <div key={r.id} className={`collector-region-card ${r.type.toLowerCase()} ${isSel ? "selected" : ""}`}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                              <span className={`script-badge ${r.type === "BEGIN" ? "badge-active" : r.type === "END" ? "badge-draft" : ""}`}>
                                {r.type}
                              </span>
                              {r.groupTag && (
                                <span className="collector-group-badge">
                                  Group: {r.groupTag}
                                </span>
                              )}
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
                          {r.referenceImage && (
                            <div style={{ marginTop: "4px" }}>
                              <img
                                src={r.referenceImage}
                                alt={`${r.label} reference crop`}
                                style={{
                                  maxWidth: "140px",
                                  maxHeight: "40px",
                                  objectFit: "contain",
                                  borderRadius: "2px",
                                  border: "1px solid #1e293b",
                                  background: "#090d14",
                                  display: "block",
                                }}
                              />
                            </div>
                          )}
                          <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                            {!r.confirmed && (
                              <button type="button" className="primary" onClick={() => handleConfirmRegion(r.id)}>
                                Confirm Anchor
                              </button>
                            )}
                            {r.confirmed && (
                              <span className="script-badge badge-active">Confirmed</span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedRegionId(r.id);
                                setRegionInteractionMode("edit");
                              }}
                            >
                              Edit
                            </button>
                            <button type="button" onClick={() => setRegionPendingDelete(r)}>
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Section B: Anchor Group Status Summary */}
                {(() => {
                  const groupAnalysis = verifyAnchorGroups(activeRegions);
                  if (activeRegions.length === 0) return null;
                  return (
                    <div className="collector-group-summary">
                      <b>Anchor Groups ({groupAnalysis.groups.size}):</b>
                      {Array.from(groupAnalysis.groups.entries()).map(([tag, g]) => {
                        const isComplete = Boolean(g.begin && g.end && !g.error);
                        return (
                          <div key={tag} className="collector-group-summary-item">
                            <span>
                              <b>Group &quot;{tag}&quot;</b>: {g.begin ? "BEGIN ✓" : "BEGIN ✗"} · {g.end ? "END ✓" : "END ✗"}
                            </span>
                            <span className={`script-badge ${isComplete ? "badge-active" : "badge-draft"}`}>
                              {isComplete ? "Ready" : "Incomplete"}
                            </span>
                          </div>
                        );
                      })}
                      {groupAnalysis.freeRegions.length > 0 && (
                        <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                          FREE regions: {groupAnalysis.freeRegions.length} (independent)
                        </div>
                      )}
                      {groupAnalysis.errors.length > 0 && (
                        <div style={{ color: "#f87171", fontSize: "10px", marginTop: "2px" }}>
                          {groupAnalysis.errors[0]}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Sequential Stage Navigation */}
                <button
                  type="button"
                  className="primary"
                  style={{ width: "100%", marginTop: "10px" }}
                  disabled={locked}
                  onClick={() => setStep2Stage("fields")}
                  title="Advance to OCR Field Mapping"
                >
                  Continue to Field Mapping →
                </button>
              </>
            ) : (
              /* STAGE 2B — Field Mapping Sidebar */
              <>
                <div className="collector-mapping-toolbar">
                  <b>Field Mapping (2B)</b>
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
                    Teaching Reference: Click OCR blocks on screenshot to map to Variables.
                  </p>
                ) : (
                  <p className="collector-banner" role="status">
                    Rules learned from confirmed reference are applied. Confirm or correct exceptions.
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

            {/* Bottom Audit Bar: Confirm Audit, Mark Needs Attention, Exclude Item */}
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

      {/* Safe Region Deletion Confirmation Popover Modal */}
      {regionPendingDelete && (
        <UiPopover
          variant="modal"
          label="Delete Region Anchor"
          className="unsaved-confirm"
          close={() => setRegionPendingDelete(null)}
        >
          <div className="popover-heading">
            <b>Delete Region Anchor?</b>
            <button type="button" onClick={() => setRegionPendingDelete(null)}>×</button>
          </div>
          <div style={{ padding: "8px 0" }}>
            <p style={{ margin: "0 0 8px" }}>
              Are you sure you want to delete region <b>{regionPendingDelete.label}</b>?
            </p>
            <div style={{ fontSize: "12px", color: "#9fb3c8", display: "flex", gap: "6px", alignItems: "center", marginBottom: "8px" }}>
              <span className={`script-badge ${regionPendingDelete.type === "BEGIN" ? "badge-active" : regionPendingDelete.type === "END" ? "badge-draft" : ""}`}>
                {regionPendingDelete.type}
              </span>
              {regionPendingDelete.groupTag && (
                <span className="collector-group-badge">
                  Group: {regionPendingDelete.groupTag}
                </span>
              )}
            </div>
            {deletionWarning && (
              <div className="collector-banner warn" style={{ fontSize: "11px", margin: "6px 0" }}>
                <b>Warning:</b> {deletionWarning}
              </div>
            )}
          </div>
          <div className="popover-footer" style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              type="button"
              autoFocus
              onClick={() => setRegionPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              style={{ background: "#dc2626", borderColor: "#b91c1c" }}
              onClick={() => {
                handleDeleteRegion(regionPendingDelete.id);
                setRegionPendingDelete(null);
              }}
            >
              Delete Region
            </button>
          </div>
        </UiPopover>
      )}
    </div>
  );
}
