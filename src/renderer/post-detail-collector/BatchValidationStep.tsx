import React, { useMemo, useRef, useState } from "react";
import { playCompletionSound } from "../completion-sound";
import type {
  PostDetailParentConfig,
  PostDetailSavedParentResolution,
  PostDetailEngagementOcrResult,
} from "../../shared/post-detail-collector/types";
import { shouldRetrySavedParentResolution } from "./auto-resume";
import {
  advanceParentReadiness,
  evaluateMatchedParentDom,
  reconcileBatchEngagement,
  extractPostIdentityFromUrl,
  formatShortPostLabel,
  parseBatchUrls,
} from "./batch-validation";
import { SavedParentHtmlStep } from "./SavedParentHtmlStep";
import { extractParentData } from "./extract-parent-data";
import type {
  BatchValidationRow,
  BrowserProbe,
  Invoke,
  PostDetailDomVariableMapping,
} from "./types";
import { listRegistryVariables } from "./variable-registry";
import { SidebarDrawer } from "../components/BrowserWorkspace";

const MAX_RESOLVE_ATTEMPTS = 10;
const RESOLVE_RETRY_DELAY_MS = 750;
const REQUIRED_STABLE_SNAPSHOTS = 2;

function parseHtmlFragment(innerHTML: string): Element | null {
  if (!innerHTML || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString("<!doctype html><body></body>", "text/html");
  const root = doc.createElement("div");
  root.innerHTML = innerHTML;
  return root;
}

function extractionSignature(root: Element, postId: string | null, currentUrl: string, config: PostDetailParentConfig) {
  return JSON.stringify(extractParentData(root, { postId: postId || undefined, currentUrl, domAnchors: config.domAnchors }).filter(item => item.semanticField).map(item => ({
    semanticField: item.semanticField,
    value: item.value,
    extractionStatus: item.extractionStatus,
    sourcePaths: item.sourcePaths,
  })));
}

export type ResolveStableParentProgress = {
  strategyId?: string;
  strategyIndex?: number;
  totalStrategies?: number;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  message: string;
  failureCode?: string;
};

export async function resolveStableParent(opts: {
  invoke: Invoke;
  config: PostDetailParentConfig;
  expectedPostId: string | null;
  currentUrl: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  deadlineMs?: number;
  startedAtMs?: number;
  strategyId?: string;
  strategyIndex?: number;
  totalStrategies?: number;
  cancelled?: () => boolean;
  onWaiting?: (message: string) => void;
  onProgress?: (progress: ResolveStableParentProgress) => void;
}): Promise<PostDetailSavedParentResolution> {
  const maxAttempts = opts.maxAttempts ?? MAX_RESOLVE_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? RESOLVE_RETRY_DELAY_MS;
  const startedAtMs = opts.startedAtMs ?? Date.now();
  let last: PostDetailSavedParentResolution | null = null;
  let readinessState = { signature: "", stableCount: 0 };
  const elapsed = () => Math.max(0, Date.now() - startedAtMs);

  const cancelledResult = (): PostDetailSavedParentResolution => ({
    status: "CANCELLED",
    innerHTML: "",
    rect: null,
    diagnosticMeta: {
      ...(last?.diagnosticMeta || {}),
      strategyId: opts.strategyId,
      cancelled: true,
      elapsedMs: elapsed(),
    },
    diagnostics: [...(last?.diagnostics || []), "Auto Match cancelled."],
  });

  const timeoutResult = (attempt: number): PostDetailSavedParentResolution => ({
    status: "BROWSER_NOT_READY",
    innerHTML: "",
    rect: null,
    failureCode: "BROWSER_NOT_READY",
    diagnosticMeta: {
      ...(last?.diagnosticMeta || {}),
      strategyId: opts.strategyId,
      attempt,
      maxAttempts,
      timedOut: true,
      elapsedMs: elapsed(),
      readinessVerified: false,
      stableSnapshots: readinessState.stableCount,
    },
    diagnostics: [
      ...(last?.diagnostics || []),
      `Auto Match timeout reached after ${elapsed()}ms (attempt ${attempt}/${maxAttempts}).`,
    ],
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.cancelled?.()) return cancelledResult();
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      return timeoutResult(attempt);
    }
    const attemptNum = attempt + 1;
    opts.onProgress?.({
      strategyId: opts.strategyId,
      strategyIndex: opts.strategyIndex,
      totalStrategies: opts.totalStrategies,
      attempt: attemptNum,
      maxAttempts,
      elapsedMs: elapsed(),
      message: `Resolving Parent (attempt ${attemptNum}/${maxAttempts})...`,
    });

    const resolution = await opts.invoke<PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config: opts.config });
    if (opts.cancelled?.()) return cancelledResult();
    last = resolution;

    if (resolution.status === "PARENT_MATCHED") {
      const meta = resolution.diagnosticMeta || {};
      const livePostId = typeof meta.postId === "string" ? meta.postId : null;
      const identityVerified = meta.postIdentityVerified === true && (!opts.expectedPostId || livePostId === opts.expectedPostId);
      const root = identityVerified ? parseHtmlFragment(resolution.innerHTML) : null;
      if (!identityVerified) {
        readinessState = { signature: "", stableCount: 0 };
        const msg = `Waiting for live post identity${opts.expectedPostId ? ` #${opts.expectedPostId}` : ""} (${attemptNum}/${maxAttempts})`;
        opts.onWaiting?.(msg);
        opts.onProgress?.({
          strategyId: opts.strategyId,
          strategyIndex: opts.strategyIndex,
          totalStrategies: opts.totalStrategies,
          attempt: attemptNum,
          maxAttempts,
          elapsedMs: elapsed(),
          message: msg,
          failureCode: "POST_IDENTITY_MISMATCH",
        });
      } else if (root) {
        const signature = extractionSignature(root, opts.expectedPostId, opts.currentUrl, opts.config);
        const readiness = advanceParentReadiness({ state: readinessState, expectedPostId: opts.expectedPostId, resolvedPostId: livePostId, postIdentityVerified: identityVerified, parentMatched: true, semanticSignature: signature, requiredStableSnapshots: REQUIRED_STABLE_SNAPSHOTS });
        readinessState = readiness.state;
        if (readiness.ready) {
          return {
            ...resolution,
            diagnosticMeta: {
              ...meta,
              strategyId: opts.strategyId ?? meta.strategyId,
              attempt: attemptNum,
              maxAttempts,
              elapsedMs: elapsed(),
              readinessVerified: true,
              stableSnapshots: readinessState.stableCount,
              extractionSignature: signature,
            },
            diagnostics: [...resolution.diagnostics, `DOM readiness verified after ${readinessState.stableCount} stable semantic snapshots.`],
          };
        }
        const msg = `Waiting for semantic DOM stability (${readinessState.stableCount}/${REQUIRED_STABLE_SNAPSHOTS}, attempt ${attemptNum}/${maxAttempts})`;
        opts.onWaiting?.(msg);
        opts.onProgress?.({
          strategyId: opts.strategyId,
          strategyIndex: opts.strategyIndex,
          totalStrategies: opts.totalStrategies,
          attempt: attemptNum,
          maxAttempts,
          elapsedMs: elapsed(),
          message: msg,
        });
      }
    } else if (!shouldRetrySavedParentResolution(resolution)) {
      return {
        ...resolution,
        diagnosticMeta: {
          ...(resolution.diagnosticMeta || {}),
          strategyId: opts.strategyId ?? resolution.diagnosticMeta?.strategyId,
          attempt: attemptNum,
          maxAttempts,
          elapsedMs: elapsed(),
        },
      };
    } else {
      readinessState = { signature: "", stableCount: 0 };
      const msg = `Waiting for Parent locator (${resolution.failureCode || resolution.status}, ${attemptNum}/${maxAttempts})`;
      opts.onWaiting?.(msg);
      opts.onProgress?.({
        strategyId: opts.strategyId,
        strategyIndex: opts.strategyIndex,
        totalStrategies: opts.totalStrategies,
        attempt: attemptNum,
        maxAttempts,
        elapsedMs: elapsed(),
        message: msg,
        failureCode: resolution.failureCode,
      });
    }

    if (attempt < maxAttempts - 1) {
      if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        return timeoutResult(attemptNum);
      }
      const sleepMs = opts.deadlineMs !== undefined
        ? Math.min(retryDelayMs, Math.max(0, opts.deadlineMs - Date.now()))
        : retryDelayMs;
      if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs));
    }
  }

  if (opts.cancelled?.()) return cancelledResult();
  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
    return timeoutResult(maxAttempts);
  }
  if (last && last.status !== "PARENT_MATCHED" && last.status !== "RESOLVING") {
    return {
      ...last,
      diagnosticMeta: {
        ...(last.diagnosticMeta || {}),
        strategyId: opts.strategyId ?? last.diagnosticMeta?.strategyId,
        attempt: maxAttempts,
        maxAttempts,
        elapsedMs: elapsed(),
        readinessVerified: false,
        stableSnapshots: readinessState.stableCount,
      },
      diagnostics: [...(last.diagnostics || []), `Parent resolution exhausted ${maxAttempts} attempts.`],
    };
  }
  return {
    status: "BROWSER_NOT_READY",
    innerHTML: "",
    rect: null,
    failureCode: "BROWSER_NOT_READY",
    diagnosticMeta: {
      ...(last?.diagnosticMeta || {}),
      strategyId: opts.strategyId ?? last?.diagnosticMeta?.strategyId,
      attempt: maxAttempts,
      maxAttempts,
      elapsedMs: elapsed(),
      readinessVerified: false,
      stableSnapshots: readinessState.stableCount,
    },
    diagnostics: [...(last?.diagnostics || []), "Readiness timeout: post identity and semantic DOM did not produce two consecutive stable snapshots."],
  };
}

export function BatchValidationStep({
  invoke,
  parentConfigs,
  variableMappings,
  hiddenExtractedData,
  batchUrlsText,
  batchResults,
  batchConfigVersion,
  batchValidatedVersion,
  engagementResults,
  onBatchUrlsText,
  onBatchResults,
  onVariableMappings,
  onHiddenExtractedData,
  onEngagementResult,
  onReviewInStep3,
  onBackToStep3,
}: {
  invoke: Invoke;
  parentConfigs: Record<string, PostDetailParentConfig>;
  variableMappings: PostDetailDomVariableMapping[];
  hiddenExtractedData: Record<string, string[]>;
  batchUrlsText: string;
  batchResults: BatchValidationRow[];
  batchConfigVersion: number;
  batchValidatedVersion: number | null;
  engagementResults: Record<string, PostDetailEngagementOcrResult>;
  onBatchUrlsText: (text: string) => void;
  onBatchResults: (rows: BatchValidationRow[], validatedVersion: number) => void;
  onVariableMappings: (mappings: PostDetailDomVariableMapping[]) => void;
  onHiddenExtractedData: (hidden: Record<string, string[]>) => void;
  onEngagementResult: (result: PostDetailEngagementOcrResult) => void;
  onReviewInStep3: (url: string, resolution: PostDetailSavedParentResolution) => void;
  onBackToStep3: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PASS" | "REVIEW" | "FAILED">("ALL");
  const [copiedJson, setCopiedJson] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewResolution, setReviewResolution] = useState<PostDetailSavedParentResolution | null>(null);
  const [reviewStaleWarning, setReviewStaleWarning] = useState<string>("");
  const cancelRef = useRef(false);
  const reviewEpochRef = useRef(0);
  const summaryScrollRef = useRef<HTMLDivElement | null>(null);
  const savedSummaryScrollRef = useRef(0);

  const parsed = useMemo(() => parseBatchUrls(batchUrlsText), [batchUrlsText]);
  const validCount = parsed.items.filter((i) => i.valid).length;
  const invalidCount = parsed.items.length - validCount;
  const isStale =
    batchResults.length > 0 &&
    batchValidatedVersion !== null &&
    batchValidatedVersion !== batchConfigVersion;

  const reconciledRows = useMemo(
    () => batchResults.map(row => reconcileBatchEngagement(row, variableMappings, row.postId ? engagementResults[row.postId] : undefined)),
    [batchResults, variableMappings, engagementResults],
  );

  const statusCounts = useMemo(() => ({
    total: reconciledRows.length,
    pass: reconciledRows.filter(row => row.status === "PASS").length,
    review: reconciledRows.filter(row => row.status === "REVIEW").length,
    failed: reconciledRows.filter(row => row.status === "FAILED").length,
  }), [reconciledRows]);

  const filteredRows = useMemo(
    () => statusFilter === "ALL" ? reconciledRows : reconciledRows.filter(row => row.status === statusFilter),
    [reconciledRows, statusFilter],
  );

  const selectedRow =
    reconciledRows.find((r) => r.url === selectedUrl) || filteredRows[0] || reconciledRows[0] || null;

  const engagementCoverage = (row: BatchValidationRow) => {
    const ocr = row.postId ? engagementResults[row.postId] : undefined;
    if (ocr?.fields) {
      const verified = Object.values(ocr.fields).filter(field => field.status === "verified").length;
      return `${verified}/3`;
    }
    const visual = row.fields.filter(field => field.method === "VISUAL_OCR");
    if (!visual.length) return "—";
    return `${visual.filter(field => field.status === "PASS").length}/${visual.length}`;
  };

  const selectRow = (row: BatchValidationRow) => {
    setSelectedUrl(row.url);
    setCopiedJson(false);
  };

  const runBatch = async () => {
    if (running || parsed.items.length === 0) return;
    cancelRef.current = false;
    setRunning(true);
    setCopiedJson(false);

    const runVersion = batchConfigVersion;
    const registryVariables = listRegistryVariables();
    const collected: BatchValidationRow[] = [];

    try {
      for (let idx = 0; idx < parsed.items.length; idx++) {
        if (cancelRef.current) break;
        const item = parsed.items[idx];
        setProgressText(`Validating ${idx + 1}/${parsed.items.length}: ${item.url}`);

        if (!item.valid) {
          collected.push({
            url: item.url,
            resolvedUrl: "",
            postId: null,
            parentStatus: "Invalid",
            passedCount: 0,
            totalCount: variableMappings.length,
            status: "FAILED",
            failureReason: item.error || "Invalid URL",
            fields: [],
            validatedAt: new Date().toISOString(),
          });
          onBatchResults([...collected], runVersion);
          continue;
        }

        const platform = item.platform || "facebook";
        const config = parentConfigs[platform];
        if (!config) {
          collected.push({
            url: item.url,
            resolvedUrl: "",
            postId: item.postId,
            parentStatus: "Failed",
            passedCount: 0,
            totalCount: variableMappings.length,
            status: "FAILED",
            failureReason: `Parent config not configured for ${platform}`,
            fields: [],
            validatedAt: new Date().toISOString(),
          });
          onBatchResults([...collected], runVersion);
          continue;
        }

        let resolvedUrl = item.url;
        let resolution: PostDetailSavedParentResolution | null = null;

        try {
          await invoke({ type: "postDetailNavigate", url: item.url });
          resolution = await resolveStableParent({
            invoke,
            config,
            expectedPostId: item.postId,
            currentUrl: item.url,
            cancelled: () => cancelRef.current,
            onWaiting: message => setProgressText(`Waiting DOM (${idx + 1}/${parsed.items.length}) · ${message}`),
          });
          if (cancelRef.current) break;
          try {
            const probe = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" });
            if (probe?.url) resolvedUrl = probe.url;
          } catch {
            /* keep navigated url */
          }
        } catch (err) {
          resolution = {
            status: "REMATCH_REQUIRED",
            failureCode: "BROWSER_NOT_READY",
            innerHTML: "",
            rect: null,
            diagnostics: [String(err)],
          };
        }

        if (cancelRef.current) break;

        const effectiveResolution: PostDetailSavedParentResolution = resolution || {
          status: "REMATCH_REQUIRED",
          failureCode: "BROWSER_NOT_READY",
          innerHTML: "",
          rect: null,
          diagnostics: ["No resolution response"],
        };
        const rootElement =
          effectiveResolution.status === "PARENT_MATCHED"
            ? parseHtmlFragment(effectiveResolution.innerHTML)
            : null;

        const row = evaluateMatchedParentDom({
          url: item.url,
          resolvedUrl,
          postId: item.postId,
          resolution: effectiveResolution,
          rootElement,
          mappings: variableMappings,
          registryVariables,
          parentConfig: config,
          engagementResult: item.postId ? engagementResults[item.postId] : undefined,
        });
        collected.push(row);
        onBatchResults([...collected], runVersion);
        if (!selectedUrl) setSelectedUrl(row.url);
      }
    } finally {
      setRunning(false);
      setProgressText(cancelRef.current ? "Batch stopped by user." : "Batch validation complete.");
      if (!cancelRef.current) {
        const allPass = collected.length > 0 && collected.every(row => row.status === "PASS");
        void playCompletionSound(allPass ? "SUCCESS" : "NEEDS_ATTENTION", `batch:${runVersion}:${Date.now()}`);
      }
    }
  };

  const stopBatch = () => {
    cancelRef.current = true;
    setProgressText("Stopping after current check...");
  };

  const customizeRowInStep3 = async (row: BatchValidationRow) => {
    const platform = /threads\.(?:com|net)/i.test(row.url) ? "threads" : "facebook";
    const config = parentConfigs[platform];
    try {
      await invoke({ type: "postDetailNavigate", url: row.url });
      if (config) {
        const res = await invoke<PostDetailSavedParentResolution>({
          type: "postDetailResolveSavedParent",
          config,
        });
        onReviewInStep3(row.url, res);
        return;
      }
    } catch {
      /* fallback to Step 3 */
    }
    onBackToStep3();
  };

  const copyRowJson = () => {
    if (!selectedRow) return;
    void navigator.clipboard.writeText(JSON.stringify(selectedRow, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1800);
  };

  const openRowDetailReview = async (row: BatchValidationRow) => {
    const epoch = ++reviewEpochRef.current;
    setSelectedUrl(row.url);
    setReviewUrl(row.url);
    setReviewStaleWarning("");
    setReviewResolution({
      status: "RESOLVING",
      innerHTML: "",
      rect: null,
      diagnostics: [`Loading ${row.url} in BrowserCore...`],
    });

    const platform = /threads\.(?:com|net)/i.test(row.url) ? "threads" : "facebook";
    const config = parentConfigs[platform];
    if (!config) {
      setReviewResolution({
        status: "NOT_CONFIGURED",
        innerHTML: "",
        rect: null,
        diagnostics: [`Parent config not configured for ${platform}`],
      });
      return;
    }

    try {
      let needsNav = true;
      try {
        const probe = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" });
        if (probe?.url && (probe.url === row.resolvedUrl || probe.url === row.url)) {
          needsNav = false;
        }
      } catch {
        /* navigate */
      }
      if (epoch !== reviewEpochRef.current) return;
      if (needsNav) {
        await invoke({ type: "postDetailNavigate", url: row.url });
      }
      const res = await resolveStableParent({
        invoke,
        config,
        expectedPostId: row.postId,
        currentUrl: row.url,
        cancelled: () => epoch !== reviewEpochRef.current,
      });
      if (epoch !== reviewEpochRef.current || !res) return;

      const probeAfter = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" }).catch(() => null);
      if (epoch !== reviewEpochRef.current) return;

      const liveIdentity = probeAfter?.url ? extractPostIdentityFromUrl(probeAfter.url) : null;
      const resolvedIdentity = typeof res.diagnosticMeta?.postId === "string" ? res.diagnosticMeta.postId : null;
      let staleReason = "";
      if (res.diagnosticMeta?.readinessVerified !== true) {
        staleReason = "Navigation/DOM readiness was not verified; live highlighting is disabled.";
      } else if (row.postId && resolvedIdentity !== row.postId) {
        staleReason = `Post identity mismatch: expected #${row.postId}, resolved Parent is #${resolvedIdentity || "unknown"}.`;
      } else if (row.postId && liveIdentity?.postId && liveIdentity.postId !== row.postId) {
        staleReason = `Post identity mismatch: expected #${row.postId}, live BrowserCore is #${liveIdentity.postId}.`;
      } else if (res.status === "PARENT_MATCHED" && row.parentStatus === "Matched" && row.fields.length > 0) {
        const root = parseHtmlFragment(res.innerHTML);
        const liveEval = evaluateMatchedParentDom({
          url: row.url,
          resolvedUrl: probeAfter?.url || row.resolvedUrl || row.url,
          postId: row.postId,
          resolution: res,
          rootElement: root,
          mappings: variableMappings,
          registryVariables: listRegistryVariables(),
          parentConfig: config,
          engagementResult: row.postId ? engagementResults[row.postId] : undefined,
        });
        const differences = row.fields.flatMap((f) => {
          const liveF = liveEval.fields.find((lf) => lf.variableId === f.variableId);
          return liveF && (liveF.value !== f.value || liveF.fieldStatus !== f.fieldStatus) ? [{ snapshot: f, live: liveF }] : [];
        });
        if (differences.some(({ live }) => live.variableKey === "post_images" && live.fieldStatus === "NEEDS_ATTENTION")) {
          staleReason = "Post media is still lazy-loading; live highlighting is disabled until media locators stabilize.";
        } else if (differences.some(({ snapshot, live }) => snapshot.fieldStatus === "PASS" && live.fieldStatus !== "PASS")) {
          staleReason = "DOM structure/path is stale: a previously mapped field no longer resolves to verified live data.";
        } else if (differences.length) {
          staleReason = "Live data value changed after the batch snapshot; Parent identity and current locators remain verified.";
        }
      }
      setReviewStaleWarning(staleReason);
      setReviewResolution(res);
    } catch (err) {
      if (epoch !== reviewEpochRef.current) return;
      setReviewResolution({
        status: "REMATCH_REQUIRED",
        failureCode: "BROWSER_NOT_READY",
        innerHTML: "",
        rect: null,
        diagnostics: [String(err)],
      });
    }
  };

  const reviewRowIndex = reviewUrl ? reconciledRows.findIndex((r) => r.url === reviewUrl) : -1;
  const reviewRow = reviewRowIndex >= 0 ? reconciledRows[reviewRowIndex] : null;
  if (reviewRow) {
    return (
      <SavedParentHtmlStep
        invoke={invoke}
        result={reviewResolution}
        currentUrl={reviewRow.resolvedUrl || reviewRow.url}
        runId={engagementResults[reviewRow.postId || ""]?.runId || null}
        engagementResult={engagementResults[reviewRow.postId || ""]}
        onEngagementResult={onEngagementResult}
        parentConfig={parentConfigs[extractPostIdentityFromUrl(reviewRow.resolvedUrl || reviewRow.url).platform || "facebook"]}
        variableMappings={variableMappings}
        onVariableMappings={onVariableMappings}
        hiddenExtractedData={hiddenExtractedData}
        onHiddenExtractedData={onHiddenExtractedData}
        onRematch={() => void customizeRowInStep3(reviewRow)}
        reviewMode={{
          row: reviewRow,
          rowIndex: reviewRowIndex,
          totalRows: reconciledRows.length,
          canPrev: reviewRowIndex > 0,
          canNext: reviewRowIndex < reconciledRows.length - 1,
          staleDomWarning: reviewStaleWarning || undefined,
          onBackToResults: () => {
            reviewEpochRef.current += 1;
            setReviewUrl(null);
            setReviewResolution(null);
            setReviewStaleWarning("");
            requestAnimationFrame(() => {
              if (summaryScrollRef.current) summaryScrollRef.current.scrollTop = savedSummaryScrollRef.current;
            });
          },
          onPrevPost: () => {
            if (reviewRowIndex > 0) {
              savedSummaryScrollRef.current = summaryScrollRef.current?.scrollTop || savedSummaryScrollRef.current;
              void openRowDetailReview(reconciledRows[reviewRowIndex - 1]);
            }
          },
          onNextPost: () => {
            if (reviewRowIndex < reconciledRows.length - 1) {
              savedSummaryScrollRef.current = summaryScrollRef.current?.scrollTop || savedSummaryScrollRef.current;
              void openRowDetailReview(reconciledRows[reviewRowIndex + 1]);
            }
          },
          onCustomizeInStep3: () => void customizeRowInStep3(reviewRow),
        }}
      />
    );
  }

  const selectedEngagement = selectedRow?.postId ? engagementResults[selectedRow.postId] : undefined;
  const staleEngagementPipeline = Boolean(
    selectedEngagement?.diagnostics?.some(item => /ocr_preprocess:normalize\b/i.test(item) || /overlaps an action\/icon region/i.test(item))
      && !selectedEngagement?.preprocessVariant
      && !selectedEngagement?.diagnostics?.some(item => /ocr_preprocess:left-/i.test(item)),
  );

  return (
    <div className={`pdc-step pdc-step4 pdc-validation-summary ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="pdc-summary-main" ref={summaryScrollRef}>
        <div className="pdc-section-header">
          <div>
            <span className="pdc-eyebrow">VALIDATION SUMMARY</span>
            <h2>Validation Summary</h2>
            <p className="pdc-subtitle">
              Select a card to inspect Row Details in the right sidebar. Review opens Detail Review explicitly.
            </p>
          </div>
          <div className="pdc-btn-row">
            <button type="button" className="pdc-btn pdc-btn-secondary" onClick={onBackToStep3}>
              ← Back to Step 3
            </button>
            {running ? (
              <button type="button" className="pdc-btn pdc-btn-danger" onClick={stopBatch}>
                Stop Batch
              </button>
            ) : (
              <button
                type="button"
                className="pdc-btn pdc-btn-primary"
                disabled={parsed.items.length === 0}
                onClick={() => void runBatch()}
              >
                Run Batch Validation ({parsed.items.length})
              </button>
            )}
          </div>
        </div>

        {isStale && (
          <div className="pdc-alert pdc-alert-warn" role="status">
            Mappings or Variable definitions changed since the last validation run. Re-run Batch Validation to verify latest configuration.
          </div>
        )}

        {progressText && (
          <div className="pdc-alert pdc-alert-ok" role="status">
            {progressText}
          </div>
        )}

        <div className="pdc-batch-input-card">
          <div className="pdc-batch-card-head">
            <h3>Post URLs (one per line)</h3>
            <span className="pdc-panel-desc">
              {validCount} valid · {invalidCount} invalid · {parsed.duplicateCount} duplicates removed
            </span>
          </div>
          <textarea
            className="pdc-batch-textarea"
            aria-label="Batch Post URLs"
            rows={3}
            disabled={running}
            value={batchUrlsText}
            onChange={(e) => onBatchUrlsText(e.target.value)}
            placeholder={"https://www.facebook.com/groups/abc/posts/123/\nhttps://www.facebook.com/groups/abc/posts/456/"}
          />
        </div>

        <div className="pdc-summary-counters" aria-label="Validation counters">
          <span><strong>{statusCounts.total}</strong> Total</span>
          <span><strong>{statusCounts.pass}</strong> Passed</span>
          <span><strong>{statusCounts.review}</strong> Review</span>
          <span><strong>{statusCounts.failed}</strong> Failed</span>
        </div>

        <div className="pdc-library-filters" role="tablist" aria-label="Validation status filter">
          {(["ALL", "PASS", "REVIEW", "FAILED"] as const).map(value => (
            <button
              type="button"
              key={value}
              className={statusFilter === value ? "active" : ""}
              onClick={() => setStatusFilter(value)}
            >
              {value === "ALL" ? "All" : value === "PASS" ? "Passed" : value === "REVIEW" ? "Review" : "Failed"}
            </button>
          ))}
        </div>

        {!reconciledRows.length ? (
          <div className="pdc-empty-state">
            <h3>No validation results yet</h3>
            <p>Paste Facebook Post URLs above and click Run Batch Validation.</p>
          </div>
        ) : !filteredRows.length ? (
          <div className="pdc-empty-state">
            <h3>No posts match this filter</h3>
            <p>Try another status filter to inspect batch results.</p>
          </div>
        ) : (
          <div className="pdc-post-grid pdc-summary-grid">
            {filteredRows.map(row => {
              const selected = selectedRow?.url === row.url;
              return (
                <article
                  key={row.url}
                  className={`pdc-post-card ${selected ? "selected" : ""}`}
                  onClick={() => selectRow(row)}
                >
                  <header>
                    <span className={`pdc-platform ${/threads\.(?:com|net)/i.test(row.url) ? "threads" : "facebook"}`}>
                      {/threads\.(?:com|net)/i.test(row.url) ? "Threads" : "Facebook"}
                    </span>
                    <span className={`pdc-batch-pill status-${row.status.toLowerCase()}`}>{row.status}</span>
                  </header>
                  <div>
                    <span className="pdc-card-label">{formatShortPostLabel(row.url, row.postId)}</span>
                    <h3 title={row.postId || row.url}>#{row.postId && row.postId.length > 16 ? `${row.postId.slice(0, 8)}…${row.postId.slice(-6)}` : row.postId || "unknown"}</h3>
                  </div>
                  <div className="pdc-card-progress">
                    <span>Parent {row.parentStatus}</span>
                    <span>Fields {row.passedCount}/{row.totalCount}</span>
                    <span>Engagement {engagementCoverage(row)}</span>
                  </div>
                  <footer>
                    <button
                      type="button"
                      className="pdc-primary-button"
                      onClick={event => {
                        event.stopPropagation();
                        savedSummaryScrollRef.current = summaryScrollRef.current?.scrollTop || 0;
                        void openRowDetailReview(row);
                      }}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        selectRow(row);
                        if (sidebarCollapsed) setSidebarCollapsed(false);
                      }}
                    >
                      View Details
                    </button>
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        selectRow(row);
                        void navigator.clipboard.writeText(JSON.stringify(row, null, 2));
                        setCopiedJson(true);
                        setTimeout(() => setCopiedJson(false), 1800);
                      }}
                    >
                      {copiedJson && selected ? "Copied!" : "Copy JSON"}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <SidebarDrawer
        title="Row Details"
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(value => !value)}
        className="pdc-summary-sidebar"
      >
        {selectedRow ? (
          <div className="pdc-batch-detail-body">
            <div className="pdc-btn-row pdc-summary-sidebar-actions">
              <button type="button" className="pdc-btn pdc-btn-tiny" onClick={copyRowJson}>
                {copiedJson ? "Copied!" : "Copy JSON"}
              </button>
              <button
                type="button"
                className="pdc-btn pdc-btn-tiny pdc-btn-primary"
                onClick={() => {
                  savedSummaryScrollRef.current = summaryScrollRef.current?.scrollTop || 0;
                  void openRowDetailReview(selectedRow);
                }}
              >
                Review
              </button>
              <button
                type="button"
                className="pdc-btn pdc-btn-tiny"
                onClick={() => void customizeRowInStep3(selectedRow)}
              >
                Customize in Step 3
              </button>
            </div>

            {staleEngagementPipeline && (
              <div className="pdc-alert pdc-alert-warn" role="status">
                Cached Engagement OCR used the old preprocess/classifier pipeline. Recapture Engagement in Step 3 or Detail Review with the current build.
              </div>
            )}

            <dl className="pdc-kv pdc-summary-kv">
              <dt>Post ID</dt>
              <dd title={selectedRow.postId || ""}>{selectedRow.postId || "—"}</dd>
              <dt>Parent</dt>
              <dd>{selectedRow.parentStatus}</dd>
              <dt>Fields</dt>
              <dd>{selectedRow.passedCount}/{selectedRow.totalCount}</dd>
              <dt>Status</dt>
              <dd><span className={`pdc-batch-pill status-${selectedRow.status.toLowerCase()}`}>{selectedRow.status}</span></dd>
              <dt>Engagement</dt>
              <dd>
                {engagementCoverage(selectedRow)}
                {selectedEngagement?.preprocessVariant ? ` · ${selectedEngagement.preprocessVariant}` : ""}
                {selectedEngagement?.cropSha256 ? ` · ${selectedEngagement.cropSha256.slice(0, 8)}…` : ""}
              </dd>
              {selectedRow.failureReason && (
                <>
                  <dt>Failure / Note</dt>
                  <dd>{selectedRow.failureReason}</dd>
                </>
              )}
            </dl>

            {selectedRow.fields.length > 0 ? (
              <div className="pdc-summary-fields-scroll">
                <table className="pdc-batch-table">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Value</th>
                      <th>Method</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRow.fields.map((f) => (
                      <tr key={`${f.variableId}:${f.variableKey}`}>
                        <td>{f.variableKey}</td>
                        <td className="pdc-preserve-lines pdc-summary-value">{f.value || "—"}</td>
                        <td>{f.attribute ? `${f.method}(${f.attribute})` : f.method}</td>
                        <td>
                          <span className={`pdc-batch-pill status-${f.status.toLowerCase()}`}>
                            {f.status}
                          </span>
                          {f.reason && <div className="pdc-panel-desc">{f.reason}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="pdc-panel-desc">No mapped field output for this post.</p>
            )}

            <details className="pdc-advanced-debug">
              <summary>Locators &amp; diagnostics</summary>
              {selectedRow.fields.map((f) => (
                <p key={`loc:${f.variableId}:${f.variableKey}`} className="pdc-panel-desc pdc-truncate-url" title={f.relativeXPath || ""}>
                  <b>{f.variableKey}</b>: <code>{f.relativeXPath || "—"}</code>
                </p>
              ))}
              {selectedRow.parentDiagnostics?.map((d, i) => (
                <p key={`diag:${i}`} className="pdc-panel-desc">{d}</p>
              ))}
              {selectedEngagement?.diagnostics?.map((d, i) => (
                <p key={`ocr:${i}`} className="pdc-panel-desc">{d}</p>
              ))}
            </details>
          </div>
        ) : (
          <p className="pdc-panel-desc">Select a card to inspect field extraction without leaving this summary.</p>
        )}
      </SidebarDrawer>
    </div>
  );
}
