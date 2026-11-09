import React, { useState, useEffect, useRef, useCallback } from "react";
import type { State } from "../../shared/contracts.js";
import type {
  CollectorDraft,
  MatchTestResult,
  MatchedPostItem,
  PostGroupMatch,
  EndVisualCandidate,
  EndVisualMatchResult,
  BeginLayoutCandidate,
  BeginLayoutMatchResult,
  BeginBlockCandidate,
  BeginBlockMatchResult,
  CollectorRegion,
} from "../../shared/collectors/types.js";
import {
  executeLiveBrowserMatchTest,
} from "../../shared/collectors/regions.js";
import { domRectToShellBounds } from "../../shared/collector-browser-host.js";
import { readAdminUiZoom } from "../ui-zoom.js";
import {
  collectorInspectDom,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  collectorHighlightMatches,
  collectorClearHighlights,
  collectorLogMatchDiagnostic,
  collectorMatchEndVisual,
  collectorHighlightEndVisual,
  collectorMatchBeginLayout,
  collectorHighlightBeginLayout,
  collectorMatchBeginBlockLayout,
  collectorHighlightBeginBlockLayout,
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

  // C2.11.12: Isolated END-only Visual Matching experiment mode
  // C2.11.13: Isolated BEGIN layout matching experiment (B3)
  // C2.11.15: Isolated BEGIN block layout matching experiment (B3 V2)
  const [matchExperimentMode, setMatchExperimentMode] = useState<
    "BEGIN_PRIMARY" | "END_ONLY_VISUAL" | "BEGIN_LAYOUT_B3" | "BEGIN_BLOCK_B3_V2"
  >("BEGIN_PRIMARY");
  const [endVisualResult, setEndVisualResult] = useState<EndVisualMatchResult | null>(null);
  const [beginLayoutResult, setBeginLayoutResult] = useState<BeginLayoutMatchResult | null>(null);
  const [beginBlockResult, setBeginBlockResult] = useState<BeginBlockMatchResult | null>(null);
  const matchExperimentModeRef = useRef<
    "BEGIN_PRIMARY" | "END_ONLY_VISUAL" | "BEGIN_LAYOUT_B3" | "BEGIN_BLOCK_B3_V2"
  >("BEGIN_PRIMARY");
  matchExperimentModeRef.current = matchExperimentMode;

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
    matchExperimentMode === "BEGIN_BLOCK_B3_V2" && beginBlockResult
      ? beginBlockResult.status === "NO_REFERENCES"
        ? "NO REFERENCES"
        : beginBlockResult.status === "NO_MATCH"
          ? "NO MATCH"
          : beginBlockResult.status === "MATCHED"
            ? "MATCHED"
            : beginBlockResult.status === "PARTIAL"
              ? "PARTIAL"
              : rawStatus
      : matchExperimentMode === "BEGIN_LAYOUT_B3" && beginLayoutResult
        ? beginLayoutResult.status === "NO_REFERENCES"
          ? "NO REFERENCES"
          : beginLayoutResult.status === "NO_MATCH"
            ? "NO MATCH"
            : beginLayoutResult.status === "MATCHED"
              ? "MATCHED"
              : beginLayoutResult.status === "PARTIAL"
                ? "PARTIAL"
                : rawStatus
        : rawStatus === "FAILED" && !isExecutionError && resolvedMatchedCount === 0
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

      // C2.11.12: Isolated END-Only Visual Matching Experiment
      if (matchExperimentModeRef.current === "END_ONLY_VISUAL") {
        const allRegions = [
          ...(draftRef.current.regions ?? []),
          ...(draftRef.current.captures ?? []).flatMap((c) => c.regions ?? []),
        ];
        const endRegions = allRegions.filter(
          (r) => r.confirmed && (r.type === "END" || (r.type === "STATIC" && r.role === "footer")),
        );

        if (endRegions.length === 0) {
          setErrorMsg(
            "No confirmed END regions found in teaching samples. Please confirm an END region in Step 2A first.",
          );
          isRunningRef.current = false;
          setIsRunning(false);
          return;
        }

        const references = endRegions.map((r) => ({
          sampleId: r.captureItemId,
          referenceImage: r.referenceImage,
          assetId: r.referenceImageAsset,
          originalRoi: r.originalRoi,
        }));

        const visualResult = await collectorMatchEndVisual(invoke, references);
        setEndVisualResult(visualResult);

        // File-based structured diagnostic logging
        try {
          const diagRecord = {
            timestamp: new Date().toISOString(),
            matchRunId: `match_run_end_visual_${currentRunId}_${Date.now()}`,
            mode: "END_ONLY_VISUAL",
            sessionId: draftRef.current.id,
            url: currentUrl,
            matchingTechnique: visualResult.technique,
            referenceEndSampleIds: visualResult.referenceSampleIds,
            referenceCropDimensions: visualResult.diagnostics.referenceCropDimensions,
            screenshotDimensions: visualResult.screenshotDimensions,
            scale: visualResult.scale,
            status: visualResult.status,
            matchedFooters: visualResult.matchedFooters,
            rejectedCandidates: visualResult.rejectedCandidates,
            durationMs: visualResult.diagnostics.durationMs,
          };
          void collectorLogMatchDiagnostic(invoke, diagRecord);
        } catch (logErr) {
          console.error("End visual match diagnostic logging failed", logErr);
        }

        if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
          await collectorClearHighlights(invoke);
          return;
        }

        if (visualResult.matchedFooters.length > 0) {
          await collectorHighlightEndVisual(invoke, visualResult.matchedFooters);
        } else {
          await collectorClearHighlights(invoke);
        }

        const expTestResult: MatchTestResult = {
          testedAt: visualResult.testedAt,
          browserUrl: currentUrl,
          status: visualResult.status === "MATCHED" ? "MATCHED" : "FAILED",
          matchedPostCount: visualResult.matchedFooters.length,
          groups: [],
          summary: visualResult.diagnostics.summary,
          endVisualExperiment: visualResult,
        };
        onChangeRef.current({ ...draftRef.current, matchTest: expTestResult, dirty: true });
        return;
      }

      // C2.11.13: Isolated BEGIN Layout Matching Experiment (B3)
      if (matchExperimentModeRef.current === "BEGIN_LAYOUT_B3") {
        const captures = draftRef.current.captures ?? [];
        const captureAuditMap = new Map(
          (draftRef.current.captureAudits ?? []).map((a) => [a.captureItemId, a.status]),
        );
        const teachingCaptureId = draftRef.current.teachingCaptureId;

        // Gather all regions from top-level and capture-level, deduplicated by region ID
        const regionMap = new Map<string, CollectorRegion>();
        for (const r of [
          ...(draftRef.current.regions ?? []),
          ...captures.flatMap((c) => c.regions ?? []),
        ]) {
          if (!r?.id) continue;
          const existing = regionMap.get(r.id);
          // Prefer region with inline referenceImage if one exists
          if (!existing || (!existing.referenceImage && r.referenceImage)) {
            regionMap.set(r.id, r);
          }
        }
        const uniqueRegions = Array.from(regionMap.values());

        // Structured pipeline logging for every candidate region
        const regionalLogs: Array<{
          collectorId: string;
          sampleId: string;
          regionId: string;
          anchorGroup: string;
          confirmationStatus: string;
          referenceImageAvailability: string;
          cropDimensions: string;
          reason: string;
          accepted: boolean;
          region: CollectorRegion;
        }> = [];

        for (const r of uniqueRegions) {
          const isBeginType =
            r.type === "BEGIN" ||
            (r.type === "STATIC" && r.role === "header") ||
            r.role === "header";
          const parentCap = captures.find((c) => c.id === r.captureItemId);
          const isConfirmedAudit = parentCap
            ? captureAuditMap.get(parentCap.id) === "confirmed"
            : false;
          const isTeaching = parentCap ? parentCap.id === teachingCaptureId : false;
          const isConfirmed = Boolean(r.confirmed || isConfirmedAudit || isTeaching);

          const w =
            r.originalRoi?.width ??
            (r.geometry ? Math.round(r.geometry.relW * 1280) : 0);
          const h =
            r.originalRoi?.height ??
            (r.geometry ? Math.round(r.geometry.relH * 800) : 0);
          const cropDims = `${w}x${h}`;

          const hasRefImage = Boolean(r.referenceImage);
          const hasAsset = Boolean(parentCap?.imageAsset || r.referenceImageAsset);
          const refImgAvail = hasRefImage
            ? "inline_data_url"
            : hasAsset
              ? "parent_capture_asset"
              : "none";

          let accepted = false;
          let reason = "";

          if (!isBeginType) {
            reason = `Skipped: region type '${r.type}' (role: ${r.role || "none"}) is not a BEGIN/header`;
          } else if (!isConfirmed) {
            reason = "Skipped: region and parent sample are both unconfirmed";
          } else if (!hasRefImage && !hasAsset) {
            reason = "Skipped: neither inline referenceImage nor parent screenshot asset found";
          } else {
            accepted = true;
            reason = `Accepted: confirmed BEGIN anchor (${hasRefImage ? "inline crop" : "parent capture asset"})`;
          }

          regionalLogs.push({
            collectorId: draftRef.current.id,
            sampleId: r.captureItemId,
            regionId: r.id,
            anchorGroup: r.groupTag || "default",
            confirmationStatus: r.confirmed
              ? "confirmed_region"
              : isTeaching
                ? "teaching_sample"
                : isConfirmedAudit
                  ? "confirmed_audit"
                  : "unconfirmed",
            referenceImageAvailability: refImgAvail,
            cropDimensions: cropDims,
            reason,
            accepted,
            region: r,
          });
        }

        console.info(
          `[B3 Pipeline Stage 1-3] BEGIN Reference Candidates (evaluated ${uniqueRegions.length} region(s)):`,
          regionalLogs,
        );

        const acceptedRegions = regionalLogs
          .filter((item) => item.accepted)
          .map((item) => item.region);

        if (acceptedRegions.length === 0) {
          const detailReasons = regionalLogs
            .map((item) => `[Region ${item.regionId} in Sample ${item.sampleId}]: ${item.reason}`)
            .join("; ");
          setErrorMsg(
            detailReasons
              ? `No usable confirmed BEGIN reference crops found: ${detailReasons}`
              : "No confirmed BEGIN regions found in teaching samples. Please confirm a BEGIN region in Step 2A first.",
          );
          isRunningRef.current = false;
          setIsRunning(false);
          return;
        }

        const references = acceptedRegions.map((r) => {
          const parentCap = captures.find((c) => c.id === r.captureItemId);
          return {
            sampleId: r.captureItemId,
            regionId: r.id,
            groupTag: r.groupTag,
            referenceImage: r.referenceImage,
            assetId: parentCap?.imageAsset || r.referenceImageAsset,
            captureId: r.captureItemId,
            originalRoi: r.originalRoi,
            geometry: r.geometry,
          };
        });

        const layoutResult = await collectorMatchBeginLayout(invoke, references);
        setBeginLayoutResult(layoutResult);

        // File-based structured diagnostic logging
        try {
          const diagRecord = {
            timestamp: new Date().toISOString(),
            matchRunId: `match_run_begin_layout_${currentRunId}_${Date.now()}`,
            mode: "BEGIN_LAYOUT_B3",
            sessionId: draftRef.current.id,
            url: currentUrl,
            matchingTechnique: layoutResult.technique,
            referenceBeginSampleIds: layoutResult.referenceSampleIds,
            referenceCropDimensions: layoutResult.diagnostics.referenceCropDimensions,
            screenshotDimensions: layoutResult.screenshotDimensions,
            scale: layoutResult.scale,
            status: layoutResult.status,
            matchedHeaders: layoutResult.matchedHeaders,
            rejectedCandidates: layoutResult.rejectedCandidates,
            durationMs: layoutResult.diagnostics.durationMs,
            pipelineLogs: regionalLogs.map(({ region: _reg, ...rest }) => rest),
          };
          void collectorLogMatchDiagnostic(invoke, diagRecord);
        } catch (logErr) {
          console.error("Begin layout match diagnostic logging failed", logErr);
        }

        if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
          await collectorClearHighlights(invoke);
          return;
        }

        if (layoutResult.matchedHeaders.length > 0) {
          await collectorHighlightBeginLayout(invoke, layoutResult.matchedHeaders);
        } else {
          await collectorClearHighlights(invoke);
        }

        const expTestResult: MatchTestResult = {
          testedAt: layoutResult.testedAt,
          browserUrl: currentUrl,
          status:
            layoutResult.status === "MATCHED"
              ? "MATCHED"
              : layoutResult.status === "NO_REFERENCES"
                ? ("NO_REFERENCES" as any)
                : "FAILED",
          matchedPostCount: layoutResult.matchedHeaders.length,
          groups: [],
          summary: layoutResult.diagnostics.summary,
          beginLayoutExperiment: layoutResult,
        };
        onChangeRef.current({ ...draftRef.current, matchTest: expTestResult, dirty: true });
        return;
      }

      // C2.11.15: Isolated BEGIN block layout matching experiment (B3 V2)
      if (matchExperimentModeRef.current === "BEGIN_BLOCK_B3_V2") {
        const captures = draftRef.current.captures ?? [];
        const captureAuditMap = new Map(
          (draftRef.current.captureAudits ?? []).map((a) => [a.captureItemId, a.status]),
        );
        const teachingCaptureId = draftRef.current.teachingCaptureId;

        const regionMap = new Map<string, CollectorRegion>();
        for (const r of [
          ...(draftRef.current.regions ?? []),
          ...captures.flatMap((c) => c.regions ?? []),
        ]) {
          if (!r?.id) continue;
          const existing = regionMap.get(r.id);
          if (!existing || (!existing.referenceImage && r.referenceImage)) {
            regionMap.set(r.id, r);
          }
        }
        const uniqueRegions = Array.from(regionMap.values());

        const regionalLogs: Array<{
          collectorId: string;
          sampleId: string;
          regionId: string;
          anchorGroup: string;
          confirmationStatus: string;
          referenceImageAvailability: string;
          cropDimensions: string;
          reason: string;
          accepted: boolean;
          region: CollectorRegion;
        }> = [];

        for (const r of uniqueRegions) {
          const isBeginType =
            r.type === "BEGIN" ||
            (r.type === "STATIC" && r.role === "header") ||
            r.role === "header";
          const parentCap = captures.find((c) => c.id === r.captureItemId);
          const isConfirmedAudit = parentCap
            ? captureAuditMap.get(parentCap.id) === "confirmed"
            : false;
          const isTeaching = parentCap ? parentCap.id === teachingCaptureId : false;
          const isConfirmed = Boolean(r.confirmed || isConfirmedAudit || isTeaching);

          const w =
            r.originalRoi?.width ??
            (r.geometry ? Math.round(r.geometry.relW * 1280) : 0);
          const h =
            r.originalRoi?.height ??
            (r.geometry ? Math.round(r.geometry.relH * 800) : 0);
          const cropDims = `${w}x${h}`;

          const hasRefImage = Boolean(r.referenceImage);
          const hasAsset = Boolean(parentCap?.imageAsset || r.referenceImageAsset);
          const refImgAvail = hasRefImage
            ? "inline_data_url"
            : hasAsset
              ? "parent_capture_asset"
              : "none";

          let accepted = false;
          let reason = "";

          if (!isBeginType) {
            reason = `Skipped: region type '${r.type}' (role: ${r.role || "none"}) is not a BEGIN/header`;
          } else if (!isConfirmed) {
            reason = "Skipped: region and parent sample are both unconfirmed";
          } else if (!hasRefImage && !hasAsset) {
            reason = "Skipped: neither inline referenceImage nor parent screenshot asset found";
          } else {
            accepted = true;
            reason = `Accepted: confirmed BEGIN anchor (${hasRefImage ? "inline crop" : "parent capture asset"})`;
          }

          regionalLogs.push({
            collectorId: draftRef.current.id,
            sampleId: r.captureItemId,
            regionId: r.id,
            anchorGroup: r.groupTag || "default",
            confirmationStatus: r.confirmed
              ? "confirmed_region"
              : isTeaching
                ? "teaching_sample"
                : isConfirmedAudit
                  ? "confirmed_audit"
                  : "unconfirmed",
            referenceImageAvailability: refImgAvail,
            cropDimensions: cropDims,
            reason,
            accepted,
            region: r,
          });
        }

        console.info(
          `[B3 V2 Pipeline Stage 1] BEGIN Reference Candidates (evaluated ${uniqueRegions.length} region(s), accepted ${regionalLogs.filter((l) => l.accepted).length}):`,
          regionalLogs,
        );

        const acceptedRegions = regionalLogs
          .filter((item) => item.accepted)
          .map((item) => item.region);

        if (acceptedRegions.length === 0) {
          const detailReasons = regionalLogs
            .map((item) => `[Region ${item.regionId} in Sample ${item.sampleId}]: ${item.reason}`)
            .join("; ");
          setErrorMsg(
            detailReasons
              ? `No usable confirmed BEGIN reference crops found: ${detailReasons}`
              : "No confirmed BEGIN regions found in teaching samples. Please confirm a BEGIN region in Step 2A first.",
          );
          isRunningRef.current = false;
          setIsRunning(false);
          return;
        }

        const references = acceptedRegions.map((r) => {
          const parentCap = captures.find((c) => c.id === r.captureItemId);
          return {
            sampleId: r.captureItemId,
            regionId: r.id,
            groupTag: r.groupTag,
            referenceImage: r.referenceImage,
            assetId: parentCap?.imageAsset || r.referenceImageAsset,
            captureId: r.captureItemId,
            originalRoi: r.originalRoi,
            geometry: r.geometry,
          };
        });

        const blockResult = await collectorMatchBeginBlockLayout(invoke, references);
        blockResult.runId = currentRunId;
        setBeginBlockResult(blockResult);

        // File-based structured diagnostic logging
        try {
          const diagRecord = {
            timestamp: new Date().toISOString(),
            matchRunId: `match_run_begin_block_${currentRunId}_${Date.now()}`,
            mode: "BEGIN_BLOCK_B3_V2",
            sessionId: draftRef.current.id,
            url: currentUrl,
            matchingTechnique: blockResult.technique,
            referenceBeginSampleIds: blockResult.referenceSampleIds,
            variantCount: blockResult.variantCount,
            screenshotDimensions: blockResult.screenshotDimensions,
            scale: blockResult.scale,
            status: blockResult.status,
            matchedCandidates: blockResult.matchedCandidates,
            rejectedCandidates: blockResult.rejectedCandidates,
            diagnostics: blockResult.diagnostics,
          };
          void collectorLogMatchDiagnostic(invoke, diagRecord);
        } catch (logErr) {
          console.error("Begin block layout match diagnostic logging failed", logErr);
        }

        if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
          await collectorClearHighlights(invoke);
          return;
        }

        if (blockResult.matchedCandidates.length > 0) {
          await collectorHighlightBeginBlockLayout(invoke, blockResult.matchedCandidates);
        } else {
          await collectorClearHighlights(invoke);
        }

        const expTestResult: MatchTestResult = {
          testedAt: blockResult.testedAt,
          browserUrl: currentUrl,
          status:
            blockResult.status === "MATCHED"
              ? "MATCHED"
              : blockResult.status === "NO_REFERENCES"
                ? ("NO_REFERENCES" as any)
                : "FAILED",
          matchedPostCount: blockResult.matchedCandidates.length,
          groups: [],
          summary: `B3 V2 Block Layout Match: ${blockResult.matchedCandidates.length} matched (${blockResult.status}), ${blockResult.diagnostics.evaluatedWindowsCount} windows in ${blockResult.diagnostics.totalDurationMs}ms`,
        };
        onChangeRef.current({ ...draftRef.current, matchTest: expTestResult, dirty: true });
        return;
      }

      const startTime = performance.now();
      // Real live DOM inspection strictly bounded to current visible viewport (NO SCROLL)
      const snapshot = await collectorInspectDom(invoke, currentUrl, draftRef.current.layoutContext);

      if (!isMountedRef.current || currentRunId !== runIdRef.current || !matchModeRef.current) {
        return;
      }

      const result = executeLiveBrowserMatchTest(
        draftRef.current.regions ?? [],
        snapshot,
        draftRef.current,
        { mode: "BEGIN_ONLY", isolateBeginOnly: true },
      );
      const durationMs = Math.round(performance.now() - startTime);

      // Filter to highlight ONLY successfully resolved containers (never unresolved candidates)
      const resolvedMatches = (result.matchedItems || []).filter((item) => item.domResolved);

      // File-based structured diagnostic logging on manual Match Test / Re-match
      try {
        const primaryGroup = result.groups[0];
        const primaryDiag = primaryGroup?.candidateDiagnostics;

        const diagRecord = {
          timestamp: new Date().toISOString(),
          matchRunId: `match_run_${currentRunId}_${Date.now()}`,
          mode: "BEGIN_ONLY",
          sessionId: draftRef.current.id,
          url: snapshot.url || currentUrl,
          viewport: snapshot.viewport,
          groupTag: primaryGroup?.groupTag || "default",
          trainingSampleCount: primaryDiag?.trainingSampleCount ?? 1,
          learnedFeatures: primaryDiag?.learnedFeatures ?? [],
          liveCandidates: {
            beforeDeduplication: primaryDiag?.liveCandidatesBeforeDeduplication ?? 0,
            afterDeduplication: primaryDiag?.liveCandidatesAfterDeduplication ?? 0,
          },
          topCandidates: primaryDiag?.topCandidates ?? [],
          selectedCandidate: primaryDiag?.selectedCandidate ?? null,
          rejectionReasons: primaryDiag?.rejectionReasons ?? [],
          outerContainerDiagnostics: primaryDiag?.outerContainerDiagnostics ?? [],
          deduplicationDecisions: primaryDiag?.deduplicationDecisions ?? [],
          finalUniquePostCount: primaryDiag?.finalUniquePostCount ?? result.matchedPostCount,
          configuredPrimaryVariable: primaryDiag?.configuredPrimaryVariable ?? null,
          primaryCandidatesFound: primaryDiag?.primaryCandidatesFound ?? 0,
          primaryCandidateEvidence: primaryDiag?.primaryCandidateEvidence ?? [],
          primaryCandidateRejectionReasons: primaryDiag?.primaryCandidateRejectionReasons ?? [],
          selectedPrimaryDOM: primaryDiag?.selectedPrimaryDOM ?? null,
          resolvedOuterContainer: primaryDiag?.resolvedOuterContainer ?? null,
          primaryMatchStatus: primaryDiag?.primaryMatchStatus ?? null,
          totalNodes: snapshot.elements?.length || 0,
          inViewportNodes: snapshot.elements?.filter((e) => e.rect.width > 0 && e.rect.height > 0).length || 0,
          articlesFound: snapshot.elements?.filter((e) => e.isArticleOrCard).length || 0,
          feedsFound: snapshot.elements?.filter((e) => e.isFeedContainer || e.role === "feed").length || 0,
          status: result.status,
          matchedPostCount: result.matchedPostCount,
          durationMs,
          groups: result.groups.map((g) => ({
            groupTag: g.groupTag,
            status: g.status,
            domAssociationStatus: g.domAssociationStatus,
            visualConfidence: g.visualConfidence,
            failureReason: g.failureReason,
            beginMatched: g.beginMatch?.matched,
            endMatched: g.endMatch?.matched,
            candidateDiagnostics: g.candidateDiagnostics,
          })),
          matchedItems: (result.matchedItems || []).map((item) => ({
            index: item.index,
            groupTag: item.groupTag,
            primaryElementId: item.primaryElementId,
            primaryVariableKey: item.primaryVariableKey,
            beginMatched: item.beginMatched,
            endMatched: item.endMatched,
            paired: item.paired,
            domResolved: item.domResolved,
            confidence: item.confidence,
            failureReason: item.failureReason,
          })),
        };
        void collectorLogMatchDiagnostic(invoke, diagRecord);
      } catch (logErr) {
        console.error("Match diagnostic logging failed", logErr);
      }

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
          {/* C2.11.12: Experiment Mode Selector */}
          <div className="collector-match-mode-control">
            <span className="collector-match-mode-label">Mode:</span>
            <select
              value={matchExperimentMode}
              disabled={locked || isRunning}
              onChange={(e) => {
                const nextMode = e.target.value as
                  | "BEGIN_PRIMARY"
                  | "END_ONLY_VISUAL"
                  | "BEGIN_LAYOUT_B3"
                  | "BEGIN_BLOCK_B3_V2";
                setMatchExperimentMode(nextMode);
                matchExperimentModeRef.current = nextMode;
                // C2.11.13a: Reset stale experimental results and status when switching matching modes
                setEndVisualResult(null);
                setBeginLayoutResult(null);
                setBeginBlockResult(null);
                setErrorMsg(null);
                if (invoke && isElectronBrowserCoreAvailable()) {
                  void collectorClearHighlights(invoke);
                }
              }}
              style={{
                background: "#0f172a",
                color:
                  matchExperimentMode === "BEGIN_BLOCK_B3_V2"
                    ? "#34d399"
                    : matchExperimentMode === "BEGIN_LAYOUT_B3"
                      ? "#06b6d4"
                      : matchExperimentMode === "END_ONLY_VISUAL"
                        ? "#c084fc"
                        : "#38bdf8",
                border: "1px solid #334155",
                borderRadius: "3px",
                padding: "3px 8px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Select matching mode: Production, END Visual, B3 V1 Layout, or B3 V2 Block Layout"
            >
              <option value="BEGIN_PRIMARY">Production (Primary / BEGIN)</option>
              <option value="END_ONLY_VISUAL">🧪 END-Only Visual Experiment</option>
              <option value="BEGIN_LAYOUT_B3">🧪 BEGIN Layout Experiment (B3)</option>
              <option value="BEGIN_BLOCK_B3_V2">🧪 BEGIN Block Layout Experiment (B3 V2)</option>
            </select>
          </div>

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

          {/* C2.11.15: BEGIN Block Layout Matching Experiment (B3 V2) Results Card */}
          {matchExperimentMode === "BEGIN_BLOCK_B3_V2" ? (
            <div className="collector-match-items-section">
              <div className="collector-match-items-head-row">
                <h4 className="collector-section-title" style={{ margin: 0, color: "#10b981" }}>
                  🧪 BEGIN Block Layout Experiment (B3 V2) (Screenshot Space)
                </h4>
                <span className="collector-count-pill matched has-matches" style={{ backgroundColor: "#065f46" }}>
                  Matched: <b>{beginBlockResult?.matchedCandidates?.length ?? 0}</b>
                </span>
              </div>

              <div
                style={{
                  background: "#064e3b",
                  border: "1px solid #059669",
                  borderRadius: "4px",
                  padding: "8px 12px",
                  marginBottom: "10px",
                  fontSize: "11px",
                  color: "#d1fae5",
                }}
              >
                <b>Matching Technique:</b> {beginBlockResult?.technique || "B3_V2_BLOCK_LEVEL_MATCHING"}<br />
                <b>Reference Crops:</b> {beginBlockResult?.validReferenceCount ?? beginBlockResult?.referenceBeginCount ?? 0} valid / {beginBlockResult?.inputReferenceCount ?? beginBlockResult?.referenceBeginCount ?? 0} input ({beginBlockResult?.skippedReferenceCount ?? 0} skipped) | <b>Variants:</b> {beginBlockResult?.variantCount ?? 0} | <b>Scale:</b> {beginBlockResult?.scale ?? 1.0}×
                {beginBlockResult?.runId ? <span> | <b>Run ID:</b> #{beginBlockResult.runId}</span> : null}<br />
                {beginBlockResult?.diagnostics && (
                  <div style={{ marginTop: "4px", fontSize: "10px", color: "#a7f3d0" }}>
                    <b>Performance:</b> Decode: {beginBlockResult.diagnostics.decodeTimeMs}ms | Preprocess: {beginBlockResult.diagnostics.preprocessTimeMs}ms | Gen: {beginBlockResult.diagnostics.candidateGenerationTimeMs}ms | Compare: {beginBlockResult.diagnostics.candidateComparisonTimeMs}ms | <b>Total: {beginBlockResult.diagnostics.totalDurationMs}ms</b> ({beginBlockResult.diagnostics.evaluatedWindowsCount} windows)
                  </div>
                )}
                {beginBlockResult?.diagnostics?.pipelineSummary && (
                  <div style={{ marginTop: "3px", fontSize: "10px", color: "#6ee7b7" }}>
                    <b>Pipeline:</b> {beginBlockResult.diagnostics.pipelineSummary}
                  </div>
                )}
                <div style={{ marginTop: "4px", color: "#6ee7b7", fontWeight: 700 }}>
                  ⚠️ B3 V2 VISUAL CANDIDATE — NOT DOM VERIFIED
                </div>
                <span style={{ color: "#a7f3d0", fontSize: "10px" }}>
                  Note: Whole-layout block matching. Matches abstract geometry (avatar, text-line strips, action menu) instead of stroke/texture pixels, eliminating body text and media false positives.
                </span>
              </div>

              {beginBlockResult?.skipReasons && beginBlockResult.skipReasons.length > 0 && (
                <div
                  style={{
                    background: "#451a03",
                    border: "1px solid #b45309",
                    borderRadius: "4px",
                    padding: "6px 10px",
                    marginBottom: "10px",
                    fontSize: "10px",
                    color: "#fde68a",
                  }}
                >
                  <b>Skipped Reference Crops ({beginBlockResult.skipReasons.length}):</b>
                  <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                    {beginBlockResult.skipReasons.map((sr, idx) => (
                      <li key={idx}>
                        [Sample {sr.sampleId || "unknown"}]: {sr.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(!beginBlockResult?.matchedCandidates || beginBlockResult.matchedCandidates.length === 0) && (
                <div className="collector-sample-empty">
                  {displayStatus === "NOT TESTED"
                    ? "Click 'Re-match Current Viewport' in Match Mode ON to test B3 V2 block-level layout matching."
                    : beginBlockResult?.status === "NO_REFERENCES"
                      ? beginBlockResult.diagnostics?.pipelineSummary || "NO REFERENCES: 0 usable confirmed BEGIN reference crops found. Ensure at least one BEGIN anchor is confirmed in Review 2A."
                      : beginBlockResult?.status === "PARTIAL"
                        ? "Partial header detected at viewport boundary; insufficient complete block evidence."
                        : "0 post headers matched by B3 V2. Ensure post headers are visible in viewport."}
                </div>
              )}

              {beginBlockResult?.matchedCandidates?.map((cand, idx) => (
                <div
                  key={cand.id || `begin-block-${idx}`}
                  className="collector-match-item-card resolved"
                  style={{ borderLeftColor: "#10b981" }}
                >
                  <div className="collector-match-item-head">
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span className="collector-match-num-badge" style={{ backgroundColor: "#059669" }}>
                        #{idx + 1}
                      </span>
                      <b style={{ color: "#e2e8f0" }}>B3 V2 VISUAL CANDIDATE — NOT DOM VERIFIED</b>
                      <span style={{ color: "#34d399", fontSize: "11px", fontFamily: "monospace" }}>
                        [{cand.rect.x}, {cand.rect.y}, {cand.rect.width}×{cand.rect.height}]
                      </span>
                    </div>
                    <span className="collector-match-pill small status-matched" style={{ background: "#065f46", color: "#6ee7b7" }}>
                      {cand.confidence}% MATCH
                    </span>
                  </div>

                  <div style={{ marginTop: "6px", fontSize: "11px", color: "#94a3b8", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <span>Matched Blocks: <b style={{ color: "#34d399" }}>{cand.matchedBlocksCount} / {cand.totalTemplateBlocks}</b></span>
                    <span>Geometry Alignment: <b style={{ color: "#38bdf8" }}>{Math.round(cand.geometryScore * 100)}%</b></span>
                    <span>Extra Blocks: <b>{cand.extraBlocksCount}</b></span>
                    <span>Variant: <code style={{ color: "#cbd5e1" }}>{cand.variantId}</code></span>
                  </div>

                  {cand.blocks && cand.blocks.length > 0 && (
                    <div style={{ display: "flex", gap: "4px", marginTop: "6px", flexWrap: "wrap" }}>
                      {cand.blocks.map((b) => (
                        <span
                          key={b.id}
                          style={{
                            fontSize: "9px",
                            padding: "1px 5px",
                            background: "#091e17",
                            border: "1px solid #059669",
                            color: "#6ee7b7",
                            borderRadius: "2px",
                          }}
                        >
                          {b.label || b.type}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {beginBlockResult?.rejectedCandidates && beginBlockResult.rejectedCandidates.length > 0 && (
                <div style={{ marginTop: "12px" }}>
                  <small style={{ color: "#94a3b8", fontWeight: 600 }}>
                    Rejected Candidate Zones ({beginBlockResult.rejectedCandidates.length}):
                  </small>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                    {beginBlockResult.rejectedCandidates.map((rej, rIdx) => (
                      <div
                        key={rej.id || `blk-rej-${rIdx}`}
                        style={{
                          background: "#0f172a",
                          border: "1px solid #1e293b",
                          borderRadius: "3px",
                          padding: "4px 8px",
                          fontSize: "10px",
                        }}
                      >
                        <span style={{ color: "#f87171", fontWeight: 600 }}>REJECTED at y={rej.rect.y}:</span>{" "}
                        <span style={{ color: "#cbd5e1" }}>{rej.rejectionReason}</span>
                        {rej.missingRequiredBlocks && rej.missingRequiredBlocks.length > 0 && (
                          <span style={{ color: "#fca5a5", marginLeft: "6px" }}>
                            [Missing: {rej.missingRequiredBlocks.join(", ")}]
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : matchExperimentMode === "BEGIN_LAYOUT_B3" ? (
            <div className="collector-match-items-section">
              <div className="collector-match-items-head-row">
                <h4 className="collector-section-title" style={{ margin: 0, color: "#06b6d4" }}>
                  🧪 BEGIN Layout Experiment (B3) (Screenshot Space)
                </h4>
                <span className="collector-count-pill matched has-matches">
                  Matched: <b>{beginLayoutResult?.matchedHeaders?.length ?? 0}</b>
                </span>
              </div>

              <div
                style={{
                  background: "#083344",
                  border: "1px solid #0891b2",
                  borderRadius: "4px",
                  padding: "8px 12px",
                  marginBottom: "10px",
                  fontSize: "11px",
                  color: "#cffafe",
                }}
              >
                <b>Visual Technique:</b> {beginLayoutResult?.technique || "Structural Geometry & Relative Layout Correlation (Sharp)"}<br />
                <b>Reference Crops:</b> {beginLayoutResult?.referenceBeginCount ?? 0} confirmed BEGIN sample(s) | <b>Scale:</b> {beginLayoutResult?.scale ?? 1.0}×<br />
                {beginLayoutResult?.templateInfo && (
                  <div style={{ marginTop: "4px", fontSize: "10px", color: "#a5f3fc" }}>
                    <b>Template Family:</b> Group: <code>{beginLayoutResult.templateInfo.groupTag}</code> | AR: <code>{beginLayoutResult.templateInfo.aspectRatio}:1</code> | Nominal: <code>{beginLayoutResult.templateInfo.nominalDimensions.width}×{beginLayoutResult.templateInfo.nominalDimensions.height}px</code>
                  </div>
                )}
                <div style={{ marginTop: "4px", color: "#67e8f9", fontWeight: 600 }}>
                  ⚠️ B3 VISUAL CANDIDATE — NOT DOM VERIFIED
                </div>
                <span style={{ color: "#7dd3fc", fontSize: "10px" }}>
                  Note: Isolated B3 layout recognition. Does not resolve post containers, does not run variable extraction, does not pair with END, and does not claim candidate is a confirmed post.
                </span>
              </div>

              {(!beginLayoutResult?.matchedHeaders || beginLayoutResult.matchedHeaders.length === 0) && (
                <div className="collector-sample-empty">
                  {displayStatus === "NOT TESTED"
                    ? "Click 'Re-match Current Viewport' in Match Mode ON to test B3 visual layout matching."
                    : beginLayoutResult?.status === "NO_REFERENCES"
                      ? "NO REFERENCES: 0 confirmed BEGIN reference crops found. Ensure at least one BEGIN anchor is confirmed in Review 2A."
                      : beginLayoutResult?.status === "PARTIAL"
                        ? "Partial header detected at viewport boundary; insufficient complete evidence."
                        : "0 post headers matched. Check that post headers (avatar, author, timestamp, action menu) are visible in the viewport."}
                </div>
              )}

              {beginLayoutResult?.matchedHeaders?.map((cand, idx) => (
                <div
                  key={cand.id || `begin-header-${idx}`}
                  className="collector-match-item-card resolved"
                  style={{ borderLeftColor: "#06b6d4" }}
                >
                  <div className="collector-match-item-head">
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span className="collector-match-num-badge" style={{ backgroundColor: "#0891b2" }}>
                        #{idx + 1}
                      </span>
                      <b style={{ color: "#e2e8f0" }}>B3 VISUAL CANDIDATE — NOT DOM VERIFIED</b>
                      <span style={{ color: "#22d3ee", fontSize: "11px", fontFamily: "monospace" }}>
                        [{cand.rect.x}, {cand.rect.y}, {cand.rect.width}×{cand.rect.height}]
                      </span>
                    </div>
                    <span className="collector-match-pill small status-matched">
                      {cand.confidence}% MATCH
                    </span>
                  </div>

                  <div style={{ marginTop: "6px", fontSize: "11px", color: "#94a3b8", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <span>Avatar: <b style={{ color: "#38bdf8" }}>{cand.features.avatarConfidence}%</b></span>
                    <span>Dual-Band Text: <b style={{ color: "#38bdf8" }}>{cand.features.dualBandConfidence}%</b></span>
                    <span>Action Menu: <b style={{ color: "#38bdf8" }}>{cand.features.menuConfidence}%</b></span>
                    <span>Structural Grid: <b style={{ color: "#4ade80" }}>{cand.features.structuralGridSimilarity}%</b></span>
                    <span>Vertical Profile: <b style={{ color: "#4ade80" }}>{cand.features.verticalProfileSimilarity}%</b></span>
                  </div>
                </div>
              ))}

              {beginLayoutResult?.rejectedCandidates && beginLayoutResult.rejectedCandidates.length > 0 && (
                <div style={{ marginTop: "12px" }}>
                  <small style={{ color: "#94a3b8", fontWeight: 600 }}>
                    Rejected Candidate Zones ({beginLayoutResult.rejectedCandidates.length}):
                  </small>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                    {beginLayoutResult.rejectedCandidates.map((rej, rIdx) => (
                      <div
                        key={rej.id || `rej-${rIdx}`}
                        style={{
                          background: "#0f172a",
                          border: "1px solid #1e293b",
                          borderRadius: "3px",
                          padding: "4px 8px",
                          fontSize: "10px",
                        }}
                      >
                        <span style={{ color: "#f87171", fontWeight: 600 }}>REJECTED at y={rej.rect.y}:</span>{" "}
                        <span style={{ color: "#cbd5e1" }}>{rej.rejectionReason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : matchExperimentMode === "END_ONLY_VISUAL" ? (
            <div className="collector-match-items-section">
              <div className="collector-match-items-head-row">
                <h4 className="collector-section-title" style={{ margin: 0, color: "#c084fc" }}>
                  🧪 END-Only Visual Experiment (Screenshot Space)
                </h4>
                <span className="collector-count-pill matched has-matches">
                  Matched: <b>{endVisualResult?.matchedFooters?.length ?? 0}</b>
                </span>
              </div>

              <div style={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: "4px", padding: "8px 12px", marginBottom: "10px", fontSize: "11px", color: "#c7d2fe" }}>
                <b>Visual Technique:</b> {endVisualResult?.technique || "Tripartite Multi-Cluster Visual Template Correlation"}<br />
                <b>Reference Crops:</b> {endVisualResult?.referenceEndCount ?? 0} confirmed END sample(s) | <b>Scale:</b> {endVisualResult?.scale ?? 1.0}×<br />
                <span style={{ color: "#a5b4fc" }}>Note: Isolated END recognition. Does not resolve outer post containers; does not pair with BEGIN.</span>
              </div>

              {(!endVisualResult?.matchedFooters || endVisualResult.matchedFooters.length === 0) && (
                <div className="collector-sample-empty">
                  {displayStatus === "NOT TESTED"
                    ? "Click 'Re-match Current Viewport' in Match Mode ON to test END visual matching."
                    : endVisualResult?.status === "PARTIAL"
                      ? "Partial footer detected at viewport boundary; insufficient complete evidence."
                      : "0 post engagement footers matched. Check that post action buttons (Like/Comment/Share) are visible in the viewport."}
                </div>
              )}

              {endVisualResult?.matchedFooters?.map((cand, idx) => (
                <div
                  key={cand.id || `end-footer-${idx}`}
                  className="collector-match-item-card resolved"
                  style={{ borderLeftColor: "#8b5cf6" }}
                >
                  <div className="collector-match-item-head">
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span className="collector-match-num-badge" style={{ backgroundColor: "#8b5cf6" }}>
                        #{idx + 1}
                      </span>
                      <b style={{ color: "#e2e8f0" }}>END Visual Anchor</b>
                      <span style={{ color: "#a78bfa", fontSize: "11px", fontFamily: "monospace" }}>
                        [{cand.rect.x}, {cand.rect.y}, {cand.rect.width}×{cand.rect.height}]
                      </span>
                    </div>
                    <span className="collector-match-pill small status-matched">
                      {cand.confidence}% MATCH
                    </span>
                  </div>

                  <div style={{ marginTop: "6px", fontSize: "11px", color: "#94a3b8", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <span>Like: <b style={{ color: "#38bdf8" }}>{cand.features.likeConfidence}%</b></span>
                    <span>Comment: <b style={{ color: "#38bdf8" }}>{cand.features.commentConfidence}%</b></span>
                    <span>Share: <b style={{ color: "#38bdf8" }}>{cand.features.shareConfidence}%</b></span>
                    <span>Tripartite Layout: <b style={{ color: "#4ade80" }}>{cand.features.tripartiteLayout ? "YES" : "NO"}</b></span>
                  </div>
                </div>
              ))}

              {endVisualResult?.rejectedCandidates && endVisualResult.rejectedCandidates.length > 0 && (
                <div style={{ marginTop: "12px" }}>
                  <small style={{ color: "#94a3b8", fontWeight: 600 }}>Rejected Candidate Zones ({endVisualResult.rejectedCandidates.length}):</small>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                    {endVisualResult.rejectedCandidates.map((rej, rIdx) => (
                      <div
                        key={rej.id || `rej-${rIdx}`}
                        style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "3px", padding: "4px 8px", fontSize: "10px" }}
                      >
                        <span style={{ color: "#f87171", fontWeight: 600 }}>REJECTED at y={rej.rect.y}:</span>{" "}
                        <span style={{ color: "#cbd5e1" }}>{rej.rejectionReason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Viewport Candidates (Max 3) - Production BEGIN / Primary Mode */
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
          )}

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
