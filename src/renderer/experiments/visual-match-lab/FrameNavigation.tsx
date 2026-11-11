import React, { useEffect } from "react";
import type { BoundaryStatus } from "../../../shared/boundary-probe";

export type FrameFilter = "ALL" | "FOUND" | "ATTENTION" | "NO_ACTION_ROW";

export function FrameNavigation({
  currentFrameIndex,
  totalFrames,
  currentFrameNumber,
  boundaryStatus,
  runId,
  platform,
  onPrevious,
  onNext,
  onJumpToFrame,
  filter,
  onFilterChange,
  filterCounts,
  onJumpNextError,
}: {
  currentFrameIndex: number;
  totalFrames: number;
  currentFrameNumber: number;
  boundaryStatus: BoundaryStatus | "NO_ACTION_ROW" | undefined;
  runId: string;
  platform: string;
  onPrevious: () => void;
  onNext: () => void;
  onJumpToFrame: (index: number) => void;
  filter: FrameFilter;
  onFilterChange: (filter: FrameFilter) => void;
  filterCounts: { all: number; found: number; attention: number; noActionRow: number };
  onJumpNextError: () => void;
}) {
  // Arrow key navigation when inputs are not focused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        activeEl?.getAttribute("contenteditable") === "true";
      if (isInput) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrevious();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onPrevious, onNext]);

  const statusBadgeClass =
    boundaryStatus === "BOUNDARY_FOUND"
      ? "BOUNDARY_FOUND"
      : boundaryStatus === "BOUNDARY_AMBIGUOUS"
        ? "BOUNDARY_AMBIGUOUS"
        : boundaryStatus === "NO_ACTION_ROW"
          ? "NO_ACTION_ROW"
          : "BOUNDARY_NOT_FOUND";

  return (
    // Intentionally a <div>, not <header>: the Creator global stylesheet pins every
    // <header> to height: 36px, which clipped the wrapped filter row under the screenshot pane.
    <div className="frame-inspector-header" role="toolbar" aria-label="Frame navigation">
      <div className="inspector-header-left">
        <span className="run-tag">Run: <b>{runId || "live_session"}</b></span>
        <span className="platform-tag">Platform: <b>{platform.toUpperCase()}</b></span>
        <span className={`badge-boundary ${statusBadgeClass}`}>
          {boundaryStatus ?? "PENDING"}
        </span>
      </div>

      <div className="inspector-header-center">
        <button
          type="button"
          className="nav-btn prev-btn"
          onClick={onPrevious}
          disabled={currentFrameIndex <= 0}
          title="Previous Frame (Left Arrow)"
        >
          &larr; Previous
        </button>

        <span className="frame-counter">
          Frame <b>{String(currentFrameNumber).padStart(2, "0")}</b> / {String(totalFrames).padStart(2, "0")}
        </span>

        <button
          type="button"
          className="nav-btn next-btn"
          onClick={onNext}
          disabled={currentFrameIndex >= totalFrames - 1}
          title="Next Frame (Right Arrow)"
        >
          Next &rarr;
        </button>

        <button
          type="button"
          className="nav-btn next-error-btn"
          onClick={onJumpNextError}
          title="Jump to next frame needing attention or with no action row"
        >
          Next Attention ⚠
        </button>
      </div>

      <div className="inspector-header-right">
        <div className="filter-pill-group">
          <button
            type="button"
            className={`filter-pill ${filter === "ALL" ? "active" : ""}`}
            onClick={() => onFilterChange("ALL")}
          >
            All ({filterCounts.all})
          </button>
          <button
            type="button"
            className={`filter-pill ${filter === "FOUND" ? "active" : ""}`}
            onClick={() => onFilterChange("FOUND")}
          >
            Found ({filterCounts.found})
          </button>
          <button
            type="button"
            className={`filter-pill ${filter === "ATTENTION" ? "active" : ""}`}
            onClick={() => onFilterChange("ATTENTION")}
          >
            Attention ({filterCounts.attention})
          </button>
          <button
            type="button"
            className={`filter-pill ${filter === "NO_ACTION_ROW" ? "active" : ""}`}
            onClick={() => onFilterChange("NO_ACTION_ROW")}
          >
            No Row ({filterCounts.noActionRow})
          </button>
        </div>
      </div>
    </div>
  );
}
