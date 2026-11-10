import React, { useState, useEffect, useMemo, useCallback } from "react";
import type {
  CollectorDraft,
  CollectorRegion,
  BeginLayoutInspectionReport,
  BeginGroupTemplateInspection,
  BeginSampleTemplateInspection,
  BeginBlockInspectionReport,
  BeginGroupBlockInspection,
  BeginSampleBlockInspection,
  BeginLayoutBlock,
} from "../../shared/collectors/types.js";
import {
  collectorInspectBeginTemplate,
  collectorInspectBeginBlockTemplate,
  type CollectorInvoke,
  isElectronBrowserCoreAvailable,
} from "./browser-capture.js";

function getBlockColor(type: string): string {
  switch (type) {
    case "image_avatar":
      return "#8b5cf6"; // Purple
    case "image_region":
      return "#ec4899"; // Pink
    case "primary_text":
      return "#0284c7"; // Sky blue
    case "secondary_text":
      return "#64748b"; // Slate gray
    case "action_menu":
      return "#f59e0b"; // Amber
    case "unknown":
      return "#94a3b8"; // Muted gray
    case "generic_block":
    default:
      return "#10b981"; // Emerald
  }
}

type LayoutTemplateReviewStepProps = {
  draft: CollectorDraft;
  invoke?: CollectorInvoke;
  onGoToStage?: (stage: "regions" | "fields") => void;
};

export function LayoutTemplateReviewStep({
  draft,
  invoke,
  onGoToStage,
}: LayoutTemplateReviewStepProps) {
  const [selectedGroupTag, setSelectedGroupTag] = useState<string>("default");
  const [selectedSampleIndex, setSelectedSampleIndex] = useState<number>(0);
  const [inspectionReport, setInspectionReport] =
    useState<BeginLayoutInspectionReport | null>(null);
  const [blockReport, setBlockReport] =
    useState<BeginBlockInspectionReport | null>(null);
  const [selectedVariantIndex, setSelectedVariantIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "all" | "original" | "edges" | "grid" | "aggregated" | "blocks"
  >("all");
  const [hoveredCell, setHoveredCell] = useState<{
    r: number;
    c: number;
    val: number;
    isVariance?: boolean;
    variance?: number;
  } | null>(null);

  // B3 V2 Inspection States
  const [b3v2ViewMode, setB3v2ViewMode] = useState<"overlay" | "raw" | "mask" | "split">("overlay");
  const [b3v2TemplateSource, setB3v2TemplateSource] = useState<"variant" | "sample">("variant");
  const [b3v2HoveredBlockId, setB3v2HoveredBlockId] = useState<string | null>(null);
  const [b3v2ShowDiagnostics, setB3v2ShowDiagnostics] = useState<boolean>(true);

  const captures = draft.captures ?? [];
  const captureAuditMap = useMemo(
    () =>
      new Map((draft.captureAudits ?? []).map((a) => [a.captureItemId, a.status])),
    [draft.captureAudits],
  );
  const teachingCaptureId = draft.teachingCaptureId;

  // Gather unique regions from draft.regions and capture.regions
  const confirmedBeginRegions = useMemo(() => {
    const regionMap = new Map<string, CollectorRegion>();
    for (const r of [
      ...(draft.regions ?? []),
      ...captures.flatMap((c) => c.regions ?? []),
    ]) {
      if (!r?.id) continue;
      const existing = regionMap.get(r.id);
      if (!existing || (!existing.referenceImage && r.referenceImage)) {
        regionMap.set(r.id, r);
      }
    }
    const unique = Array.from(regionMap.values());

    return unique.filter((r) => {
      const isBeginType =
        r.type === "BEGIN" ||
        (r.type === "STATIC" && r.role === "header") ||
        r.role === "header";
      const parentCap = captures.find((c) => c.id === r.captureItemId);
      const isConfirmedAudit = parentCap
        ? captureAuditMap.get(parentCap.id) === "confirmed"
        : false;
      const isTeaching = parentCap ? parentCap.id === teachingCaptureId : false;
      return isBeginType && Boolean(r.confirmed || isConfirmedAudit || isTeaching);
    });
  }, [draft.regions, captures, captureAuditMap, teachingCaptureId]);

  // Group confirmed BEGIN regions by Anchor Group tag
  const anchorGroups = useMemo(() => {
    const map = new Map<string, CollectorRegion[]>();
    for (const r of confirmedBeginRegions) {
      const tag = (r.groupTag || "default").trim();
      const list = map.get(tag) ?? [];
      list.push(r);
      map.set(tag, list);
    }
    return map;
  }, [confirmedBeginRegions]);

  const groupTags = useMemo(() => {
    const tags = Array.from(anchorGroups.keys());
    return tags.length > 0 ? tags : ["default"];
  }, [anchorGroups]);

  // Sync selectedGroupTag when available groups change
  useEffect(() => {
    if (!groupTags.includes(selectedGroupTag)) {
      setSelectedGroupTag(groupTags[0] ?? "default");
      setSelectedSampleIndex(0);
    }
  }, [groupTags, selectedGroupTag]);

  // Fetch actual B3 layout template data via IPC
  const fetchTemplateData = useCallback(async () => {
    if (!invoke || !isElectronBrowserCoreAvailable()) {
      return;
    }

    if (confirmedBeginRegions.length === 0) {
      setInspectionReport(null);
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const references = confirmedBeginRegions.map((r) => {
        const parentCap = captures.find((c) => c.id === r.captureItemId);
        return {
          sampleId: r.captureItemId,
          regionId: r.id,
          groupTag: r.groupTag,
          referenceImage: r.referenceImage,
          assetId: parentCap?.imageAsset || r.referenceImageAsset,
          captureId: r.captureItemId,
          originalRoi: r.originalRoi,
          geometry: r.geometry,
        };
      });

      const [report, bReport] = await Promise.all([
        collectorInspectBeginTemplate(invoke, references, selectedGroupTag),
        collectorInspectBeginBlockTemplate(invoke, references, selectedGroupTag),
      ]);
      setInspectionReport(report);
      setBlockReport(bReport);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to inspect B3 layout template: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }, [invoke, confirmedBeginRegions, captures, selectedGroupTag]);

  useEffect(() => {
    void fetchTemplateData();
  }, [fetchTemplateData]);

  const currentGroupData: BeginGroupTemplateInspection | undefined =
    inspectionReport?.groups[selectedGroupTag];

  const currentGroupBlockData: BeginGroupBlockInspection | undefined =
    blockReport?.groups[selectedGroupTag];

  const currentSamples = currentGroupData?.samples ?? [];
  const currentSample: BeginSampleTemplateInspection | undefined =
    currentSamples[selectedSampleIndex] ?? currentSamples[0];

  const currentBlockSamples = currentGroupBlockData?.samples ?? [];
  const currentBlockSample: BeginSampleBlockInspection | undefined =
    currentBlockSamples[selectedSampleIndex] ?? currentBlockSamples[0];

  const currentVariants = currentGroupBlockData?.variants ?? [];
  const currentVariant = currentVariants[selectedVariantIndex] ?? currentVariants[0];

  return (
    <div
      className="collector-review-workspace"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "8px 12px",
        background: "#090d14",
        minHeight: "520px",
      }}
    >
      {/* 1. Top Bar: Group Selector, Sample Switcher, View Toggles */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          background: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "4px",
          padding: "6px 10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "#38bdf8" }}>
              Anchor Group:
            </span>
            <select
              value={selectedGroupTag}
              onChange={(e) => {
                setSelectedGroupTag(e.target.value);
                setSelectedSampleIndex(0);
              }}
              style={{
                background: "#090d14",
                color: "#e2e8f0",
                border: "1px solid #334155",
                borderRadius: "3px",
                padding: "2px 8px",
                fontSize: "11px",
                fontWeight: 600,
              }}
            >
              {groupTags.map((gt) => {
                const count = anchorGroups.get(gt)?.length ?? 0;
                return (
                  <option key={gt} value={gt}>
                    {gt} ({count} sample{count === 1 ? "" : "s"})
                  </option>
                );
              })}
            </select>
          </div>

          {currentSamples.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ fontSize: "11px", color: "#7f93ab" }}>Samples:</span>
              {currentSamples.map((s, idx) => (
                <button
                  key={s.sampleId || `sample-${idx}`}
                  type="button"
                  onClick={() => setSelectedSampleIndex(idx)}
                  className={`small ${selectedSampleIndex === idx ? "primary" : ""}`}
                  style={{
                    padding: "2px 8px",
                    fontSize: "10px",
                    fontWeight: selectedSampleIndex === idx ? 700 : 500,
                    borderColor: selectedSampleIndex === idx ? "#06b6d4" : "#334155",
                    background: selectedSampleIndex === idx ? "#083344" : "#0f172a",
                    color: selectedSampleIndex === idx ? "#22d3ee" : "#94a3b8",
                  }}
                >
                  #{idx + 1} {s.sampleId.slice(0, 8)}
                  {s.rawDimensions.width > 0 ? ` (${s.rawDimensions.width}×${s.rawDimensions.height})` : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* View Mode Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {(["all", "original", "edges", "grid", "aggregated", "blocks"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setActiveTab(mode)}
              style={{
                fontSize: "10px",
                padding: "2px 6px",
                background:
                  activeTab === mode
                    ? mode === "blocks"
                      ? "#064e3b"
                      : "#1e293b"
                    : "transparent",
                color:
                  activeTab === mode
                    ? mode === "blocks"
                      ? "#34d399"
                      : "#38bdf8"
                    : "#64748b",
                border: "1px solid",
                borderColor:
                  activeTab === mode
                    ? mode === "blocks"
                      ? "#10b981"
                      : "#38bdf8"
                    : "#334155",
                borderRadius: "3px",
                textTransform: "capitalize",
                fontWeight: mode === "blocks" ? 700 : 500,
              }}
            >
              {mode === "all"
                ? "All Panels"
                : mode === "edges"
                  ? "Edge Map"
                  : mode === "grid"
                    ? "Density Grid"
                    : mode === "aggregated"
                      ? "Family Template"
                      : mode === "blocks"
                        ? "🧩 Block Layout (B3 V2)"
                        : "Original Crop"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void fetchTemplateData()}
            disabled={isLoading}
            title="Refresh B3 template inspection"
            style={{
              fontSize: "10px",
              padding: "2px 6px",
              background: "#090d14",
              border: "1px solid #334155",
              color: "#94a3b8",
              borderRadius: "3px",
            }}
          >
            {isLoading ? "Analyzing..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="collector-banner warn" style={{ margin: 0 }}>
          {errorMsg}
        </div>
      )}

      {/* Zero Confirmed BEGIN Samples State */}
      {confirmedBeginRegions.length === 0 && (
        <div
          style={{
            background: "#0f172a",
            border: "1px dashed #334155",
            borderRadius: "6px",
            padding: "32px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "24px", marginBottom: "8px" }}>📐</div>
          <h4 style={{ margin: "0 0 6px 0", color: "#e2e8f0" }}>
            No Confirmed BEGIN Regions
          </h4>
          <p style={{ margin: "0 0 14px 0", color: "#94a3b8", fontSize: "12px", maxWidth: "480px", marginInline: "auto" }}>
            B3 visual layout templates are learned from confirmed BEGIN region crops.
            Please go to <b>2A Region Teaching</b> to draw and confirm a post header BEGIN region.
          </p>
          {onGoToStage && (
            <button
              type="button"
              className="primary"
              onClick={() => onGoToStage("regions")}
              style={{ fontSize: "11px", padding: "4px 14px" }}
            >
              ➔ Go to 2A Region Teaching
            </button>
          )}
        </div>
      )}

      {/* 3-Panel Inspection Workspace */}
      {confirmedBeginRegions.length > 0 && currentGroupData && (
        activeTab === "blocks" ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "33% 37% 30%",
              gap: "10px",
              flex: 1,
              minHeight: "440px",
            }}
          >
            {/* PANEL 1: LEFT — Original Reference Crop & Segmented Regions */}
            <div
              style={{
                background: "#0b1220",
                border: "1px solid #1e293b",
                borderRadius: "4px",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                <b style={{ color: "#34d399", fontSize: "12px" }}>
                  1. Segmented Reference Regions
                </b>
                <div style={{ display: "flex", gap: "2px" }}>
                  {(["overlay", "raw", "mask", "split"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setB3v2ViewMode(mode)}
                      style={{
                        fontSize: "9px",
                        padding: "1px 5px",
                        background: b3v2ViewMode === mode ? "#064e3b" : "#0f172a",
                        border: "1px solid",
                        borderColor: b3v2ViewMode === mode ? "#10b981" : "#334155",
                        color: b3v2ViewMode === mode ? "#34d399" : "#94a3b8",
                        borderRadius: "2px",
                        fontWeight: b3v2ViewMode === mode ? 700 : 500,
                      }}
                    >
                      {mode === "overlay"
                        ? "Overlay"
                        : mode === "raw"
                          ? "Clean Crop"
                          : mode === "mask"
                            ? "Mask & Regions"
                            : "Compare"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fail-Safe Diagnostic Indicators */}
              {currentBlockSample?.diagnostics && (
                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: "8.5px",
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: "2px",
                      background: currentBlockSample.diagnostics.avatarFound ? "#064e3b" : "#78350f",
                      color: currentBlockSample.diagnostics.avatarFound ? "#6ee7b7" : "#fde68a",
                      border: `1px solid ${currentBlockSample.diagnostics.avatarFound ? "#059669" : "#d97706"}`,
                    }}
                  >
                    {currentBlockSample.diagnostics.avatarFound ? "✓ AVATAR_FOUND" : "⚠ AVATAR_NOT_FOUND"}
                  </span>
                  <span
                    style={{
                      fontSize: "8.5px",
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: "2px",
                      background: currentBlockSample.diagnostics.primaryTextFound ? "#064e3b" : "#78350f",
                      color: currentBlockSample.diagnostics.primaryTextFound ? "#6ee7b7" : "#fde68a",
                      border: `1px solid ${currentBlockSample.diagnostics.primaryTextFound ? "#059669" : "#d97706"}`,
                    }}
                  >
                    {currentBlockSample.diagnostics.primaryTextFound ? "✓ PRIMARY_TEXT_FOUND" : "⚠ PRIMARY_TEXT_NOT_FOUND"}
                  </span>
                  <span
                    style={{
                      fontSize: "8.5px",
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: "2px",
                      background: currentBlockSample.diagnostics.menuFound ? "#064e3b" : "#78350f",
                      color: currentBlockSample.diagnostics.menuFound ? "#6ee7b7" : "#fde68a",
                      border: `1px solid ${currentBlockSample.diagnostics.menuFound ? "#059669" : "#d97706"}`,
                    }}
                  >
                    {currentBlockSample.diagnostics.menuFound ? "✓ MENU_FOUND" : "⚠ MENU_NOT_FOUND"}
                  </span>
                  {currentBlockSample.diagnostics.statusSummary && (
                    <span style={{ fontSize: "8.5px", color: "#64748b", fontFamily: "monospace" }}>
                      ({currentBlockSample.diagnostics.statusSummary})
                    </span>
                  )}
                </div>
              )}

              {/* Image Preview Box with Strict Aspect-Ratio Sync */}
              {currentBlockSample?.originalCropDataUrl || currentBlockSample?.segmentedCropDataUrl ? (
                (() => {
                  const rawW = currentBlockSample.rawDimensions.width || 640;
                  const rawH = Math.max(1, currentBlockSample.rawDimensions.height || 64);
                  const sampleAR = Math.round((rawW / rawH) * 100) / 100;
                  const imgSrc =
                    b3v2ViewMode === "mask" && currentBlockSample.maskOverlayDataUrl
                      ? currentBlockSample.maskOverlayDataUrl
                      : currentBlockSample.originalCropDataUrl || currentBlockSample.segmentedCropDataUrl;

                  const renderImageBox = (withOverlay: boolean, label?: string, customSrc?: string) => (
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", width: "100%" }}>
                      {label && <span style={{ fontSize: "9px", color: "#64748b", fontWeight: 600 }}>{label}</span>}
                      <div
                        style={{
                          position: "relative",
                          width: "100%",
                          aspectRatio: `${sampleAR}`,
                          maxHeight: b3v2ViewMode === "split" ? "80px" : "130px",
                          background: "#030712",
                          border: "1px solid #334155",
                          borderRadius: "4px",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <img
                          src={customSrc || imgSrc}
                          alt="Original BEGIN Reference Crop"
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "fill",
                            display: "block",
                          }}
                        />
                        {withOverlay && (
                          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                            {currentBlockSample.blocks.map((b) => {
                              const color = getBlockColor(b.type);
                              const isHovered = b3v2HoveredBlockId === b.id;
                              const labelText =
                                b.type === "image_avatar"
                                  ? "AVATAR"
                                  : b.type === "primary_text"
                                    ? "AUTHOR"
                                    : b.type === "secondary_text"
                                      ? "TIMESTAMP"
                                      : b.type === "action_menu"
                                        ? "MENU"
                                        : "BLOCK";

                              return (
                                <div
                                  key={b.id}
                                  style={{
                                    position: "absolute",
                                    left: `${b.normalizedBounds.x * 100}%`,
                                    top: `${b.normalizedBounds.y * 100}%`,
                                    width: `${b.normalizedBounds.width * 100}%`,
                                    height: `${b.normalizedBounds.height * 100}%`,
                                    border: `${isHovered ? "3px" : "2px"} solid ${color}`,
                                    background: isHovered ? `${color}44` : `${color}25`,
                                    boxSizing: "border-box",
                                    borderRadius: "2px",
                                    boxShadow: isHovered ? `0 0 6px ${color}` : undefined,
                                  }}
                                >
                                  <span
                                    style={{
                                      position: "absolute",
                                      top: "-11px",
                                      left: "0",
                                      fontSize: "7.5px",
                                      fontWeight: 700,
                                      background: color,
                                      color: "#ffffff",
                                      padding: "0 2px",
                                      borderRadius: "1px",
                                      lineHeight: "10px",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {labelText}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );

                  return (
                    <div
                      style={{
                        background: "#030712",
                        border: "1px solid #334155",
                        borderRadius: "4px",
                        padding: "6px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      {b3v2ViewMode === "split" ? (
                        <>
                          {renderImageBox(false, "Original BEGIN Reference Crop (Clean)")}
                          {renderImageBox(true, "Synchronized Segmentation Overlay")}
                        </>
                      ) : b3v2ViewMode === "raw" ? (
                        renderImageBox(false)
                      ) : b3v2ViewMode === "mask" ? (
                        renderImageBox(false, "Intermediate Masking & Text Search Zone", currentBlockSample.maskOverlayDataUrl)
                      ) : (
                        renderImageBox(true)
                      )}
                      <div style={{ fontSize: "10px", color: "#64748b", display: "flex", justifyContent: "space-between" }}>
                        <span>
                          Crop: <b>{rawW}×{rawH} px</b>
                        </span>
                        <span>
                          Aspect Ratio: <b>{sampleAR}:1</b>
                        </span>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ color: "#94a3b8", fontSize: "11px", textAlign: "center", padding: "20px" }}>
                  {currentBlockSample?.error || "No reference preview available"}
                </div>
              )}

              {/* Detected Blocks in Sample */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minHeight: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <small style={{ color: "#94a3b8", fontWeight: 700 }}>
                    Detected Blocks ({currentBlockSample?.blocks.length ?? 0}):
                  </small>
                  <span style={{ fontSize: "9px", color: "#64748b" }}>Hover to highlight</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "3px", maxHeight: "170px", overflowY: "auto" }}>
                  {currentBlockSample?.blocks.map((b) => {
                    const isHovered = b3v2HoveredBlockId === b.id;
                    const color = getBlockColor(b.type);
                    return (
                      <div
                        key={b.id}
                        onMouseEnter={() => setB3v2HoveredBlockId(b.id)}
                        onMouseLeave={() => setB3v2HoveredBlockId(null)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          background: isHovered ? "#1e293b" : "#0f172a",
                          border: `1px solid ${isHovered ? color : "#334155"}`,
                          borderRadius: "3px",
                          padding: "3px 6px",
                          fontSize: "10px",
                          cursor: "pointer",
                          transition: "all 0.1s ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: color }} />
                          <span style={{ color, fontWeight: 700 }}>
                            {b.label || b.type}
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "1px" }}>
                          {b.rawBounds && (
                            <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: "9px" }}>
                              {b.rawBounds.x},{b.rawBounds.y} ({b.rawBounds.width}×{b.rawBounds.height}px)
                            </span>
                          )}
                          <span style={{ color: "#64748b", fontFamily: "monospace", fontSize: "8.5px" }}>
                            [{Math.round(b.normalizedBounds.x * 100)}%, {Math.round(b.normalizedBounds.y * 100)}%, {Math.round(b.normalizedBounds.width * 100)}%×{Math.round(b.normalizedBounds.height * 100)}%]
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* PANEL 2: CENTER — Abstract Block Template Preview */}
            <div
              style={{
                background: "#0b1220",
                border: "1px solid #1e293b",
                borderRadius: "4px",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                <b style={{ color: "#38bdf8", fontSize: "12px" }}>
                  2. Abstract Block Template (B3 V2)
                </b>
                <div style={{ display: "flex", gap: "2px" }}>
                  <button
                    type="button"
                    onClick={() => setB3v2TemplateSource("sample")}
                    style={{
                      fontSize: "9px",
                      padding: "1px 5px",
                      background: b3v2TemplateSource === "sample" ? "#083344" : "#0f172a",
                      border: "1px solid",
                      borderColor: b3v2TemplateSource === "sample" ? "#06b6d4" : "#334155",
                      color: b3v2TemplateSource === "sample" ? "#22d3ee" : "#94a3b8",
                      borderRadius: "2px",
                      fontWeight: b3v2TemplateSource === "sample" ? 700 : 500,
                    }}
                  >
                    Sample #{selectedSampleIndex + 1}
                  </button>
                  <button
                    type="button"
                    onClick={() => setB3v2TemplateSource("variant")}
                    style={{
                      fontSize: "9px",
                      padding: "1px 5px",
                      background: b3v2TemplateSource === "variant" ? "#083344" : "#0f172a",
                      border: "1px solid",
                      borderColor: b3v2TemplateSource === "variant" ? "#06b6d4" : "#334155",
                      color: b3v2TemplateSource === "variant" ? "#22d3ee" : "#94a3b8",
                      borderRadius: "2px",
                      fontWeight: b3v2TemplateSource === "variant" ? 700 : 500,
                    }}
                  >
                    Variant #{selectedVariantIndex + 1}
                  </button>
                </div>
              </div>

              {/* Canvas Preview of Abstract Blocks with True Aspect-Ratio */}
              {(() => {
                const isSample = b3v2TemplateSource === "sample";
                const activeBlocks = isSample
                  ? (currentBlockSample?.blocks ?? [])
                  : (currentVariant?.blocks ?? currentBlockSample?.blocks ?? []);

                const targetAR = isSample
                  ? (currentBlockSample ? currentBlockSample.rawDimensions.width / Math.max(1, currentBlockSample.rawDimensions.height) : 11.0)
                  : (currentVariant?.nominalAspectRatio || 11.0);

                const activeW = isSample
                  ? (currentBlockSample?.rawDimensions.width || 640)
                  : (currentVariant?.nominalDimensions.width || 640);
                const activeH = isSample
                  ? (currentBlockSample?.rawDimensions.height || 60)
                  : (currentVariant?.nominalDimensions.height || 60);

                return (
                  <div
                    style={{
                      background: "#030712",
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      padding: "8px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: `${Math.round(targetAR * 100) / 100}`,
                        maxHeight: "130px",
                        background: "#090d14",
                        border: "1px dashed #334155",
                        borderRadius: "4px",
                        overflow: "hidden",
                      }}
                    >
                      {activeBlocks.map((b) => {
                        const color = getBlockColor(b.type);
                        const isHovered = b3v2HoveredBlockId === b.id;
                        return (
                          <div
                            key={b.id}
                            title={`${b.label || b.type} (${Math.round(b.normalizedBounds.width * 100)}%×${Math.round(b.normalizedBounds.height * 100)}%)`}
                            style={{
                              position: "absolute",
                              left: `${b.normalizedBounds.x * 100}%`,
                              top: `${b.normalizedBounds.y * 100}%`,
                              width: `${b.normalizedBounds.width * 100}%`,
                              height: `${b.normalizedBounds.height * 100}%`,
                              background: isHovered ? `${color}66` : `${color}33`,
                              border: `${isHovered ? "3px" : "2px"} solid ${color}`,
                              borderRadius: b.type === "image_avatar" ? "4px" : "2px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "#ffffff",
                              fontSize: "8.5px",
                              fontWeight: 700,
                              boxSizing: "border-box",
                              pointerEvents: "none",
                              boxShadow: isHovered ? `0 0 8px ${color}` : undefined,
                            }}
                          >
                            {b.type === "image_avatar"
                              ? "AVATAR"
                              : b.type === "primary_text"
                                ? "TITLE"
                                : b.type === "secondary_text"
                                  ? "TIME"
                                  : b.type === "action_menu"
                                    ? "•••"
                                    : "BLOCK"}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: "10px", color: "#64748b", width: "100%", display: "flex", justifyContent: "space-between" }}>
                      <span>
                        Viewing: <b style={{ color: "#38bdf8" }}>{isSample ? `Sample #${selectedSampleIndex + 1}` : `Learned Variant #${selectedVariantIndex + 1}`}</b> ({activeW}×{activeH} px)
                      </span>
                      <span>
                        AR: <b>{Math.round(targetAR * 100) / 100}:1</b>
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Block Category Legend */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "10px", color: "#cbd5e1" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <span style={{ width: "8px", height: "8px", background: "#8b5cf6", borderRadius: "2px" }} />
                  Avatar Block
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <span style={{ width: "8px", height: "8px", background: "#0284c7", borderRadius: "2px" }} />
                  Primary Text (Title)
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <span style={{ width: "8px", height: "8px", background: "#64748b", borderRadius: "2px" }} />
                  Secondary Text (Time)
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                  <span style={{ width: "8px", height: "8px", background: "#f59e0b", borderRadius: "2px" }} />
                  Action Menu
                </span>
              </div>

              {/* Consistency & Requirement Note */}
              <div
                style={{
                  background: "#082f49",
                  border: "1px solid #0369a1",
                  borderRadius: "3px",
                  padding: "6px 8px",
                  fontSize: "10px",
                  color: "#bae6fd",
                }}
              >
                <b>Layout Invariance:</b> B3 V2 matches the <i>whole layout geometry</i>. Does not match character strokes or individual letter textures, eliminating false positives on body paragraphs and video controls.
              </div>
            </div>

            {/* PANEL 3: RIGHT — Multi-Sample Learned Variants & Geometry Diagnostics */}
            <div
              style={{
                background: "#0b1220",
                border: "1px solid #1e293b",
                borderRadius: "4px",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                overflowY: "auto",
                maxHeight: "560px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ color: "#fbbf24", fontSize: "12px" }}>
                  3. Learned Layout Variants
                </b>
                <span
                  style={{
                    background: "#78350f",
                    color: "#fde68a",
                    fontSize: "9px",
                    fontWeight: 700,
                    padding: "1px 5px",
                    borderRadius: "2px",
                  }}
                >
                  {currentVariants.length} VARIANT(S)
                </span>
              </div>

              {/* Variant Switcher if multiple */}
              {currentVariants.length > 1 && (
                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                  {currentVariants.map((v, vIdx) => (
                    <button
                      key={v.variantId}
                      type="button"
                      onClick={() => {
                        setSelectedVariantIndex(vIdx);
                        setB3v2TemplateSource("variant");
                      }}
                      style={{
                        fontSize: "10px",
                        padding: "2px 6px",
                        background: selectedVariantIndex === vIdx ? "#083344" : "#0f172a",
                        border: "1px solid",
                        borderColor: selectedVariantIndex === vIdx ? "#06b6d4" : "#334155",
                        color: selectedVariantIndex === vIdx ? "#22d3ee" : "#94a3b8",
                        borderRadius: "2px",
                        fontWeight: selectedVariantIndex === vIdx ? 700 : 500,
                      }}
                    >
                      Variant #{vIdx + 1} ({v.sampleCount} sample{v.sampleCount === 1 ? "" : "s"})
                    </button>
                  ))}
                </div>
              )}

              {/* Variant Diagnostics Card */}
              {currentVariant && (
                <div
                  style={{
                    background: "#081325",
                    border: "1px solid #1e293b",
                    borderRadius: "3px",
                    padding: "6px 8px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    color: "#cbd5e1",
                    fontSize: "10px",
                  }}
                >
                  <b style={{ color: "#38bdf8" }}>VARIANT: {currentVariant.variantId}</b>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Contributing Samples:</span>
                    <b>{currentVariant.sampleCount}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Nominal Dimensions:</span>
                    <b>{currentVariant.nominalDimensions.width} × {currentVariant.nominalDimensions.height} px</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Aspect Ratio:</span>
                    <b>{currentVariant.nominalAspectRatio}:1</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Total Blocks:</span>
                    <b>{currentVariant.blocks.length}</b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Required Blocks:</span>
                    <b style={{ color: "#34d399" }}>
                      {currentVariant.blocks.filter((b) => b.required).length} / {currentVariant.blocks.length}
                    </b>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Consistency Score:</span>
                    <b>{Math.round(currentVariant.consistencyScore * 100)}%</b>
                  </div>
                </div>
              )}

              {/* SECTION 4: Geometry & Input Preprocessing Diagnostics */}
              <div
                style={{
                  background: "#081325",
                  border: "1px solid #334155",
                  borderRadius: "3px",
                  padding: "6px 8px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "5px",
                  fontSize: "9.5px",
                  color: "#94a3b8",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <b style={{ color: "#a5b4fc" }}>📐 Geometry & Preprocessing Audit</b>
                  <button
                    type="button"
                    onClick={() => setB3v2ShowDiagnostics((prev) => !prev)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#64748b",
                      fontSize: "9px",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {b3v2ShowDiagnostics ? "Hide ▲" : "Show ▼"}
                  </button>
                </div>

                {b3v2ShowDiagnostics && currentBlockSample && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Original Crop:</span>
                      <b style={{ color: "#e2e8f0" }}>
                        {currentBlockSample.rawDimensions.width} × {currentBlockSample.rawDimensions.height} px ({currentBlockSample.aspectRatio}:1)
                      </b>
                    </div>
                    {currentBlockSample.processingDimensions && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Working / Preproc:</span>
                        <b style={{ color: "#e2e8f0" }}>
                          {currentBlockSample.processingDimensions.width} × {currentBlockSample.processingDimensions.height} px ({currentBlockSample.processingAspectRatio}:1)
                        </b>
                      </div>
                    )}
                    {currentBlockSample.scaleFactors && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Scale (Proc / Raw):</span>
                        <b style={{ color: "#f59e0b" }}>
                          X: {currentBlockSample.scaleFactors.scaleX} | Y: {currentBlockSample.scaleFactors.scaleY}
                        </b>
                      </div>
                    )}
                    {currentBlockSample.diagnostics && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px", borderTop: "1px dashed #334155", paddingTop: "3px", marginTop: "2px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>Segmentation Status:</span>
                          <b style={{ color: currentBlockSample.diagnostics.avatarFound ? "#34d399" : "#fbbf24" }}>
                            {currentBlockSample.diagnostics.statusSummary || "n/a"}
                          </b>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>Edges / Components:</span>
                          <span>
                            {currentBlockSample.diagnostics.edgePixelCount ?? 0} px | {currentBlockSample.diagnostics.rawComponentCount ?? 0} raw &rarr; {currentBlockSample.diagnostics.filteredComponentCount ?? 0} blocks
                          </span>
                        </div>
                        {currentBlockSample.diagnostics.intermediateBounds?.textZone && (
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>Unmasked Text Zone:</span>
                            <span style={{ fontFamily: "monospace", color: "#38bdf8" }}>
                              x={currentBlockSample.diagnostics.intermediateBounds.textZone.x}, w={currentBlockSample.diagnostics.intermediateBounds.textZone.width} px
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Block Coordinates Table */}
                    <div style={{ marginTop: "4px", borderTop: "1px solid #1e293b", paddingTop: "4px" }}>
                      <span style={{ color: "#cbd5e1", fontWeight: 600 }}>Sample #{selectedSampleIndex + 1} Blocks Audit:</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px" }}>
                        {currentBlockSample.blocks.map((b) => (
                          <div
                            key={b.id}
                            style={{
                              background: "#030712",
                              padding: "2px 4px",
                              borderRadius: "2px",
                              display: "flex",
                              justifyContent: "space-between",
                              fontFamily: "monospace",
                              fontSize: "8.5px",
                              borderLeft: `2px solid ${getBlockColor(b.type)}`,
                            }}
                          >
                            <span style={{ color: getBlockColor(b.type) }}>{b.type.replace("image_", "").replace("_text", "")}</span>
                            <span style={{ color: "#e2e8f0" }}>
                              {b.rawBounds ? `${b.rawBounds.x},${b.rawBounds.y} ${b.rawBounds.width}×${b.rawBounds.height}px` : "N/A"}
                            </span>
                            <span style={{ color: "#64748b" }}>
                              [{b.normalizedBounds.x.toFixed(2)},{b.normalizedBounds.y.toFixed(2)},{b.normalizedBounds.width.toFixed(2)}×{b.normalizedBounds.height.toFixed(2)}]
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Read-Only Notice */}
              <div
                style={{
                  marginTop: "auto",
                  fontSize: "9.5px",
                  color: "#64748b",
                  borderTop: "1px solid #1e293b",
                  paddingTop: "6px",
                }}
              >
                🔒 <b>Read-Only Preview:</b> Reflects the exact runtime B3 V2 abstract block extractor.
              </div>
            </div>
          </div>
        ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              activeTab === "all"
                ? "30% 42% 28%"
                : activeTab === "original"
                  ? "60% 0% 40%"
                  : activeTab === "aggregated"
                    ? "25% 45% 30%"
                    : "25% 50% 25%",
            gap: "10px",
            flex: 1,
            minHeight: "440px",
          }}
        >
          {/* PANEL 1: LEFT — Original Reference Crop */}
          {(activeTab === "all" || activeTab === "original" || activeTab === "aggregated") && (
            <div
              style={{
                background: "#0b1220",
                border: "1px solid #1e293b",
                borderRadius: "4px",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ color: "#38bdf8", fontSize: "12px" }}>
                  1. Original BEGIN Crop
                </b>
                <span
                  style={{
                    background: "#064e3b",
                    color: "#6ee7b7",
                    fontSize: "9px",
                    fontWeight: 700,
                    padding: "1px 5px",
                    borderRadius: "2px",
                  }}
                >
                  CONFIRMED
                </span>
              </div>

              {currentSample?.originalCropDataUrl ? (
                <div
                  style={{
                    background: "#030712",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    padding: "6px",
                    textAlign: "center",
                  }}
                >
                  <img
                    src={currentSample.originalCropDataUrl}
                    alt="Original Reference Crop"
                    style={{
                      maxWidth: "100%",
                      maxHeight: "120px",
                      objectFit: "contain",
                      borderRadius: "2px",
                      display: "block",
                      margin: "0 auto",
                    }}
                  />
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "10px",
                      color: "#94a3b8",
                      fontFamily: "monospace",
                    }}
                  >
                    Dimensions: {currentSample.rawDimensions.width} × {currentSample.rawDimensions.height} px
                    {currentSample.aspectRatio ? ` (AR: ${currentSample.aspectRatio}:1)` : ""}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: "#1e1b4b",
                    border: "1px solid #4338ca",
                    borderRadius: "4px",
                    padding: "12px",
                    color: "#c7d2fe",
                    fontSize: "11px",
                  }}
                >
                  ⚠️ <b>Reference Crop Image Unavailable</b>
                  <p style={{ margin: "4px 0 0 0", fontSize: "10px", color: "#a5b4fc" }}>
                    {currentSample?.error || "Image buffer could not be loaded from capture evidence."}
                  </p>
                </div>
              )}

              {/* Sample Meta Box */}
              <div
                style={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: "3px",
                  padding: "6px 8px",
                  fontSize: "10px",
                  color: "#94a3b8",
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                }}
              >
                <div><b>Sample ID:</b> <code>{currentSample?.sampleId || "n/a"}</code></div>
                {currentSample?.regionId && (
                  <div><b>Region ID:</b> <code>{currentSample.regionId}</code></div>
                )}
                <div><b>Anchor Group:</b> <code style={{ color: "#38bdf8" }}>{selectedGroupTag}</code></div>
                <div><b>Samples in Group:</b> {currentGroupData.sampleCount}</div>
              </div>

              {/* Multi-sample preview thumbnails */}
              {currentSamples.length > 1 && (
                <div style={{ marginTop: "auto" }}>
                  <small style={{ color: "#64748b", fontSize: "10px", fontWeight: 600 }}>
                    Samples in Group ({currentSamples.length}):
                  </small>
                  <div style={{ display: "flex", gap: "6px", marginTop: "4px", overflowX: "auto", paddingBottom: "2px" }}>
                    {currentSamples.map((s, idx) => (
                      <div
                        key={s.sampleId || idx}
                        onClick={() => setSelectedSampleIndex(idx)}
                        style={{
                          border: selectedSampleIndex === idx ? "2px solid #06b6d4" : "1px solid #334155",
                          borderRadius: "2px",
                          padding: "2px",
                          cursor: "pointer",
                          background: "#030712",
                          opacity: selectedSampleIndex === idx ? 1 : 0.6,
                        }}
                        title={`Sample #${idx + 1}`}
                      >
                        {s.originalCropDataUrl ? (
                          <img
                            src={s.originalCropDataUrl}
                            alt={`Thumb #${idx + 1}`}
                            style={{ height: "26px", maxWidth: "70px", objectFit: "contain", display: "block" }}
                          />
                        ) : (
                          <div style={{ width: "40px", height: "26px", fontSize: "8px", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171" }}>
                            Missing
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PANEL 2: CENTER — Normalized / Edge / Density Grid Visualization */}
          {(activeTab === "all" || activeTab === "edges" || activeTab === "grid" || activeTab === "aggregated") && (
            <div
              style={{
                background: "#0b1220",
                border: "1px solid #1e293b",
                borderRadius: "4px",
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ color: "#22d3ee", fontSize: "12px" }}>
                  2. B3 Structural Fingerprint (Canonical 240 × 48 px)
                </b>
                <span style={{ fontSize: "10px", color: "#64748b" }}>
                  Algorithm: Sobel + 24×6 Grid
                </span>
              </div>

              {/* Normalized Reference & Edge Map */}
              {(activeTab === "all" || activeTab === "edges") && (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {/* Normalized Grayscale Frame */}
                  <div>
                    <div style={{ fontSize: "10px", color: "#94a3b8", marginBottom: "2px", display: "flex", justifyContent: "space-between" }}>
                      <span>A. Normalized Grayscale Reference (240 × 48 px):</span>
                      <span style={{ color: "#64748b" }}>Fit: Fill canonical frame</span>
                    </div>
                    {currentSample?.normalizedDataUrl ? (
                      <div style={{ background: "#000", border: "1px solid #334155", borderRadius: "3px", padding: "2px", textAlign: "center" }}>
                        <img
                          src={currentSample.normalizedDataUrl}
                          alt="Normalized 240x48 Frame"
                          style={{
                            width: "100%",
                            maxHeight: "48px",
                            objectFit: "fill",
                            display: "block",
                            imageRendering: "pixelated",
                          }}
                        />
                      </div>
                    ) : (
                      <div style={{ background: "#111827", padding: "6px", fontSize: "10px", color: "#6b7280" }}>
                        Normalized preview unavailable
                      </div>
                    )}
                  </div>

                  {/* Sobel Edge Gradient Map */}
                  <div>
                    <div style={{ fontSize: "10px", color: "#94a3b8", marginBottom: "2px", display: "flex", justifyContent: "space-between" }}>
                      <span>B. Sobel Edge Gradient Map (Canonical 240 × 48 px):</span>
                      <span style={{ color: "#06b6d4", fontWeight: 600 }}>Threshold: mag ≥ 26</span>
                    </div>
                    {currentSample?.edgesDataUrl ? (
                      <div
                        style={{
                          position: "relative",
                          background: "#000",
                          border: "1px solid #0891b2",
                          borderRadius: "3px",
                          padding: "2px",
                          textAlign: "center",
                        }}
                      >
                        <img
                          src={currentSample.edgesDataUrl}
                          alt="Sobel Edge Map"
                          style={{
                            width: "100%",
                            maxHeight: "56px",
                            objectFit: "fill",
                            display: "block",
                            imageRendering: "pixelated",
                          }}
                        />
                        {/* Landmark Feature Zone Badges Over Edge Map */}
                        <div
                          style={{
                            position: "absolute",
                            top: "4px",
                            left: "2%",
                            width: "13%",
                            height: "75%",
                            border: "1px solid #3b82f6",
                            background: "rgba(59, 130, 246, 0.15)",
                            borderRadius: "2px",
                            pointerEvents: "none",
                          }}
                          title="Avatar Zone"
                        />
                        <div
                          style={{
                            position: "absolute",
                            top: "4px",
                            left: "17%",
                            width: "65%",
                            height: "75%",
                            border: "1px solid #10b981",
                            background: "rgba(16, 185, 129, 0.15)",
                            borderRadius: "2px",
                            pointerEvents: "none",
                          }}
                          title="Dual-Band Text Zone"
                        />
                        <div
                          style={{
                            position: "absolute",
                            top: "4px",
                            left: "86%",
                            width: "12%",
                            height: "55%",
                            border: "1px solid #f59e0b",
                            background: "rgba(245, 158, 11, 0.15)",
                            borderRadius: "2px",
                            pointerEvents: "none",
                          }}
                          title="Action Menu Zone"
                        />
                      </div>
                    ) : (
                      <div style={{ background: "#111827", padding: "6px", fontSize: "10px", color: "#6b7280" }}>
                        Edge map unavailable
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* C. 24x6 Structural Density Grid Visualizer */}
              {(activeTab === "all" || activeTab === "grid") && currentSample?.grid && (
                <div style={{ marginTop: "4px" }}>
                  <div style={{ fontSize: "10px", color: "#94a3b8", marginBottom: "3px", display: "flex", justifyContent: "space-between" }}>
                    <span>C. Structural Density Grid (24 cols × 6 rows = 144 cells):</span>
                    <span style={{ color: "#38bdf8", fontSize: "9px" }}>
                      {hoveredCell && !hoveredCell.isVariance
                        ? `Col ${hoveredCell.c}, Row ${hoveredCell.r}: ${Math.round(hoveredCell.val * 100)}% edge density`
                        : "Hover cell for exact value"}
                    </span>
                  </div>

                  {/* 24x6 Interactive Density Matrix */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(24, 1fr)",
                      gridTemplateRows: "repeat(6, 11px)",
                      gap: "1px",
                      background: "#020617",
                      padding: "3px",
                      border: "1px solid #1e293b",
                      borderRadius: "3px",
                    }}
                  >
                    {currentSample.grid.map((row, r) =>
                      row.map((val, c) => {
                        const intensity = Math.min(1.0, val * 2.2);
                        // Highlight landmark zones with tint
                        const isAvatar = c <= 3;
                        const isText = c >= 4 && c <= 19;
                        const isMenu = c >= 20;

                        return (
                          <div
                            key={`cell-${r}-${c}`}
                            onMouseEnter={() => setHoveredCell({ r, c, val })}
                            onMouseLeave={() => setHoveredCell(null)}
                            style={{
                              background:
                                val > 0.01
                                  ? isAvatar
                                    ? `rgba(59, 130, 246, ${Math.max(0.2, intensity)})`
                                    : isText
                                      ? `rgba(16, 185, 129, ${Math.max(0.2, intensity)})`
                                      : `rgba(245, 158, 11, ${Math.max(0.2, intensity)})`
                                  : "#090d16",
                              border:
                                hoveredCell?.r === r && hoveredCell?.c === c
                                  ? "1px solid #fff"
                                  : "1px solid rgba(255, 255, 255, 0.05)",
                              borderRadius: "1px",
                              cursor: "crosshair",
                            }}
                            title={`Col ${c}, Row ${r}: ${Math.round(val * 100)}% density (${isAvatar ? "Avatar" : isText ? "Text" : "Menu"})`}
                          />
                        );
                      }),
                    )}
                  </div>
                </div>
              )}

              {/* D. Multi-Sample Aggregated Template (Family Mean & Variance) */}
              {(activeTab === "all" || activeTab === "aggregated") && currentGroupData && (
                <div style={{ marginTop: "4px" }}>
                  <div style={{ fontSize: "10px", color: "#94a3b8", marginBottom: "3px", display: "flex", justifyContent: "space-between" }}>
                    <span>
                      D. Learned Template Family (Aggregated from {currentGroupData.sampleCount} sample{currentGroupData.sampleCount === 1 ? "" : "s"}):
                    </span>
                    <span style={{ color: "#fbbf24", fontSize: "9px" }}>
                      {hoveredCell?.isVariance
                        ? `Col ${hoveredCell.c}, Row ${hoveredCell.r}: Mean ${Math.round(hoveredCell.val * 100)}%, Var ${hoveredCell.variance?.toFixed(3)}`
                        : `${currentGroupData.dynamicLowWeightCellsCount} dynamic cell(s) downweighted`}
                    </span>
                  </div>

                  {/* 24x6 Mean Grid with Variance Overlay */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(24, 1fr)",
                      gridTemplateRows: "repeat(6, 11px)",
                      gap: "1px",
                      background: "#020617",
                      padding: "3px",
                      border: "1px solid #334155",
                      borderRadius: "3px",
                    }}
                  >
                    {currentGroupData.meanGrid.map((row, r) =>
                      row.map((val, c) => {
                        const variance = currentGroupData.varianceGrid[r]?.[c] ?? 0;
                        const isDynamic = variance > 0.04;
                        const intensity = Math.min(1.0, val * 2.2);

                        return (
                          <div
                            key={`fam-${r}-${c}`}
                            onMouseEnter={() =>
                              setHoveredCell({ r, c, val, isVariance: true, variance })
                            }
                            onMouseLeave={() => setHoveredCell(null)}
                            style={{
                              background: isDynamic
                                ? `rgba(234, 179, 8, ${Math.max(0.3, intensity)})`
                                : val > 0.01
                                  ? `rgba(6, 182, 212, ${Math.max(0.2, intensity)})`
                                  : "#090d16",
                              border:
                                hoveredCell?.r === r && hoveredCell?.c === c
                                  ? "1px solid #fff"
                                  : isDynamic
                                    ? "1px dashed rgba(234, 179, 8, 0.7)"
                                    : "1px solid rgba(255, 255, 255, 0.05)",
                              borderRadius: "1px",
                              cursor: "crosshair",
                            }}
                            title={`Col ${c}, Row ${r}: Mean=${Math.round(val * 100)}%, Variance=${variance.toFixed(3)} ${isDynamic ? "(Dynamic - Downweighted)" : "(Stable Anchor)"}`}
                          />
                        );
                      }),
                    )}
                  </div>

                  {/* Legend */}
                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      marginTop: "4px",
                      fontSize: "9px",
                      color: "#64748b",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "8px", height: "8px", background: "#06b6d4", borderRadius: "1px", display: "inline-block" }} />
                      Stable Anchor (High Weight)
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "8px", height: "8px", background: "#eab308", borderRadius: "1px", display: "inline-block" }} />
                      Dynamic Content (Downweighted)
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PANEL 3: RIGHT — B3 Learned Template Diagnostics */}
          <div
            style={{
              background: "#0b1220",
              border: "1px solid #1e293b",
              borderRadius: "4px",
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              fontSize: "11px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ color: "#a855f7", fontSize: "12px" }}>
                3. B3 Template Diagnostics
              </b>
              <span
                style={{
                  background: currentGroupData.status === "READY" ? "#064e3b" : "#451a03",
                  color: currentGroupData.status === "READY" ? "#6ee7b7" : "#fcd34d",
                  fontSize: "9px",
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: "2px",
                }}
              >
                {currentGroupData.status}
              </span>
            </div>

            {/* Template Status Banner */}
            <div
              style={{
                background: "#083344",
                border: "1px solid #0891b2",
                borderRadius: "3px",
                padding: "6px 8px",
                color: "#cffafe",
                fontSize: "10px",
              }}
            >
              <b>B3 Layout Fingerprint Status:</b> READY FOR LIVE SCREENSHOT MATCHING<br />
              <span style={{ color: "#67e8f9" }}>
                Canonical Frame: <b>240 × 48 px</b> | Density: <b>24 × 6</b> | Bins: <b>144</b>
              </span>
            </div>

            {/* Geometric Landmarks Section */}
            <div
              style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: "3px",
                padding: "6px 8px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                color: "#cbd5e1",
              }}
            >
              <b style={{ color: "#38bdf8", fontSize: "10px" }}>SPATIAL FEATURE ZONES:</b>

              {/* Avatar */}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Avatar Density:</span>
                <b style={{ color: "#38bdf8" }}>
                  {Math.round((currentSample?.avatar.density ?? currentGroupData.expectedAvatarDensity) * 100)}%
                </b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Avatar Squareness:</span>
                <b style={{ color: "#38bdf8" }}>
                  {currentSample?.avatar.squareness ?? "n/a"}
                </b>
              </div>

              {/* Dual-Band Text */}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Text Bimodal Contrast:</span>
                <b style={{ color: "#10b981" }}>
                  {currentSample?.text.bimodalContrast ?? currentGroupData.expectedBimodalContrast}×
                </b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#94a3b8" }}>
                <span>Upper / Gap / Lower:</span>
                <span>
                  {Math.round((currentSample?.text.upperDensity ?? 0) * 100)}% /{" "}
                  {Math.round((currentSample?.text.gapDensity ?? 0) * 100)}% /{" "}
                  {Math.round((currentSample?.text.lowerDensity ?? 0) * 100)}%
                </span>
              </div>

              {/* Action Menu */}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Action Menu Contrast:</span>
                <b style={{ color: "#f59e0b" }}>
                  {currentSample?.menu.contrast ?? currentGroupData.expectedMenuContrast}×
                </b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#94a3b8" }}>
                <span>Menu / Void Density:</span>
                <span>
                  {Math.round((currentSample?.menu.density ?? 0) * 100)}% /{" "}
                  {Math.round((currentSample?.menu.voidDensity ?? 0) * 100)}%
                </span>
              </div>

              {currentSample?.isWideSinglePill && (
                <div style={{ color: "#f87171", fontWeight: 700, fontSize: "10px", marginTop: "2px" }}>
                  ⚠️ Single continuous pill detected (Composer pattern)
                </div>
              )}
            </div>

            {/* Aggregated Variance Diagnostics */}
            <div
              style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: "3px",
                padding: "6px 8px",
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                color: "#cbd5e1",
              }}
            >
              <b style={{ color: "#fbbf24", fontSize: "10px" }}>MULTI-SAMPLE INVARIANCE:</b>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Training Samples:</span>
                <b>{currentGroupData.sampleCount}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Nominal AR:</span>
                <b>{currentGroupData.nominalAspectRatio}:1</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Nominal Size:</span>
                <b>{currentGroupData.nominalDimensions.width} × {currentGroupData.nominalDimensions.height} px</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Downweighted Cells:</span>
                <b style={{ color: "#eab308" }}>
                  {currentGroupData.dynamicLowWeightCellsCount} / 144
                </b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Stable Invariant Cells:</span>
                <b style={{ color: "#4ade80" }}>
                  {144 - currentGroupData.dynamicLowWeightCellsCount} / 144
                </b>
              </div>
            </div>

            {/* Read-Only Notice */}
            <div
              style={{
                marginTop: "auto",
                fontSize: "10px",
                color: "#64748b",
                borderTop: "1px solid #1e293b",
                paddingTop: "6px",
              }}
            >
              🔒 <b>Read-Only Preview:</b> Reflects the exact runtime B3 feature model. Does not mutate Collector configuration.
            </div>
          </div>
        </div>
        )
      )}
    </div>
  );
}
