import React from "react";
import type { SavedRunSummaryItem } from "../../../shared/contracts";
import type { LiveCandidate } from "./LiveScrollTest";

export function RunSummary({
  totalFrames,
  capturePassCount,
  captureFailCount,
  actionClustersTotal,
  rawIconMatchesTotal,
  boundaryFoundCount,
  boundaryAmbiguousCount,
  boundaryNotFoundCount,
  candidates,
  savedRuns,
  currentRunId,
  onLoadRun,
  loadingRun,
}: {
  totalFrames: number;
  capturePassCount: number;
  captureFailCount: number;
  actionClustersTotal: number;
  rawIconMatchesTotal: number;
  boundaryFoundCount: number;
  boundaryAmbiguousCount: number;
  boundaryNotFoundCount: number;
  candidates: LiveCandidate[];
  savedRuns: SavedRunSummaryItem[];
  currentRunId: string | null;
  onLoadRun: (runId: string) => void;
  loadingRun: boolean;
}) {
  const confirmed = candidates.filter(item => item.status === "NEW_ITEM").length;
  const duplicates = candidates.filter(item => item.status === "DUPLICATE").length;
  const attention = candidates.filter(item => item.status === "NEEDS_ATTENTION").length;
  const commentActions = candidates.filter(item => item.status === "COMMENT_ACTION").length;

  return (
    <div className="run-summary-container">
      {/* Metrics Bar */}
      <div className="live-scroll-summary">
        <div className="summary-stat-card">
          <span className="stat-label">Capture</span>
          <span className="stat-val">
            <b className="text-green">{capturePassCount} pass</b> / {captureFailCount} fail
          </span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Action Rows</span>
          <span className="stat-val">{actionClustersTotal}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Raw Icons</span>
          <span className="stat-val">{rawIconMatchesTotal}</span>
        </div>
        <div className="summary-stat-card highlight-card">
          <span className="stat-label">Boundary Found</span>
          <span className="stat-val text-green font-bold">{boundaryFoundCount}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Ambiguous</span>
          <span className="stat-val text-amber">{boundaryAmbiguousCount}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Not Found</span>
          <span className="stat-val text-muted">{boundaryNotFoundCount}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Confirmed Posts</span>
          <span className="stat-val text-blue font-bold">{confirmed}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Duplicates</span>
          <span className="stat-val">{duplicates}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Needs Attention</span>
          <span className="stat-val text-amber">{attention}</span>
        </div>
        <div className="summary-stat-card">
          <span className="stat-label">Comment Actions</span>
          <span className="stat-val text-purple">{commentActions}</span>
        </div>
      </div>

      {/* Saved Runs Selector */}
      {savedRuns.length > 0 && (
        <div className="saved-runs-bar">
          <span className="saved-runs-label">📂 Saved Runs ({savedRuns.length}):</span>
          <div className="saved-runs-chips">
            {savedRuns.slice(0, 6).map(run => {
              const isSelected = run.runId === currentRunId;
              const dateStr = new Date(run.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
              return (
                <button
                  key={run.runId}
                  type="button"
                  className={`run-chip ${isSelected ? "active" : ""}`}
                  onClick={() => onLoadRun(run.runId)}
                  disabled={loadingRun || isSelected}
                  title={`Run: ${run.runId}\nTime: ${run.timestamp}\nFound: ${run.boundaryFoundCount}/${run.actionRowsDetected} rows\nTotal frames: ${run.totalFrames}`}
                >
                  <span className="chip-time">{dateStr}</span>
                  <span className="chip-id">{run.runId.slice(0, 16)}...</span>
                  <span className="chip-badge">{run.boundaryFoundCount} found</span>
                  {run.source === "structured" && <span className="chip-source">📁</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
