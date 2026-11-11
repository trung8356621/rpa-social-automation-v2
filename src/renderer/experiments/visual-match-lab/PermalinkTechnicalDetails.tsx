import React from "react";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import type { BrowserCoreNavigationResult } from "../../../shared/contracts";
import type { InspectableUrl } from "./PermalinkInspector";

export function PermalinkTechnicalDetails({
  selectedCandidate,
  allCurrentUrls,
  navResult,
  boundary,
  frameNumber,
  scrollY,
  dimensions,
  captureStatus,
  detectionStatus,
  pipelineStatus,
  templateStatus,
  rawIconMatches,
  actionClusters,
  matchScore,
  candidateStatus,
  candidateContext,
  copiedUrl,
  onCopy,
}: {
  selectedCandidate: InspectableUrl | null;
  allCurrentUrls: InspectableUrl[];
  navResult: BrowserCoreNavigationResult | null;
  boundary?: BoundaryProbeResult;
  frameNumber?: number;
  scrollY?: number | string;
  dimensions?: string;
  captureStatus?: string;
  detectionStatus?: string;
  pipelineStatus?: string;
  templateStatus?: string;
  rawIconMatches?: number;
  actionClusters?: number;
  matchScore?: string;
  candidateStatus?: string;
  candidateContext?: string;
  copiedUrl: string | null;
  onCopy: (text: string) => void;
}) {
  const activeUrlItem = selectedCandidate ?? allCurrentUrls[0] ?? null;

  return (
    <details className="permalink-technical-details">
      <summary className="technical-details-summary">
        <span>4. Technical Details</span>
        <span className="technical-details-hint">Thu gọn mặc định</span>
      </summary>

      <div className="technical-details-body">
        {/* Selected / Primary URL Technical Breakdown */}
        {activeUrlItem ? (
          <div className="tech-section">
            <div className="tech-section-title">
              URL #{activeUrlItem.index} Diagnostics
            </div>

            <div className="tech-kv-list">
              <div className="tech-kv-row">
                <span className="tech-k">DOM Ancestor Level:</span>
                <span className="tech-v monospace-val">
                  L{activeUrlItem.level} &lt;{activeUrlItem.tag}
                  {activeUrlItem.role ? ` role="${activeUrlItem.role}"` : ""}
                  &gt;
                </span>
              </div>

              <div className="tech-kv-row">
                <span className="tech-k">Classification / Rule ID:</span>
                <span className="tech-v monospace-val">
                  {activeUrlItem.classificationLabel} (
                  {activeUrlItem.matchedRuleId ?? "UNRECOGNIZED"})
                </span>
              </div>

              <div className="tech-url-box">
                <div className="tech-url-box-header">
                  <span className="tech-k">Raw URL (Resolved):</span>
                  <button
                    type="button"
                    className="tech-copy-btn"
                    onClick={() => onCopy(activeUrlItem.url)}
                  >
                    {copiedUrl === activeUrlItem.url ? "✔ Copied" : "Copy"}
                  </button>
                </div>
                <div className="tech-url-code">{activeUrlItem.url}</div>
              </div>

              {activeUrlItem.rawUrl &&
                activeUrlItem.rawUrl !== activeUrlItem.url && (
                  <div className="tech-url-box">
                    <div className="tech-url-box-header">
                      <span className="tech-k">DOM href Attribute:</span>
                      <button
                        type="button"
                        className="tech-copy-btn"
                        onClick={() => onCopy(activeUrlItem.rawUrl!)}
                      >
                        {copiedUrl === activeUrlItem.rawUrl
                          ? "✔ Copied"
                          : "Copy"}
                      </button>
                    </div>
                    <div className="tech-url-code">{activeUrlItem.rawUrl}</div>
                  </div>
                )}

              {activeUrlItem.canonicalUrl && (
                <div className="tech-url-box">
                  <div className="tech-url-box-header">
                    <span className="tech-k">Canonical URL:</span>
                    <button
                      type="button"
                      className="tech-copy-btn"
                      onClick={() => onCopy(activeUrlItem.canonicalUrl!)}
                    >
                      {copiedUrl === activeUrlItem.canonicalUrl
                        ? "✔ Copied"
                        : "Copy"}
                    </button>
                  </div>
                  <div className="tech-url-code">
                    {activeUrlItem.canonicalUrl}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="tech-empty-note">
            Không có URL candidate nào trong bài hiện tại.
          </div>
        )}

        {/* Navigation / Redirect Diagnostics */}
        {navResult && (
          <div className="tech-section">
            <div className="tech-section-title">
              BrowserCore Navigation &amp; Redirect Diagnostics
            </div>

            <div className="tech-url-box">
              <div className="tech-url-box-header">
                <span className="tech-k">Requested URL:</span>
                <button
                  type="button"
                  className="tech-copy-btn"
                  onClick={() => onCopy(navResult.requestedUrl)}
                >
                  {copiedUrl === navResult.requestedUrl ? "✔ Copied" : "Copy"}
                </button>
              </div>
              <div className="tech-url-code">{navResult.requestedUrl}</div>
            </div>

            <div className="tech-url-box">
              <div className="tech-url-box-header">
                <span className="tech-k">Final URL:</span>
                {navResult.finalUrl && (
                  <button
                    type="button"
                    className="tech-copy-btn"
                    onClick={() => onCopy(navResult.finalUrl)}
                  >
                    {copiedUrl === navResult.finalUrl ? "✔ Copied" : "Copy"}
                  </button>
                )}
              </div>
              <div className="tech-url-code">
                {navResult.finalUrl || "(chưa xác định)"}
              </div>
            </div>

            {navResult.redirected && navResult.redirectReason && (
              <div className="tech-warning-box">
                ⚠ Redirect Reason: {navResult.redirectReason}
              </div>
            )}

            {navResult.error && (
              <div className="tech-warning-box">
                ⚠ Navigation Error: {navResult.error}
              </div>
            )}

            {navResult.events && navResult.events.length > 0 && (
              <div className="tech-event-log">
                <div className="tech-k" style={{ marginBottom: 4 }}>
                  Navigation Event Log ({navResult.events.length} events):
                </div>
                {navResult.events.map((ev, i) => (
                  <div key={i} className="tech-event-item">
                    <span className="tech-event-time">+{ev.atMs}ms</span>{" "}
                    <b>[{ev.type}]</b> {ev.url}
                    {ev.httpResponseCode
                      ? ` (HTTP ${ev.httpResponseCode})`
                      : ""}
                    {ev.errorCode
                      ? ` (ERR ${ev.errorCode}: ${ev.errorDescription})`
                      : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Boundary & Warnings Diagnostics */}
        {boundary && (
          <div className="tech-section">
            <div className="tech-section-title">
              DOM Boundary &amp; Technical Warnings
            </div>
            <div className="tech-kv-grid">
              <div className="tech-kv-item">
                <span className="tech-k">Hit Element:</span>
                <span className="tech-v monospace-val">
                  &lt;{boundary.hitElement?.tag ?? "i"}
                  {boundary.hitElement?.role
                    ? ` role="${boundary.hitElement.role}"`
                    : ""}
                  &gt;
                </span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">Ancestors Checked:</span>
                <span className="tech-v">
                  {boundary.ancestorsChecked ?? 0} levels
                </span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">First Permalink:</span>
                <span className="tech-v">
                  {boundary.firstPermalinkLevel !== null &&
                  boundary.firstPermalinkLevel !== undefined
                    ? `L${boundary.firstPermalinkLevel}`
                    : "None"}
                </span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">Crossed (Second):</span>
                <span className="tech-v">
                  {boundary.secondPermalinkLevel !== null &&
                  boundary.secondPermalinkLevel !== undefined
                    ? `L${boundary.secondPermalinkLevel}`
                    : "None"}
                </span>
              </div>
            </div>

            {boundary.candidateContainer ? (
              <div className="tech-kv-row" style={{ marginTop: 4 }}>
                <span className="tech-k">Candidate Container:</span>
                <span className="tech-v monospace-val">
                  &lt;{boundary.candidateContainer.tag}
                  {boundary.candidateContainer.role
                    ? ` role="${boundary.candidateContainer.role}"`
                    : ""}
                  &gt; L{boundary.candidateContainer.level} (
                  {Math.round(boundary.candidateContainer.rect.width)}×
                  {Math.round(boundary.candidateContainer.rect.height)} px)
                </span>
              </div>
            ) : (
              boundary.jumpReason && (
                <div className="tech-warning-box">
                  ⚠ {boundary.jumpReason}
                </div>
              )
            )}

            {boundary.hasQuoteOrSharedPostRisk && (
              <div className="tech-warning-box">
                ⚠ Quote/Shared Post Risk: {boundary.riskReason}
              </div>
            )}
            {!boundary.hasQuoteOrSharedPostRisk && boundary.riskReason && (
              <div className="tech-warning-box">⚠ {boundary.riskReason}</div>
            )}
          </div>
        )}

        {/* Frame & OpenCV Metrics */}
        {frameNumber !== undefined && (
          <div className="tech-section">
            <div className="tech-section-title">Frame &amp; OpenCV Metrics</div>
            <div className="tech-kv-grid">
              <div className="tech-kv-item">
                <span className="tech-k">Frame / Scroll Y:</span>
                <span className="tech-v">
                  #{frameNumber} / {scrollY ?? "N/A"} px
                </span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">Dimensions:</span>
                <span className="tech-v">{dimensions ?? "1024×560"}</span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">Capture / Detection:</span>
                <span className="tech-v">
                  {captureStatus} / {detectionStatus}
                </span>
              </div>
              <div className="tech-kv-item">
                <span className="tech-k">Icons / Clusters / Score:</span>
                <span className="tech-v">
                  {rawIconMatches ?? 0} / {actionClusters ?? 0} /{" "}
                  {matchScore ?? "N/A"}
                </span>
              </div>
              {candidateStatus && (
                <div className="tech-kv-item">
                  <span className="tech-k">Candidate / Context:</span>
                  <span className="tech-v">
                    {candidateStatus} ({candidateContext ?? "unknown"})
                  </span>
                </div>
              )}
            </div>
            {pipelineStatus && (
              <div className="tech-subtext">{pipelineStatus}</div>
            )}
            {templateStatus && (
              <div className="tech-subtext">{templateStatus}</div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
