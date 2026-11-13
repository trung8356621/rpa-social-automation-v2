import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Rect, State } from "../../shared/contracts";
import { dragToCaptureRoi } from "../../shared/collector-browser-host";
import { clientToImageCoords } from "../../shared/collectors/roi-preview-interaction";
import { assertCaptureFromSocialPage } from "../../shared/post-detail-collector/social-url";
import type {
  PostDetailContainerResult,
  PostDetailScanFrame,
  VisualReferenceSample,
} from "../../shared/post-detail-collector/types";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorPostDetailScanInputLock,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import {
  claimCollectorHostOwner,
  isCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { runPostDetailAutoScan, type AutoScanProgress } from "./auto-scan-runner";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import type { BrowserProbe, Invoke, PostDetailMatchResult } from "./types";

type Props = {
  invoke: Invoke;
  state?: State | null;
  sourceUrl: string;
  visualReferences: VisualReferenceSample[];
  containerResult: PostDetailContainerResult | null;
  scanFrames: PostDetailScanFrame[];
  contentRoi: Rect | null;
  lastMatch: PostDetailMatchResult | null;
  lastScreenshot: { id: string; dataUrl: string; width: number; height: number } | null;
  onContainerResult: (result: PostDetailContainerResult | null) => void;
  onScanFrames: (frames: PostDetailScanFrame[]) => void;
  onContentRoi: (roi: Rect | null) => void;
  onMatch: (match: PostDetailMatchResult | null) => void;
  onScreenshot: (shot: { id: string; dataUrl: string; width: number; height: number } | null) => void;
  onRunId: (runId: string) => void;
  onProbeRefresh: () => Promise<BrowserProbe | null>;
  onBack: () => void;
  onNext: () => void;
};

type DragState = { kind: "select"; startX: number; startY: number; currentX: number; currentY: number };
type HostClient = { left: number; top: number; width: number; height: number };

export function VisualRegionStep({
  invoke,
  state,
  sourceUrl,
  visualReferences,
  containerResult,
  scanFrames,
  contentRoi,
  lastMatch,
  lastScreenshot,
  onContainerResult,
  onScanFrames,
  onContentRoi,
  onMatch,
  onScreenshot,
  onRunId,
  onProbeRefresh,
  onBack,
  onNext,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  const [progress, setProgress] = useState<AutoScanProgress>({
    phase: "idle",
    frameIndex: 0,
    maxFrames: 20,
    message: visualReferences.length
      ? `Sẵn sàng Auto Scan với ${visualReferences.length} visual reference(s). Cuộn Post Detail về đầu bài trước khi Start (Δy=-100).`
      : "Thiếu visual reference — quay lại Step 1.",
  });
  const [error, setError] = useState("");
  const [frameIndex, setFrameIndex] = useState(0);
  const [manualMode, setManualMode] = useState(false);
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const cancelRef = useRef(false);
  const scanningRef = useRef(false);
  /** Frames buffered during scan to avoid pushing every dataUrl into React each loop. */
  const liveFramesRef = useRef<PostDetailScanFrame[]>([]);

  const hostRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);

  const frames = scanFrames;
  const active = frames[frameIndex] || frames[frames.length - 1];
  const imageWidth = active?.width ?? lastScreenshot?.width ?? 0;
  const imageHeight = active?.height ?? lastScreenshot?.height ?? 0;
  const shotUrl = active?.screenshotDataUrl || lastScreenshot?.dataUrl;

  const imageBox = useMemo(() => {
    if (!hostClient || !imageWidth || !imageHeight) return null;
    const width = hostClient.width;
    const height = (imageHeight / imageWidth) * width;
    return { width, height };
  }, [hostClient, imageWidth, imageHeight]);

  const publishHost = React.useCallback(() => {
    if (!electron || !invoke) return;
    const client = publishPostDetailBrowserHost(invoke, hostRef.current);
    if (client) setHostClient(client);
    else if (!hostRef.current) setHostClient(null);
  }, [electron, invoke]);

  useEffect(() => {
    if (!electron || !invoke) return;
    const { ownerId } = claimCollectorHostOwner("pdc-step2");
    const safePublish = () => {
      if (!isCollectorHostOwner(ownerId)) return;
      // Keep host active during scan (skipping publish caused WHEEL_BLOCKED_NOT_VISIBLE).
      publishHost();
    };
    safePublish();
    const rafIds = [
      requestAnimationFrame(safePublish),
      requestAnimationFrame(() => requestAnimationFrame(safePublish)),
    ];
    const el = hostRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => safePublish()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", safePublish);
    window.addEventListener("scroll", safePublish, true);
    void collectorSetBrowserVisible(invoke, true).then(() => requestAnimationFrame(safePublish));
    return () => {
      for (const id of rafIds) cancelAnimationFrame(id);
      ro?.disconnect();
      window.removeEventListener("resize", safePublish);
      window.removeEventListener("scroll", safePublish, true);
      cancelRef.current = true;
      scanningRef.current = false;
      void collectorPostDetailScanInputLock(invoke, false).catch(() => undefined);
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
  }, [electron, invoke, publishHost]);

  async function startAutoScan() {
    if (!invoke || scanningRef.current) return;
    if (!visualReferences.length) {
      setError("Cần visual references từ Step 1 trước khi Auto Scan.");
      return;
    }
    setError("");
    cancelRef.current = false;
    scanningRef.current = true;
    liveFramesRef.current = [];
    onScanFrames([]);
    onContainerResult(null);
    onContentRoi(null);
    setFrameIndex(0);
    setManualMode(false);
    try {
      const probe = await onProbeRefresh();
      assertCaptureFromSocialPage(probe?.url || state?.url || sourceUrl || "");
      publishHost();
      await collectorPostDetailScanInputLock(invoke, true);
      const { runId, frames: nextFrames, container } = await runPostDetailAutoScan({
        invoke,
        sourceUrl,
        visualReferences,
        isCancelled: () => cancelRef.current,
        onProgress: setProgress,
        onFrame: (frame, all) => {
          liveFramesRef.current = all;
          // Lightweight UI: latest preview only — flush full frame list at end.
          setFrameIndex(Math.max(0, all.length - 1));
          if (frame.screenshotDataUrl) {
            onScreenshot({
              id: frame.frameId,
              dataUrl: frame.screenshotDataUrl,
              width: frame.width,
              height: frame.height,
            });
            onScanFrames([{ ...frame, anchorCandidates: undefined }]);
          }
        },
      });
      onRunId(runId);
      onScanFrames(nextFrames);
      onContainerResult(container);

      const bestIdx = container.mainActionRow
        ? Math.max(
            0,
            nextFrames.findIndex((f) => f.frameId === container.mainActionRow!.frameId),
          )
        : Math.max(0, nextFrames.length - 1);
      setFrameIndex(bestIdx === -1 ? Math.max(0, nextFrames.length - 1) : bestIdx);

      const row = container.mainActionRow;
      if (row?.status === "MAIN_ACTION_ROW_CANDIDATE" || (row && row.types.length >= 2)) {
        onMatch({
          status: "AMBIGUOUS",
          score: row.meanScore,
          templateId: row.anchors[0]?.templateId ?? null,
          bbox: row.bbox,
          candidateCount: row.anchors.length,
          scores: row.anchors.map((a) => a.score),
          screenshotDataUrl: nextFrames[bestIdx]?.screenshotDataUrl,
          notes: [
            ...container.notes,
            `Main Action Row ${row.status} on frame ${row.frameIndex}: ${row.types.join(",")}`,
            "Confirm Action Row để giữ candidate (không cuộn tiếp comment).",
          ],
        });
        if (container.containerBounds) onContentRoi(container.containerBounds);
      } else if (container.status === "FOUND" && container.containerBounds) {
        onContentRoi(container.containerBounds);
        onMatch({
          status: "AMBIGUOUS",
          score: container.confidence,
          templateId: container.visualAnchors[0]?.templateId ?? null,
          bbox: container.containerBounds,
          candidateCount: container.visualAnchors.length,
          scores: container.visualAnchors.map((a) => a.score),
          screenshotDataUrl: nextFrames[bestIdx]?.screenshotDataUrl,
          notes: [...container.notes, "Review overlay then Confirm."],
        });
      } else if (container.status === "AMBIGUOUS") {
        setManualMode(true);
        onMatch({
          status: "AMBIGUOUS",
          score: container.confidence,
          templateId: null,
          bbox: row?.bbox ?? null,
          candidateCount: container.visualAnchors.length,
          scores: container.visualAnchors.map((a) => a.score),
          notes: [...container.notes, "Manual Confirm fallback available."],
        });
      } else {
        onMatch({
          status: "NOT_FOUND",
          score: container.confidence,
          templateId: null,
          bbox: null,
          candidateCount: container.visualAnchors.length,
          scores: container.visualAnchors.map((a) => a.score),
          notes: container.notes,
        });
      }

      try {
        await invoke({
          type: "postDetailSaveAutoScan",
          input: {
            runId,
            sourceUrl,
            visualReferences,
            frames: nextFrames.map((f) => ({
              frameId: f.frameId,
              frameIndex: f.frameIndex,
              scrollDeltaApplied: f.scrollDeltaApplied,
              observedScrollPx: f.observedScrollPx,
              width: f.width,
              height: f.height,
              anchors: f.anchors,
              anchorCandidates: f.anchorCandidates,
              diagnostics: f.diagnostics,
              notes: f.notes,
              screenshotDataUrl: f.screenshotDataUrl,
            })),
            container,
          },
        });
      } catch (saveErr) {
        setProgress((p) => ({
          ...p,
          message: `${p.message} · evidence save warn: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress((p) => ({ ...p, phase: "error", message: String(e) }));
      if (liveFramesRef.current.length) onScanFrames(liveFramesRef.current);
    } finally {
      scanningRef.current = false;
      try {
        await collectorPostDetailScanInputLock(invoke, false);
      } catch {
        /* ignore */
      }
      try {
        await collectorSetBrowserVisible(invoke, true);
        publishHost();
      } catch {
        /* ignore */
      }
    }
  }

  function stopScan() {
    cancelRef.current = true;
    setProgress((p) => ({ ...p, phase: "stopped", message: "Đang dừng…" }));
    // Unlock ASAP so user can regain BrowserCore; runner still exits via isCancelled.
    void collectorPostDetailScanInputLock(invoke, false).catch(() => undefined);
  }

  function confirmActionRow() {
    const row = containerResult?.mainActionRow;
    if (!row?.bbox) {
      setError("Chưa có Main Action Row candidate để Confirm.");
      return;
    }
    onContentRoi(containerResult?.containerBounds || row.bbox);
    onMatch({
      status: "MANUALLY_CONFIRMED",
      score: row.meanScore,
      templateId: row.anchors[0]?.templateId ?? null,
      bbox: containerResult?.containerBounds || row.bbox,
      candidateCount: row.anchors.length,
      scores: row.anchors.map((a) => a.score),
      screenshotDataUrl: frames.find((f) => f.frameId === row.frameId)?.screenshotDataUrl || lastScreenshot?.dataUrl,
      notes: [
        ...row.notes,
        "MAIN_ACTION_ROW confirmed for handoff.",
      ],
    });
    if (containerResult) {
      onContainerResult({
        ...containerResult,
        mainActionRow: { ...row, status: "MAIN_ACTION_ROW_CANDIDATE" },
        status: containerResult.containerBounds ? "FOUND" : containerResult.status,
      });
    }
    setProgress((p) => ({ ...p, message: "Action Row đã Confirm." }));
  }

  function confirmContainer() {
    if (!containerResult?.containerBounds && !contentRoi && !containerResult?.mainActionRow?.bbox) {
      setError("Chưa có container / action-row bounds để Confirm.");
      return;
    }
    const bounds = containerResult?.containerBounds || contentRoi || containerResult?.mainActionRow?.bbox;
    if (!bounds) return;
    onContentRoi(bounds);
    onMatch({
      status: containerResult?.status === "FOUND" ? "MATCHED" : "MANUALLY_CONFIRMED",
      score: containerResult?.confidence ?? lastMatch?.score ?? null,
      templateId: lastMatch?.templateId ?? null,
      bbox: bounds,
      candidateCount: containerResult?.visualAnchors.length ?? lastMatch?.candidateCount ?? 0,
      scores: containerResult?.visualAnchors.map((a) => a.score) ?? lastMatch?.scores ?? [],
      screenshotDataUrl: active?.screenshotDataUrl || lastScreenshot?.dataUrl,
      notes: [
        ...(containerResult?.notes ?? lastMatch?.notes ?? []),
        "Container confirmed for Step 3 OCR handoff.",
      ],
    });
    if (containerResult) {
      onContainerResult({ ...containerResult, status: "FOUND", containerBounds: bounds });
    }
    setProgress((p) => ({ ...p, message: "Container đã Confirm · có thể sang Step 3." }));
  }

  function pointerPos(e: { clientX: number; clientY: number }) {
    if (!imageBox || !imageWidth || !imageHeight || !previewScrollRef.current) return { x: 0, y: 0 };
    const rect = previewScrollRef.current.getBoundingClientRect();
    return clientToImageCoords(
      e.clientX,
      e.clientY,
      {
        left: rect.left,
        top: rect.top,
        scrollLeft: previewScrollRef.current.scrollLeft,
        scrollTop: previewScrollRef.current.scrollTop,
      },
      imageBox,
      imageWidth,
      imageHeight,
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!manualMode || !shotUrl) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    const next: DragState = { kind: "select", startX: p.x, startY: p.y, currentX: p.x, currentY: p.y };
    setDrag(next);
    dragRef.current = next;
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = pointerPos(e);
    const next = { ...d, currentX: p.x, currentY: p.y };
    setDrag(next);
    dragRef.current = next;
  }
  function onPointerUp(e: React.PointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const d = dragRef.current;
    if (!d) return;
    setDrag(undefined);
    dragRef.current = undefined;
    const nextRoi = dragToCaptureRoi(d.startX, d.startY, d.currentX, d.currentY);
    if (nextRoi && nextRoi.width >= 4 && nextRoi.height >= 4) {
      onContentRoi(nextRoi);
      onMatch({
        status: "MANUALLY_CONFIRMED",
        score: lastMatch?.score ?? null,
        templateId: lastMatch?.templateId ?? null,
        bbox: nextRoi,
        candidateCount: lastMatch?.candidateCount ?? 0,
        scores: lastMatch?.scores ?? [],
        screenshotDataUrl: shotUrl,
        notes: ["Manual container/OCR region confirmed (AMBIGUOUS fallback)."],
      });
      if (containerResult) {
        onContainerResult({
          ...containerResult,
          status: "FOUND",
          containerBounds: nextRoi,
          notes: [...containerResult.notes, "Manual override bounds."],
        });
      }
    }
  }

  const liveDrag = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : null;

  const canNext =
    Boolean(contentRoi && contentRoi.width >= 4 && (lastScreenshot || shotUrl)) &&
    Boolean(
      lastMatch &&
        (lastMatch.status === "MATCHED" || lastMatch.status === "MANUALLY_CONFIRMED") &&
        lastMatch.bbox,
    ) &&
    Boolean(containerResult?.containerBounds || contentRoi);

  const running = progress.phase === "running";
  const mainRow = containerResult?.mainActionRow;
  const overlayBounds = mainRow?.bbox || containerResult?.containerBounds || contentRoi;
  const overlayAnchors =
    (mainRow && active?.frameId === mainRow.frameId ? mainRow.anchors : null) ||
    active?.anchors ||
    containerResult?.visualAnchors.filter((a) => a.frameId === active?.frameId) ||
    [];

  if (!electron) {
    return <div className="pdc-alert pdc-alert-warn">{BROWSER_CORE_UNAVAILABLE}</div>;
  }

  return (
    <div className="pdc-step pdc-step-calibration">
      <div className="pdc-section-header">
        <div>
          <h2>Step 2 — Auto Scroll & Container Detection</h2>
          <p className="pdc-subtitle">
            Cuộn về đầu bài trước khi Start. Auto Scan khóa input (Facebook vẫn hiện), wheel Δy=-100,
            settle thích ứng, tối đa 20 frame. Stop luôn mở khóa.
          </p>
        </div>
        <div className="pdc-btn-row">
          <button type="button" className="pdc-btn pdc-btn-secondary" disabled={running} onClick={onBack}>
            ← Back
          </button>
          <button
            type="button"
            className="pdc-btn pdc-btn-primary"
            disabled={running || !visualReferences.length}
            onClick={() => void startAutoScan()}
          >
            Start Auto Scan
          </button>
          <button type="button" className="pdc-btn pdc-btn-warn" disabled={!running} onClick={stopScan}>
            Stop
          </button>
          {running && (
            <span className="pdc-input-lock-badge" title="OS input tới BrowserCore bị chặn; engine wheel vẫn chạy">
              Auto Scan · Input Locked
            </span>
          )}
        </div>
      </div>

      <div className="pdc-scan-status" role="status">
        <span className={`pdc-mode ${running ? "frozen" : "live"}`}>{progress.phase.toUpperCase()}</span>
        <span>
          Frames: {running ? progress.frameIndex : frames.length}/{progress.maxFrames}
        </span>
        <span>{progress.message}</span>
      </div>

      {error && <div className="pdc-alert pdc-alert-error">{error}</div>}
      {manualMode && (
        <div className="pdc-alert pdc-alert-warn">
          Kết quả AMBIGUOUS — kéo vùng container thủ công trên frame rồi Confirm Container.
        </div>
      )}

      <div className="pdc-calibration-workspace">
        <div className="pdc-crop-container">
          <div className="collector-capture-workspace collector-browser-workspace" style={{ position: "relative" }}>
            <div ref={hostRef} className="collector-browser-host" data-browser-core-host="" aria-label="Browser Core host" />
            {running && (
              <div
                className="pdc-scan-input-shield"
                aria-hidden
                title="Auto Scan · Input Locked"
              />
            )}
          </div>
          {/* Live BrowserCore during scan — freeze screenshot only after Stop / for manual ROI. */}
          {!running && shotUrl && hostClient && imageBox && (
            <div
              className="collector-capture-freeze snapshot pdc-scan-overlay"
              style={{
                position: "fixed",
                left: hostClient.left,
                top: hostClient.top,
                width: hostClient.width,
                height: hostClient.height,
                zIndex: 40,
                margin: 0,
                boxSizing: "border-box",
                pointerEvents: manualMode ? "auto" : "none",
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                ref={previewScrollRef}
                className="collector-capture-preview-scroll"
                style={{ width: "100%", height: "100%", overflow: "hidden" }}
              >
                <div style={{ width: imageBox.width, height: imageBox.height, position: "relative" }}>
                  <img
                    src={shotUrl}
                    alt={`Scan frame ${active?.frameIndex ?? ""}`}
                    draggable={false}
                    style={{
                      display: "block",
                      width: imageBox.width,
                      height: imageBox.height,
                      maxWidth: "none",
                      objectFit: "fill",
                      pointerEvents: "none",
                    }}
                  />
                  {overlayAnchors.map((a) => (
                    <div
                      key={`${a.type}-${a.templateId}-${a.frameId}`}
                      className="collector-roi-highlight"
                      style={{
                        left: (a.bbox.x / imageWidth) * imageBox.width,
                        top: (a.bbox.y / imageHeight) * imageBox.height,
                        width: (a.bbox.width / imageWidth) * imageBox.width,
                        height: (a.bbox.height / imageHeight) * imageBox.height,
                        border: "2px solid #fbbf24",
                        background: "rgba(251, 191, 36, 0.15)",
                        position: "absolute",
                        pointerEvents: "none",
                      }}
                      title={`${a.type} ${a.score.toFixed(3)}`}
                    />
                  ))}
                  {overlayBounds && (
                    <div
                      className="collector-roi-highlight"
                      style={{
                        left: (overlayBounds.x / imageWidth) * imageBox.width,
                        top: (overlayBounds.y / imageHeight) * imageBox.height,
                        width: (overlayBounds.width / imageWidth) * imageBox.width,
                        height: (overlayBounds.height / imageHeight) * imageBox.height,
                        border: "2px solid #34d399",
                        background: "rgba(52, 211, 153, 0.12)",
                        position: "absolute",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  {liveDrag && liveDrag.width > 0 && (
                    <div
                      className="collector-roi-highlight"
                      style={{
                        left: (liveDrag.x / imageWidth) * imageBox.width,
                        top: (liveDrag.y / imageHeight) * imageBox.height,
                        width: (liveDrag.width / imageWidth) * imageBox.width,
                        height: (liveDrag.height / imageHeight) * imageBox.height,
                        border: "2px dashed #7dd3fc",
                        background: "rgba(125, 211, 252, 0.15)",
                        position: "absolute",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pdc-side-panel">
          <h3>Detection</h3>
          <dl className="pdc-dl">
            <dt>Status</dt>
            <dd className={`pdc-status-${(containerResult?.status || "not_found").toLowerCase()}`}>
              {containerResult?.status || "—"}
            </dd>
            <dt>Action Row</dt>
            <dd>
              {mainRow
                ? `${mainRow.status} · f${mainRow.frameIndex} · ${mainRow.types.join("+")} · ${mainRow.meanScore.toFixed(3)}`
                : "—"}
            </dd>
            <dt>Confidence</dt>
            <dd>{containerResult?.confidence != null ? containerResult.confidence.toFixed(3) : mainRow?.meanScore.toFixed(3) ?? "—"}</dd>
            <dt>Container</dt>
            <dd>
              {overlayBounds
                ? `${Math.round(overlayBounds.width)}×${Math.round(overlayBounds.height)} @ (${Math.round(overlayBounds.x)},${Math.round(overlayBounds.y)})`
                : "—"}
            </dd>
            <dt>Wheel</dt>
            <dd>
              {containerResult
                ? `${containerResult.scrollMetadata.wheelPoint.x},${containerResult.scrollMetadata.wheelPoint.y} Δ${containerResult.scrollMetadata.deltaY}`
                : "viewport center"}
            </dd>
            <dt>Scroll</dt>
            <dd>
              {containerResult
                ? `req=${containerResult.scrollMetadata.requestedScrollPx} · obs=${containerResult.scrollMetadata.observedScrollPx} · confirmedFrames=${containerResult.scrollMetadata.visualScrollConfirmedFrames}`
                : active?.diagnostics
                  ? `obs=${active.diagnostics.observedScrollPx} · ${active.diagnostics.scrollConfirmLabel} · motion=${active.diagnostics.visualMotionScore ?? "—"}`
                  : "—"}
            </dd>
            <dt>Frame diag</dt>
            <dd>
              {active?.diagnostics
                ? `${active.diagnostics.wheelOutcome} · matches=${active.diagnostics.matchLogs.filter((m) => m.accepted).length}/${active.diagnostics.matchLogs.length}`
                : "—"}
            </dd>
            <dt>Stop</dt>
            <dd>{containerResult?.scrollMetadata.stoppedReason || active?.diagnostics?.stopOrRejectReason || "—"}</dd>
          </dl>

          <h3>References ({visualReferences.length})</h3>
          <ul className="pdc-sample-list">
            {visualReferences.map((s) => (
              <li key={s.sampleId}>
                {s.dataUrl ? <img src={s.dataUrl} alt={s.label} /> : null}
                <span>
                  {s.label} · {s.width}×{s.height}
                </span>
              </li>
            ))}
          </ul>

          <h3>Anchors (frame)</h3>
          <ul className="pdc-sample-list">
            {(active?.anchors || []).map((a) => (
              <li key={`${a.type}-${a.score}`}>
                <span>
                  {a.type} · {a.score.toFixed(3)} · {Math.round(a.bbox.width)}×{Math.round(a.bbox.height)}
                </span>
              </li>
            ))}
            {!active?.anchors?.length && <li className="pdc-muted">Chưa có anchor trên frame này.</li>}
          </ul>

          <div className="pdc-frame-nav">
            <button
              type="button"
              className="pdc-btn pdc-btn-tiny"
              disabled={frameIndex <= 0 || running}
              onClick={() => setFrameIndex((i) => Math.max(0, i - 1))}
            >
              ← Prev
            </button>
            <span>
              Frame {frames.length ? frameIndex + 1 : 0}/{frames.length}
            </span>
            <button
              type="button"
              className="pdc-btn pdc-btn-tiny"
              disabled={frameIndex >= frames.length - 1 || running}
              onClick={() => setFrameIndex((i) => Math.min(frames.length - 1, i + 1))}
            >
              Next →
            </button>
          </div>

          <div className="pdc-btn-row">
            <button
              type="button"
              className="pdc-btn pdc-btn-primary"
              disabled={running || !mainRow?.bbox}
              onClick={confirmActionRow}
            >
              Confirm Action Row
            </button>
            <button
              type="button"
              className="pdc-btn pdc-btn-secondary"
              disabled={running || (!containerResult?.containerBounds && !contentRoi && !mainRow?.bbox)}
              onClick={confirmContainer}
            >
              Confirm Container
            </button>
          </div>
          <p className="pdc-panel-desc">{(containerResult?.notes || []).join(" · ") || "Chưa có diagnostics."}</p>
          <button
            type="button"
            className="pdc-btn pdc-btn-primary"
            disabled={!canNext || running}
            title={canNext ? undefined : "Cần Confirm Container (FOUND hoặc manual) + evidence"}
            onClick={onNext}
          >
            Next: OCR Preview →
          </button>
        </div>
      </div>
    </div>
  );
}
