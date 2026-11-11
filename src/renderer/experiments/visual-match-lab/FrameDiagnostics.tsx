import React from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import type { LiveCapture } from "./types";
import type {
  BrowserCoreNavigationResult,
  Command,
} from "../../../shared/contracts";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import type { UserPermalinkRule } from "../../../shared/permalink-rules";
import { PermalinkInspector } from "./PermalinkInspector";
import { PermalinkTechnicalDetails } from "./PermalinkTechnicalDetails";

type Invoke = <T>(command: Command) => Promise<T>;

export function FrameDiagnostics({
  frameNumber,
  capture,
  captureStatus,
  pipelineStatus,
  templateStatus,
  detectionStatus,
  boundaryStatus,
  rawIconMatches,
  actionClusters,
  candidates,
  selectedCandidateIndex,
  onSelectCandidate,
  rules,
  onRuleSaved,
  onUpdateBoundary,
  invoke,
  isLiveRunning,
  onInspectInBrowserCore,
  activeUrlInspection,
}: {
  frameNumber: number;
  capture: LiveCapture | null;
  captureStatus: string;
  pipelineStatus: string;
  templateStatus: string;
  detectionStatus: string;
  boundaryStatus: string;
  rawIconMatches: number;
  actionClusters: number;
  candidates: LiveCandidate[];
  selectedCandidateIndex: number;
  onSelectCandidate: (index: number) => void;
  rules: UserPermalinkRule[];
  onRuleSaved: (newRule: UserPermalinkRule) => void;
  onUpdateBoundary: (
    candidateIndex: number,
    newBoundary: BoundaryProbeResult,
    evidenceUrl?: string,
  ) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
  onInspectInBrowserCore?: (result: BrowserCoreNavigationResult | null) => void;
  activeUrlInspection?: BrowserCoreNavigationResult | null;
}) {
  const currentCandidate = candidates[selectedCandidateIndex] ?? candidates[0];
  const boundary = currentCandidate?.boundary;
  const effectiveBoundaryStatus = boundary?.status ?? boundaryStatus;

  const boundaryBadgeClass =
    effectiveBoundaryStatus === "BOUNDARY_FOUND"
      ? "BOUNDARY_FOUND"
      : effectiveBoundaryStatus === "BOUNDARY_AMBIGUOUS"
        ? "BOUNDARY_AMBIGUOUS"
        : effectiveBoundaryStatus === "NO_ACTION_ROW"
          ? "NO_ACTION_ROW"
          : "BOUNDARY_NOT_FOUND";

  return (
    <div className="frame-diagnostics-panel">
      {/* Compact Header Bar: Frame # + Boundary Status + Post Identity Pill */}
      <div className="inspector-compact-topbar">
        <div className="topbar-left">
          <span className="topbar-frame-label">Frame #{frameNumber}</span>
          {currentCandidate && (
            <span className="topbar-row-status">{currentCandidate.status}</span>
          )}
        </div>
        <span className={`badge-boundary ${boundaryBadgeClass}`}>
          {effectiveBoundaryStatus}
        </span>
      </div>

      {/* Candidate Row Selector if multiple candidates */}
      {candidates.length > 1 && (
        <div className="candidate-selector-bar">
          <span className="selector-label">
            Action Rows ({candidates.length}):
          </span>
          <div className="selector-buttons">
            {candidates.map((cand, idx) => (
              <button
                key={idx}
                type="button"
                className={`candidate-pill ${
                  idx === selectedCandidateIndex ? "active" : ""
                }`}
                onClick={() => onSelectCandidate(idx)}
              >
                Row {idx + 1} ({cand.status})
              </button>
            ))}
          </div>
        </div>
      )}

      {!currentCandidate ? (
        <div className="url-inspector-block">
          <div className="no-candidate-msg">
            Không phát hiện Action Row nào trong frame này.
          </div>
          <PermalinkTechnicalDetails
            selectedCandidate={null}
            allCurrentUrls={[]}
            navResult={activeUrlInspection ?? null}
            frameNumber={frameNumber}
            scrollY={capture?.viewport.scrollY}
            dimensions={
              capture ? `${capture.width}×${capture.height}` : "1024×560"
            }
            captureStatus={captureStatus}
            detectionStatus={detectionStatus}
            pipelineStatus={pipelineStatus}
            templateStatus={templateStatus}
            rawIconMatches={rawIconMatches}
            actionClusters={actionClusters}
            copiedUrl={null}
            onCopy={() => {}}
          />
        </div>
      ) : (
        <PermalinkInspector
          frameNumber={frameNumber}
          candidateIndex={selectedCandidateIndex}
          candidate={currentCandidate}
          capture={capture}
          rules={rules}
          onRuleSaved={onRuleSaved}
          onUpdateBoundary={(newBoundary, evidenceUrl) =>
            onUpdateBoundary(selectedCandidateIndex, newBoundary, evidenceUrl)
          }
          invoke={invoke}
          isLiveRunning={isLiveRunning}
          onInspectInBrowserCore={onInspectInBrowserCore}
          activeUrlInspection={activeUrlInspection}
          captureStatus={captureStatus}
          pipelineStatus={pipelineStatus}
          templateStatus={templateStatus}
          detectionStatus={detectionStatus}
          rawIconMatches={rawIconMatches}
          actionClusters={actionClusters}
        />
      )}
    </div>
  );
}
