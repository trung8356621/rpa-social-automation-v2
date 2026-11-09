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
  setGroupPrimaryVariable,
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
  resolveRegionCropBox,
  assignSegmentMapping,
  getMappedVariablesForSegment,
  getMappingConfigState,
  getGroupTagSuggestions,
  proposeRegionQuickFill,
  confirmQuickFillMapping,
  rejectQuickFillMapping,
  getLearnedCandidateVariablesForGroup,
} from "../../shared/collectors/regions";
import { GroupTagCombobox } from "./GroupTagCombobox";
import type {
  CaptureAuditStatus,
  CollectorDraft,
  CollectorExtractionMethod,
  CollectorRegion,
  CollectorRegionRole,
  CollectorRegionType,
  CollectorVariable,
  CollectorVariableMapping,
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

// Module-level in-memory cache for loaded capture screenshot assets (bounded to 50 items)
const assetDataUrlCache = new Map<string, string>();
const MAX_ASSET_CACHE_ENTRIES = 50;

export function getCachedAssetUrl(assetName: string): string | undefined {
  return assetDataUrlCache.get(assetName);
}

export function setCachedAssetUrl(assetName: string, url: string): void {
  if (assetDataUrlCache.size >= MAX_ASSET_CACHE_ENTRIES) {
    const firstKey = assetDataUrlCache.keys().next().value;
    if (firstKey) assetDataUrlCache.delete(firstKey);
  }
  assetDataUrlCache.set(assetName, url);
}

export function clearAssetUrlCache(): void {
  assetDataUrlCache.clear();
}

type AssetLoadStatus = "IDLE" | "LOADING" | "READY" | "FAILED";

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
  const [assetStatus, setAssetStatus] = useState<AssetLoadStatus>(() => {
    if (!active?.imageAsset) return "IDLE";
    return getCachedAssetUrl(active.imageAsset) ? "READY" : "IDLE";
  });
  const [realImageUrl, setRealImageUrl] = useState<string | undefined>(() => {
    if (!active?.imageAsset) return undefined;
    return getCachedAssetUrl(active.imageAsset);
  });
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [cropRecoveryError, setCropRecoveryError] = useState<string | null>(null);
  const [isRecoveringCrop, setIsRecoveringCrop] = useState(false);
  const loadSequenceRef = useRef<number>(0);
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
  const [ocrStatusFeedback, setOcrStatusFeedback] = useState<string | null>(null);
  const [groupingLevel, setGroupingLevel] = useState<OcrGroupingLevel>("block");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>();
  const [segmentSearch, setSegmentSearch] = useState("");
  const [assignTargetVarId, setAssignTargetVarId] = useState("");
  const [assignMethod, setAssignMethod] = useState<CollectorExtractionMethod>("OCR_TEXT");
  const [assignAttribute, setAssignAttribute] = useState<string>("href");
  const [newVarName, setNewVarName] = useState<string>("");
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
  const [learnedVarsNotice, setLearnedVarsNotice] = useState<string | null>(null);
  const [newRegionOcrText, setNewRegionOcrText] = useState("");

  // Edit mode drag/resize state
  const [resizingHandle, setResizingHandle] = useState<"nw" | "ne" | "sw" | "se" | null>(null);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; initialBox: Rect } | null>(null);

  // Safe region deletion confirmation state
  const [regionPendingDelete, setRegionPendingDelete] = useState<CollectorRegion | null>(null);
  const [showFullScreenshotModal, setShowFullScreenshotModal] = useState(false);

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

  const currentRegion = selectedRegion || activeRegions[0];

  const createGroupSuggestions = useMemo(() => {
    if (!active || newRegionType === "FREE") return [];
    return getGroupTagSuggestions(draft, active.id, newRegionType, newRegionGroupTag);
  }, [draft, active?.id, newRegionType, newRegionGroupTag]);

  const editGroupSuggestions = useMemo(() => {
    if (!active || !selectedRegion || selectedRegion.type === "FREE") return [];
    return getGroupTagSuggestions(
      draft,
      active.id,
      selectedRegion.type,
      selectedRegion.groupTag ?? "",
    );
  }, [draft, active?.id, selectedRegion?.type, selectedRegion?.groupTag]);

  const quickFillStatus = useMemo(() => {
    if (!currentRegion || !active) return { hasConfirmedReferences: false, confirmedRefCount: 0, pendingProposals: [], confirmedCount: 0 };
    const allRegions = [
      ...(draft.regions ?? []),
      ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
    ];
    const confirmedRefs = allRegions.filter((r) => {
      if (!r.confirmed || r.captureItemId === active.id) return false;
      if (r.type !== currentRegion.type) return false;
      if (r.type === "FREE") return true;
      return (r.groupTag || "default").trim() === (currentRegion.groupTag || "default").trim();
    });

    const regionMappings = draft.variables.flatMap((v) =>
      v.mappings
        .filter((m) => m.sampleId === active.id && m.regionId === currentRegion.id)
        .map((m) => ({ variable: v, mapping: m })),
    );

    const pendingProposals = regionMappings.filter((item) => item.mapping.simulatedProposal || !item.mapping.confirmed);
    const confirmedCount = regionMappings.filter((item) => item.mapping.confirmed && !item.mapping.simulatedProposal).length;

    return {
      hasConfirmedReferences: confirmedRefs.length > 0,
      confirmedRefCount: confirmedRefs.length,
      pendingProposals,
      confirmedCount,
    };
  }, [currentRegion, active, draft.regions, draft.captures, draft.variables]);

  const handleApplyRegionQuickFill = useCallback(() => {
    if (!currentRegion || !active) return;
    const res = proposeRegionQuickFill(draft, currentRegion.id, imageDims.width, imageDims.height);
    if (res.appliedCount > 0) {
      onChange(res.draft);
    }
  }, [currentRegion, active, draft, imageDims.width, imageDims.height, onChange]);

  const runRegionOcr = useCallback(
    async (force = false, targetRegionId?: string) => {
      const regId = targetRegionId || selectedRegionId || activeRegions[0]?.id;
      const targetReg = activeRegions.find((r) => r.id === regId);
      if (!targetReg || !active || ocrLoading) return;
      if (targetReg.ocr && !force) return;

      if (!targetReg.referenceImage) {
        setOcrError("Cannot run OCR: reference crop image is unavailable for this region.");
        setOcrStatusFeedback("OCR failed — Cannot run OCR: reference crop image is unavailable for this region.");
        return;
      }

      setOcrLoading(true);
      setOcrError(undefined);
      setOcrStatusFeedback("Running OCR...");

      const cropBoxResult = resolveRegionCropBox(targetReg, imageDims.width, imageDims.height);
      const roi = targetReg.originalRoi || cropBoxResult.box;

      console.log(`[Collector OCR] Running OCR for region: ${targetReg.id} (${targetReg.label})`, {
        regionId: targetReg.id,
        groupTag: targetReg.groupTag,
        roi,
        hasImageAsset: Boolean(active.imageAsset),
        isElectronCore: isElectronBrowserCoreAvailable(),
      });

      try {
        let result: OcrResult;
        if (active.imageAsset && invoke && isElectronBrowserCoreAvailable() && roi) {
          result = await collectorOcrAsset(invoke, active.imageAsset, roi);
          // Coordinates from ocrTarget with crop are offset by cropOffset (or roi.x and roi.y).
          // Convert to crop-local coordinates for overlay rendering:
          const offsetX = result.cropOffset?.x ?? roi.x;
          const offsetY = result.cropOffset?.y ?? roi.y;
          result = {
            ...result,
            containerCrop: result.containerCrop ?? { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
            cropOffset: { x: offsetX, y: offsetY },
            segments: result.segments.map((seg) => ({
              ...seg,
              bbox: {
                ...seg.bbox,
                x: seg.bbox.x >= offsetX ? seg.bbox.x - offsetX : seg.bbox.x,
                y: seg.bbox.y >= offsetY ? seg.bbox.y - offsetY : seg.bbox.y,
              },
            })),
          };
          console.log(`[Collector OCR] IPC OCR completed: ${result.segments.length} segments found.`, {
            textSnippet: result.text.slice(0, 40),
            segmentCount: result.segments.length,
            confidence: result.confidence,
            coordinateSystem: "crop-local",
          });
        } else {
          const cropW = roi?.width || 300;
          const cropH = roi?.height || 60;
          const sampleText = targetReg.ocrEvidence?.text || targetReg.label;
          result = {
            text: sampleText,
            confidence: 92,
            language: "vie+eng",
            containerCrop: roi ? { x: roi.x, y: roi.y, width: roi.width, height: roi.height } : undefined,
            cropOffset: roi ? { x: roi.x, y: roi.y } : undefined,
            segments: [
              {
                id: `${targetReg.id}_seg_0`,
                text: sampleText,
                kind: "block",
                confidence: 94,
                bbox: { x: 5, y: 5, width: Math.max(20, cropW - 10), height: Math.max(15, cropH - 10) },
              },
            ],
          };
        }

        const count = result.segments.length;
        if (count > 0) {
          setOcrStatusFeedback(`OCR completed — ${count} segment${count === 1 ? "" : "s"}`);
        } else {
          setOcrStatusFeedback("No text detected");
        }

        const nextRegions = (draft.regions ?? []).map((r) =>
          r.id === targetReg.id
            ? {
                ...r,
                originalRoi: roi || r.originalRoi,
                ocr: result,
                ocrEvidence: {
                  text: result.text,
                  confidence: result.confidence,
                  segmentIds: result.segments.map((s) => s.id),
                },
                updatedAt: new Date().toISOString(),
              }
            : r,
        );

        onChange({
          ...draft,
          regions: nextRegions,
          dirty: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Collector OCR] OCR failed for region ${targetReg.id}:`, msg);
        setOcrError(msg);
        setOcrStatusFeedback(`OCR failed — ${msg}`);
      } finally {
        setOcrLoading(false);
      }
    },
    [active, activeRegions, draft, imageDims.height, imageDims.width, invoke, ocrLoading, onChange, selectedRegionId],
  );

  useEffect(() => {
    if (currentRegion?.ocr) {
      const count = currentRegion.ocr.segments.length;
      if (count > 0) {
        setOcrStatusFeedback(`OCR completed — ${count} segment${count === 1 ? "" : "s"}`);
      } else {
        setOcrStatusFeedback("No text detected");
      }
    } else {
      setOcrStatusFeedback(null);
    }
    setOcrError(undefined);
  }, [currentRegion?.id, currentRegion?.ocr]);

  useEffect(() => {
    if (!active || step2Stage !== "fields") return;
    const target = selectedRegion || activeRegions[0];
    if (target && target.referenceImage && !target.ocr) {
      void runRegionOcr(false, target.id);
    }
  }, [active?.id, step2Stage, selectedRegion?.id, selectedRegion?.ocr, selectedRegion?.referenceImage, activeRegions, runRegionOcr]);

  const activeSegments = useMemo(() => {
    const ocrSource = currentRegion?.ocr || active?.ocr;
    if (!ocrSource) return [];
    const cropBox = currentRegion ? resolveRegionCropBox(currentRegion, imageDims.width, imageDims.height).box : undefined;
    const w = currentRegion?.originalRoi?.width || cropBox?.width || imageDims.width;
    const h = currentRegion?.originalRoi?.height || cropBox?.height || imageDims.height;
    return getSegmentsByLevel(ocrSource, groupingLevel, w, h);
  }, [currentRegion, active?.ocr, groupingLevel, imageDims.width, imageDims.height]);

  function getMappedVariableForSegment(segment: OcrSegment) {
    if (!active) return undefined;
    const mapped = getMappedVariablesForSegment(
      draft.variables,
      active.id,
      segment.id,
      currentRegion?.id,
      segment.text,
    );
    return mapped[0]?.variable;
  }

  const selectedSegment = useMemo(() => {
    if (!selectedSegmentId) return undefined;
    return activeSegments.find((s) => s.id === selectedSegmentId);
  }, [activeSegments, selectedSegmentId]);

  function handleAssignSegment(
    segment: OcrSegment,
    varId: string,
    method: CollectorExtractionMethod = assignMethod,
    attributeName: string = assignAttribute,
  ) {
    if (!active || !varId) return;
    const cropBox = currentRegion ? resolveRegionCropBox(currentRegion, imageDims.width, imageDims.height).box : undefined;
    const roiX = currentRegion?.originalRoi?.x ?? cropBox?.x ?? 0;
    const roiY = currentRegion?.originalRoi?.y ?? cropBox?.y ?? 0;
    const screenshotBbox: Rect = {
      x: roiX + segment.bbox.x,
      y: roiY + segment.bbox.y,
      width: segment.bbox.width,
      height: segment.bbox.height,
    };

    const nextDraft = assignSegmentMapping(
      draft,
      active.id,
      varId,
      segment,
      currentRegion?.id,
      method,
      attributeName,
      screenshotBbox,
    );
    onChange(nextDraft);
  }

  function handleCreateVariableFromSegment(
    segment: OcrSegment,
    customName?: string,
    method: CollectorExtractionMethod = assignMethod,
    attributeName: string = assignAttribute,
  ) {
    if (!active) return;
    const rawKey = (customName || segment.text)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20);
    const key = rawKey || `var_${draft.variables.length + 1}`;
    const cleanAttr = method === "DOM_ATTRIBUTE" ? (attributeName?.trim() || "href") : undefined;
    const label =
      customName?.trim() ||
      (method === "DOM_ATTRIBUTE" ? `${key} (${cleanAttr})` : segment.text.slice(0, 30));
    const isOcr = method === "OCR_TEXT";

    const cropBox = currentRegion ? resolveRegionCropBox(currentRegion, imageDims.width, imageDims.height).box : undefined;
    const roiX = currentRegion?.originalRoi?.x ?? cropBox?.x ?? 0;
    const roiY = currentRegion?.originalRoi?.y ?? cropBox?.y ?? 0;
    const screenshotBbox: Rect = {
      x: roiX + segment.bbox.x,
      y: roiY + segment.bbox.y,
      width: segment.bbox.width,
      height: segment.bbox.height,
    };
    const newMapping: CollectorVariableMapping = {
      sampleId: active.id,
      regionId: currentRegion?.id,
      presence: "mapped",
      confirmed: true,
      method,
      attribute: cleanAttr,
      text: isOcr ? segment.text : undefined,
      confidence: isOcr ? segment.confidence : undefined,
      bbox: screenshotBbox,
      segmentId: segment.id,
      evidence: isOcr
        ? (isTeaching ? "Manual teaching assignment (Reference)" : "Manual user correction")
        : "Configured / Awaiting DOM Match",
    };
    const newVar: CollectorVariable = {
      id: cryptoRandomId(),
      key,
      label,
      valueType: isOcr && /^\d+$/.test(segment.text.trim()) ? "number" : "string",
      required: false,
      source: isOcr ? "ocr_image" : "visual_dom",
      expectedValue: isOcr ? segment.text : undefined,
      mappings: [newMapping],
    };
    let nextRegions = draft.regions;
    if (currentRegion) {
      nextRegions = (draft.regions ?? []).map((r) =>
        r.id === currentRegion.id
          ? {
              ...r,
              candidateVariableKeys: Array.from(new Set([...r.candidateVariableKeys, newVar.key])),
              updatedAt: new Date().toISOString(),
            }
          : r,
      );
    }
    onChange({
      ...draft,
      variables: [...draft.variables, newVar],
      regions: nextRegions,
      dirty: true,
    });
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

      // C2.11: Prioritize unpaired BEGIN missing END in current sample when creating END
      const unpairedInSample = activeRegions.find(
        (r) =>
          r.type === "BEGIN" &&
          !activeRegions.some((end) => end.type === "END" && (end.groupTag || "default") === (r.groupTag || "default")),
      );
      const isTop = y < imageDims.height * 0.45;
      const suggestedType: CollectorRegionType = unpairedInSample || !isTop ? "END" : "BEGIN";
      const defaultTag = (suggestedType === "END" && unpairedInSample?.groupTag) || "post-main";
      setNewRegionType(suggestedType);
      setNewRegionGroupTag(defaultTag);
      setNewRegionRole(suggestedType === "BEGIN" ? "header" : "footer");
      setNewRegionLabel(suggestedType === "BEGIN" ? `${defaultTag} Begin` : `${defaultTag} End`);
      const learned = getLearnedCandidateVariablesForGroup(draft, defaultTag, suggestedType, active?.id);
      if (learned.variableKeys.length > 0) {
        setNewRegionVars(learned.variableKeys);
        setLearnedVarsNotice(`Variables learned from ${learned.sampleCount} sample${learned.sampleCount > 1 ? "s" : ""}`);
      } else {
        setNewRegionVars([]);
        setLearnedVarsNotice(null);
      }
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
    let refImg: string | undefined;
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      refImg = cropRegionReference(imgEl, newRegionBox);
    }
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
    let refImg: string | undefined;
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      refImg = cropRegionReference(imgEl, box);
    }
    const updated = updateRegionInDraft(draft, regionId, {
      originalRoi: box,
      geometry: normalizeGeometry(box, imageDims.width, imageDims.height),
      ...(refImg ? { referenceImage: refImg } : {}),
      ocr: undefined,
      ocrEvidence: undefined,
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

  // C2.11.4: Free-form sample confirmation — no completeness blocking gates
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
      // Confirm whatever mapped variables exist for active.id without fabricating missing info
      const variables = nextDraft.variables.map((v) => {
        const mappings = v.mappings.map((m) => {
          if (m.sampleId === active.id && m.presence === "mapped") {
            return { ...m, confirmed: true, simulatedProposal: false };
          }
          return m;
        });
        return { ...v, mappings };
      });
      // Also confirm whatever regions exist for active.id
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
    onChange(result.draft);
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
    const seq = ++loadSequenceRef.current;
    const asset = active?.imageAsset;

    if (!asset) {
      setRealImageUrl(undefined);
      setAssetStatus("IDLE");
      setAssetLoading(false);
      setAssetError(null);
      return;
    }

    const cached = getCachedAssetUrl(asset);
    if (cached) {
      setRealImageUrl(cached);
      setAssetStatus("READY");
      setAssetLoading(false);
      setAssetError(null);
      return;
    }

    if (!invoke || !isElectronBrowserCoreAvailable()) {
      setRealImageUrl(undefined);
      setAssetStatus("FAILED");
      setAssetLoading(false);
      return;
    }

    setAssetStatus("LOADING");
    setAssetLoading(true);
    setAssetError(null);

    void collectorLoadImageAsset(invoke, asset)
      .then((url) => {
        if (loadSequenceRef.current === seq) {
          setCachedAssetUrl(asset, url);
          setRealImageUrl(url);
          setAssetStatus("READY");
          setAssetLoading(false);
        }
      })
      .catch((err) => {
        if (loadSequenceRef.current === seq) {
          setRealImageUrl(undefined);
          setAssetStatus("FAILED");
          setAssetLoading(false);
          setAssetError(err instanceof Error ? err.message : String(err));
        }
      });
  }, [active?.id, active?.imageAsset, invoke]);

  const previewSrcUrl = useMemo(() => {
    if (realCapture) return realImageUrl;
    const asset = active?.previewAssetId ?? mock?.previewAssetId;
    return asset ? previewSrc(asset) : undefined;
  }, [realCapture, realImageUrl, active?.previewAssetId, mock?.previewAssetId]);

  const recoverCrops = useCallback(async () => {
    if (!active || !previewSrcUrl || isRecoveringCrop) return;
    const missing = (draft.regions ?? []).filter(
      (r) => r.captureItemId === active.id && !r.referenceImage,
    );
    if (missing.length === 0) return;

    setIsRecoveringCrop(true);
    setCropRecoveryError(null);

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Asset loading failure: could not decode screenshot image."));
        i.src = previewSrcUrl;
      });

      const updatedRegions: CollectorRegion[] = [];
      let latestError: string | null = null;

      for (const region of missing) {
        const { box, error } = resolveRegionCropBox(region, img.naturalWidth, img.naturalHeight);
        if (error || !box) {
          latestError = error || "Invalid region bounds.";
          continue;
        }

        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(box.width));
          canvas.height = Math.max(1, Math.round(box.height));
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            latestError = "Crop generation failure: 2D canvas context unavailable.";
            continue;
          }
          ctx.drawImage(
            img,
            Math.round(box.x),
            Math.round(box.y),
            Math.round(box.width),
            Math.round(box.height),
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const dataUrl = canvas.toDataURL("image/png");
          updatedRegions.push({
            ...region,
            originalRoi: box,
            referenceImage: dataUrl,
            updatedAt: new Date().toISOString(),
          });
        } catch (cropErr) {
          latestError = `Crop generation failure: ${cropErr instanceof Error ? cropErr.message : String(cropErr)}`;
        }
      }

      if (updatedRegions.length > 0) {
        const updatedMap = new Map(updatedRegions.map((r) => [r.id, r]));
        const nextRegions = (draft.regions ?? []).map((r) => updatedMap.get(r.id) ?? r);
        const nextCaptures = (draft.captures ?? []).map((c) => {
          if (c.id !== active.id) return c;
          return {
            ...c,
            regions: (c.regions ?? []).map((r) => updatedMap.get(r.id) ?? r),
          };
        });
        onChange({
          ...draft,
          regions: nextRegions,
          captures: nextCaptures,
          dirty: true,
        });
      }

      if (latestError && updatedRegions.length === 0) {
        setCropRecoveryError(latestError);
      }
    } catch (err) {
      setCropRecoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRecoveringCrop(false);
    }
  }, [active, previewSrcUrl, isRecoveringCrop, draft, onChange]);

  useEffect(() => {
    if (active && previewSrcUrl) {
      const hasMissing = (draft.regions ?? []).some(
        (r) => r.captureItemId === active.id && !r.referenceImage,
      );
      if (hasMissing && !isRecoveringCrop) {
        void recoverCrops();
      }
    }
  }, [active?.id, previewSrcUrl, draft.regions, isRecoveringCrop, recoverCrops]);

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

              {/* STAGE 2B Toolbar: Region Selector + OCR Word/Line/Block + Search */}
              {step2Stage === "fields" && (
                <>
                  <button
                    type="button"
                    onClick={() => setStep2Stage("regions")}
                    title="Return to Region Teaching"
                  >
                    ← Back to Regions
                  </button>
                  {/* Region Selector Pills */}
                  <div className="collector-region-selector-bar" role="tablist" aria-label="Regions on capture">
                    <span className="collector-subheading" style={{ fontSize: "11px", color: "#7f93ab" }}>Region:</span>
                    {activeRegions.map((reg) => (
                      <button
                        key={reg.id}
                        type="button"
                        className={`collector-region-pill ${reg.type.toLowerCase()} ${(currentRegion?.id === reg.id) ? "active" : ""}`}
                        onClick={() => {
                          setSelectedRegionId(reg.id);
                          setSelectedSegmentId(undefined);
                        }}
                      >
                        <span className={`collector-region-tag ${reg.type.toLowerCase()}`}>{reg.type}</span>
                        {reg.groupTag && <span className="collector-group-badge">#{reg.groupTag}</span>}
                        <span>{reg.label}</span>
                        {reg.ocr ? <span style={{ color: "#68d6a6", marginLeft: "2px" }}>✓</span> : null}
                      </button>
                    ))}
                  </div>
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
                    placeholder="Search text on region..."
                    value={segmentSearch}
                    onChange={(e) => setSegmentSearch(e.target.value)}
                  />
                  <div style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => setShowFullScreenshotModal(true)}
                      title="View full original screenshot for reference"
                    >
                      🖼 Full Screenshot
                    </button>
                    {ocrStatusFeedback && (
                      <span
                        className={`collector-ocr-feedback-pill ${
                          ocrLoading
                            ? "loading"
                            : ocrError
                            ? "error"
                            : ocrStatusFeedback === "No text detected"
                            ? "empty"
                            : "success"
                        }`}
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: "4px",
                          color: ocrLoading
                            ? "#38bdf8"
                            : ocrError
                            ? "#f87171"
                            : ocrStatusFeedback === "No text detected"
                            ? "#fbbf24"
                            : "#34d399",
                          background: ocrLoading
                            ? "rgba(56, 189, 248, 0.12)"
                            : ocrError
                            ? "rgba(248, 113, 113, 0.12)"
                            : ocrStatusFeedback === "No text detected"
                            ? "rgba(251, 191, 36, 0.12)"
                            : "rgba(52, 211, 153, 0.12)",
                          border: `1px solid ${
                            ocrLoading
                              ? "rgba(56, 189, 248, 0.3)"
                              : ocrError
                              ? "rgba(248, 113, 113, 0.3)"
                              : ocrStatusFeedback === "No text detected"
                              ? "rgba(251, 191, 36, 0.3)"
                              : "rgba(52, 211, 153, 0.3)"
                          }`,
                        }}
                      >
                        {ocrStatusFeedback}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={locked || ocrLoading || !currentRegion || !currentRegion.referenceImage || isRecoveringCrop}
                      onClick={() => void runRegionOcr(true, currentRegion?.id)}
                      title={!currentRegion?.referenceImage ? "Reference crop must be available before running OCR" : (ocrStatusFeedback || "Re-run OCR for selected region")}
                    >
                      {ocrLoading ? "Running OCR..." : "Re-run Region OCR"}
                    </button>
                  </div>
                </>
              )}

              <span className="hint" style={{ fontSize: "11px", color: "#7f93ab", marginLeft: "auto" }}>Sample Data</span>
            </div>

            <div className="collector-review-image-frame">
              {step2Stage === "fields" ? (
                /* STAGE 2B — Region Crop Primary Workspace */
                <div className="collector-region-crop-workspace">
                  {activeRegions.length === 0 ? (
                    <div className="collector-sample-empty" style={{ padding: "40px 20px", textAlign: "center" }}>
                      <p style={{ color: "#e0b35a", fontWeight: "bold" }}>No anchor regions defined on this capture item.</p>
                      <p style={{ color: "#7f93ab", fontSize: "12px", marginBottom: "16px" }}>
                        Go back to Stage 2A (Region Teaching) to draw BEGIN, END, or FREE anchors first.
                      </p>
                      <button type="button" className="primary" onClick={() => setStep2Stage("regions")}>
                        ← Go to Stage 2A (Region Teaching)
                      </button>
                    </div>
                  ) : currentRegion ? (
                    <div className="collector-region-crop-card">
                      <div className="collector-region-crop-meta">
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                          <span className={`collector-region-tag ${currentRegion.type.toLowerCase()}`}>
                            {currentRegion.type}
                          </span>
                          {currentRegion.groupTag && (
                            <span className="collector-group-badge">#{currentRegion.groupTag}</span>
                          )}
                          <b style={{ color: "#e2e8f0" }}>{currentRegion.label}</b>
                          {currentRegion.originalRoi && (
                            <small style={{ color: "#7f93ab" }}>
                              [{currentRegion.originalRoi.width}×{currentRegion.originalRoi.height} at ({currentRegion.originalRoi.x}, {currentRegion.originalRoi.y})]
                            </small>
                          )}
                        </div>
                        <small style={{ color: "#68d6a6" }}>
                          Teaching Reference Crop (Primary OCR Workspace)
                        </small>
                      </div>

                      <div className="collector-region-crop-view-frame">
                        {currentRegion.referenceImage ? (
                          <div
                            className="collector-review-image-container region-crop-view"
                            style={{
                              position: "relative",
                              display: "inline-block",
                              maxWidth: "100%",
                              background: "#0f172a",
                              borderRadius: "4px",
                              overflow: "hidden",
                              border: "1px solid #2b394a",
                            }}
                          >
                            <img
                              src={currentRegion.referenceImage}
                              alt={`Crop for region ${currentRegion.label}`}
                              draggable={false}
                              style={{
                                display: "block",
                                maxWidth: "100%",
                                maxHeight: "440px",
                                height: "auto",
                                userSelect: "none",
                              }}
                            />

                            {/* STAGE 2B — OCR Field Mapping Overlay */}
                            {step2Stage === "fields" && (currentRegion?.ocr || active.ocr) && (
                              <div className="collector-ocr-overlay">
                                {activeSegments.map((s) => {
                                  const mappedVars = getMappedVariablesForSegment(
                                    draft.variables,
                                    active.id,
                                    s.id,
                                    currentRegion?.id,
                                    s.text,
                                  );
                                  const mappedVar = mappedVars[0]?.variable;
                                  const m = mappedVar?.mappings.find((entry) => entry.sampleId === active.id);
                                  const isProposed = Boolean(m?.simulatedProposal && !m?.confirmed);
                                  const isSelected = selectedSegmentId === s.id;
                                  const isMapped = mappedVars.length > 0;
                                  const isSearchMatch =
                                    !segmentSearch.trim() ||
                                    normalizeVietnameseText(s.text).includes(normalizeVietnameseText(segmentSearch.trim()));
                                  const resolvedBox = resolveRegionCropBox(currentRegion, imageDims.width, imageDims.height).box;
                                  const cropW = Math.max(1, currentRegion.originalRoi?.width || currentRegion.ocr?.containerCrop?.width || resolvedBox?.width || 300);
                                  const cropH = Math.max(1, currentRegion.originalRoi?.height || currentRegion.ocr?.containerCrop?.height || resolvedBox?.height || 60);
                                  const titleText = isMapped
                                    ? `${s.text} (${mappedVars.map((mv) => `${mv.variable.label} [${mv.mapping.method || "OCR_TEXT"}]`).join(", ")})`
                                    : `${s.text} (${Math.round(s.confidence)}%)`;
                                  return (
                                    <div
                                      key={s.id}
                                      className={`collector-ocr-box ${isSelected ? "selected" : ""} ${isMapped && !isProposed ? "mapped" : ""} ${isProposed ? "proposed" : ""} ${!isSearchMatch ? "dimmed" : ""}`}
                                      style={{
                                        position: "absolute",
                                        left: `${(s.bbox.x / cropW) * 100}%`,
                                        top: `${(s.bbox.y / cropH) * 100}%`,
                                        width: `${(s.bbox.width / cropW) * 100}%`,
                                        height: `${(s.bbox.height / cropH) * 100}%`,
                                      }}
                                      onClick={() => setSelectedSegmentId(s.id)}
                                      title={titleText}
                                    />
                                  );
                                })}
                              </div>
                            )}

                            {step2Stage === "fields" && currentRegion?.ocr && activeSegments.length === 0 && (
                              <div
                                className="collector-ocr-empty-notice"
                                style={{
                                  position: "absolute",
                                  bottom: "8px",
                                  left: "8px",
                                  right: "8px",
                                  padding: "6px 10px",
                                  background: "rgba(15, 23, 42, 0.9)",
                                  border: "1px dashed #e0b35a",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  color: "#fbbf24",
                                  textAlign: "center",
                                  zIndex: 10,
                                }}
                              >
                                ℹ️ No text detected in this region crop ({groupingLevel}).
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="collector-sample-empty collector-crop-recovery-box" style={{ padding: "30px 20px", textAlign: "center" }}>
                            <div style={{ color: assetError || cropRecoveryError ? "#f87171" : "#e0b35a", fontWeight: "bold", marginBottom: "8px" }}>
                              {assetError
                                ? "Asset loading failure"
                                : cropRecoveryError
                                ? "Reference Crop Recovery Failed"
                                : isRecoveringCrop || assetLoading
                                ? "Generating Reference Crop..."
                                : "Reference Crop Unavailable"}
                            </div>
                            <div style={{ color: "#94a3b8", fontSize: "12px", marginBottom: "14px", maxWidth: "420px", margin: "0 auto 14px auto" }}>
                              {assetError
                                ? `Could not load original screenshot asset: ${assetError}`
                                : cropRecoveryError
                                ? cropRecoveryError
                                : isRecoveringCrop
                                ? "Extracting region crop from capture screenshot..."
                                : assetLoading
                                ? "Loading original capture screenshot..."
                                : !active?.imageAsset && !active?.previewAssetId && !mock?.previewAssetId
                                ? "Original screenshot missing."
                                : !currentRegion?.originalRoi && (!currentRegion?.geometry || currentRegion.geometry.relW <= 0)
                                ? "Invalid region bounds."
                                : "No reference crop available for this region. Click below to regenerate."}
                            </div>
                            {previewSrcUrl && !isRecoveringCrop && (
                              <button
                                type="button"
                                className="primary small"
                                onClick={() => void recoverCrops()}
                              >
                                Regenerate Region Crop
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : previewSrcUrl ? (
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
                </div>
              ) : assetStatus === "LOADING" ? (
                <div className="collector-sample-empty collector-asset-loading">
                  <span style={{ marginRight: "8px" }}>⏳</span>
                  <span>Loading screenshot...</span>
                </div>
              ) : (
                <div className="collector-sample-empty">
                  {assetError ? `Failed to load capture screenshot: ${assetError}` : realCapture ? "Real image unavailable in this preview" : "No preview asset"}
                </div>
              )}
            </div>

            {/* STAGE 2A — Floating Region Editor (New Region Creation) */}
            {step2Stage === "regions" && newRegionBox && (
              <div className="collector-floating-anchor-editor">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <b>Define Region Anchor</b>
                    <small style={{ color: "#7f93ab" }}>
                      [{newRegionBox.width}×{newRegionBox.height} at x:{newRegionBox.x}, y:{newRegionBox.y}]
                    </small>
                  </div>
                  <button type="button" className="close-btn" onClick={() => setNewRegionBox(null)}>✕</button>
                </div>

                {/* Uniform Input Row: Type, Group Tag, Label */}
                <div className="collector-uniform-input-row">
                  <div className="collector-uniform-input-col type-col">
                    <label>Type:</label>
                    <select
                      value={newRegionType}
                      onChange={(e) => {
                        const t = e.target.value as CollectorRegionType;
                        setNewRegionType(t);
                        let targetTag = newRegionGroupTag;
                        if (t === "BEGIN") {
                          setNewRegionRole("header");
                          setNewRegionLabel(newRegionGroupTag ? `${newRegionGroupTag} Begin` : "Begin Anchor");
                        } else if (t === "END") {
                          setNewRegionRole("footer");
                          const unpaired = activeRegions.find(
                            (r) =>
                              r.type === "BEGIN" &&
                              !activeRegions.some((end) => end.type === "END" && (end.groupTag || "default") === (r.groupTag || "default")),
                          );
                          targetTag = unpaired?.groupTag || newRegionGroupTag || "post-main";
                          setNewRegionGroupTag(targetTag);
                          setNewRegionLabel(`${targetTag} End`);
                        } else {
                          setNewRegionRole("custom");
                          setNewRegionLabel("Free Region");
                        }
                        const learned = getLearnedCandidateVariablesForGroup(draft, targetTag, t, active?.id);
                        if (learned.variableKeys.length > 0) {
                          setNewRegionVars(learned.variableKeys);
                          setLearnedVarsNotice(`Variables learned from ${learned.sampleCount} sample${learned.sampleCount > 1 ? "s" : ""}`);
                        } else {
                          setNewRegionVars([]);
                          setLearnedVarsNotice(null);
                        }
                      }}
                    >
                      <option value="BEGIN">BEGIN ANCHOR</option>
                      <option value="END">END ANCHOR</option>
                      <option value="FREE">FREE REGION</option>
                    </select>
                  </div>

                  {newRegionType !== "FREE" && (
                    <div className="collector-uniform-input-col group-col">
                      <label>Group Tag:</label>
                      <GroupTagCombobox
                        value={newRegionGroupTag}
                        onChange={(tag) => {
                          setNewRegionGroupTag(tag);
                          if (newRegionType === "BEGIN") setNewRegionLabel(`${tag} Begin`);
                          if (newRegionType === "END") setNewRegionLabel(`${tag} End`);
                          const learned = getLearnedCandidateVariablesForGroup(draft, tag, newRegionType, active?.id);
                          if (learned.variableKeys.length > 0) {
                            setNewRegionVars(learned.variableKeys);
                            setLearnedVarsNotice(`Variables learned from ${learned.sampleCount} sample${learned.sampleCount > 1 ? "s" : ""}`);
                          } else {
                            setLearnedVarsNotice(null);
                          }
                        }}
                        suggestions={createGroupSuggestions}
                        placeholder="e.g. post-main"
                        dropdownPlacement="top"
                      />
                    </div>
                  )}

                  <div className="collector-uniform-input-col label-col">
                    <label>Label:</label>
                    <input
                      type="text"
                      value={newRegionLabel}
                      placeholder="e.g. Header Anchor"
                      onChange={(e) => setNewRegionLabel(e.target.value)}
                    />
                  </div>
                </div>

                {/* Candidate Variable Checkbox UI — Dedicated Scrollable Container */}
                {draft.variables.length > 0 && (
                  <div className="collector-var-section">
                    <div className="collector-var-section-header">
                      <span style={{ color: "#94a3b8", fontWeight: 600 }}>Candidate Variables:</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ color: "#f59e0b", fontSize: "11px", fontWeight: "bold" }}>★ Primary:</span>
                        <select
                          value={draft.primaryVariableKeysByGroup?.[(newRegionGroupTag || "default").trim()] || ""}
                          onChange={(e) => {
                            const val = e.target.value.trim() || undefined;
                            onChange(setGroupPrimaryVariable(draft, newRegionGroupTag || "default", val));
                          }}
                          style={{
                            background: "#0f172a",
                            color: draft.primaryVariableKeysByGroup?.[(newRegionGroupTag || "default").trim()] ? "#f59e0b" : "#94a3b8",
                            border: "1px solid #334155",
                            borderRadius: "3px",
                            padding: "2px 6px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          title="Select ONE Primary Variable for this Anchor Group to guide live matching"
                        >
                          <option value="">(None - infer signals)</option>
                          {draft.variables.map((v) => (
                            <option key={v.id} value={v.key}>
                              {v.label} ({v.key})
                            </option>
                          ))}
                        </select>
                      </div>
                      {learnedVarsNotice && (
                        <span style={{ color: "#38bdf8", fontWeight: "bold" }}>
                          ⚡ {learnedVarsNotice}
                        </span>
                      )}
                    </div>
                    <div className="collector-var-scroll-container">
                      <div className="collector-var-checkbox-grid">
                        {draft.variables.map((v) => {
                          const checked = newRegionVars.includes(v.key);
                          const isPrimary = draft.primaryVariableKeysByGroup?.[(newRegionGroupTag || "default").trim()] === v.key;
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
                                  setNewRegionVars((prev) =>
                                    checked ? prev.filter((k) => k !== v.key) : [...prev, v.key],
                                  );
                                  setLearnedVarsNotice(null);
                                }}
                              />
                              <span>{v.label}</span>
                              {isPrimary && (
                                <span
                                  style={{
                                    marginLeft: "4px",
                                    color: "#f59e0b",
                                    fontWeight: "bold",
                                    fontSize: "11px",
                                  }}
                                  title="Configured Primary Variable for this group"
                                >
                                  ★ Primary
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Footer Actions */}
                <div className="collector-floating-actions">
                  <button type="button" className="primary" onClick={handleSaveRegion}>
                    Save Region
                  </button>
                  <button type="button" onClick={() => setNewRegionBox(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2A — Selected Region Editor in Floating Panel */}
            {step2Stage === "regions" && !newRegionBox && selectedRegion && (
              <div className="collector-floating-anchor-editor">
                <div className="collector-dock-head">
                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
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

                {/* Uniform Input Row: Type, Group Tag, Label */}
                <div className="collector-uniform-input-row">
                  <div className="collector-uniform-input-col type-col">
                    <label>Type:</label>
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
                  </div>

                  {selectedRegion.type !== "FREE" && (
                    <div className="collector-uniform-input-col group-col">
                      <label>Group Tag:</label>
                      <GroupTagCombobox
                        value={selectedRegion.groupTag ?? ""}
                        onChange={(tag) =>
                          handleUpdateRegionProps(selectedRegion.id, {
                            groupTag: tag.trim() || undefined,
                          })
                        }
                        suggestions={editGroupSuggestions}
                        placeholder="e.g. post-main"
                        dropdownPlacement="top"
                      />
                    </div>
                  )}

                  <div className="collector-uniform-input-col label-col">
                    <label>Label:</label>
                    <input
                      type="text"
                      value={selectedRegion.label}
                      onChange={(e) =>
                        handleUpdateRegionProps(selectedRegion.id, { label: e.target.value })
                      }
                    />
                  </div>
                </div>

                {/* Candidate Variables Dedicated Scrollable Container */}
                {draft.variables.length > 0 && (
                  <div className="collector-var-section">
                    <div className="collector-var-section-header">
                      <span style={{ color: "#94a3b8", fontWeight: 600 }}>Candidate Variables:</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ color: "#f59e0b", fontSize: "11px", fontWeight: "bold" }}>★ Primary:</span>
                        <select
                          value={
                            draft.primaryVariableKeysByGroup?.[(selectedRegion.groupTag || "default").trim()] ||
                            selectedRegion.primaryVariableKey ||
                            ""
                          }
                          onChange={(e) => {
                            const val = e.target.value.trim() || undefined;
                            onChange(setGroupPrimaryVariable(draft, selectedRegion.groupTag || "default", val));
                          }}
                          style={{
                            background: "#0f172a",
                            color:
                              draft.primaryVariableKeysByGroup?.[(selectedRegion.groupTag || "default").trim()] ||
                              selectedRegion.primaryVariableKey
                                ? "#f59e0b"
                                : "#94a3b8",
                            border: "1px solid #334155",
                            borderRadius: "3px",
                            padding: "2px 6px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          title="Select ONE Primary Variable for this Anchor Group to guide live matching"
                        >
                          <option value="">(None - infer signals)</option>
                          {draft.variables.map((v) => (
                            <option key={v.id} value={v.key}>
                              {v.label} ({v.key})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="collector-var-scroll-container">
                      <div className="collector-var-checkbox-grid">
                        {draft.variables.map((v) => {
                          const checked = selectedRegion.candidateVariableKeys.includes(v.key);
                          const isPrimary =
                            (draft.primaryVariableKeysByGroup?.[(selectedRegion.groupTag || "default").trim()] ||
                              selectedRegion.primaryVariableKey) === v.key;
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
                              {isPrimary && (
                                <span
                                  style={{
                                    marginLeft: "4px",
                                    color: "#f59e0b",
                                    fontWeight: "bold",
                                    fontSize: "11px",
                                  }}
                                  title="Configured Primary Variable for this group"
                                >
                                  ★ Primary
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Reference Crop Preview (Compact, No Distortion) & Evidence */}
                {(selectedRegion.referenceImage || selectedRegion.evidence) && (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "2px", flexWrap: "wrap" }}>
                    {selectedRegion.referenceImage && (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <small style={{ color: "#7f93ab", fontSize: "11px", whiteSpace: "nowrap" }}>
                          Reference Crop:
                        </small>
                        <img
                          src={selectedRegion.referenceImage}
                          alt={`${selectedRegion.label} reference crop`}
                          style={{
                            maxHeight: "36px",
                            maxWidth: "160px",
                            objectFit: "contain",
                            borderRadius: "3px",
                            border: "1px solid #1e3a5f",
                            background: "#0b131e",
                            display: "block",
                          }}
                        />
                      </div>
                    )}
                    {selectedRegion.evidence && (
                      <span className="collector-evidence-badge" style={{ fontSize: "10px" }}>
                        Evidence: {selectedRegion.evidence}
                      </span>
                    )}
                  </div>
                )}

                {/* Footer Actions */}
                <div className="collector-floating-actions">
                  {!selectedRegion.confirmed && (
                    <button type="button" className="primary" onClick={() => handleConfirmRegion(selectedRegion.id)}>
                      Confirm Anchor
                    </button>
                  )}
                  <button type="button" onClick={() => setRegionPendingDelete(selectedRegion)}>
                    Delete Region
                  </button>
                  <button type="button" onClick={() => setSelectedRegionId(undefined)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2A — Floating Placeholder Hint */}
            {step2Stage === "regions" && !newRegionBox && !selectedRegion && (
              <div className="collector-dock-placeholder floating">
                <span>
                  Switch to <b>DRAW (✏️)</b> to drag an anchor rectangle, or click a region in <b>VIEW (🔍)</b> / <b>EDIT (📐)</b> mode.
                </span>
              </div>
            )}

            {/* STAGE 2B — Region Quick Fill & Docked Selected OCR Segment */}
            {step2Stage === "fields" && currentRegion && (
              <div className="collector-quick-fill-panel" style={{ marginBottom: "10px", padding: "8px", background: "#0b1320", border: "1px solid #1e3a5f", borderRadius: "4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <span style={{ fontSize: "12px", fontWeight: "bold", color: "#38bdf8" }}>⚡ Region Quick Fill</span>
                    <span className="collector-group-badge">
                      {currentRegion.type} {currentRegion.groupTag ? `#${currentRegion.groupTag}` : ""}
                    </span>
                  </div>
                  {quickFillStatus.hasConfirmedReferences && currentRegion.ocr && (
                    <button
                      type="button"
                      className="primary"
                      disabled={locked || ocrLoading}
                      onClick={handleApplyRegionQuickFill}
                      style={{ fontSize: "10px", padding: "2px 8px" }}
                      title={`Quick Fill variable mappings using confirmed ${currentRegion.type} #${currentRegion.groupTag || "default"} reference`}
                    >
                      ⚡ Quick Fill from Reference
                    </button>
                  )}
                </div>

                {quickFillStatus.hasConfirmedReferences ? (
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                    Found {quickFillStatus.confirmedRefCount} confirmed {currentRegion.type} reference(s) for group "{currentRegion.groupTag || "default"}".
                  </div>
                ) : (
                  <div style={{ fontSize: "11px", color: "#64748b", fontStyle: "italic" }}>
                    No confirmed {currentRegion.type} reference available yet for group "{currentRegion.groupTag || "default"}". Confirm Image #1 to enable Quick Fill.
                  </div>
                )}

                {/* Suggestions List */}
                {quickFillStatus.pendingProposals.length > 0 && (
                  <div style={{ marginTop: "8px", borderTop: "1px solid #1e293b", paddingTop: "6px" }}>
                    <div style={{ fontSize: "10px", fontWeight: "bold", color: "#facc15", marginBottom: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
                      <span>💡 Suggested Mappings ({quickFillStatus.pendingProposals.length})</span>
                      <small style={{ color: "#94a3b8", fontWeight: "normal" }}>Review and accept or correct:</small>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      {quickFillStatus.pendingProposals.map(({ variable, mapping }) => {
                        const method = mapping.method || "OCR_TEXT";
                        const isOcr = method === "OCR_TEXT";
                        return (
                          <div
                            key={`prop-${variable.id}-${method}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              background: "#172554",
                              border: "1px solid #1d4ed8",
                              borderRadius: "3px",
                              padding: "4px 8px",
                              fontSize: "11px",
                            }}
                          >
                            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                              <b style={{ color: "#93c5fd" }}>{variable.label}</b>
                              <code style={{ fontSize: "10px", color: "#bfdbfe" }}>({variable.key})</code>
                              <span style={{ fontSize: "9px", background: "#f59e0b", color: "#000", padding: "1px 4px", borderRadius: "2px", fontWeight: "bold" }}>
                                SUGGESTED
                              </span>
                              {mapping.confidence != null && (
                                <span style={{ fontSize: "10px", color: "#68d6a6" }}>
                                  {mapping.confidence}% confidence
                                </span>
                              )}
                              <span style={{ fontSize: "10px", color: "#94a3b8" }}>
                                [{method}{method === "DOM_ATTRIBUTE" ? `(${mapping.attribute || "href"})` : ""}]
                              </span>
                              {isOcr && mapping.text && (
                                <span style={{ fontStyle: "italic", color: "#e2e8f0" }}>"{mapping.text}"</span>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: "4px" }}>
                              <button
                                type="button"
                                disabled={locked}
                                style={{ fontSize: "10px", padding: "2px 6px", background: "#166534", color: "#bbf7d0", border: "1px solid #22c55e", borderRadius: "3px" }}
                                onClick={() => onChange(confirmQuickFillMapping(draft, active.id, variable.id, currentRegion.id))}
                                title="Accept and confirm this suggestion"
                              >
                                ✓ Accept
                              </button>
                              <button
                                type="button"
                                disabled={locked}
                                style={{ fontSize: "10px", padding: "2px 6px", background: "#7f1d1d", color: "#fecaca", border: "1px solid #ef4444", borderRadius: "3px" }}
                                onClick={() => onChange(rejectQuickFillMapping(draft, active.id, variable.id, currentRegion.id))}
                                title="Reject this suggestion"
                              >
                                ✕ Reject
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

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

                  {/* Existing Variable Mappings for this Segment (C2.10.3 Multi-Variable Mapping) */}
                  <div className="collector-segment-mappings-section">
                    <div style={{ fontSize: "11px", fontWeight: "bold", color: "#94a3b8", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Mapped Variables ({getMappedVariablesForSegment(draft.variables, active.id, selectedSegment.id, currentRegion?.id, selectedSegment.text).length}):</span>
                      <button
                        type="button"
                        style={{ fontSize: "10px", padding: "1px 6px" }}
                        onClick={() => void navigator.clipboard?.writeText(selectedSegment.text)}
                      >
                        Copy Text
                      </button>
                    </div>

                    {(() => {
                      const mappedList = getMappedVariablesForSegment(
                        draft.variables,
                        active.id,
                        selectedSegment.id,
                        currentRegion?.id,
                        selectedSegment.text,
                      );
                      if (mappedList.length === 0) {
                        return (
                          <div style={{ fontSize: "11px", color: "#64748b", fontStyle: "italic", padding: "2px 0" }}>
                            No variables mapped to this segment yet. Use the controls below to add a mapping.
                          </div>
                        );
                      }
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          {mappedList.map(({ variable, mapping }) => {
                            const method = mapping.method || "OCR_TEXT";
                            const isOcr = method === "OCR_TEXT";
                            return (
                              <div
                                key={`${variable.id}-${method}-${mapping.attribute || ""}`}
                                className="collector-segment-mapping-item"
                              >
                                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                  <b style={{ color: "#e2e8f0" }}>{variable.label}</b>
                                  <code style={{ fontSize: "10px", color: "#7f93ab" }}>({variable.key})</code>
                                  <span className={`script-badge ${isOcr ? "badge-active" : "badge-draft"}`} style={{ fontSize: "10px" }}>
                                    {method}{method === "DOM_ATTRIBUTE" ? `(${mapping.attribute || "href"})` : ""}
                                  </span>
                                  {isOcr ? (
                                    <small style={{ color: "#68d6a6" }}>Recognized</small>
                                  ) : (
                                    <small style={{ color: "#e0b35a" }}>Configured / Awaiting DOM Match</small>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  disabled={locked}
                                  style={{ fontSize: "10px", padding: "1px 6px", color: "#f87171" }}
                                  onClick={() => onChange(unmapVariableForCapture(draft, active.id, variable.id))}
                                  title={`Remove mapping for ${variable.label}`}
                                >
                                  ✕ Remove
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Add / Assign Mapping Controls */}
                  <div className="collector-dock-assign-row" style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "stretch" }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                      <select
                        disabled={locked}
                        value={assignTargetVarId}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAssignTargetVarId(val);
                          if (val === "__NEW__") {
                            setNewVarName(selectedSegment.text.slice(0, 30));
                          }
                        }}
                        style={{ flex: 1, minWidth: "140px", fontSize: "11px" }}
                      >
                        <option value="">— Select Target Variable —</option>
                        {draft.variables.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label} ({v.key})
                          </option>
                        ))}
                        {isTeaching && <option value="__NEW__">+ Create New Variable...</option>}
                      </select>

                      <select
                        disabled={locked}
                        value={assignMethod}
                        onChange={(e) => setAssignMethod(e.target.value as CollectorExtractionMethod)}
                        style={{ width: "130px", fontSize: "11px" }}
                        title="Extraction Method"
                      >
                        <option value="OCR_TEXT">OCR_TEXT</option>
                        <option value="DOM_TEXT">DOM_TEXT</option>
                        <option value="DOM_ATTRIBUTE">DOM_ATTRIBUTE</option>
                      </select>

                      {assignMethod === "DOM_ATTRIBUTE" && (
                        <input
                          type="text"
                          disabled={locked}
                          value={assignAttribute}
                          placeholder="e.g. href, src"
                          onChange={(e) => setAssignAttribute(e.target.value)}
                          style={{ width: "90px", fontSize: "11px", padding: "2px 6px" }}
                          title="Attribute Name"
                        />
                      )}

                      {assignTargetVarId !== "__NEW__" && (() => {
                        const targetVar = draft.variables.find((v) => v.id === assignTargetVarId);
                        const isAlreadyMapped = Boolean(
                          targetVar &&
                            targetVar.mappings.some(
                              (m) =>
                                m.sampleId === active.id &&
                                m.presence === "mapped" &&
                                m.segmentId === selectedSegment.id &&
                                (m.method || "OCR_TEXT") === assignMethod &&
                                (m.attribute || undefined) === (assignMethod === "DOM_ATTRIBUTE" ? (assignAttribute?.trim() || "href") : undefined),
                            ),
                        );
                        return (
                          <button
                            type="button"
                            className="primary"
                            disabled={locked || !assignTargetVarId || isAlreadyMapped}
                            onClick={() => {
                              if (assignTargetVarId) {
                                handleAssignSegment(selectedSegment, assignTargetVarId, assignMethod, assignAttribute);
                              }
                            }}
                            title={isAlreadyMapped ? "Variable already mapped with this method" : "Add or update mapping"}
                          >
                            {isAlreadyMapped ? "Already Mapped" : "Add Mapping"}
                          </button>
                        );
                      })()}
                    </div>

                    {assignTargetVarId === "__NEW__" && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", background: "#0b1320", padding: "6px", borderRadius: "4px", border: "1px dashed #2b394a" }}>
                        <input
                          type="text"
                          disabled={locked}
                          value={newVarName}
                          placeholder="Variable Name / Key (e.g. post_url)"
                          onChange={(e) => setNewVarName(e.target.value)}
                          style={{ flex: 1, fontSize: "11px", padding: "3px 6px" }}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="primary"
                          disabled={locked || !newVarName.trim()}
                          onClick={() => {
                            if (newVarName.trim()) {
                              handleCreateVariableFromSegment(selectedSegment, newVarName.trim(), assignMethod, assignAttribute);
                              setNewVarName("");
                              setAssignTargetVarId("");
                            }
                          }}
                        >
                          Create &amp; Map
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAssignTargetVarId("");
                            setNewVarName("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {isTeaching && assignTargetVarId !== "__NEW__" && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => handleCreateVariableFromSegment(selectedSegment, undefined, assignMethod, assignAttribute)}
                          style={{ fontSize: "11px" }}
                          title={`Create variable with ${assignMethod}`}
                        >
                          + Create Variable ({assignMethod})
                        </button>
                      </div>
                    )}
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
                    const method = mapping?.method || "OCR_TEXT";
                    const isOcr = method === "OCR_TEXT";
                    const configState = getMappingConfigState(mapping);
                    const isMapped = configState.isValid;
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
                            <span
                              className={`script-badge ${
                                isOcr
                                  ? "badge-active"
                                  : "badge-draft"
                              }`}
                              style={
                                !isOcr
                                  ? { backgroundColor: "#1e3a5f", color: "#93c5fd", border: "1px solid #2563eb" }
                                  : undefined
                              }
                            >
                              {configState.badgeLabel}
                            </span>
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
                              <b style={{ fontSize: "11px", color: isProposed ? "#e0b35a" : isOcr ? "#68d6a6" : "#93c5fd" }}>
                                {isProposed ? "Suggested Value:" : isOcr ? "Mapped OCR Text:" : "Configured Extraction:"}
                              </b>
                              {isOcr ? (
                                mapping?.confidence != null && (
                                  <small style={{ color: "#7f93ab" }}>
                                    {mapping.confidence}% match
                                  </small>
                                )
                              ) : (
                                <span
                                  className="script-badge"
                                  style={{ backgroundColor: "#1e3a5f", color: "#93c5fd", border: "1px solid #2563eb", fontSize: "10px" }}
                                >
                                  Awaiting browser match
                                </span>
                              )}
                            </div>
                            {isOcr ? (
                              <code style={{ fontSize: "11px", display: "block", margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                "{mapping?.text}"
                              </code>
                            ) : (
                              <div style={{ margin: "4px 0", fontSize: "11px", color: "#cbd5e1" }}>
                                <span>Method: <b>{method}</b></span>
                                {method === "DOM_ATTRIBUTE" && (
                                  <span style={{ marginLeft: "4px" }}>
                                    (attribute: <code>{mapping?.attribute || "href"}</code>)
                                  </span>
                                )}
                                <div style={{ fontSize: "10px", color: "#93c5fd", marginTop: "2px" }}>
                                  ℹ Configured · Awaiting live browser match test
                                </div>
                              </div>
                            )}
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
                                onClick={() => handleAssignSegment(selectedSegment, variable.id, assignMethod, assignAttribute)}
                                title={`Assign "${selectedSegment.text}" to ${variable.label} via ${assignMethod}`}
                              >
                                Map Selected {groupingLevel.toUpperCase()} ({assignMethod})
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

      {/* Full Screenshot Reference Modal */}
      {showFullScreenshotModal && previewSrcUrl && (
        <div
          className="collector-modal-backdrop"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.75)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
          onClick={() => setShowFullScreenshotModal(false)}
        >
          <div
            style={{
              background: "#1e293b",
              border: "1px solid #334155",
              borderRadius: "8px",
              padding: "16px",
              maxWidth: "90vw",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ color: "#e2e8f0" }}>Full Original Screenshot Reference</b>
              <button type="button" onClick={() => setShowFullScreenshotModal(false)}>✕ Close</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <img
                src={previewSrcUrl}
                alt="Full original screenshot reference"
                style={{ maxWidth: "100%", height: "auto", display: "block", borderRadius: "4px" }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
