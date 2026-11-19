import React, { useEffect, useState } from "react";
import type { Command, State } from "../../shared/contracts";
import {
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import {
  claimCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { getActiveCollectorPart } from "../collectors/active-part-session";
import { BrowserCaptureStep } from "./BrowserCaptureStep";
import { BatchValidationStep } from "./BatchValidationStep";
import { PostProcessingToolbar, PostProcessingToolbarProvider } from "./PostProcessingToolbar";
import { resolveStableParent } from "./BatchValidationStep";
import { extractPostIdentityFromUrl } from "./batch-validation";
import { shouldRetrySavedParentResolution } from "./auto-resume";
import {
  AUTO_MATCH_TOTAL_TIMEOUT_MS,
  ensureTerminalResolution,
  runAutoMatchStrategies,
} from "./auto-match";
import { SavedParentHtmlStep } from "./SavedParentHtmlStep";
import { VisualRegionStep } from "./VisualRegionStep";
import { UrlWorkspaceStep } from "./UrlWorkspaceStep";
import {
  getBoundPostDetailPartId,
  usePostDetailCollectorStore,
} from "./store";
import { legacyStrategies, rankStrategies, upsertStrategyVariation } from "./url-workspace";
import type { BrowserProbe, Invoke, PostDetailStep, PostDetailUrlItem } from "./types";
import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import "../collectors/part-library.css";
import "./post-detail-collector.css";
import { playCompletionSound } from "../completion-sound";

function canEnterStep2(refs: number): boolean {
  return refs > 0;
}

function isStaleEngagementPipeline(result: import("../../shared/post-detail-collector/types").PostDetailEngagementOcrResult | undefined): boolean {
  if (!result?.runId || !result.postId) return false;
  if (result.preprocessVariant && /icon-slots/i.test(result.preprocessVariant)) return false;
  const diagnostics = result.diagnostics?.join(" ") || "";
  if (/ocr_preprocess:icon-slots/i.test(diagnostics)) return false;
  // Pre-slot pipeline required a full numeric trio — reprocess for partial Share/Comment rows.
  if (/need 3 evidence counts for LTR/i.test(diagnostics)) return true;
  if (result.preprocessVariant && /left-/i.test(result.preprocessVariant)) return false;
  if (/ocr_preprocess:left-/i.test(diagnostics)) return false;
  return /ocr_preprocess:normalize\b/i.test(diagnostics) || /overlaps an action\/icon region/i.test(diagnostics) || !result.cropSha256;
}

function locatorDiagnosticSummary(result: import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution): string {
  const meta = result.diagnosticMeta || {};
  return [
    `v${String(meta.locatorVersion ?? "?")}`,
    `post=${String(meta.postId ?? "?")}`,
    `abs=${String(meta.absoluteMatchCount ?? 0)}`,
    `rel=${String(meta.relativeMatchCount ?? 0)}`,
    `same=${String(meta.sameNode ?? false)}`,
    `identity=${String(meta.postIdentityVerified ?? false)}`,
    `row=${String(meta.actionRowVerified ?? false)}`,
    `parent=${String(meta.parentVerified ?? false)}`,
  ].join(" · ");
}

export function PostDetailCollectorPage({ invoke, state: parentState }: { invoke: Invoke; state?: State | null }) {
  const [state, updateStore] = usePostDetailCollectorStore();
  const [probe, setProbe] = useState<BrowserProbe | null>(null);
  const [probeError, setProbeError] = useState("");
  const [connStatus, setConnStatus] = useState("Đang kiểm tra BrowserCore...");
  const autoResolveStarted = React.useRef(false);
  const navigationEpoch = React.useRef(0);
  const activeResolveRunRef = React.useRef<{ epoch: number; targetKey: string } | null>(null);
  const activePart = getActiveCollectorPart();
  const boundPartId = getBoundPostDetailPartId();

  function goCollectorsHome() {
    void invoke<State>({ type: "appPage", page: "collectors" } as Command);
  }

  const cancelActiveResolve = React.useCallback((reason = "Auto Match cancelled.") => {
    navigationEpoch.current += 1;
    activeResolveRunRef.current = null;
    autoResolveStarted.current = false;
    updateStore(prev => ({
      savedParentResolution: prev.savedParentResolution?.status === "RESOLVING"
        ? {
            ...prev.savedParentResolution,
            status: "CANCELLED",
            diagnostics: [...(prev.savedParentResolution.diagnostics || []), reason],
          }
        : prev.savedParentResolution,
      urlItems: prev.urlItems.map(value =>
        value.status === "PROCESSING"
          ? { ...value, status: "NEEDS_ATTENTION", diagnostics: [...value.diagnostics, reason], updatedAt: new Date().toISOString() }
          : value,
      ),
    }));
  }, [updateStore]);

  const refreshProbe = React.useCallback(async () => {
    if (!isElectronBrowserCoreAvailable()) {
      setProbe(null);
      setProbeError("Real Browser Core unavailable (web-dev stub).");
      setConnStatus("BrowserCore không khả dụng trong web-dev.");
      return null;
    }
    try {
      const next = await invoke<BrowserProbe>({ type: "postDetailBrowserProbe" });
      setProbe(next);
      setProbeError("");
      if (next.url) updateStore({ browserUrl: next.url });
      setConnStatus(
        next.isSocialPage
          ? `BrowserCore sẵn sàng · webContents.id=${next.webContentsId} · ${next.url}`
          : `BrowserCore sẵn sàng · webContents.id=${next.webContentsId} · trang hiện tại chưa phải Facebook/Threads — dùng Open URL.`,
      );
      return next;
    } catch (err) {
      setProbe(null);
      setProbeError(String(err));
      setConnStatus(`BrowserCore chưa sẵn sàng: ${String(err)}`);
      return null;
    }
  }, [invoke, updateStore]);

  // Refresh localStorage Engagement results that were produced by the legacy normalize pipeline.
  useEffect(() => {
    let cancelled = false;
    const stale = Object.values(state.engagementResults).filter(isStaleEngagementPipeline);
    if (!stale.length || !isElectronBrowserCoreAvailable()) return;
    void (async () => {
      for (const entry of stale) {
        if (cancelled) break;
        try {
          const refreshed = await invoke<import("../../shared/post-detail-collector/types").PostDetailEngagementOcrResult>({
            type: "postDetailReprocessEngagementCrop",
            runId: entry.runId,
            postId: entry.postId,
          });
          if (cancelled) break;
          updateStore(prev => ({
            engagementResults: { ...prev.engagementResults, [refreshed.postId]: { ...refreshed, previewDataUrl: undefined } },
            batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1,
          }));
        } catch {
          /* keep cached result; UI shows stale banner until manual reprocess/recapture */
        }
      }
    })();
    return () => { cancelled = true; };
  // Intentionally once on mount for the hydrated store snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe only. Host clear is ownership-gated so Step remounts / sibling collectors are not wiped.
  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-page");
    let cancelled = false;
    let startedAtEpoch = -1;
    void (async () => {
      let live = await refreshProbe();
      const restoreUrl = state.browserUrl || state.sourceUrl;
      if (live && !live.isSocialPage && /^https?:\/\/(?:www\.)?(?:facebook\.com|threads\.(?:com|net))\//i.test(restoreUrl)) {
        setConnStatus("Restoring the last BrowserCore post…");
        await invoke({ type: "postDetailNavigate", url: restoreUrl });
        if (cancelled) return;
        live = await refreshProbe();
      }
      const needsResolve =
        (state.majorStep === 2 && state.processingSubstep === 3 && state.step === 1) ||
        state.savedParentResolution?.status === "RESOLVING";
      if (cancelled || !live || autoResolveStarted.current || activeResolveRunRef.current || !needsResolve) return;
      autoResolveStarted.current = true;
      startedAtEpoch = ++navigationEpoch.current;
      activeResolveRunRef.current = { epoch: startedAtEpoch, targetKey: "auto-resume" };
      const isOwner = () =>
        !cancelled &&
        navigationEpoch.current === startedAtEpoch &&
        activeResolveRunRef.current?.epoch === startedAtEpoch;
      const platform = /threads\.(?:com|net)/i.test(live.url) ? "threads" : "facebook";
      const config = state.parentConfigs[platform];
      if (!config) {
        setConnStatus(`Not Configured · ${platform}`);
        if (isOwner()) {
          updateStore({
            savedParentResolution: {
              status: "NOT_CONFIGURED",
              innerHTML: "",
              rect: null,
              diagnostics: [`No saved DOM Parent config for ${platform}.`],
              diagnosticMeta: { configLoaded: false, platform },
            },
          });
        }
        activeResolveRunRef.current = null;
        autoResolveStarted.current = false;
        return;
      }
      const startedAtMs = Date.now();
      const deadlineMs = startedAtMs + AUTO_MATCH_TOTAL_TIMEOUT_MS;
      updateStore({
        savedParentResolution: {
          status: "RESOLVING",
          innerHTML: "",
          rect: null,
          diagnostics: ["Resolving saved Parent against the live DOM..."],
          diagnosticMeta: {
            configLoaded: true,
            hasActionRowLocator: Boolean(config.actionRowLocator),
            parentLevel: config.parentLevel,
            attempt: 0,
            maxAttempts: 20,
            elapsedMs: 0,
          },
        },
        step: 3,
      });
      let savedParentResolution: PostDetailSavedParentResolution | null = null;
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
          if (Date.now() >= deadlineMs) {
            savedParentResolution = {
              status: "BROWSER_NOT_READY",
              failureCode: "BROWSER_NOT_READY",
              innerHTML: "",
              rect: null,
              diagnostics: [
                ...(savedParentResolution?.diagnostics || []),
                `Auto-resume timeout reached after ${Date.now() - startedAtMs}ms.`,
              ],
              diagnosticMeta: {
                ...(savedParentResolution?.diagnosticMeta || {}),
                configLoaded: true,
                hasActionRowLocator: Boolean(config.actionRowLocator),
                parentLevel: config.parentLevel,
                attempt,
                maxAttempts: 20,
                elapsedMs: Date.now() - startedAtMs,
                timedOut: true,
              },
            };
            break;
          }
          savedParentResolution = await invoke<PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config });
          if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
          if (savedParentResolution.status === "PARENT_MATCHED") break;
          if (!shouldRetrySavedParentResolution(savedParentResolution)) break;
          const elapsedMs = Date.now() - startedAtMs;
          setConnStatus(`Đang chờ DOM bài viết render · ${savedParentResolution.failureCode} · lần ${attempt + 1}/20`);
          if (isOwner()) {
            updateStore(prev =>
              prev.savedParentResolution?.status === "RESOLVING"
                ? {
                    savedParentResolution: {
                      ...prev.savedParentResolution,
                      diagnostics: [`Waiting for DOM render (${savedParentResolution?.failureCode || "RETRY"}) · attempt ${attempt + 1}/20`],
                      diagnosticMeta: {
                        ...prev.savedParentResolution.diagnosticMeta,
                        attempt: attempt + 1,
                        maxAttempts: 20,
                        elapsedMs,
                        lastFailureCode: savedParentResolution?.failureCode,
                      },
                    },
                  }
                : {},
            );
          }
          if (attempt < 19) {
            const sleepMs = Math.min(750, Math.max(0, deadlineMs - Date.now()));
            if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
          }
        }
      } catch (err) {
        if (!isOwner()) return;
        updateStore({ savedParentResolution: { status: "REMATCH_REQUIRED", failureCode: "BROWSER_NOT_READY", innerHTML: "", rect: null, diagnostics: [`Resolve failed: ${String(err)}`], diagnosticMeta: { configLoaded: true, hasActionRowLocator: Boolean(config.actionRowLocator), parentLevel: config.parentLevel, elapsedMs: Date.now() - startedAtMs } } });
        setConnStatus(`Resolve failed: ${String(err)}`);
        return;
      } finally {
        if (activeResolveRunRef.current?.epoch === startedAtEpoch) {
          activeResolveRunRef.current = null;
        }
        autoResolveStarted.current = false;
      }
      if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
      savedParentResolution = ensureTerminalResolution(savedParentResolution, "BROWSER_NOT_READY");
      if (savedParentResolution.status !== "PARENT_MATCHED") {
        updateStore({ savedParentResolution });
        setConnStatus(`Rematch Required · ${savedParentResolution.failureCode || savedParentResolution.status} · ${locatorDiagnosticSummary(savedParentResolution)}`);
        return;
      }
      const resolvedConfig = savedParentResolution.resolvedDomAnchors
        ? { ...config, domAnchors: savedParentResolution.resolvedDomAnchors, updatedAt: new Date().toISOString() }
        : config;
      updateStore(prev => ({
        savedParentResolution,
        step: 3,
        parentConfigs: { ...prev.parentConfigs, [platform]: resolvedConfig },
        strategies: prev.strategies.map(strategy => strategy.platform === platform && strategy.parentConfig === config
          ? { ...strategy, parentConfig: resolvedConfig, anchors: resolvedConfig.domAnchors || strategy.anchors }
          : strategy),
      }));
    })();
    return () => {
      cancelled = true;
      autoResolveStarted.current = false;
      if (startedAtEpoch >= 0 && activeResolveRunRef.current?.epoch === startedAtEpoch) {
        activeResolveRunRef.current = null;
        updateStore(prev =>
          prev.savedParentResolution?.status === "RESOLVING"
            ? {
                savedParentResolution: {
                  ...prev.savedParentResolution,
                  status: "CANCELLED",
                  diagnostics: [...(prev.savedParentResolution.diagnostics || []), "Auto-resume cancelled on unmount."],
                },
              }
            : {},
        );
      }
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe refresh must not tear down host
    // Auto-resume belongs to this Collector mount. Depending on the invoke wrapper
    // cancels the retry loop when a parent render recreates that function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canEnterStep4 = Object.keys(state.parentConfigs).length > 0 || Boolean(state.savedParentResolution);
  const goToStep = (step: PostDetailStep) => {
    if (step === 2 && !canEnterStep2(state.visualReferences.length)) return;
    if (step === 3 && !state.savedParentResolution) return;
    if (step === 4 && !canEnterStep4) return;
    cancelActiveResolve("Auto Match cancelled by step navigation.");
    if (step !== 1 && step !== 2) {
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    }
    updateStore({ step });
  };

  const connected = Boolean(probe?.available) && !probeError;
  const step2Ready = canEnterStep2(state.visualReferences.length);
  // Prefer selected/source post for the header label so Detail Review does not keep a stale BrowserCore post.
  const selectedWorkspaceItem = state.urlItems.find(item => item.id === state.selectedUrlId);
  const selectionPostId = selectedWorkspaceItem?.postId
    || extractPostIdentityFromUrl(state.sourceUrl || "").postId
    || null;
  const liveConnectionUrl = probe?.url || state.browserUrl || "";
  const liveConnectionPostId = extractPostIdentityFromUrl(liveConnectionUrl).postId;
  const connectionPostId = selectionPostId || liveConnectionPostId;
  const connectionUrl = selectionPostId && state.sourceUrl
    ? state.sourceUrl
    : (liveConnectionUrl || state.sourceUrl);
  const connectionLabel = connectionPostId
    ? `Post #${connectionPostId.length > 14 ? `${connectionPostId.slice(0, 7)}…${connectionPostId.slice(-5)}` : connectionPostId}`
    : connected ? "BrowserCore ready" : "BrowserCore unavailable";

  const runUrlAutoMatch = async (opts: {
    item?: PostDetailUrlItem;
    targetUrl: string;
    postId: string | null;
    platform: string;
    navigateFirst: boolean;
  }) => {
    const targetKey = opts.item?.id || opts.targetUrl;
    if (opts.navigateFirst && activeResolveRunRef.current?.targetKey === targetKey) {
      return;
    }
    const epoch = ++navigationEpoch.current;
    activeResolveRunRef.current = { epoch, targetKey };
    autoResolveStarted.current = true;
    const isOwner = () =>
      navigationEpoch.current === epoch && activeResolveRunRef.current?.epoch === epoch;

    const identity = extractPostIdentityFromUrl(opts.targetUrl);
    const platform = identity.platform || opts.platform || "facebook";
    const ranked = rankStrategies(state.strategies, platform);
    const fallbackConfig = state.parentConfigs[platform];
    const candidates = ranked.length
      ? ranked
      : fallbackConfig
        ? legacyStrategies({ [platform]: fallbackConfig })
        : [];

    updateStore(prev => ({
      selectedUrlId: opts.item ? opts.item.id : prev.selectedUrlId,
      majorStep: 2,
      processingSubstep: 3,
      step: 3,
      sourceUrl: opts.targetUrl,
      savedParentResolution: {
        status: "RESOLVING",
        innerHTML: "",
        rect: null,
        diagnostics: [
          opts.navigateFirst
            ? "Navigating selected URL and verifying live post identity..."
            : "Retrying Auto Match against the current BrowserCore session...",
        ],
        diagnosticMeta: {
          expectedPostId: opts.postId,
          totalStrategies: candidates.length,
          attempt: 0,
          elapsedMs: 0,
        },
      },
      urlItems: opts.item
        ? prev.urlItems.map(value =>
            value.id === opts.item!.id
              ? { ...value, status: "PROCESSING", diagnostics: [], updatedAt: new Date().toISOString() }
              : value,
          )
        : prev.urlItems,
    }));

    try {
      if (opts.navigateFirst) {
        await invoke({ type: "postDetailNavigate", url: opts.targetUrl });
      } else {
        await refreshProbe();
      }
      if (!isOwner()) return;

      const matchResult = await runAutoMatchStrategies({
        invoke,
        strategies: candidates,
        expectedPostId: opts.postId,
        currentUrl: opts.targetUrl,
        isCancelled: () => !isOwner(),
        timeoutMs: AUTO_MATCH_TOTAL_TIMEOUT_MS,
        onWaiting: setConnStatus,
        onProgress: (progress) => {
          if (!isOwner()) return;
          updateStore(prev =>
            prev.savedParentResolution?.status === "RESOLVING"
              ? {
                  savedParentResolution: {
                    ...prev.savedParentResolution,
                    diagnostics: [progress.message],
                    diagnosticMeta: {
                      ...prev.savedParentResolution.diagnosticMeta,
                      expectedPostId: opts.postId,
                      strategyId: progress.strategyId,
                      strategyIndex: progress.strategyIndex,
                      totalStrategies: progress.totalStrategies,
                      attempt: progress.attempt,
                      maxAttempts: progress.maxAttempts,
                      elapsedMs: progress.elapsedMs,
                      lastFailureCode: progress.failureCode,
                    },
                  },
                }
              : {},
          );
        },
      });

      if (!isOwner()) return;

      if (matchResult.outcome === "CANCELLED") {
        updateStore(prev => ({
          savedParentResolution: matchResult.resolution,
          urlItems: opts.item
            ? prev.urlItems.map(value =>
                value.id === opts.item!.id
                  ? { ...value, status: "NEEDS_ATTENTION", diagnostics: matchResult.resolution.diagnostics, updatedAt: new Date().toISOString() }
                  : value,
              )
            : prev.urlItems,
        }));
        return;
      }

      const resolution = ensureTerminalResolution(matchResult.resolution, "REMATCH_REQUIRED");
      const ready = resolution.status === "PARENT_MATCHED";
      const liveProbe = await refreshProbe();
      if (!isOwner()) return;

      updateStore(prev => ({
        browserUrl: liveProbe?.url || prev.browserUrl,
        savedParentResolution: resolution,
        parentConfigs: matchResult.selectedConfig
          ? { ...prev.parentConfigs, [matchResult.selectedConfig.platform]: matchResult.selectedConfig }
          : prev.parentConfigs,
        processingSubstep: 3,
        step: 3,
        urlItems: opts.item
          ? prev.urlItems.map(value =>
              value.id === opts.item!.id
                ? {
                    ...value,
                    status: ready ? "READY" : "NEEDS_ATTENTION",
                    strategyId: matchResult.strategyId,
                    engagementAnchorsVerified: resolution.diagnosticMeta?.engagementAnchorsVerified === true,
                    diagnostics: resolution.diagnostics,
                    updatedAt: new Date().toISOString(),
                  }
                : value,
            )
          : prev.urlItems,
        strategies: prev.strategies.map(strategy =>
          strategy.id === matchResult.strategyId
            ? {
                ...strategy,
                parentConfig: matchResult.selectedConfig || strategy.parentConfig,
                anchors: matchResult.selectedConfig?.domAnchors || strategy.anchors,
                successes: strategy.successes + (ready ? 1 : 0),
                failures: strategy.failures + (ready ? 0 : 1),
                updatedAt: new Date().toISOString(),
              }
            : strategy,
        ),
      }));
      void playCompletionSound(ready ? "SUCCESS" : "NEEDS_ATTENTION", `auto-match:${targetKey}:${epoch}`);
    } catch (error) {
      if (!isOwner()) return;
      updateStore(prev => ({
        savedParentResolution: {
          status: "REMATCH_REQUIRED",
          failureCode: "BROWSER_NOT_READY",
          innerHTML: "",
          rect: null,
          diagnostics: [String(error)],
          diagnosticMeta: { expectedPostId: opts.postId },
        },
        urlItems: opts.item
          ? prev.urlItems.map(value =>
              value.id === opts.item!.id
                ? { ...value, status: "FAILED", diagnostics: [String(error)], updatedAt: new Date().toISOString() }
                : value,
            )
          : prev.urlItems,
      }));
      void playCompletionSound("NEEDS_ATTENTION", `auto-match:${targetKey}:${epoch}`);
    } finally {
      if (activeResolveRunRef.current?.epoch === epoch) {
        activeResolveRunRef.current = null;
      }
      autoResolveStarted.current = false;
    }
  };

  const selectUrl = async (item: PostDetailUrlItem) => {
    await runUrlAutoMatch({
      item,
      targetUrl: item.originalUrl,
      postId: item.postId,
      platform: item.platform || "facebook",
      navigateFirst: true,
    });
  };

  const retryAutoMatch = async () => {
    const selectedItem = state.urlItems.find(item => item.id === state.selectedUrlId);
    const targetUrl = selectedItem?.originalUrl || state.sourceUrl || state.browserUrl;
    const identity = extractPostIdentityFromUrl(targetUrl);
    await runUrlAutoMatch({
      item: selectedItem,
      targetUrl,
      postId: selectedItem?.postId ?? identity.postId,
      platform: selectedItem?.platform || identity.platform || "facebook",
      navigateFirst: false,
    });
  };

  return (
    <PostProcessingToolbarProvider>
    <section className="app-page post-detail-collector-page" aria-label="Post Detail Collector">
      {boundPartId && activePart ? (
        <div className="part-active-banner" role="status">
          <span>
            Visual Part: <b>{activePart.name}</b> · v{activePart.version} · config isolated from other Parts
          </span>
          <button type="button" onClick={goCollectorsHome}>
            ← Collectors Home
          </button>
        </div>
      ) : null}
      <div className="pdc-page-header">
        <div className="pdc-title-group">
          <h1>Post Detail Collector</h1>
          <span className="pdc-version-tag">V2</span>
          <div className={`pdc-banner pdc-connection-chip ${connected ? "banner-connected" : "banner-disconnected"}`} role="status" title={`${connStatus}\n${connectionUrl}`}>
            <span className="pdc-connection-dot" aria-hidden />
            <span>{connectionLabel}</span>
            {connectionUrl && <button type="button" className="pdc-copy-link" onClick={() => void navigator.clipboard.writeText(connectionUrl)}>Copy</button>}
          </div>
        </div>
        <nav className="pdc-stepper" aria-label="Post Detail Collector Stepper">
          <button
            type="button"
            className={`pdc-step-pill ${state.majorStep === 1 ? "active" : ""}`}
            onClick={() => updateStore({ majorStep: 1 })}
          >
            <span className="pdc-step-num">1</span>
            <span className="pdc-step-text">URL Workspace</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button
            type="button"
            className={`pdc-step-pill ${state.majorStep === 2 ? "active" : ""}`}
            disabled={!state.selectedUrlId}
            onClick={() => updateStore({ majorStep: 2 })}
          >
            <span className="pdc-step-num">2</span>
            <span className="pdc-step-text">Post Processing</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button type="button" title="Batch Validation Summary" className={`pdc-step-pill ${state.majorStep === 3 ? "active" : ""} ${state.batchResults.length ? "completed" : ""}`} onClick={() => updateStore({ majorStep: 3 })}><span className="pdc-step-num">3</span><span className="pdc-step-text">Validation Summary</span></button>
        </nav>
      </div>

      {state.majorStep === 2 && (
        <PostProcessingToolbar
          processingSubstep={state.processingSubstep}
          step2Ready={step2Ready}
          onSelectSubstep={(substep) => updateStore({ processingSubstep: substep, step: substep })}
        />
      )}

      <div className="pdc-content-area">
        {state.majorStep === 1 && <UrlWorkspaceStep
          invoke={invoke}
          text={state.batchUrlsText}
          items={state.urlItems}
          selectedId={state.selectedUrlId}
          onChange={(batchUrlsText, urlItems) => updateStore((prev) => ({
            batchUrlsText,
            urlItems,
            selectedUrlId: prev.selectedUrlId && urlItems.some(item => item.id === prev.selectedUrlId)
              ? prev.selectedUrlId
              : null,
          }))}
          onSelect={item => void selectUrl(item)}
        />}
        {state.majorStep === 2 && state.processingSubstep === 1 && (
          <BrowserCaptureStep
            invoke={invoke}
            state={parentState}
            sourceUrl={state.sourceUrl}
            browserUrl={state.browserUrl}
            visualReferences={state.visualReferences}
            onSourceUrl={(sourceUrl) => updateStore({ sourceUrl })}
            onBrowserUrl={(browserUrl) => { cancelActiveResolve("Auto Match cancelled due to browser navigation."); updateStore({ browserUrl }); }}
            onUpdateReferences={(visualReferences) => updateStore({ visualReferences })}
            onScreenshot={(lastScreenshot) => updateStore({ lastScreenshot })}
            onProbeRefresh={refreshProbe}
            onNext={() => updateStore({ step: 2, processingSubstep: 2 })}
          />
        )}
        {state.majorStep === 2 && state.processingSubstep === 2 && (
          <VisualRegionStep
            invoke={invoke}
            state={parentState}
            sourceUrl={state.sourceUrl}
            savedDomStrategy={state.parentConfigs[extractPostIdentityFromUrl(state.sourceUrl).platform || "facebook"]}
            runId={state.runId}
            visualReferences={state.visualReferences}
            containerResult={state.containerResult}
            scanFrames={state.scanFrames}
            contentRoi={state.contentRoi}
            lastMatch={state.lastMatch}
            lastScreenshot={state.lastScreenshot}
            onContainerResult={(containerResult) => updateStore({ containerResult })}
            onScanFrames={(scanFrames) => updateStore({ scanFrames })}
            onContentRoi={(contentRoi) => updateStore({ contentRoi })}
            onMatch={(lastMatch) => updateStore({ lastMatch })}
            onScreenshot={(lastScreenshot) => updateStore({ lastScreenshot })}
            onRunId={(runId) => updateStore({ runId })}
            onProbeRefresh={refreshProbe}
            onBack={() => updateStore({ step: 1, processingSubstep: 1 })}
            onParentConfigured={async (config) => {
              const parentConfigs = { ...state.parentConfigs, [config.platform]: config };
              const savedParentResolution = await invoke<import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config });
              await collectorReportBrowserHost(invoke, null);
              await collectorSetBrowserVisible(invoke, false);
              updateStore((prev) => ({ parentConfigs, strategies: upsertStrategyVariation(prev.strategies, config), savedParentResolution, step: 3, processingSubstep: 3, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }));
            }}
          />
        )}
        {state.majorStep === 2 && state.processingSubstep === 3 && (
          <SavedParentHtmlStep
            invoke={invoke}
            result={state.savedParentResolution}
            currentUrl={state.sourceUrl || state.browserUrl}
            runId={state.runId}
            engagementResult={state.engagementResults[String(state.savedParentResolution?.diagnosticMeta?.postId || extractPostIdentityFromUrl(state.sourceUrl || state.browserUrl).postId || "current-post")]}
            onEngagementResult={(engagementResult) => updateStore((prev) => ({ engagementResults: { ...prev.engagementResults, [engagementResult.postId]: { ...engagementResult, previewDataUrl: undefined } }, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))}
            parentConfig={state.parentConfigs[extractPostIdentityFromUrl(state.sourceUrl || state.browserUrl).platform || "facebook"]}
            variableMappings={state.variableMappings}
            onVariableMappings={(variableMappings) =>
              updateStore((prev) => ({ variableMappings, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            hiddenExtractedData={state.hiddenExtractedData}
            onHiddenExtractedData={(hiddenExtractedData) => updateStore({ hiddenExtractedData })}
            onBackToLibrary={() => updateStore({ majorStep: 1 })}
            onVariablesChanged={() =>
              updateStore((prev) => ({ batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            onRematch={() => { cancelActiveResolve("Auto Match cancelled for manual rematch."); updateStore({ step: 2, processingSubstep: 2 }); }}
            onRetryAutoMatch={() => void retryAutoMatch()}
            onNextBatchValidation={() => updateStore({ majorStep: 3 })}
          />
        )}
        {state.majorStep === 3 && (
          <BatchValidationStep
            invoke={invoke}
            parentConfigs={state.parentConfigs}
            variableMappings={state.variableMappings}
            hiddenExtractedData={state.hiddenExtractedData}
            batchUrlsText={state.batchUrlsText}
            batchResults={state.batchResults}
            batchConfigVersion={state.batchConfigVersion}
            batchValidatedVersion={state.batchValidatedVersion}
            engagementResults={state.engagementResults}
            onBatchUrlsText={(batchUrlsText) => updateStore({ batchUrlsText })}
            onBatchResults={(batchResults, batchValidatedVersion) =>
              updateStore({ batchResults, batchValidatedVersion })
            }
            onVariableMappings={(variableMappings) =>
              updateStore((prev) => ({ variableMappings, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            onHiddenExtractedData={(hiddenExtractedData) => updateStore({ hiddenExtractedData })}
            onEngagementResult={(engagementResult) => updateStore((prev) => ({ engagementResults: { ...prev.engagementResults, [engagementResult.postId]: { ...engagementResult, previewDataUrl: undefined } }, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))}
            onReviewInStep3={(url, savedParentResolution) => {
              const reviewItem = state.urlItems.find(item => item.originalUrl === url || item.postId && url.includes(item.postId));
              updateStore({
                sourceUrl: url,
                selectedUrlId: reviewItem?.id ?? state.selectedUrlId,
                savedParentResolution,
                step: 3,
                majorStep: 2,
                processingSubstep: 3,
              });
            }}
            onBackToStep3={() => updateStore({ majorStep: 2, processingSubstep: 3, step: 3 })}
          />
        )}
      </div>
    </section>
    </PostProcessingToolbarProvider>
  );
}
