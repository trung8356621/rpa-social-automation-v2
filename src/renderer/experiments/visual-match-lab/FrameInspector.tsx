import React, { useState, useMemo, useEffect } from "react";
import type { Command } from "../../../shared/contracts";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import type { UserPermalinkRule } from "../../../shared/permalink-rules";
import type { FrameReport, LiveCandidate } from "./LiveScrollTest";
import { FrameNavigation, type FrameFilter } from "./FrameNavigation";
import { FrameScreenshot } from "./FrameScreenshot";
import { FrameDiagnostics } from "./FrameDiagnostics";

type Invoke = <T>(command: Command) => Promise<T>;

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

  // A different run has different frames/rows; restore per-run selection or reset to 0.
  useEffect(() => {
    const next = readSavedSelection(currentRunId);
    setSelectedFrameIndex(next.frameIdx);
    setSelectedCandidateIndex(next.candIdx);
    setFilter(next.filter);
  }, [currentRunId]);

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
        {/* Left 70%: Screenshot Viewer */}
        <div className="inspector-left-pane">
          <FrameScreenshot
            capture={currentFrame.capture}
            highlightedEvidenceUrl={highlightedImg}
            candidates={currentFrame.candidates}
            selectedCandidateIndex={selectedCandidateIndex}
            onSelectCandidate={setSelectedCandidateIndex}
            frameNumber={currentFrame.frame}
            runId={currentRunId}
          />
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
          />
        </div>
      </div>
    </div>
  );
}
