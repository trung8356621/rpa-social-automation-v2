import React, { useState, useEffect, useRef, useCallback } from "react";
import type { State } from "../../shared/contracts.js";
import type {
  CollectorDraft,
  MatchTestResult,
  MatchedPostItem,
  PostGroupMatch,
} from "../../shared/collectors/types.js";
import {
  executeLiveBrowserMatchTest,
  buildLearnedAnchorRules,
  findAnchorCandidates,
  findLowestCommonAncestor,
  verifyAnchorGroups,
} from "../../shared/collectors/regions.js";
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
  // C2.10.6: Interactive Match Mode toggle (default OFF)
  const [matchMode, setMatchMode] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [browserConnected, setBrowserConnected] = useState<boolean>(false);
  const [showDiagnostic, setShowDiagnostic] = useState<boolean>(false);
  const [isDiagRunning, setIsDiagRunning] = useState<boolean>(false);
  const [diagReport, setDiagReport] = useState<{
    timestamp: string;
    url: string;
    viewport: { width: number; height: number };
    totalNodes: number;
    inViewportNodes: number;
    parentLinkedNodes: number;
    articlesFound: number;
    feedsFound: number;
    groups: Array<{
      tag: string;
      beginAnchor: string;
      beginCandidates: Array<{ id: string; tag: string; score: number; text: string; rect: { x: number; y: number; width: number; height: number } }>;
      endAnchor: string;
      endCandidates: Array<{ id: string; tag: string; score: number; text: string; rect: { x: number; y: number; width: number; height: number } }>;
      lcaResolved?: string;
      status: string;
      rejectionReason?: string;
    }>;
  } | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const isRunningRef = useRef<boolean>(false);
  const matchModeRef = useRef<boolean>(false);
  const runIdRef = useRef<number>(0);
  // Auto-run on entry replaced by explicit Match Mode toggle; ref retained for compatibility
  const hasAutoRunRef = useRef<boolean>(false);

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
  const rawStatus = matchTestResult?.status ?? "NOT TESTED";

  // Counts: clearly separate inspected viewport candidates from actually resolved post matches
  const inspectedCount = matchTestResult?.matchedItems?.length ?? 0;
  const resolvedMatchedCount =
    matchTestResult?.matchedPostCount ??
    matchTestResult?.matchedItems?.filter((item) => item.domResolved).length ??
    0;

  // Differentiate NO MATCH (inspection succeeded but 0 containers matched) from execution/browser failures (ERROR/FAILED)
  const isExecutionError = Boolean(
    errorMsg ||
    matchTestResult?.error?.includes("unavailable") ||
    matchTestResult?.error?.includes("empty") ||
    matchTestResult?.error?.includes("Stale")
  );
  const displayStatus =
    rawStatus === "FAILED" && !isExecutionError && resolvedMatchedCount === 0
      ? "NO MATCH"
      : rawStatus;

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
  // Single-run guarantee with runIdRef and isRunningRef to drop stale results
  const runViewportMatch = useCallback(async () => {
    if (lockedRef.current || isRunningRef.current) return;
    if (!matchModeRef.current) return;

    const currentRunId = ++runIdRef.current;
    isRunningRef.current = true;
    setIsRunning(true);
    setErrorMsg(null);

    if (!isElectronBrowserCoreAvailable() || !invoke) {
      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        isRunningRef.current = false;
        setIsRunning(false);
        return;
      }
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
      isRunningRef.current = false;
      setIsRunning(false);
      return;
    }

    try {
      // Clear previous highlights before fresh run
      await collectorClearHighlights(invoke);

      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        return;
      }

      // Real live DOM inspection strictly bounded to current visible viewport (NO SCROLL)
      const snapshot = await collectorInspectDom(invoke, currentUrl, draftRef.current.layoutContext);

      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        return;
      }

      const result = executeLiveBrowserMatchTest(draftRef.current.regions ?? [], snapshot, draftRef.current);

      // Filter to highlight ONLY successfully resolved containers (never unresolved candidates)
      const resolvedMatches = (result.matchedItems || []).filter((item) => item.domResolved);

      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        await collectorClearHighlights(invoke);
        return;
      }

      if (resolvedMatches.length > 0) {
        await collectorHighlightMatches(invoke, resolvedMatches);
      } else {
        await collectorClearHighlights(invoke);
      }

      if (isMountedRef.current && currentRunId === runIdRef.current && matchModeRef.current) {
        onChangeRef.current({ ...draftRef.current, matchTest: result, dirty: true });
      }
    } catch (err) {
      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        return;
      }
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
      if (currentRunId === runIdRef.current) {
        isRunningRef.current = false;
        if (isMountedRef.current) {
          setIsRunning(false);
        }
      }
    }
  }, [invoke, currentUrl]);

  // Run Opt-In Real DOM Diagnostic
  const handleRunDiagnostic = useCallback(async () => {
    if (!invoke || !isElectronBrowserCoreAvailable()) {
      alert("Browser Core session unavailable. Live DOM Diagnostic requires an active Electron browser session.");
      return;
    }
    setIsDiagRunning(true);
    try {
      const snapshot = await collectorInspectDom(invoke, currentUrl, draftRef.current.layoutContext);
      const learnedRules = buildLearnedAnchorRules(draftRef.current);
      const elementMap = new Map(snapshot.elements.map((e) => [e.id, e]));

      const groupsDiag: Array<{
        tag: string;
        beginAnchor: string;
        beginCandidates: Array<{ id: string; tag: string; score: number; text: string; rect: { x: number; y: number; width: number; height: number } }>;
        endAnchor: string;
        endCandidates: Array<{ id: string; tag: string; score: number; text: string; rect: { x: number; y: number; width: number; height: number } }>;
        lcaResolved?: string;
        status: string;
        rejectionReason?: string;
      }> = [];

      const analysis = verifyAnchorGroups(draftRef.current.regions ?? []);
      for (const [tag, group] of analysis.groups.entries()) {
        if (!group.begin || !group.end) continue;
        const ruleGroup = learnedRules.get(tag);
        const bCands = findAnchorCandidates(group.begin, snapshot.elements, ruleGroup?.beginRule);
        const eCands = findAnchorCandidates(group.end, snapshot.elements, ruleGroup?.endRule);

        let lcaStr: string | undefined = undefined;
        let pairStatus = "NO_CANDIDATES";
        let rejReason: string | undefined = undefined;

        if (bCands.length > 0 && eCands.length > 0) {
          const b = bCands[0]!;
          const e = eCands[0]!;
          const isVert = e.el.rect.y > b.el.rect.y + b.el.rect.height - 5;
          if (!isVert) {
            pairStatus = "INVERTED_ORDER";
            rejReason = `END (<${e.el.tagName}> at y:${e.el.rect.y}) is above BEGIN (<${b.el.tagName}> at y:${b.el.rect.y})`;
          } else {
            const lca = findLowestCommonAncestor(b.el.id, e.el.id, elementMap);
            if (!lca) {
              pairStatus = "DISJOINT_DOM";
              rejReason = "No common ancestor between BEGIN and END candidates";
            } else if (lca.isFeedContainer || lca.role === "feed" || lca.tagName === "BODY" || lca.tagName === "HTML") {
              pairStatus = "BROAD_FEED";
              rejReason = `Lowest common ancestor <${lca.tagName}> is a broad feed container`;
            } else {
              pairStatus = "RESOLVED";
              lcaStr = `<${lca.tagName}> [${lca.id}] (${lca.rect.width}×${lca.rect.height} at y:${lca.rect.y})`;
            }
          }
        } else {
          rejReason = `BEGIN cands: ${bCands.length}, END cands: ${eCands.length}`;
        }

        groupsDiag.push({
          tag,
          beginAnchor: group.begin.label,
          beginCandidates: bCands.slice(0, 3).map((c: (typeof bCands)[number]) => ({
            id: c.el.id,
            tag: c.el.tagName,
            score: c.score,
            text: c.el.textSnippet.slice(0, 40),
            rect: c.el.rect,
          })),
          endAnchor: group.end.label,
          endCandidates: eCands.slice(0, 3).map((c: (typeof eCands)[number]) => ({
            id: c.el.id,
            tag: c.el.tagName,
            score: c.score,
            text: c.el.textSnippet.slice(0, 40),
            rect: c.el.rect,
          })),
          lcaResolved: lcaStr,
          status: pairStatus,
          rejectionReason: rejReason,
        });
      }

      setDiagReport({
        timestamp: new Date().toISOString(),
        url: snapshot.url,
        viewport: { width: snapshot.viewport.width, height: snapshot.viewport.height },
        totalNodes: snapshot.elements.length,
        inViewportNodes: snapshot.elements.filter(
          (e) => e.rect.y >= 0 && e.rect.y <= snapshot.viewport.height && e.rect.width > 0 && e.rect.height > 0,
        ).length,
        parentLinkedNodes: snapshot.elements.filter((e) => e.parentId !== undefined).length,
        articlesFound: snapshot.elements.filter((e) => e.isArticleOrCard || e.role === "article").length,
        feedsFound: snapshot.elements.filter((e) => e.isFeedContainer || e.role === "feed").length,
        groups: groupsDiag,
      });
      setShowDiagnostic(true);
    } catch (err) {
      alert("Diagnostic inspection failed: " + String(err));
    } finally {
      setIsDiagRunning(false);
    }
  }, [invoke, currentUrl]);

  // Alias for backward compatibility
  const handleRunMatchTest = runViewportMatch;

  // Handle explicit Match Mode toggling (OFF / ON)
  const handleToggleMatchMode = useCallback(
    (nextMode: boolean) => {
      if (lockedRef.current) return;
      if (nextMode === matchModeRef.current) return;

      matchModeRef.current = nextMode;
      setMatchMode(nextMode);

      if (nextMode) {
        // Switching ON: Trigger exactly one match operation
        void runViewportMatch();
      } else {
        // Switching OFF: Invalidate any in-flight run, clear highlights, return to normal browser
        runIdRef.current++;
        isRunningRef.current = false;
        setIsRunning(false);
        setErrorMsg(null);
        if (invoke && isElectronBrowserCoreAvailable()) {
          void collectorClearHighlights(invoke);
        }
      }
    },
    [invoke, runViewportMatch],
  );

  // 1. Browser Host Lifecycle: Mounted ONCE when entering Step 3, unmounted ONCE when leaving Step 3.
  // Independent of isRunning, matchMode, draft updates, match results, or React re-renders.
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
      // Invalidate in-flight operations and clear visual highlights
      runIdRef.current++;
      isRunningRef.current = false;
      matchModeRef.current = false;
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      lastBoundsRef.current = null;
      void collectorClearHighlights(invoke);
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
      // NOTE: Browser session itself is preserved and NOT closed/destroyed.
    };
  }, [invoke, publishHost]);

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
          {/* Prominent Match Mode Toggle (OFF / ON) */}
          <div className="collector-match-mode-control">
            <span className="collector-match-mode-label">Match Mode:</span>
            <div className="collector-match-mode-toggle" role="radiogroup" aria-label="Match Mode">
              <button
                type="button"
                className={`collector-toggle-btn ${!matchMode ? "active off" : ""}`}
                disabled={locked}
                onClick={() => handleToggleMatchMode(false)}
                aria-checked={!matchMode}
                role="radio"
              >
                OFF
              </button>
              <button
                type="button"
                className={`collector-toggle-btn ${matchMode ? "active on" : ""}`}
                disabled={locked}
                onClick={() => handleToggleMatchMode(true)}
                aria-checked={matchMode}
                role="radio"
              >
                ON
              </button>
            </div>
          </div>

          <button
            type="button"
            className="primary collector-btn-rematch"
            disabled={locked || isRunning || !matchMode}
            onClick={() => void runViewportMatch()}
            title="Re-run Match Test on current visible viewport"
          >
            {isRunning ? "Testing Viewport..." : "↻ Re-match Current Viewport"}
          </button>

          <button
            type="button"
            className="collector-btn-diag"
            disabled={locked || isDiagRunning}
            onClick={() => void handleRunDiagnostic()}
            title="Inspect real Facebook/page DOM nodes in viewport and export diagnostic report"
            style={{
              padding: "6px 12px",
              background: "#1c2538",
              border: "1px solid #3b4c68",
              color: "#9eb4d0",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            {isDiagRunning ? "Inspecting DOM..." : "🔍 DOM Diagnostic"}
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
              🌐 Live Browser Viewport {matchMode ? "(Match Mode Active)" : "(Interactive Browsing)"}
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
          {/* Instruction when Match Mode is OFF */}
          {!matchMode && (
            <div className="collector-match-off-instruction">
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontSize: "16px" }}>ℹ️</span>
                <b style={{ color: "#38bdf8" }}>Match Mode is OFF</b>
              </div>
              <p style={{ margin: "0 0 6px 0" }}>
                The live browser is interactive. Scroll and navigate normally to view the target feed or posts.
              </p>
              <p style={{ margin: 0 }}>
                When ready, switch <b>Match Mode to ON</b> to evaluate anchor matching and DOM container resolution on the current visible viewport.
              </p>
            </div>
          )}

          {/* Summary Status Card */}
          <div className="collector-match-summary-card">
            <div className="collector-match-status-bar">
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <span className="collector-subheading">Status:</span>
                <span
                  className={`collector-match-pill status-${displayStatus.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {displayStatus}
                </span>
                {matchTestResult && (
                  <span className="collector-post-count-badge">
                    {resolvedMatchedCount} post(s) matched
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

            {(!matchTestResult?.matchedItems || matchTestResult.matchedItems.length === 0 || resolvedMatchedCount === 0) && (
              <div className="collector-sample-empty">
                {displayStatus === "NOT TESTED"
                  ? "Switch Match Mode to ON to evaluate anchors on the live page."
                  : displayStatus === "NO MATCH"
                    ? "0 posts matched in the current visible viewport. Scroll the browser to visible posts and click 'Re-match Current Viewport'."
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

      {/* Opt-in Runtime DOM Diagnostic Modal */}
      {showDiagnostic && diagReport && (
        <div className="collector-capture-library-layer" role="dialog" aria-modal="true" aria-label="Real DOM Diagnostic">
          <button
            type="button"
            className="collector-versions-backdrop"
            aria-label="Close Diagnostic"
            onClick={() => setShowDiagnostic(false)}
          />
          <div
            className="collector-capture-library-drawer"
            style={{ maxWidth: "720px", background: "#111827", color: "#e5e7eb", padding: "20px", overflowY: "auto", maxHeight: "90vh" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "16px" }}>🔬 Real Electron DOM Diagnostic Report</h3>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  style={{ padding: "4px 10px", fontSize: "12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
                  onClick={() => {
                    void navigator.clipboard.writeText(JSON.stringify(diagReport, null, 2));
                    alert("Diagnostic report copied to clipboard!");
                  }}
                >
                  📋 Copy JSON
                </button>
                <button
                  type="button"
                  style={{ padding: "4px 10px", fontSize: "12px", background: "#374151", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
                  onClick={() => setShowDiagnostic(false)}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px", background: "#1f2937", padding: "12px", borderRadius: "6px", fontSize: "12px" }}>
              <div><b>Captured At:</b> {diagReport.timestamp.slice(11, 19)}</div>
              <div><b>Viewport:</b> {diagReport.viewport.width} × {diagReport.viewport.height}</div>
              <div><b>Total Viewport Nodes:</b> {diagReport.totalNodes}</div>
              <div><b>Parent-Linked Nodes:</b> {diagReport.parentLinkedNodes} / {diagReport.totalNodes}</div>
              <div><b>Post Articles in Viewport:</b> {diagReport.articlesFound}</div>
              <div><b>Feed Containers:</b> {diagReport.feedsFound}</div>
            </div>

            <h4 style={{ fontSize: "14px", margin: "12px 0 8px 0" }}>Anchor Candidate Evaluation:</h4>
            {diagReport.groups.map((g) => (
              <div
                key={g.tag}
                style={{ background: "#1f2937", border: "1px solid #374151", borderRadius: "6px", padding: "12px", marginBottom: "12px", fontSize: "12px" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <b>Group #{g.tag}</b>
                  <span style={{ color: g.status === "RESOLVED" ? "#10b981" : "#ef4444", fontWeight: "bold" }}>
                    Status: {g.status}
                  </span>
                </div>
                {g.rejectionReason && (
                  <div style={{ color: "#f87171", marginBottom: "6px" }}>
                    <b>Rejection:</b> {g.rejectionReason}
                  </div>
                )}
                {g.lcaResolved && (
                  <div style={{ color: "#34d399", marginBottom: "6px" }}>
                    <b>Resolved Container (LCA):</b> {g.lcaResolved}
                  </div>
                )}

                <div style={{ marginTop: "8px" }}>
                  <div style={{ color: "#93c5fd" }}><b>BEGIN:</b> "{g.beginAnchor}" ({g.beginCandidates.length} candidates)</div>
                  {g.beginCandidates.map((c) => (
                    <div key={c.id} style={{ marginLeft: "12px", color: "#9ca3af" }}>
                      • &lt;{c.tag}&gt; [{c.id}] score={c.score} y={c.rect.y} text="{c.text}"
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: "8px" }}>
                  <div style={{ color: "#c084fc" }}><b>END:</b> "{g.endAnchor}" ({g.endCandidates.length} candidates)</div>
                  {g.endCandidates.map((c) => (
                    <div key={c.id} style={{ marginLeft: "12px", color: "#9ca3af" }}>
                      • &lt;{c.tag}&gt; [{c.id}] score={c.score} y={c.rect.y} text="{c.text}"
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
