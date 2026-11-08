import React, { useState, useEffect } from "react";
import type { State } from "../../shared/contracts.js";
import type {
  CollectorDraft,
  MatchTestResult,
  PostGroupMatch,
} from "../../shared/collectors/types.js";
import { executeLiveBrowserMatchTest } from "../../shared/collectors/regions.js";
import {
  collectorInspectDom,
  isElectronBrowserCoreAvailable,
  type CollectorInvoke,
} from "./browser-capture.js";

type MatchTestStepProps = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (sessionId: string) => void;
};

export function StepMatchTest({
  draft,
  locked,
  onChange,
  invoke,
  state,
}: MatchTestStepProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [browserConnected, setBrowserConnected] = useState<boolean>(false);

  const sessionId = state?.activeBrowserSessionId;
  const session = sessionId
    ? state?.browserSessions?.find((s) => s.id === sessionId)
    : undefined;
  const currentUrl = session?.lastUrl || state?.url || "";

  useEffect(() => {
    setBrowserConnected(isElectronBrowserCoreAvailable());
  }, []);

  const matchTestResult: MatchTestResult | undefined = draft.matchTest;
  const status = matchTestResult?.status ?? "NOT TESTED";

  async function handleRunMatchTest() {
    if (locked || isRunning) return;
    setErrorMsg(null);

    if (!isElectronBrowserCoreAvailable() || !invoke) {
      setErrorMsg(
        "Browser Core session unavailable. Live Browser Match Test requires an active Electron browser session.",
      );
      const failedResult: MatchTestResult = {
        testedAt: new Date().toISOString(),
        browserUrl: currentUrl,
        status: "FAILED",
        matchedPostCount: 0,
        groups: [],
        summary: "Match Test failed: Browser Core session unavailable.",
        limitations: [
          "Visual matching requires a live Electron WebContentsView session.",
        ],
        error: "Browser Core unavailable",
      };
      onChange({ ...draft, matchTest: failedResult, dirty: true });
      return;
    }

    setIsRunning(true);
    try {
      // Real live DOM inspection from browser
      const snapshot = await collectorInspectDom(invoke, currentUrl, draft.layoutContext);
      const result = executeLiveBrowserMatchTest(draft.regions ?? [], snapshot);
      onChange({ ...draft, matchTest: result, dirty: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Match Test failed: ${msg}`);
      const failedResult: MatchTestResult = {
        testedAt: new Date().toISOString(),
        browserUrl: currentUrl,
        status: "FAILED",
        matchedPostCount: 0,
        groups: [],
        summary: `Match Test failed: ${msg}`,
        error: msg,
      };
      onChange({ ...draft, matchTest: failedResult, dirty: true });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="collector-match-test-stage">
      {/* Session Connection Header */}
      <div className="collector-match-header">
        <div className="collector-match-session-info">
          <div className="collector-session-badge-row">
            <span
              className={`collector-connection-dot ${browserConnected ? "connected" : "disconnected"}`}
              title={browserConnected ? "Browser Core connected" : "Browser disconnected"}
            />
            <b>Live Browser Core:</b>
            <span>{browserConnected ? "Connected" : "Disconnected / Unavailable"}</span>
            {currentUrl && <code className="collector-match-url">{currentUrl}</code>}
          </div>
          {sessionId && <small style={{ color: "#7f93ab" }}>Session: {sessionId}</small>}
        </div>

        <div className="collector-match-actions">
          <button
            type="button"
            className="primary"
            disabled={locked || isRunning}
            onClick={() => void handleRunMatchTest()}
          >
            {isRunning ? "Running Match Test..." : "▶ Run Match Test"}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="collector-banner error" role="alert">
          {errorMsg}
        </div>
      )}

      {/* Main Status & Results */}
      <div className="collector-match-content">
        <div className="collector-match-summary-card">
          <div className="collector-match-status-bar">
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <span className="collector-subheading">Status:</span>
              <span
                className={`collector-match-pill status-${status.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {status}
              </span>
              {matchTestResult && (
                <span className="collector-post-count-badge">
                  {matchTestResult.matchedPostCount} post(s) matched
                </span>
              )}
            </div>
            {matchTestResult?.testedAt && (
              <small style={{ color: "#7f93ab" }}>
                Tested at: {new Date(matchTestResult.testedAt).toLocaleTimeString()}
              </small>
            )}
          </div>

          {matchTestResult?.summary && (
            <p className="collector-match-summary-text">{matchTestResult.summary}</p>
          )}

          {matchTestResult?.limitations && matchTestResult.limitations.length > 0 && (
            <div className="collector-match-limitations">
              <b>Engine Limitations:</b>
              <ul>
                {matchTestResult.limitations.map((lim, idx) => (
                  <li key={idx}>{lim}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Anchor Groups & Candidates */}
        <div className="collector-match-groups-list">
          <h4 className="collector-section-title">Anchor Group Verifications</h4>

          {(!matchTestResult || matchTestResult.groups.length === 0) && (
            <div className="collector-sample-empty">
              {status === "NOT TESTED"
                ? "Click 'Run Match Test' to search for taught BEGIN/END anchor groups in the live browser."
                : "No anchor groups were evaluated."}
            </div>
          )}

          {matchTestResult?.groups.map((group: PostGroupMatch) => (
            <div className={`collector-group-match-card status-${group.status.toLowerCase()}`} key={group.groupTag}>
              <div className="collector-group-match-head">
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span className="collector-group-tag-pill">#{group.groupTag}</span>
                  <span className={`collector-match-pill small status-${group.status.toLowerCase()}`}>
                    {group.status}
                  </span>
                  <span className={`collector-dom-pill ${group.domAssociationStatus.toLowerCase()}`}>
                    DOM: {group.domAssociationStatus}
                  </span>
                </div>
                <small style={{ color: group.visualConfidence >= 70 ? "#68d6a6" : "#e0b35a" }}>
                  Confidence: {group.visualConfidence}%
                </small>
              </div>

              {group.failureReason && (
                <div className="collector-match-failure-reason">
                  <b>Rejection Reason:</b> {group.failureReason}
                </div>
              )}

              <div className="collector-group-match-body">
                {/* BEGIN match */}
                <div className="collector-anchor-match-col">
                  <h5>BEGIN Anchor</h5>
                  {group.beginMatch?.matched ? (
                    <div className="collector-anchor-detail">
                      <div>
                        Tag: <code>&lt;{group.beginMatch.matchedTagName}&gt;</code> (id: {group.beginMatch.matchedElementId})
                      </div>
                      {group.beginMatch.matchedRect && (
                        <div>
                          Rect: {group.beginMatch.matchedRect.width}×{group.beginMatch.matchedRect.height} at ({group.beginMatch.matchedRect.x}, {group.beginMatch.matchedRect.y})
                        </div>
                      )}
                      <div>Confidence: {group.beginMatch.confidence}% ({group.beginMatch.method})</div>
                      {group.beginMatch.evidence && <small>Evidence: {group.beginMatch.evidence}</small>}
                    </div>
                  ) : (
                    <div className="collector-anchor-detail not-matched">Not Matched</div>
                  )}
                </div>

                {/* END match */}
                <div className="collector-anchor-match-col">
                  <h5>END Anchor</h5>
                  {group.endMatch?.matched ? (
                    <div className="collector-anchor-detail">
                      <div>
                        Tag: <code>&lt;{group.endMatch.matchedTagName}&gt;</code> (id: {group.endMatch.matchedElementId})
                      </div>
                      {group.endMatch.matchedRect && (
                        <div>
                          Rect: {group.endMatch.matchedRect.width}×{group.endMatch.matchedRect.height} at ({group.endMatch.matchedRect.x}, {group.endMatch.matchedRect.y})
                        </div>
                      )}
                      <div>Confidence: {group.endMatch.confidence}% ({group.endMatch.method})</div>
                      {group.endMatch.evidence && <small>Evidence: {group.endMatch.evidence}</small>}
                    </div>
                  ) : (
                    <div className="collector-anchor-detail not-matched">Not Matched</div>
                  )}
                </div>
              </div>

              {/* Dynamic Bounds Calculation */}
              {group.dynamicBounds && (
                <div className="collector-dynamic-calc-box">
                  <b>Dynamic Boundary Calculation (Live Browser Coordinates):</b>
                  <code>
                    dynamicStartY = matchedBegin.y + matchedBegin.height = {group.beginMatch?.matchedRect?.y ?? 0} + {group.beginMatch?.matchedRect?.height ?? 0} = {group.dynamicBounds.dynamicStartY}px
                  </code>
                  <code>
                    dynamicEndY = matchedEnd.y = {group.dynamicBounds.dynamicEndY}px
                  </code>
                  <code>
                    dynamicHeight = dynamicEndY - dynamicStartY = {group.dynamicBounds.height}px
                  </code>
                  <div className="collector-dynamic-bounds-rect">
                    Resolved Box: {group.dynamicBounds.bounds.width}×{group.dynamicBounds.bounds.height} at ({group.dynamicBounds.bounds.x}, {group.dynamicBounds.bounds.y})
                  </div>
                </div>
              )}

              {/* DOM Container */}
              {group.domContainer && (
                <div className="collector-dom-container-info">
                  <b>Resolved Post Container:</b> <code>&lt;{group.domContainer.tagName}&gt;</code> (id: {group.domContainer.containerId}, depth: {group.domContainer.depth}, card: {group.domContainer.isArticleOrCard ? "Yes" : "No"})
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
