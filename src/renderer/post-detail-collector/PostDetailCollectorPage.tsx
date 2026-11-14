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
import { shouldRetrySavedParentResolution } from "./auto-resume";
import { SavedParentHtmlStep } from "./SavedParentHtmlStep";
import { VisualRegionStep } from "./VisualRegionStep";
import { usePostDetailCollectorStore } from "./store";
import type { BrowserProbe, Invoke, PostDetailStep } from "./types";
import "./post-detail-collector.css";

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
      const live = await refreshProbe();
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
      updateStore({ savedParentResolution, step: 3 });
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

  return (
    <section className="app-page post-detail-collector-page" aria-label="Post Detail Collector">
      <div className="pdc-page-header">
        <div className="pdc-title-group">
          <h1>Post Detail Collector</h1>
          <span className="pdc-version-tag">V2 Phase 1 · OCR POC</span>
        </div>
        <nav className="pdc-stepper" aria-label="Post Detail Collector Stepper">
          <button
            type="button"
            className={`pdc-step-pill ${state.step === 1 ? "active" : ""} ${state.visualReferences.length ? "completed" : ""}`}
            onClick={() => goToStep(1)}
          >
            <span className="pdc-step-num">1</span>
            <span className="pdc-step-text">Browser & Capture</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button
            type="button"
            className={`pdc-step-pill ${state.step === 2 ? "active" : ""} ${state.lastMatch && state.contentRoi ? "completed" : ""}`}
            disabled={!step2Ready && state.step !== 2}
            title={step2Ready ? undefined : "Cần ≥1 visual reference từ Step 1"}
            onClick={() => goToStep(2)}
          >
            <span className="pdc-step-num">2</span>
            <span className="pdc-step-text">Visual Region</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button type="button" className={`pdc-step-pill ${state.step === 3 ? "active" : ""}`} disabled={!state.savedParentResolution} onClick={() => goToStep(3)}><span className="pdc-step-num">3</span><span className="pdc-step-text">Parent HTML</span></button>
          <span className="pdc-step-arrow">→</span>
          <button type="button" className={`pdc-step-pill ${state.step === 4 ? "active" : ""} ${state.batchResults.length ? "completed" : ""}`} disabled={!canEnterStep4} onClick={() => goToStep(4)}><span className="pdc-step-num">4</span><span className="pdc-step-text">Batch Validation</span></button>
        </nav>
      </div>

      <div className={`pdc-banner ${connected ? "banner-connected" : "banner-disconnected"}`} role="status">
        <span>{connected ? "🟢" : "🔴"}</span>
        <span>{connStatus}</span>
      </div>

      <div className="pdc-content-area">
        {state.step === 1 && (
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
            onNext={() => goToStep(2)}
          />
        )}
        {state.step === 2 && (
          <VisualRegionStep
            invoke={invoke}
            state={parentState}
            sourceUrl={state.sourceUrl}
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
            onBack={() => goToStep(1)}
            onParentConfigured={async (config) => {
              const parentConfigs = { ...state.parentConfigs, [config.platform]: config };
              const savedParentResolution = await invoke<import("../../shared/post-detail-collector/types").PostDetailSavedParentResolution>({ type: "postDetailResolveSavedParent", config });
              await collectorReportBrowserHost(invoke, null);
              await collectorSetBrowserVisible(invoke, false);
              updateStore((prev) => ({ parentConfigs, savedParentResolution, step: 3, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }));
            }}
          />
        )}
        {state.step === 3 && (
          <SavedParentHtmlStep
            invoke={invoke}
            result={state.savedParentResolution}
            currentUrl={state.sourceUrl || state.browserUrl}
            variableMappings={state.variableMappings}
            onVariableMappings={(variableMappings) =>
              updateStore((prev) => ({ variableMappings, batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            hiddenExtractedData={state.hiddenExtractedData}
            onHiddenExtractedData={(hiddenExtractedData) => updateStore({ hiddenExtractedData })}
            onVariablesChanged={() =>
              updateStore((prev) => ({ batchConfigVersion: (prev.batchConfigVersion ?? 1) + 1 }))
            }
            onRematch={() => { navigationEpoch.current += 1; autoResolveStarted.current = false; updateStore({ step: 2 }); }}
            onNextBatchValidation={() => goToStep(4)}
          />
        )}
        {state.step === 4 && (
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
              updateStore({ sourceUrl: url, browserUrl: url, savedParentResolution, step: 3 })
            }
            onBackToStep3={() => goToStep(3)}
          />
        )}
      </div>
    </section>
  );
}
