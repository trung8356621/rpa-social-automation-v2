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
import { VisualRegionStep } from "./VisualRegionStep";
import { usePostDetailCollectorStore } from "./store";
import type { BrowserProbe, Invoke, PostDetailStep } from "./types";
import "./post-detail-collector.css";

function canEnterStep2(refs: number): boolean {
  return refs > 0;
}

export function PostDetailCollectorPage({ invoke, state: parentState }: { invoke: Invoke; state?: State | null }) {
  const [state, updateStore] = usePostDetailCollectorStore();
  const [probe, setProbe] = useState<BrowserProbe | null>(null);
  const [probeError, setProbeError] = useState("");
  const [connStatus, setConnStatus] = useState("Đang kiểm tra BrowserCore...");

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
    void refreshProbe();
    return () => {
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe refresh must not tear down host
  }, [invoke]);

  const goToStep = (step: PostDetailStep) => {
    if (step === 2 && !canEnterStep2(state.visualReferences.length)) return;
    if (step === 3) return;
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
          <span className="pdc-step-pill" aria-disabled="true"><span className="pdc-step-num">3</span><span className="pdc-step-text">Parent Highlight POC</span></span>
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
            onBrowserUrl={(browserUrl) => updateStore({ browserUrl })}
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
          />
        )}
      </div>
    </section>
  );
}
