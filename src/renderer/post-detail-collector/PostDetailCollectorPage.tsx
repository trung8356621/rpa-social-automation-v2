import React, { useEffect, useState } from "react";
import type { State } from "../../shared/contracts";
import {
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import { BrowserCaptureStep } from "./BrowserCaptureStep";
import { OcrPreviewStep } from "./OcrPreviewStep";
import { VisualRegionStep } from "./VisualRegionStep";
import { usePostDetailCollectorStore } from "./store";
import type { BrowserProbe, Invoke, PostDetailStep } from "./types";
import "./post-detail-collector.css";

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
      setConnStatus(
        next.isSocialPage
          ? `BrowserCore sẵn sàng · webContents.id=${next.webContentsId} · ${next.url}`
          : `BrowserCore sẵn sàng · webContents.id=${next.webContentsId} · trang hiện tại chưa phải Facebook/Threads — dùng Open URL để điều hướng.`,
      );
      return next;
    } catch (err) {
      setProbe(null);
      setProbeError(String(err));
      setConnStatus(`BrowserCore chưa sẵn sàng: ${String(err)}`);
      return null;
    }
  }, [invoke]);

  // Match Feed Item: only clear BrowserCore host when leaving the page (not on probe refresh).
  useEffect(() => {
    let active = true;
    void refreshProbe();
    return () => {
      active = false;
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe refresh must not tear down host
  }, [invoke]);

  const goToStep = (step: PostDetailStep) => {
    if (step !== 1 && step !== 2) {
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    }
    updateStore({ step });
  };

  const connected = Boolean(probe?.available) && !probeError;

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
            className={`pdc-step-pill ${state.step === 1 ? "active" : ""} ${state.contentRoi ? "completed" : ""}`}
            onClick={() => goToStep(1)}
          >
            <span className="pdc-step-num">1</span>
            <span className="pdc-step-text">Browser & Capture</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button
            type="button"
            className={`pdc-step-pill ${state.step === 2 ? "active" : ""} ${state.lastMatch ? "completed" : ""}`}
            onClick={() => goToStep(2)}
          >
            <span className="pdc-step-num">2</span>
            <span className="pdc-step-text">Visual Region</span>
          </button>
          <span className="pdc-step-arrow">→</span>
          <button
            type="button"
            className={`pdc-step-pill ${state.step === 3 ? "active" : ""}`}
            disabled={!state.contentRoi}
            onClick={() => goToStep(3)}
          >
            <span className="pdc-step-num">3</span>
            <span className="pdc-step-text">OCR Preview</span>
          </button>
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
            visualReferences={state.visualReferences}
            contentRoi={state.contentRoi}
            onSourceUrl={(sourceUrl) => updateStore({ sourceUrl })}
            onUpdateReferences={(visualReferences) => updateStore({ visualReferences })}
            onContentRoi={(contentRoi) => updateStore({ contentRoi })}
            onScreenshot={(lastScreenshot) => updateStore({ lastScreenshot })}
            onProbeRefresh={refreshProbe}
            onNext={() => goToStep(2)}
          />
        )}
        {state.step === 2 && (
          <VisualRegionStep
            invoke={invoke}
            state={parentState}
            visualReferences={state.visualReferences}
            contentRoi={state.contentRoi}
            lastMatch={state.lastMatch}
            onContentRoi={(contentRoi) => updateStore({ contentRoi })}
            onMatch={(lastMatch) => updateStore({ lastMatch })}
            onScreenshot={(lastScreenshot) => updateStore({ lastScreenshot })}
            onProbeRefresh={refreshProbe}
            onBack={() => goToStep(1)}
            onNext={() => goToStep(3)}
          />
        )}
        {state.step === 3 && (
          <OcrPreviewStep
            invoke={invoke}
            sourceUrl={state.sourceUrl}
            runId={state.runId}
            contentRoi={state.contentRoi}
            lastMatch={state.lastMatch}
            lastScreenshot={state.lastScreenshot}
            visualReferences={state.visualReferences}
            frames={state.frames}
            selectedFrameIndex={state.selectedFrameIndex}
            viewMode={state.viewMode}
            onRunId={(runId) => updateStore({ runId })}
            onFrames={(frames) => updateStore({ frames })}
            onSelectFrame={(selectedFrameIndex) => updateStore({ selectedFrameIndex })}
            onViewMode={(viewMode) => updateStore({ viewMode })}
            onScreenshot={(lastScreenshot) => updateStore({ lastScreenshot })}
            onProbeRefresh={refreshProbe}
            onBack={() => goToStep(2)}
          />
        )}
      </div>
    </section>
  );
}
