import React, { useEffect, useState } from "react";
import type { BoundaryProbeResult } from "../../shared/boundary-probe";
import type { UserPermalinkRule } from "../../shared/permalink-rules";
import {
  useFeedCollectorStore,
  setFeedCollectorState,
  computeRunSummaryStats,
} from "./store";
import { CalibrationStep } from "./CalibrationStep";
import { AutoMatchStep } from "./AutoMatchStep";
import { UrlBoundaryReviewStep } from "./UrlBoundaryReviewStep";
import type {
  Invoke,
  FeedCollectorStep,
  FrameReport,
  LiveCandidate,
  LiveCapture,
  LiveIconTemplates,
  RunSummaryStats,
} from "./types";
import "./feed-item-collector.css";

type LabState = { connected: boolean; loggedIn: boolean; webContentsId: number; url: string };

export function FeedItemCollectorPage({ invoke }: { invoke: Invoke }) {
  const [state, updateStore] = useFeedCollectorStore();
  const [connection, setConnection] = useState<LabState | null>(null);
  const [connStatus, setConnStatus] = useState("Đang kết nối BrowserCore...");

  useEffect(() => {
    let active = true;
    void invoke<LabState>({ type: "visualMatchLabState" })
      .then((val) => {
        if (active) {
          setConnection(val);
          setConnStatus(
            `BrowserCore kết nối thành công · webContents.id=${val.webContentsId} · ${val.url}`,
          );
        }
      })
      .catch((err) => {
        if (active) {
          setConnStatus(`Không thể kết nối BrowserCore: ${String(err)}`);
        }
      });
    return () => {
      active = false;
    };
  }, [invoke]);

  const goToStep = (step: FeedCollectorStep) => {
    updateStore({ step });
  };

  const handleUpdateBoundary = (
    frameIndex: number,
    candIndex: number,
    newBoundary: BoundaryProbeResult,
    evidenceUrl?: string,
  ) => {
    const nextReports = state.reports.map((f, fIdx) => {
      if (fIdx !== frameIndex) return f;
      const nextCandidates = f.candidates.map((c, cIdx) => {
        if (cIdx !== candIndex) return c;
        const updatedCand: LiveCandidate = {
          ...c,
          boundary: newBoundary,
          highlightedEvidenceUrl: evidenceUrl || c.highlightedEvidenceUrl,
          status: newBoundary.status === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION",
        };
        return updatedCand;
      });

      const frameBoundary: FrameReport["boundaryStatus"] =
        nextCandidates.some((c) => c.boundary?.status === "BOUNDARY_FOUND")
          ? "BOUNDARY_FOUND"
          : nextCandidates.some((c) => c.boundary?.status === "BOUNDARY_AMBIGUOUS")
            ? "BOUNDARY_AMBIGUOUS"
            : "BOUNDARY_NOT_FOUND";

      return {
        ...f,
        candidates: nextCandidates,
        boundaryStatus: frameBoundary,
      };
    });

    const newStats = computeRunSummaryStats(nextReports);
    updateStore({
      reports: nextReports,
      summaryStats: newStats,
    });
  };

  const handleSaveRule = (rule: UserPermalinkRule) => {
    const nextRules = [rule, ...state.rules.filter((r) => r.id !== rule.id)];
    updateStore({ rules: nextRules });
  };

  return (
    <section className="app-page feed-item-collector-page" aria-label="Feed Item Collector">
      {/* Top Bar / Header */}
      <div className="fic-page-header">
        <div className="fic-title-group">
          <h1>Feed Item Collector</h1>
          <span className="fic-version-tag">V2 Standard Workflow</span>
        </div>

        {/* Stepper Navigation */}
        <nav className="fic-stepper" aria-label="Feed Item Collector Stepper">
          <button
            type="button"
            className={`fic-step-pill ${state.step === 1 ? "active" : ""} ${state.templates.like && state.templates.comment && state.templates.share ? "completed" : ""}`}
            onClick={() => goToStep(1)}
          >
            <span className="fic-step-num">1</span>
            <span className="fic-step-text">Browser Capture & Calibration</span>
          </button>
          <span className="fic-step-arrow">→</span>
          <button
            type="button"
            className={`fic-step-pill ${state.step === 2 ? "active" : ""} ${state.reports.length > 0 ? "completed" : ""}`}
            onClick={() => goToStep(2)}
          >
            <span className="fic-step-num">2</span>
            <span className="fic-step-text">Auto Match (5 Samples)</span>
          </button>
          <span className="fic-step-arrow">→</span>
          <button
            type="button"
            className={`fic-step-pill ${state.step === 3 ? "active" : ""}`}
            disabled={state.reports.length === 0}
            onClick={() => goToStep(3)}
          >
            <span className="fic-step-num">3</span>
            <span className="fic-step-text">URL & Boundary Review</span>
          </button>
        </nav>
      </div>

      {/* Browser Connection Status Banner */}
      <div
        className={`fic-banner ${connection ? "banner-connected" : "banner-disconnected"}`}
        role="status"
      >
        <span className="fic-banner-icon">{connection ? "🟢" : "🔴"}</span>
        <span className="fic-banner-text">{connStatus}</span>
      </div>

      {/* Step Content */}
      <div className="fic-content-area">
        {state.step === 1 && (
          <CalibrationStep
            capture={state.calibrationCapture}
            templates={state.templates}
            invoke={invoke}
            onCapture={(cap: LiveCapture) => updateStore({ calibrationCapture: cap })}
            onUpdateTemplates={(tpl: LiveIconTemplates) => updateStore({ templates: tpl })}
            onNext={() => goToStep(2)}
          />
        )}

        {state.step === 2 && (
          <AutoMatchStep
            templates={state.templates}
            rules={state.rules}
            reports={state.reports}
            summaryStats={state.summaryStats}
            currentRunId={state.currentRunId}
            invoke={invoke}
            onPrevious={() => goToStep(1)}
            onNext={() => goToStep(3)}
            onRunComplete={(newReports: FrameReport[], runId: string, stats: RunSummaryStats) => {
              updateStore({
                reports: newReports,
                currentRunId: runId,
                summaryStats: stats,
                selectedFrameIndex: 0,
                selectedCandidateIndex: 0,
              });
            }}
            onSelectFrameForReview={(idx: number) => {
              updateStore({ selectedFrameIndex: idx, selectedCandidateIndex: 0 });
              goToStep(3);
            }}
          />
        )}

        {state.step === 3 && (
          <UrlBoundaryReviewStep
            reports={state.reports}
            rules={state.rules}
            currentRunId={state.currentRunId}
            selectedFrameIndex={state.selectedFrameIndex}
            selectedCandidateIndex={state.selectedCandidateIndex}
            invoke={invoke}
            onSelectFrame={(idx: number) => updateStore({ selectedFrameIndex: idx })}
            onSelectCandidate={(idx: number) => updateStore({ selectedCandidateIndex: idx })}
            onUpdateBoundary={handleUpdateBoundary}
            onSaveRule={handleSaveRule}
            onPrevious={() => goToStep(2)}
          />
        )}
      </div>
    </section>
  );
}
