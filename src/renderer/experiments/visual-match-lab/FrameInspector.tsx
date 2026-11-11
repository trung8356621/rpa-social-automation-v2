import React, { useState, useMemo, useEffect, useRef } from "react";
import type { BrowserCoreNavigationResult, Command } from "../../../shared/contracts";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import type { UserPermalinkRule } from "../../../shared/permalink-rules";
import { domRectToShellBounds } from "../../../shared/collector-browser-host";
import { readAdminUiZoom } from "../../ui-zoom";
import type { FrameReport, LiveCandidate } from "./LiveScrollTest";
import { FrameNavigation, type FrameFilter } from "./FrameNavigation";
import { FrameScreenshot } from "./FrameScreenshot";
import { FrameDiagnostics } from "./FrameDiagnostics";

type Invoke = <T>(command: Command) => Promise<T>;

function BrowserCoreUrlInspectionHost({
  inspection,
  frameNumber,
  candidateIndex,
  runId,
  invoke,
  onClose,
}: {
  inspection: BrowserCoreNavigationResult;
  frameNumber: number;
  candidateIndex: number;
  runId: string;
  invoke: Invoke;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const publishHost = () => {
      const target = hostRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const bounds = domRectToShellBounds(rect, readAdminUiZoom());
      void invoke({
        type: "collectorBrowserHost",
        host: { ...bounds, active: true },
      });
      void invoke({ type: "browserVisible", visible: true });
    };

    publishHost();
    const observer = new ResizeObserver(publishHost);
    observer.observe(el);
    window.addEventListener("resize", publishHost);
    window.addEventListener("scroll", publishHost, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishHost);
      window.removeEventListener("scroll", publishHost, true);
      void invoke({ type: "collectorBrowserHost", host: null });
      void invoke({ type: "browserVisible", visible: false });
    };
  }, [invoke, inspection.requestedUrl, inspection.finalUrl]);

  return (
    <div
      className="vml-url-inspection-pane"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 620,
        background: "#090f1d",
        border: "1px solid #1e293b",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Top Bar: Visual Match URL Inspection Mode (No Script Editor / No Script Steps) */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px",
          background: "#0f172a",
          borderBottom: "1px solid #1e293b",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 700,
                background: "#2563eb",
                color: "#ffffff",
                border: "1px solid #3b82f6",
                borderRadius: 5,
                cursor: "pointer",
              }}
            >
              ← Quay lại Visual Match Lab (Frame #{frameNumber} · Row #{candidateIndex + 1})
            </button>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: "3px 8px",
                borderRadius: 4,
                background:
                  inspection.status === "SUCCESS"
                    ? "#064e3b"
                    : inspection.status === "REDIRECTED"
                    ? "#78350f"
                    : "#7f1d1d",
                color:
                  inspection.status === "SUCCESS"
                    ? "#6ee7b7"
                    : inspection.status === "REDIRECTED"
                    ? "#fcd34d"
                    : "#fca5a5",
                border:
                  inspection.status === "SUCCESS"
                    ? "1px solid #10b981"
                    : inspection.status === "REDIRECTED"
                    ? "1px solid #f59e0b"
                    : "1px solid #ef4444",
              }}
            >
              {inspection.status === "SUCCESS"
                ? "✔ NAVIGATED TO TARGET"
                : inspection.status === "REDIRECTED"
                ? "⚠ REDIRECTED BY FACEBOOK"
                : "✖ NAVIGATION FAILED"}
            </span>
          </div>
          <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
            Mode: visual-match-url-inspection · Run: {runId} · WebContents #{inspection.webContentsId ?? "?"}
          </span>
        </div>

        {/* Requested vs Final URL */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "110px 1fr",
            rowGap: 4,
            columnGap: 8,
            fontSize: 11,
            fontFamily: "monospace",
            background: "#020617",
            padding: "6px 8px",
            borderRadius: 4,
            border: "1px solid #1e293b",
          }}
        >
          <span style={{ color: "#94a3b8", fontWeight: 600 }}>Requested URL:</span>
          <span style={{ color: "#93c5fd", wordBreak: "break-all" }}>{inspection.requestedUrl}</span>
          <span style={{ color: "#94a3b8", fontWeight: 600 }}>Final URL:</span>
          <span
            style={{
              color: inspection.redirected ? "#fcd34d" : "#6ee7b7",
              wordBreak: "break-all",
              fontWeight: 600,
            }}
          >
            {inspection.finalUrl || "(chưa xác định)"}
          </span>
        </div>

        {inspection.redirected && inspection.redirectReason && (
          <div
            style={{
              padding: "6px 10px",
              borderRadius: 4,
              background: "#451a03",
              border: "1px solid #f59e0b",
              color: "#fde68a",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            <strong>⚠ Cảnh báo Redirect:</strong> {inspection.redirectReason}
          </div>
        )}
      </div>

      {/* Live BrowserCore WebContentsView Host Area */}
      <div
        ref={hostRef}
        className="vml-browsercore-viewport-host"
        style={{
          flex: 1,
          width: "100%",
          minHeight: 520,
          background: "#020617",
          position: "relative",
        }}
      />
    </div>
  );
}

export function FrameInspector({
  frames,
  currentRunId,
  platform,
  rules,
  onRuleSaved,
  onUpdateBoundary,
  invoke,
  isLiveRunning,
}: {
  frames: FrameReport[];
  currentRunId: string;
  platform: string;
  rules: UserPermalinkRule[];
  onRuleSaved: (newRule: UserPermalinkRule) => void;
  onUpdateBoundary: (frameNumber: number, candidateIndex: number, newBoundary: BoundaryProbeResult, evidenceUrl?: string) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
}) {
  const readSavedSelection = (runId: string): { frameIdx: number; candIdx: number; filter: FrameFilter } => {
    try {
      const saved = sessionStorage.getItem(`vml_inspector_state_${runId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          frameIdx: typeof parsed.frameIdx === "number" ? parsed.frameIdx : 0,
          candIdx: typeof parsed.candIdx === "number" ? parsed.candIdx : 0,
          filter: (parsed.filter as FrameFilter) || "ALL",
        };
      }
    } catch {}
    return { frameIdx: 0, candIdx: 0, filter: "ALL" as FrameFilter };
  };

  const [selectedFrameIndex, setSelectedFrameIndex] = useState<number>(() => readSavedSelection(currentRunId).frameIdx);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number>(() => readSavedSelection(currentRunId).candIdx);
  const [filter, setFilter] = useState<FrameFilter>(() => readSavedSelection(currentRunId).filter);
  const [urlInspection, setUrlInspection] = useState<BrowserCoreNavigationResult | null>(null);

  // A different run has different frames/rows; restore per-run selection or reset to 0.
  useEffect(() => {
    const next = readSavedSelection(currentRunId);
    setSelectedFrameIndex(next.frameIdx);
    setSelectedCandidateIndex(next.candIdx);
    setFilter(next.filter);
    setUrlInspection(null);
  }, [currentRunId]);

  // Exit URL inspection mode when the user switches frame or candidate
  useEffect(() => {
    setUrlInspection(null);
  }, [selectedFrameIndex, selectedCandidateIndex, filter]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        `vml_inspector_state_${currentRunId}`,
        JSON.stringify({
          frameIdx: selectedFrameIndex,
          candIdx: selectedCandidateIndex,
          filter,
        }),
      );
    } catch {}
  }, [currentRunId, selectedFrameIndex, selectedCandidateIndex, filter]);

  // Calculate filter counts across all frames
  const filterCounts = useMemo(() => {
    let found = 0;
    let attention = 0;
    let noActionRow = 0;
    for (const f of frames) {
      if (f.boundaryStatus === "BOUNDARY_FOUND") {
        found++;
      } else if (f.boundaryStatus === "NO_ACTION_ROW") {
        noActionRow++;
      } else {
        attention++;
      }
    }
    return { all: frames.length, found, attention, noActionRow };
  }, [frames]);

  // Filtered frames list with original index mapping
  const visibleFrames = useMemo(() => {
    return frames
      .map((frame, originalIndex) => ({ frame, originalIndex }))
      .filter(({ frame }) => {
        if (filter === "FOUND") return frame.boundaryStatus === "BOUNDARY_FOUND";
        if (filter === "ATTENTION") return frame.boundaryStatus === "BOUNDARY_AMBIGUOUS" || frame.boundaryStatus === "BOUNDARY_NOT_FOUND";
        if (filter === "NO_ACTION_ROW") return frame.boundaryStatus === "NO_ACTION_ROW";
        return true;
      });
  }, [frames, filter]);

  // Ensure selected frame index is in bounds
  const safeCurrentIndex = Math.max(0, Math.min(selectedFrameIndex, Math.max(0, visibleFrames.length - 1)));
  const currentItem = visibleFrames[safeCurrentIndex];
  const currentFrame = currentItem?.frame;

  const handlePrevious = () => {
    setSelectedFrameIndex(prev => Math.max(0, prev - 1));
    setSelectedCandidateIndex(0);
  };

  const handleNext = () => {
    setSelectedFrameIndex(prev => Math.min(visibleFrames.length - 1, prev + 1));
    setSelectedCandidateIndex(0);
  };

  const handleJumpToFrame = (idx: number) => {
    setSelectedFrameIndex(Math.max(0, Math.min(idx, visibleFrames.length - 1)));
    setSelectedCandidateIndex(0);
  };

  const handleJumpNextError = () => {
    if (visibleFrames.length === 0) return;
    const start = (safeCurrentIndex + 1) % visibleFrames.length;
    for (let i = 0; i < visibleFrames.length; i++) {
      const idx = (start + i) % visibleFrames.length;
      const b = visibleFrames[idx].frame.boundaryStatus;
      if (b === "BOUNDARY_NOT_FOUND" || b === "BOUNDARY_AMBIGUOUS" || b === "NO_ACTION_ROW") {
        setSelectedFrameIndex(idx);
        setSelectedCandidateIndex(0);
        return;
      }
    }
  };

  if (!currentFrame) {
    return (
      <div className="frame-inspector-empty">
        <p>No frames match the filter &ldquo;{filter}&rdquo;.</p>
        <button type="button" onClick={() => setFilter("ALL")}>Show All Frames</button>
      </div>
    );
  }

  // Find highlighted screenshot strictly matching the selected candidate first
  const selectedCand = currentFrame.candidates[selectedCandidateIndex] ?? currentFrame.candidates[0];
  const highlightedImg =
    selectedCand?.highlightedEvidenceUrl ||
    currentFrame.candidates.find(c => c.boundary?.status === "BOUNDARY_FOUND" && c.highlightedEvidenceUrl)?.highlightedEvidenceUrl ||
    currentFrame.candidates.find(c => c.highlightedEvidenceUrl)?.highlightedEvidenceUrl;

  return (
    <div className="frame-inspector-container">
      {/* 1. Header with Previous / Next / Filters */}
      <FrameNavigation
        currentFrameIndex={safeCurrentIndex}
        totalFrames={visibleFrames.length}
        currentFrameNumber={currentFrame.frame}
        boundaryStatus={currentFrame.boundaryStatus}
        runId={currentRunId}
        platform={platform}
        onPrevious={handlePrevious}
        onNext={handleNext}
        onJumpToFrame={handleJumpToFrame}
        filter={filter}
        onFilterChange={setFilter}
        filterCounts={filterCounts}
        onJumpNextError={handleJumpNextError}
      />

      {/* 2. Desktop 70/30 Main Content */}
      <div className="frame-inspector-main">
        {/* Left 70%: Screenshot Viewer OR Live BrowserCore URL Inspection */}
        <div className="inspector-left-pane">
          {urlInspection ? (
            <BrowserCoreUrlInspectionHost
              inspection={urlInspection}
              frameNumber={currentFrame.frame}
              candidateIndex={selectedCandidateIndex}
              runId={currentRunId}
              invoke={invoke}
              onClose={() => setUrlInspection(null)}
            />
          ) : (
            <FrameScreenshot
              capture={currentFrame.capture}
              highlightedEvidenceUrl={highlightedImg}
              candidates={currentFrame.candidates}
              selectedCandidateIndex={selectedCandidateIndex}
              onSelectCandidate={setSelectedCandidateIndex}
              frameNumber={currentFrame.frame}
              runId={currentRunId}
              evidenceSavedPath={selectedCand?.evidenceSavedPath}
            />
          )}
        </div>

        {/* Right 30%: Diagnostics & Permalink Inspector */}
        <div className="inspector-right-pane">
          <FrameDiagnostics
            frameNumber={currentFrame.frame}
            capture={currentFrame.capture}
            captureStatus={currentFrame.captureStatus}
            pipelineStatus={currentFrame.pipelineStatus}
            templateStatus={currentFrame.templateStatus}
            detectionStatus={currentFrame.detectionStatus}
            boundaryStatus={currentFrame.boundaryStatus}
            rawIconMatches={currentFrame.rawIconMatches}
            actionClusters={currentFrame.actionClusters}
            candidates={currentFrame.candidates}
            selectedCandidateIndex={selectedCandidateIndex}
            onSelectCandidate={setSelectedCandidateIndex}
            rules={rules}
            onRuleSaved={onRuleSaved}
            onUpdateBoundary={(candidateIdx, newBoundary, evidenceUrl) =>
              onUpdateBoundary(currentFrame.frame, candidateIdx, newBoundary, evidenceUrl)
            }
            invoke={invoke}
            isLiveRunning={isLiveRunning}
            onInspectInBrowserCore={setUrlInspection}
            activeUrlInspection={urlInspection}
          />
        </div>
      </div>
    </div>
  );
}
