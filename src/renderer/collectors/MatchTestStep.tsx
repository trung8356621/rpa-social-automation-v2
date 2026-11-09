import React, { useState, useEffect, useRef, useCallback } from "react";
import type { State } from "../../shared/contracts.js";
import type {
  CollectorDraft,
  MatchTestResult,
  MatchedPostItem,
  PostGroupMatch,
} from "../../shared/collectors/types.js";
import { executeLiveBrowserMatchTest } from "../../shared/collectors/regions.js";
import { domRectToShellBounds } from "../../shared/collector-browser-host.js";
import { readAdminUiZoom } from "../ui-zoom.js";
import {
  collectorInspectDom,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  collectorHighlightMatches,
  collectorClearHighlights,
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

  const hostRef = useRef<HTMLDivElement>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const hasAutoRunRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const isRunningRef = useRef<boolean>(false);

  // Keep latest mutable props in refs to decouple browser lifecycle from state changes
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const sessionId = state?.activeBrowserSessionId;
  const session = sessionId
    ? state?.browserSessions?.find((s) => s.id === sessionId)
    : undefined;
  const currentUrl = session?.lastUrl || state?.url || "";

  const matchTestResult: MatchTestResult | undefined = draft.matchTest;
  const status = matchTestResult?.status ?? "NOT TESTED";

  // Counts: clearly separate inspected viewport candidates from actually resolved post matches
  const inspectedCount = matchTestResult?.matchedItems?.length ?? 0;
  const resolvedMatchedCount =
    matchTestResult?.matchedPostCount ??
    matchTestResult?.matchedItems?.filter((item) => item.domResolved).length ??
    0;

  // Measure and report host frame bounds to Electron shell.
  // Suppresses redundant IPC calls if bounds have not changed.
  const publishHost = useCallback(() => {
    if (!invoke || !isElectronBrowserCoreAvailable()) return;
    const el = hostRef.current;
    if (!el) {
      if (lastBoundsRef.current !== null) {
        lastBoundsRef.current = null;
        void collectorReportBrowserHost(invoke, null);
      }
      return;
    }
    const rect = el.getBoundingClientRect();
    const zoom = readAdminUiZoom();
    const next = domRectToShellBounds(rect, zoom);
    const prev = lastBoundsRef.current;
    if (
      prev &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.width === next.width &&
      prev.height === next.height
    ) {
      return;
    }
    lastBoundsRef.current = next;
    void collectorReportBrowserHost(invoke, { ...next, active: true });
  }, [invoke]);

  // Execute Match Test logic: decoupled from the WebContentsView lifecycle
  const handleRunMatchTest = useCallback(async () => {
    if (lockedRef.current || isRunningRef.current) return;
    setErrorMsg(null);

    if (!isElectronBrowserCoreAvailable() || !invoke) {
      if (!isMountedRef.current) return;
      setErrorMsg(
        "Browser Core session unavailable. Live Browser Match Test requires an active Electron browser session.",
      );
      const failedResult: MatchTestResult = {
        testedAt: new Date().toISOString(),
        browserUrl: currentUrl,
        status: "FAILED",
        matchedPostCount: 0,
        groups: [],
        matchedItems: [],
        summary: "Match Test failed: Browser Core session unavailable.",
        limitations: [
          "Visual matching requires a live Electron WebContentsView session.",
        ],
        error: "Browser Core unavailable",
      };
      onChangeRef.current({ ...draftRef.current, matchTest: failedResult, dirty: true });
      return;
    }

    isRunningRef.current = true;
    setIsRunning(true);
    try {
      // Clear previous highlights before fresh run
      await collectorClearHighlights(invoke);

      if (!isMountedRef.current) return;

      // Real live DOM inspection strictly bounded to current visible viewport (no scroll)
      const snapshot = await collectorInspectDom(invoke, currentUrl, draftRef.current.layoutContext);

      if (!isMountedRef.current) return;

      const result = executeLiveBrowserMatchTest(draftRef.current.regions ?? [], snapshot);

      // Inject live visual highlights on WebContentsView
      if (result.matchedItems && result.matchedItems.length > 0 && isMountedRef.current) {
        await collectorHighlightMatches(invoke, result.matchedItems);
      }

      if (isMountedRef.current) {
        onChangeRef.current({ ...draftRef.current, matchTest: result, dirty: true });
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Match Test failed: ${msg}`);
      const failedResult: MatchTestResult = {
        testedAt: new Date().toISOString(),
        browserUrl: currentUrl,
        status: "FAILED",
        matchedPostCount: 0,
        groups: [],
        matchedItems: [],
        summary: `Match Test failed: ${msg}`,
        error: msg,
      };
      onChangeRef.current({ ...draftRef.current, matchTest: failedResult, dirty: true });
    } finally {
      isRunningRef.current = false;
      if (isMountedRef.current) {
        setIsRunning(false);
      }
    }
  }, [invoke, currentUrl]);

  // 1. Browser Host Lifecycle: Mounted ONCE when entering Step 3, unmounted ONCE when leaving Step 3.
  // Independent of isRunning, draft updates, match results, or React re-renders.
  useEffect(() => {
    isMountedRef.current = true;
    const isAvailable = isElectronBrowserCoreAvailable();
    setBrowserConnected(isAvailable);

    if (!isAvailable || !invoke) return;

    // Attach native WebContentsView to hostRef
    publishHost();
    void collectorSetBrowserVisible(invoke, true).then(() => {
      if (isMountedRef.current) publishHost();
    });

    const el = hostRef.current;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (isMountedRef.current) publishHost();
          })
        : null;
    if (el && ro) ro.observe(el);

    const onResize = () => {
      if (isMountedRef.current) publishHost();
    };
    window.addEventListener("resize", onResize);

    return () => {
      isMountedRef.current = false;
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      lastBoundsRef.current = null;
      void collectorClearHighlights(invoke);
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    };
  }, [invoke, publishHost]);

  // 2. Initial Match Execution Lifecycle: Runs exactly ONCE when the browser session is ready.
  useEffect(() => {
    if (!hasAutoRunRef.current && isElectronBrowserCoreAvailable() && invoke) {
      hasAutoRunRef.current = true;
      const timer = setTimeout(() => {
        if (isMountedRef.current) {
          void handleRunMatchTest();
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [invoke, handleRunMatchTest]);

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
            {isRunning ? "Running Match Test..." : "↻ Re-run Match Test"}
          </button>
        </div>
      </div>

      {!browserConnected && (
        <div className="collector-banner warn" role="alert">
          <b>Browser Core Disconnected:</b> Live Browser Match Test requires an active Browser Session.
          Please open or navigate to the target social site in the browser before running match tests.
        </div>
      )}

      {errorMsg && (
        <div className="collector-banner error" role="alert">
          {errorMsg}
        </div>
      )}

      {/* Main Split Layout: Live Browser Host (Left) | Diagnostics Dock (Right) */}
      <div className="collector-match-split-view">
        {/* Left: Live Browser Viewport */}
        <div className="collector-match-browser-area">
          <div className="collector-match-browser-toolbar">
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#93c5fd" }}>
              🌐 Live Browser Viewport
            </span>
            <span className="collector-match-limit-tag">
              Bounded Viewport · Max 3 Posts
            </span>
          </div>

          <div
            ref={hostRef}
            className="collector-browser-host-frame"
            id="collector-match-test-host"
          >
            {!browserConnected && (
              <div className="collector-browser-disconnected-placeholder">
                <p>Browser view unavailable in current environment.</p>
                <small>Run inside Electron RPA Creator to see native WebContentsView overlay.</small>
              </div>
            )}
          </div>
        </div>

        {/* Right: Diagnostics Dock */}
        <div className="collector-match-diagnostics-dock">
          {/* Summary Status Card */}
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
                  {new Date(matchTestResult.testedAt).toLocaleTimeString()}
                </small>
              )}
            </div>

            {matchTestResult?.summary && (
              <p className="collector-match-summary-text">{matchTestResult.summary}</p>
            )}
          </div>

          {/* Viewport Candidates (Max 3) */}
          <div className="collector-match-items-section">
            <div className="collector-match-items-head-row">
              <h4 className="collector-section-title" style={{ margin: 0 }}>
                Viewport Candidates (Limit: 3)
              </h4>
              <div className="collector-candidate-counts">
                <span className="collector-count-pill inspected">
                  Inspected: <b>{inspectedCount}</b>
                </span>
                <span
                  className={`collector-count-pill matched ${
                    resolvedMatchedCount > 0 ? "has-matches" : "zero"
                  }`}
                >
                  Matched: <b>{resolvedMatchedCount}</b>
                </span>
              </div>
            </div>

            {(!matchTestResult?.matchedItems || matchTestResult.matchedItems.length === 0) && (
              <div className="collector-sample-empty">
                {status === "NOT TESTED"
                  ? "Click 'Re-run Match Test' to evaluate anchors on the live page."
                  : "0 posts matched in the current visible viewport. Check that the page is loaded and matching anchor regions are visible."}
              </div>
            )}

            {matchTestResult?.matchedItems?.map((item: MatchedPostItem) => {
              const themeColor =
                item.index === 1 ? "#38bdf8" : item.index === 2 ? "#818cf8" : "#a78bfa";
              return (
                <div
                  key={`matched-item-${item.index}-${item.groupTag}`}
                  className={`collector-match-item-card ${item.domResolved ? "resolved" : "failed"}`}
                  style={{ borderLeftColor: themeColor }}
                >
                  <div className="collector-match-item-head">
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span
                        className="collector-match-num-badge"
                        style={{ backgroundColor: themeColor }}
                      >
                        #{item.index}
                      </span>
                      <b>Post Container</b>
                      <span className="collector-group-tag-pill">#{item.groupTag}</span>
                    </div>
                    <span
                      className={`collector-match-pill small ${
                        item.domResolved ? "status-matched" : "status-failed"
                      }`}
                    >
                      {item.domResolved ? "CONFIRMED" : "NOT RESOLVED"}
                    </span>
                  </div>

                  {item.failureReason && (
                    <div className="collector-match-failure-reason">
                      <b>Rejection:</b> {item.failureReason}
                    </div>
                  )}

                  <div className="collector-match-item-stages">
                    {/* BEGIN Stage */}
                    <div className="collector-stage-row">
                      <span className="collector-stage-label">BEGIN Anchor:</span>
                      {item.beginMatched ? (
                        <span className="collector-stage-status success">
                          ✓ Found {item.beginRect ? `(${item.beginRect.width}×${item.beginRect.height} at y:${item.beginRect.y})` : ""}
                        </span>
                      ) : (
                        <span className="collector-stage-status error">✗ Not Found</span>
                      )}
                    </div>

                    {/* END Stage */}
                    <div className="collector-stage-row">
                      <span className="collector-stage-label">END Anchor:</span>
                      {item.endMatched ? (
                        <span className="collector-stage-status success">
                          ✓ Found {item.endRect ? `(${item.endRect.width}×${item.endRect.height} at y:${item.endRect.y})` : ""}
                        </span>
                      ) : (
                        <span className="collector-stage-status error">✗ Not Found</span>
                      )}
                    </div>

                    {/* Pairing Stage */}
                    <div className="collector-stage-row">
                      <span className="collector-stage-label">Pairing:</span>
                      {item.paired ? (
                        <span className="collector-stage-status success">
                          ✓ Spatial Order Verified (Top-to-Bottom)
                        </span>
                      ) : (
                        <span className="collector-stage-status error">✗ Pairing Failed</span>
                      )}
                    </div>

                    {/* DOM Container Stage */}
                    <div className="collector-stage-row">
                      <span className="collector-stage-label">DOM Container:</span>
                      {item.domResolved ? (
                        <span className="collector-stage-status success">
                          ✓ Resolved <code>&lt;{item.containerTagName || "container"}&gt;</code>
                        </span>
                      ) : (
                        <span className="collector-stage-status error">✗ No Common Ancestor</span>
                      )}
                    </div>

                    {/* Confidence */}
                    <div className="collector-stage-row">
                      <span className="collector-stage-label">Confidence:</span>
                      <span style={{ color: item.confidence >= 70 ? "#68d6a6" : "#e0b35a" }}>
                        {item.confidence}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Group Verification Details */}
          {matchTestResult?.groups && matchTestResult.groups.length > 0 && (
            <div className="collector-match-groups-list">
              <h4 className="collector-section-title">Anchor Group Rules ({matchTestResult.groups.length})</h4>
              {matchTestResult.groups.map((group: PostGroupMatch) => (
                <div
                  className={`collector-group-match-card status-${group.status.toLowerCase()}`}
                  key={group.groupTag}
                >
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
                      <b>Rejection:</b> {group.failureReason}
                    </div>
                  )}

                  {group.domContainer && (
                    <div className="collector-dom-container-info">
                      <b>Resolved Container:</b> <code>&lt;{group.domContainer.tagName}&gt;</code> (depth: {group.domContainer.depth}, card: {group.domContainer.isArticleOrCard ? "Yes" : "No"})
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Engine Limitations */}
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
      </div>
    </div>
  );
}
