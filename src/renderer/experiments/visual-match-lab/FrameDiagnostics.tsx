import React, { useState } from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import type { LiveCapture } from "./types";
import type { BrowserCoreNavigationResult, Command } from "../../../shared/contracts";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import type { UserPermalinkRule } from "../../../shared/permalink-rules";
import { PermalinkInspector } from "./PermalinkInspector";
import { PermalinkRuleEditor } from "./PermalinkRuleEditor";

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
  onUpdateBoundary: (candidateIndex: number, newBoundary: BoundaryProbeResult, evidenceUrl?: string) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
  onInspectInBrowserCore?: (result: BrowserCoreNavigationResult | null) => void;
  activeUrlInspection?: BrowserCoreNavigationResult | null;
}) {
  const [prefillUrl, setPrefillUrl] = useState<string | null>(null);
  const currentCandidate = candidates[selectedCandidateIndex] ?? candidates[0];
  const boundary = currentCandidate?.boundary;

  const boundaryBadgeClass =
    boundaryStatus === "BOUNDARY_FOUND"
      ? "BOUNDARY_FOUND"
      : boundaryStatus === "BOUNDARY_AMBIGUOUS"
        ? "BOUNDARY_AMBIGUOUS"
        : boundaryStatus === "NO_ACTION_ROW"
          ? "NO_ACTION_ROW"
          : "BOUNDARY_NOT_FOUND";

  return (
    <div className="frame-diagnostics-panel">
      {/* 1. Capture Group */}
      <section className="diag-group capture-group">
        <h4 className="diag-title">📸 Capture</h4>
        <div className="diag-grid">
          <div className="diag-item">
            <span className="diag-label">Frame:</span>
            <span className="diag-value">#{frameNumber}</span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Scroll Y:</span>
            <span className="diag-value">{capture?.viewport.scrollY ?? "N/A"} px</span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Dimensions:</span>
            <span className="diag-value">
              {capture ? `${capture.width}×${capture.height}` : "1024×560"}
            </span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Status:</span>
            <span className="diag-value status-pass">{captureStatus}</span>
          </div>
        </div>
      </section>

      {/* 2. OpenCV Group */}
      <section className="diag-group cv-group">
        <h4 className="diag-title">👁 OpenCV Recognition</h4>
        <div className="diag-grid">
          <div className="diag-item">
            <span className="diag-label">Detection:</span>
            <span className={`diag-value ${detectionStatus === "DETECTION_PASS" ? "status-pass" : "status-warn"}`}>
              {detectionStatus}
            </span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Raw Icons:</span>
            <span className="diag-value">{rawIconMatches} candidates</span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Action Clusters:</span>
            <span className="diag-value">{actionClusters} detected</span>
          </div>
          <div className="diag-item">
            <span className="diag-label">Match Score:</span>
            <span className="diag-value">
              {currentCandidate ? `${(currentCandidate.score * 100).toFixed(1)}%` : "N/A"}
            </span>
          </div>
        </div>
        <div className="diag-status-text" title={pipelineStatus}>
          {pipelineStatus}
        </div>
        <div className="diag-subtext">
          {templateStatus}
        </div>
      </section>

      {/* Candidate Row Selector if multiple candidates */}
      {candidates.length > 1 && (
        <div className="candidate-selector-bar">
          <span className="selector-label">Action Rows ({candidates.length}):</span>
          <div className="selector-buttons">
            {candidates.map((cand, idx) => (
              <button
                key={idx}
                type="button"
                className={`candidate-pill ${idx === selectedCandidateIndex ? "active" : ""}`}
                onClick={() => onSelectCandidate(idx)}
              >
                Row {idx + 1} ({cand.status})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 3. DOM Boundary Group */}
      <section className="diag-group boundary-group">
        <div className="boundary-group-header">
          <h4 className="diag-title">🎯 DOM Boundary &amp; Traversal</h4>
          <span className={`badge-boundary ${boundaryBadgeClass}`}>
            {boundary?.status ?? boundaryStatus}
          </span>
        </div>

        {!currentCandidate ? (
          <div className="no-candidate-msg">
            No action row detected in this frame.
          </div>
        ) : (
          <div className="boundary-info-content">
            <div className="diag-grid">
              <div className="diag-item">
                <span className="diag-label">Candidate Status:</span>
                <span className="diag-value status-highlight">
                  {currentCandidate.status}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">DOM Context:</span>
                <span className="diag-value">{currentCandidate.context}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Hit Element:</span>
                <span className="diag-value monospace-val">
                  &lt;{boundary?.hitElement?.tag ?? "i"}
                  {boundary?.hitElement?.role ? ` role="${boundary.hitElement.role}"` : ""}&gt;
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Ancestors Traversed:</span>
                <span className="diag-value">
                  {boundary?.ancestorsChecked ?? 0} levels
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">First Permalink:</span>
                <span className="diag-value">
                  {boundary?.firstPermalinkLevel !== null && boundary?.firstPermalinkLevel !== undefined
                    ? `Level ${boundary.firstPermalinkLevel}`
                    : "None"}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Crossed (Second):</span>
                <span className="diag-value">
                  {boundary?.secondPermalinkLevel !== null && boundary?.secondPermalinkLevel !== undefined
                    ? `Level ${boundary.secondPermalinkLevel}`
                    : "None"}
                </span>
              </div>
            </div>

            {/* Candidate Container Box */}
            <div className="container-summary-box">
              <span className="container-summary-label">Candidate Container:</span>
              {boundary?.candidateContainer ? (
                <div className="container-summary-val">
                  <code>
                    &lt;{boundary.candidateContainer.tag}
                    {boundary.candidateContainer.role ? ` role="${boundary.candidateContainer.role}"` : ""}
                    &gt;
                  </code>
                  <span className="container-dims">
                    Level {boundary.candidateContainer.level} &middot; {Math.round(boundary.candidateContainer.rect.width)}×{Math.round(boundary.candidateContainer.rect.height)} px
                  </span>
                </div>
              ) : (
                <div className="container-none">
                  {boundary?.jumpReason || "No post container candidate resolved."}
                </div>
              )}
            </div>

            {/* Post Identities */}
            {boundary?.postIdentities && boundary.postIdentities.length > 0 && (
              <div className="post-identities-box">
                <span className="identities-label">Post Identities ({boundary.postIdentities.length}):</span>
                <div className="identities-list">
                  {boundary.postIdentities.map((p, i) => (
                    <span key={i} className="identity-pill">
                      {p.platform}: <b>{p.postId}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Quote / Shared post risk warning */}
            {boundary?.hasQuoteOrSharedPostRisk && (
              <div className="boundary-warning">
                ⚠ Quote/Shared Post Risk: {boundary.riskReason}
              </div>
            )}

            {/* Permalink Inspection & Rule Editor */}
            {boundary && (
              <PermalinkInspector
                candidate={currentCandidate}
                rules={rules}
                onUseUrl={setPrefillUrl}
                invoke={invoke}
                isLiveRunning={isLiveRunning}
                onInspectInBrowserCore={onInspectInBrowserCore}
                activeUrlInspection={activeUrlInspection}
              />
            )}

            {capture && (
              <PermalinkRuleEditor
                frameNumber={frameNumber}
                candidateIndex={selectedCandidateIndex}
                candidate={currentCandidate}
                capture={capture}
                rules={rules}
                onRuleSaved={onRuleSaved}
                onUpdateBoundary={(newBoundary, evidenceUrl) =>
                  onUpdateBoundary(selectedCandidateIndex, newBoundary, evidenceUrl)
                }
                prefillUrl={prefillUrl}
                invoke={invoke}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
