import React, { useState } from "react";
import { runRecognitionPipeline } from "../../../experiments/visual-match-lab/src/cv/recognition-pipeline";
import type { FixtureItem } from "../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { BoundaryProbeResult, BoundaryDebugRecord, BoundaryDebugReport } from "../../shared/boundary-probe";
import {
  detectActionRows,
  imageCanvas,
  fingerprint,
  classifyLiveCandidate,
  wait,
} from "../experiments/visual-match-lab/LiveScrollTest";
import { getExpectedFrameEvidenceDisplayPath } from "../../shared/visual-match-lab-storage";
import type {
  Invoke,
  LiveCapture,
  LiveCandidate,
  FrameReport,
  LiveIconTemplates,
  UserPermalinkRule,
  RunSummaryStats,
} from "./types";
import { computeRunSummaryStats } from "./store";
import {
  pickScrollSplit,
  evaluateScrollProgress,
  dedupeCandidates,
  deriveFrameBoundaryStatus,
  computeFrameCandidateCounts,
  extractCandidatePostIdentity,
} from "./scroll-sampling";

async function processCaptureSingle({
  capture,
  subIndex,
  frameIndex,
  runId,
  templateCanvases,
  rules,
  seen,
  invoke,
  startRowOffset,
}: {
  capture: LiveCapture;
  subIndex: 1 | 2;
  frameIndex: number;
  runId: string;
  templateCanvases: HTMLCanvasElement[];
  rules: UserPermalinkRule[];
  seen: LiveCandidate[];
  invoke: Invoke;
  startRowOffset: number;
}): Promise<{
  candidates: LiveCandidate[];
  debugRecords: BoundaryDebugRecord[];
  rawIconMatches: number;
  detectedRowCount: number;
}> {
  const fixture: FixtureItem = {
    id: `${capture.id}_s${subIndex}`,
    name: `Sample ${frameIndex}.${subIndex}`,
    description: capture.viewport.url,
    width: capture.width,
    height: capture.height,
    isRealFixture: true,
    dataUrl: capture.dataUrl,
  };
  const pipeline = await runRecognitionPipeline(fixture);
  const target = await imageCanvas(capture.dataUrl, capture.width, capture.height);

  const detected = await detectActionRows(
    target,
    templateCanvases,
    "grayscale",
    0.72,
    pipeline.candidates.filter((c) => c.type === "icon").map((c) => c.bbox),
  );

  const candidates: LiveCandidate[] = [];
  const debugRecords: BoundaryDebugRecord[] = [];

  for (let rowIdx = 0; rowIdx < detected.rows.length; rowIdx++) {
    const row = detected.rows[rowIdx]!;
    const overallRowIndex = startRowOffset + rowIdx;
    const targetIcon = row.items[0];
    const iconCenterX = targetIcon
      ? targetIcon.bbox.x + targetIcon.bbox.width / 2
      : row.bbox.x + Math.min(24, row.bbox.width / 2);
    const iconCenterY = targetIcon
      ? targetIcon.bbox.y + targetIcon.bbox.height / 2
      : row.bbox.y + row.bbox.height / 2;

    const point = {
      x: Math.round((iconCenterX * capture.viewport.width) / capture.width),
      y: Math.round((iconCenterY * capture.viewport.height) / capture.height),
    };
    const actionRowCssBbox = {
      x: Math.round((row.bbox.x * capture.viewport.width) / capture.width),
      y: Math.round((row.bbox.y * capture.viewport.height) / capture.height),
      width: Math.round((row.bbox.width * capture.viewport.width) / capture.width),
      height: Math.round((row.bbox.height * capture.viewport.height) / capture.height),
    };

    let boundary: (BoundaryProbeResult & { evidenceDataUrl?: string }) | undefined;
    let context = "unknown";

    try {
      boundary = await invoke<BoundaryProbeResult & { evidenceDataUrl?: string }>({
        type: "visualMatchLabProbeBoundary",
        captureId: capture.id,
        webContentsId: capture.webContentsId,
        point,
        actionRowBbox: actionRowCssBbox,
        options: { highlight: true, captureEvidence: true, customRules: rules },
      });
      if (boundary.candidateContainer?.role === "article" || boundary.status === "BOUNDARY_FOUND") {
        context = "post";
      }
    } catch (probeError) {
      console.warn(`Sample ${frameIndex}.${subIndex} probe error row ${rowIdx}:`, probeError);
      context = "unknown";
    }

    const hash = fingerprint(target, row.bbox);
    const docY = capture.viewport.scrollY + row.bbox.y;
    const boundaryStatus = boundary?.status ?? "BOUNDARY_NOT_FOUND";
    const postIdentity = extractCandidatePostIdentity(boundary);
    const candidateId = `cand_${runId}_f${frameIndex}_r${overallRowIndex}`;
    const evidenceSavedPath = getExpectedFrameEvidenceDisplayPath(runId, frameIndex, overallRowIndex);

    const initialStatus =
      boundaryStatus === "BOUNDARY_FOUND" && row.items.length >= 2 ? "NEW_ITEM" : "NEEDS_ATTENTION";

    const candidate: LiveCandidate = {
      candidateId,
      frameId: frameIndex,
      bbox: row.bbox,
      score: row.score,
      matchScore: row.score,
      iconCount: row.items.length,
      status: initialStatus,
      boundaryStatus,
      dedupeStatus: "NEW_ITEM",
      postIdentity,
      evidenceRef: evidenceSavedPath,
      context,
      fingerprint: hash,
      docY,
      boundary,
      highlightedEvidenceUrl: boundary?.evidenceDataUrl,
      evidenceSavedPath,
    };
    candidates.push(candidate);

    if (boundary) {
      const record: BoundaryDebugRecord = {
        runId,
        frameNumber: frameIndex,
        scrollY: capture.viewport.scrollY,
        browserWebContentsId: capture.webContentsId,
        rowIndex: overallRowIndex,
        actionRowBbox: row.bbox,
        matchingScore: row.score,
        hitPoint: point,
        hitElement: boundary.hitElement,
        ancestorDepth: boundary.ancestorsChecked,
        ancestors: (boundary.ancestorSteps ?? []).map((a) => ({
          level: a.level,
          tag: a.tag,
          role: a.role,
          id: a.id,
          className: a.className,
          rect: a.rect,
          rawUrls: a.rawUrls ?? [],
          postIdentities: a.postIdentities,
          uniqueKeys: a.uniqueKeys,
          uniqueCount: a.uniqueKeys.length,
        })),
        transitions: {
          firstPermalinkLevel: boundary.firstPermalinkLevel,
          secondPermalinkLevel: boundary.secondPermalinkLevel,
          boundaryCrossedLevel: boundary.boundaryCrossedLevel,
          jumpedZeroToTwoPlus: Boolean(boundary.jumpedZeroToTwoPlus),
          jumpReason: boundary.jumpReason ?? null,
        },
        candidateContainer: boundary.candidateContainer,
        crossedContainer: boundary.crossedContainer,
        boundaryStatus: boundary.status,
        riskReason: boundary.riskReason,
        ownershipEvidence: boundary.ownershipEvidence,
      };
      debugRecords.push(record);

      void invoke({
        type: "visualMatchLabSaveFrameAttempt",
        input: {
          runId,
          frameIndex,
          rowIndex: overallRowIndex,
          reason: `fic-auto-match-s${subIndex}`,
          record,
          highlightedBase64: boundary.evidenceDataUrl,
          screenshotBase64: capture.dataUrl,
          customRules: rules,
        },
      }).catch(() => undefined);
    }
  }

  return {
    candidates,
    debugRecords,
    rawIconMatches: detected.rawIconMatches,
    detectedRowCount: detected.rows.length,
  };
}

export function AutoMatchStep({
  templates,
  rules,
  reports,
  summaryStats,
  currentRunId,
  invoke,
  onPrevious,
  onNext,
  onRunComplete,
  onSelectFrameForReview,
}: {
  templates: LiveIconTemplates;
  rules: UserPermalinkRule[];
  reports: FrameReport[];
  summaryStats: RunSummaryStats | null;
  currentRunId: string | null;
  invoke: Invoke;
  onPrevious: () => void;
  onNext: () => void;
  onRunComplete: (newReports: FrameReport[], runId: string, stats: RunSummaryStats) => void;
  onSelectFrameForReview: (frameIndex: number) => void;
}) {
  const [running, setRunning] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [currentFrameNum, setCurrentFrameNum] = useState<number>(0);
  const [runError, setRunError] = useState<string | null>(null);

  const startAutoMatch = async () => {
    setRunning(true);
    setRunError(null);
    setProgressMsg("Chuẩn bị templates và khởi tạo run...");
    setCurrentFrameNum(0);

    const runId = `fic_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newReports: FrameReport[] = [];
    const seen: LiveCandidate[] = [];
    const debugRecords: BoundaryDebugRecord[] = [];

    try {
      const missing = (["like", "comment", "share"] as const).filter((k) => !templates[k]);
      if (missing.length > 0) {
        throw new Error(`Chưa đủ template: thiếu ${missing.join(", ")}. Quay lại Bước 1 để hiệu chuẩn.`);
      }

      const templateCanvases = await Promise.all(
        (["like", "comment", "share"] as const).map((kind) =>
          imageCanvas(templates[kind]!.dataUrl, templates[kind]!.width, templates[kind]!.height),
        ),
      );

      let browserWebContentsId: number | null = null;
      try {
        const state = await invoke<{ webContentsId: number; connected: boolean; loggedIn: boolean }>({
          type: "visualMatchLabState",
        });
        browserWebContentsId = state.webContentsId;
      } catch (err) {
        throw new Error(`BrowserCore chưa sẵn sàng: ${String(err)}`);
      }

      let priorScrollY: number | null = null;

      for (let frame = 1; frame <= 5; frame++) {
        setCurrentFrameNum(frame);
        const split = pickScrollSplit();
        setProgressMsg(
          `Sample ${frame}/5: Chia cuộn ${split.ratio} (${split.firstDelta}px + ${split.secondDelta}px, tổng 400px)...`,
        );

        // --- SUB-SEGMENT 1 ---
        setProgressMsg(`Sample ${frame}/5: Cuộn đoạn 1 (${split.firstDelta}px)...`);
        await invoke({
          type: "visualMatchLabScroll",
          webContentsId: browserWebContentsId,
          deltaY: split.firstDelta,
        });
        await wait(600);

        let capture1: LiveCapture;
        try {
          capture1 = await invoke<LiveCapture>({ type: "visualMatchLabCapture" });
        } catch (err) {
          throw new Error(`Lỗi capture đoạn 1 tại Sample ${frame}: ${String(err)}`);
        }

        if (capture1.webContentsId !== browserWebContentsId) {
          throw new Error("Phiên BrowserCore bị thay đổi trong quá trình chạy.");
        }

        const check1 = evaluateScrollProgress(priorScrollY, capture1.viewport.scrollY, split.firstDelta);
        priorScrollY = capture1.viewport.scrollY;

        if (!check1.moved) {
          console.warn(
            `Sample ${frame} đoạn 1: scroll dừng lại (thực tế ${check1.actualDelta}px, dự kiến ${check1.intendedDelta}px, scrollY ${capture1.viewport.scrollY}). Dừng theo guard.`,
          );
          setProgressMsg(`Sample ${frame}: Scroll không tiến triển (${check1.actualDelta}px). Dừng lấy mẫu.`);
          break;
        }

        setProgressMsg(`Sample ${frame}/5: Phân tích OpenCV đoạn 1...`);
        const result1 = await processCaptureSingle({
          capture: capture1,
          subIndex: 1,
          frameIndex: frame,
          runId,
          templateCanvases,
          rules,
          seen,
          invoke,
          startRowOffset: 0,
        });

        // --- SUB-SEGMENT 2 ---
        setProgressMsg(`Sample ${frame}/5: Cuộn đoạn 2 (${split.secondDelta}px)...`);
        await invoke({
          type: "visualMatchLabScroll",
          webContentsId: browserWebContentsId,
          deltaY: split.secondDelta,
        });
        await wait(600);

        let capture2: LiveCapture;
        try {
          capture2 = await invoke<LiveCapture>({ type: "visualMatchLabCapture" });
        } catch (err) {
          throw new Error(`Lỗi capture đoạn 2 tại Sample ${frame}: ${String(err)}`);
        }

        if (capture2.webContentsId !== browserWebContentsId) {
          throw new Error("Phiên BrowserCore bị thay đổi trong quá trình chạy.");
        }

        const check2 = evaluateScrollProgress(priorScrollY, capture2.viewport.scrollY, split.secondDelta);
        priorScrollY = capture2.viewport.scrollY;

        if (!check2.moved) {
          console.warn(
            `Sample ${frame} đoạn 2: scroll dừng lại (thực tế ${check2.actualDelta}px, dự kiến ${check2.intendedDelta}px, scrollY ${capture2.viewport.scrollY}). Dừng theo guard.`,
          );
          setProgressMsg(`Sample ${frame}: Scroll đoạn 2 không tiến triển (${check2.actualDelta}px). Gộp kết quả đoạn 1 và dừng.`);

          const { merged } = dedupeCandidates(result1.candidates, [], seen);
          for (const cand of merged) {
            if (cand.status !== "DUPLICATE") seen.push(cand);
          }
          debugRecords.push(...result1.debugRecords);

          const frameBoundary = deriveFrameBoundaryStatus(merged);
          const counts = computeFrameCandidateCounts(merged);
          const actualStepScroll = check1.actualDelta;
          newReports.push({
            frame,
            capture: capture1,
            captureStatus: "CAPTURE_PASS",
            pipelineStatus: `PIPELINE_PASS: ${counts.found} FOUND · ${counts.needsAttention} NEEDS_ATTENTION · ${counts.duplicate} DUPLICATE (cuộn thực tế ${actualStepScroll}px, split ${split.ratio}: ${split.firstDelta}px)`,
            templateStatus: "TEMPLATE_READY",
            detectionStatus: "DETECTION_PASS",
            boundaryStatus: frameBoundary,
            rawIconMatches: result1.rawIconMatches,
            actionClusters: result1.detectedRowCount,
            candidates: merged,
          });
          break;
        }

        setProgressMsg(`Sample ${frame}/5: Phân tích OpenCV đoạn 2...`);
        const result2 = await processCaptureSingle({
          capture: capture2,
          subIndex: 2,
          frameIndex: frame,
          runId,
          templateCanvases,
          rules,
          seen,
          invoke,
          startRowOffset: result1.detectedRowCount,
        });

        // --- GỘP KẾT QUẢ CỦA HAI LẦN & DEDUPE ---
        const { merged } = dedupeCandidates(result1.candidates, result2.candidates, seen);
        for (const cand of merged) {
          if (cand.status !== "DUPLICATE") {
            seen.push(cand);
          }
        }
        debugRecords.push(...result1.debugRecords, ...result2.debugRecords);

        const totalActionClusters = result1.detectedRowCount + result2.detectedRowCount;
        const totalRawIconMatches = result1.rawIconMatches + result2.rawIconMatches;
        const actualStepScroll = check1.actualDelta + check2.actualDelta;

        const frameBoundary = deriveFrameBoundaryStatus(merged);
        const counts = computeFrameCandidateCounts(merged);

        newReports.push({
          frame,
          capture: capture2,
          captureStatus: "CAPTURE_PASS",
          pipelineStatus: `PIPELINE_PASS: ${counts.found} FOUND · ${counts.needsAttention} NEEDS_ATTENTION · ${counts.duplicate} DUPLICATE (cuộn thực tế ${actualStepScroll}px / dự kiến ${split.totalDelta}px, split ${split.ratio}: ${split.firstDelta}px + ${split.secondDelta}px)`,
          templateStatus: "TEMPLATE_READY",
          detectionStatus: "DETECTION_PASS",
          boundaryStatus: frameBoundary,
          rawIconMatches: totalRawIconMatches,
          actionClusters: totalActionClusters,
          candidates: merged,
        });
      }

      // 6. Save Run Summary & Evidence Report
      const stats = computeRunSummaryStats(newReports);
      try {
        const debugReport: BoundaryDebugReport = {
          runId,
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "COMPLETED",
          totalFrames: newReports.length,
          environment: {
            width: 1024,
            height: 560,
            zoom: 1,
            platform: "facebook",
          },
          records: debugRecords,
          summary: {
            totalProbed: debugRecords.length,
            boundaryFoundCount: stats.boundaryFound,
            boundaryAmbiguousCount: stats.boundaryAmbiguous,
            boundaryNotFoundCount: stats.boundaryNotFound,
            noActionRowCount: newReports.filter((r) => r.boundaryStatus === "NO_ACTION_ROW").length,
            jumpedZeroToTwoPlusCount: debugRecords.filter((r) => r.transitions.jumpedZeroToTwoPlus).length,
            jumpedFrames: [
              ...new Set(debugRecords.filter((r) => r.transitions.jumpedZeroToTwoPlus).map((r) => r.frameNumber)),
            ],
          },
        };
        await invoke({
          type: "visualMatchLabSaveBoundaryDebug",
          report: debugReport,
        });
      } catch (sumErr) {
        console.warn("Failed to save debug report:", sumErr);
      }

      setProgressMsg(`Hoàn tất 5 Sample! ${stats.boundaryFound}/${stats.totalActionRows} boundary FOUND.`);
      onRunComplete(newReports, runId, stats);
    } catch (err) {
      setRunError(String(err));
      setProgressMsg(null);
    } finally {
      setRunning(false);
    }
  };

  const hasResults = reports.length > 0;

  return (
    <div className="fic-step-auto-match">
      <div className="fic-section-header">
        <div>
          <h2>Bước 2: Auto Capture & Match (5 Samples)</h2>
          <p className="fic-subtitle">
            Tự động capture 5 sample từ browser, chạy pipeline nhận diện OpenCV Stage A–E, hit-test DOM và xác định
            boundary bài viết.
          </p>
        </div>
        <div className="fic-header-actions">
          <button
            type="button"
            className="fic-btn fic-btn-primary fic-btn-large"
            disabled={running}
            onClick={() => void startAutoMatch()}
          >
            {running
              ? `⏳ Đang chạy Sample ${currentFrameNum}/5...`
              : hasResults
                ? "🔄 Chạy lại Auto Match (5 Samples)"
                : "▶ Bắt đầu Auto Capture & Match (5 Samples)"}
          </button>
        </div>
      </div>

      {runError && <div className="fic-alert fic-alert-error">⚠ {runError}</div>}
      {progressMsg && <div className="fic-alert fic-alert-info">{progressMsg}</div>}

      {/* Metrics Banner */}
      {summaryStats && (
        <div className="fic-metrics-banner card">
          <div className="fic-metric-item">
            <span className="fic-metric-val">{reports.length}</span>
            <span className="fic-metric-lbl">Samples Evidence</span>
          </div>
          <div className="fic-metric-item">
            <span className="fic-metric-val">{summaryStats.totalActionRows}</span>
            <span className="fic-metric-lbl">Tổng Action Rows</span>
          </div>
          <div className="fic-metric-item">
            <span className="fic-metric-val">{summaryStats.domHitSuccess}</span>
            <span className="fic-metric-lbl">DOM Hit Thành Công</span>
          </div>
          <div className="fic-metric-item">
            <span className="fic-metric-val fic-text-success">{summaryStats.boundaryFound}</span>
            <span className="fic-metric-lbl">Boundary FOUND</span>
          </div>
          <div className="fic-metric-item">
            <span className="fic-metric-val fic-text-warn">{summaryStats.boundaryAmbiguous}</span>
            <span className="fic-metric-lbl">AMBIGUOUS</span>
          </div>
          <div className="fic-metric-item">
            <span className="fic-metric-val fic-text-danger">{summaryStats.boundaryNotFound}</span>
            <span className="fic-metric-lbl">NOT_FOUND</span>
          </div>
        </div>
      )}

      {/* Accuracy clarification note */}
      <div className="fic-notice-box">
        <b>Lưu ý kỹ thuật:</b> Tỷ lệ <code>BOUNDARY_FOUND</code> phản ánh số lượng candidate xác định được container
        thông qua DOM & URL Inspector trong đợt chạy; đây là chỉ số nhận diện cấu trúc, <em>không tự đánh đồng với độ chính xác tuyệt đối (precision)</em> vì chưa có nhãn ground-truth hoàn chỉnh.
      </div>

      {/* 5 Evidence Samples Cards */}
      {hasResults ? (
        <div className="fic-samples-grid">
          {reports.map((report, idx) => {
            const hasIssue =
              report.boundaryStatus === "BOUNDARY_AMBIGUOUS" ||
              report.boundaryStatus === "BOUNDARY_NOT_FOUND" ||
              report.boundaryStatus === "NO_ACTION_ROW";
            return (
              <div
                key={report.frame}
                className={`fic-sample-card card ${hasIssue ? "needs-attention" : ""}`}
                onClick={() => onSelectFrameForReview(idx)}
              >
                <div className="fic-sample-thumb-wrapper">
                  <img
                    src={report.capture.dataUrl}
                    alt={`Sample ${report.frame}`}
                    className="fic-sample-thumb"
                  />
                  <span className={`fic-sample-badge badge-${report.boundaryStatus.toLowerCase()}`}>
                    {report.boundaryStatus}
                  </span>
                </div>
                <div className="fic-sample-info">
                  <div className="fic-sample-title">
                    <b>Sample #{report.frame}</b>
                    <small>scrollY={report.capture.viewport.scrollY}</small>
                  </div>
                  <div className="fic-sample-stats">
                    <span>{report.candidates.length} candidate(s)</span>
                    {hasIssue && <span className="fic-attention-tag">Cần chú ý</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="fic-empty-state card">
          <p>Chưa có kết quả Auto Match. Nhấn nút <b>"Bắt đầu Auto Capture & Match"</b> ở trên để thực thi trên BrowserCore.</p>
        </div>
      )}

      {/* Navigation footer */}
      <div className="fic-step-nav-footer">
        <button type="button" className="fic-btn fic-btn-secondary" onClick={onPrevious} disabled={running}>
          ← Quay lại Bước 1 (Calibration)
        </button>
        <button
          type="button"
          className="fic-btn fic-btn-primary fic-btn-large"
          disabled={!hasResults || running}
          onClick={onNext}
        >
          Tiếp tục sang Bước 3: URL & Boundary Review →
        </button>
      </div>
    </div>
  );
}
