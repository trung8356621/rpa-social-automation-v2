import React, { useEffect, useState } from "react";
import type { State } from "../../shared/contracts";
import {
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import {
  claimCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { BrowserCaptureStep } from "./BrowserCaptureStep";
import { BatchValidationStep } from "./BatchValidationStep";
import { resolveStableParent } from "./BatchValidationStep";
import { extractPostIdentityFromUrl } from "./batch-validation";
import { shouldRetrySavedParentResolution } from "./auto-resume";
import { SavedParentHtmlStep } from "./SavedParentHtmlStep";
import { VisualRegionStep } from "./VisualRegionStep";
import { UrlWorkspaceStep } from "./UrlWorkspaceStep";
import { usePostDetailCollectorStore } from "./store";
import { classifyAutoMatchGate, effectiveStrategyConfig, rankStrategies, upsertStrategyVariation } from "./url-workspace";
import type { BrowserProbe, Invoke, PostDetailStep, PostDetailUrlItem } from "./types";
import "./post-detail-collector.css";
import { playCompletionSound } from "../completion-sound";

function canEnterStep2(refs: number): boolean {
  return refs > 0;
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

  // Probe only. Host clear is ownership-gated so Step remounts / sibling collectors are not wiped.
  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-page");
    let cancelled = false;
    void (async () => {
      let live = await refreshProbe();
      const restoreUrl = state.browserUrl || state.sourceUrl;
      if (live && !live.isSocialPage && /^https?:\/\/(?:www\.)?(?:facebook\.com|threads\.(?:com|net))\//i.test(restoreUrl)) {
        setConnStatus("Restoring the last BrowserCore post…");
        await invoke({ type: "postDetailNavigate", url: restoreUrl });
        if (cancelled) return;
        live = await refreshProbe();
      }
      const needsResolve = state.step === 1 || (state.step === 3 && state.savedParentResolution?.status === "RESOLVING");
      if (cancelled || !live || autoResolveStarted.current || !needsResolve) return;
      autoResolveStarted.current = true;
      const startedAtEpoch = navigationEpoch.current;
      const platform = /threads\.(?:com|net)/i.test(live.url) ? "threads" : "facebook";
      const config = state.parentConfigs[platform];
      if (!config) { setConnStatus(`Not Configured · ${platform}`); return; }
      updateStore({ savedParentResolution: { status: "RESOLVING", innerHTML: "", rect: null, diagnostics: ["Resolving saved Parent against the live DOM..."], diagnosticMeta: { configLoaded: true, hasActionRowLocator: Boolean(config.actionRowLocator), parentLevel: config.parentLevel } }, step: 3 });
      let savedParentResolution: import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution | null = null;
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
          savedParentResolution = await invoke<import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config });
          if (savedParentResolution.status === "PARENT_MATCHED") break;
          if (!shouldRetrySavedParentResolution(savedParentResolution)) break;
          setConnStatus(`Đang chờ DOM bài viết render · ${savedParentResolution.failureCode} · lần ${attempt + 1}/20`);
          if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch (err) {
        if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
        updateStore({ savedParentResolution: { status: "REMATCH_REQUIRED", failureCode: "BROWSER_NOT_READY", innerHTML: "", rect: null, diagnostics: [`Resolve failed: ${String(err)}`], diagnosticMeta: { configLoaded: true, hasActionRowLocator: Boolean(config.actionRowLocator), parentLevel: config.parentLevel } } });
        setConnStatus(`Resolve failed: ${String(err)}`);
        return;
      }
      if (cancelled || !savedParentResolution || navigationEpoch.current !== startedAtEpoch) return;
      if (savedParentResolution.status !== "PARENT_MATCHED") {
        updateStore({ savedParentResolution });
        setConnStatus(`Rematch Required · ${savedParentResolution.failureCode || savedParentResolution.status} · ${locatorDiagnosticSummary(savedParentResolution)}`);
        return;
      }
      if (cancelled || navigationEpoch.current !== startedAtEpoch) return;
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
    navigationEpoch.current += 1;
    if (step !== 1 && step !== 2) {
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    }
    updateStore({ step });
  };

  const connected = Boolean(probe?.available) && !probeError;
  const step2Ready = canEnterStep2(state.visualReferences.length);
  const connectionUrl = probe?.url || state.browserUrl || state.sourceUrl;
  const connectionPostId = extractPostIdentityFromUrl(connectionUrl).postId;
  const connectionLabel = connectionPostId
    ? `Post #${connectionPostId.length > 14 ? `${connectionPostId.slice(0, 7)}…${connectionPostId.slice(-5)}` : connectionPostId}`
    : connected ? "BrowserCore ready" : "BrowserCore unavailable";

  const selectUrl = async (item: PostDetailUrlItem) => {
    const epoch = ++navigationEpoch.current;
    updateStore(prev => ({
      selectedUrlId: item.id,
      majorStep: 2,
      processingSubstep: 3,
      step: 3,
      sourceUrl: item.originalUrl,
      savedParentResolution: { status: "RESOLVING", innerHTML: "", rect: null, diagnostics: ["Navigating selected URL and verifying live post identity..."], diagnosticMeta: { expectedPostId: item.postId } },
      urlItems: prev.urlItems.map(value => value.id === item.id ? { ...value, status: "PROCESSING", diagnostics: [], updatedAt: new Date().toISOString() } : value),
    }));
    try {
      await invoke({ type: "postDetailNavigate", url: item.originalUrl });
      if (navigationEpoch.current !== epoch) return;
      const identity = extractPostIdentityFromUrl(item.originalUrl);
      const candidates = rankStrategies(state.strategies, identity.platform || item.platform || "facebook");
      let resolution: import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution | null = null;
      let strategyId: string | undefined;
      let selectedConfig: import("../../shared/post-detail-collector/types").PostDetailParentConfig | undefined;
      for (const strategy of candidates) {
        const effectiveConfig = effectiveStrategyConfig(strategy);
        resolution = await resolveStableParent({ invoke, config: effectiveConfig, expectedPostId: item.postId, currentUrl: item.originalUrl, cancelled: () => navigationEpoch.current !== epoch, onWaiting: setConnStatus });
        const runtimeConfig = resolution.resolvedDomAnchors
          ? { ...effectiveConfig, domAnchors: resolution.resolvedDomAnchors, updatedAt: new Date().toISOString() }
          : effectiveConfig;
        const anchorsConfigured = ["like_anchor", "comment_anchor", "share_anchor"].every(role =>
          runtimeConfig.domAnchors?.[role as keyof NonNullable<typeof runtimeConfig.domAnchors>]?.verificationStatus === "VERIFIED");
        const anchorsVerified = anchorsConfigured && resolution.diagnosticMeta?.domAnchorsVerified === true;
        const gate = classifyAutoMatchGate({
          status: resolution.status,
          postIdentityVerified: resolution.diagnosticMeta?.postIdentityVerified === true,
          parentVerified: resolution.diagnosticMeta?.parentVerified === true,
          engagementAnchorsVerified: anchorsVerified,
        });
        if (gate.canReview) {
          strategyId = strategy.id;
          selectedConfig = runtimeConfig;
          resolution = {
            ...resolution,
            diagnosticMeta: { ...resolution.diagnosticMeta, engagementAnchorsVerified: anchorsVerified, strategyId: strategy.id, strategyVersion: strategy.version, parentConfigVersion: effectiveConfig.version },
            diagnostics: anchorsVerified ? resolution.diagnostics : [...resolution.diagnostics, "Parent and post identity verified. Engagement anchors remain Needs Attention; other semantic fields are available."],
          };
          break;
        }
      }
      if (navigationEpoch.current !== epoch) return;
      resolution ||= { status: "REMATCH_REQUIRED", failureCode: "NOT_FOUND", innerHTML: "", rect: null, diagnostics: [candidates.length ? "No saved DOM strategy verified this post." : "No saved DOM strategy is available for this platform."] };
      const ready = resolution.status === "PARENT_MATCHED";
      const liveProbe = await refreshProbe();
      if (navigationEpoch.current !== epoch) return;
      updateStore(prev => ({
        browserUrl: liveProbe?.url || prev.browserUrl,
        savedParentResolution: resolution,
        parentConfigs: selectedConfig ? { ...prev.parentConfigs, [selectedConfig.platform]: selectedConfig } : prev.parentConfigs,
        processingSubstep: 3,
        step: 3,
        urlItems: prev.urlItems.map(value => value.id === item.id ? { ...value, status: ready ? "READY" : "NEEDS_ATTENTION", strategyId, engagementAnchorsVerified: resolution!.diagnosticMeta?.engagementAnchorsVerified === true, diagnostics: resolution!.diagnostics, updatedAt: new Date().toISOString() } : value),
        strategies: prev.strategies.map(strategy => strategy.id === strategyId ? { ...strategy, parentConfig: selectedConfig || strategy.parentConfig, anchors: selectedConfig?.domAnchors || strategy.anchors, successes: strategy.successes + (ready ? 1 : 0), failures: strategy.failures + (ready ? 0 : 1), updatedAt: new Date().toISOString() } : strategy),
      }));
      void playCompletionSound(ready ? "SUCCESS" : "NEEDS_ATTENTION", `auto-match:${item.id}:${epoch}`);
    } catch (error) {
      if (navigationEpoch.current !== epoch) return;
      updateStore(prev => ({
        savedParentResolution: { status: "REMATCH_REQUIRED", failureCode: "BROWSER_NOT_READY", innerHTML: "", rect: null, diagnostics: [String(error)] },
        urlItems: prev.urlItems.map(value => value.id === item.id ? { ...value, status: "FAILED", diagnostics: [String(error)], updatedAt: new Date().toISOString() } : value),
      }));
      void playCompletionSound("NEEDS_ATTENTION", `auto-match:${item.id}:${epoch}`);
    }
  };

  return (
    <section className="app-page post-detail-collector-page" aria-label="Post Detail Collector">
      <div className="pdc-page-header">
        <div className="pdc-title-group">
          <h1>Post Detail Collector</h1>
          <span className="pdc-version-tag">V2</span>
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

      <div className={`pdc-banner pdc-connection-chip ${connected ? "banner-connected" : "banner-disconnected"}`} role="status" title={`${connStatus}\n${connectionUrl}`}>
        <span className="pdc-connection-dot" aria-hidden />
        <span>{connectionLabel}</span>
        {connectionUrl && <button type="button" className="pdc-copy-link" onClick={() => void navigator.clipboard.writeText(connectionUrl)}>Copy</button>}
      </div>

      <div className="pdc-content-area">
        {state.majorStep === 1 && <UrlWorkspaceStep
          invoke={invoke}
          text={state.batchUrlsText}
          items={state.urlItems}
          selectedId={state.selectedUrlId}
          onChange={(batchUrlsText, urlItems) => updateStore({ batchUrlsText, urlItems })}
          onSelect={item => void selectUrl(item)}
        />}
        {state.majorStep === 2 && <nav className="pdc-substep-nav" aria-label="Post processing substeps">
          <button type="button" onClick={() => updateStore({ processingSubstep: 1, step: 1 })}>1 Browser & Capture</button>
          <button type="button" disabled={!step2Ready} onClick={() => updateStore({ processingSubstep: 2, step: 2 })}>2 Visual Region</button>
          <button type="button" title="Parent HTML semantic review" onClick={() => updateStore({ processingSubstep: 3, step: 3 })}>3 Extracted Data Review</button>
        </nav>}
        {state.majorStep === 2 && state.processingSubstep === 1 && (
          <BrowserCaptureStep
            invoke={invoke}
            state={parentState}
            sourceUrl={state.sourceUrl}
            browserUrl={state.browserUrl}
            visualReferences={state.visualReferences}
            onSourceUrl={(sourceUrl) => updateStore({ sourceUrl })}
            onBrowserUrl={(browserUrl) => { navigationEpoch.current += 1; autoResolveStarted.current = false; updateStore({ browserUrl }); }}
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
            parentConfig={state.parentConfigs[extractPostIdentityFromUrl(state.sourceUrl || state.browserUrl).platform || "facebook"]}
            variableMappings={state.variableMappings}
            onVariableMappings={(variableMappings) =>
              updateStore((prev) => ({ variableMappings, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            hiddenExtractedData={state.hiddenExtractedData}
            onHiddenExtractedData={(hiddenExtractedData) => updateStore({ hiddenExtractedData })}
            onVariablesChanged={() =>
              updateStore((prev) => ({ batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            onRematch={() => { navigationEpoch.current += 1; autoResolveStarted.current = false; updateStore({ step: 2, processingSubstep: 2 }); }}
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
            onBatchUrlsText={(batchUrlsText) => updateStore({ batchUrlsText })}
            onBatchResults={(batchResults, batchValidatedVersion) =>
              updateStore({ batchResults, batchValidatedVersion })
            }
            onVariableMappings={(variableMappings) =>
              updateStore((prev) => ({ variableMappings, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            onHiddenExtractedData={(hiddenExtractedData) => updateStore({ hiddenExtractedData })}
            onReviewInStep3={(url, savedParentResolution) =>
              updateStore({ sourceUrl: url, savedParentResolution, step: 3, majorStep: 2, processingSubstep: 3 })
            }
            onBackToStep3={() => updateStore({ majorStep: 2, processingSubstep: 3, step: 3 })}
          />
        )}
      </div>
    </section>
  );
}
