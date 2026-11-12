import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Rect, State } from "../../shared/contracts";
import { dragToCaptureRoi } from "../../shared/collector-browser-host";
import { clientToImageCoords } from "../../shared/collectors/roi-preview-interaction";
import { classifyVisualMatchStatus } from "../../shared/post-detail-collector/match-status";
import { assertCaptureFromSocialPage } from "../../shared/post-detail-collector/social-url";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import { TemplateMatcher } from "../experiments/visual-match-lab/template-matcher";
import {
  claimCollectorHostOwner,
  isCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { imageToCanvas } from "./image-utils";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import type { BrowserProbe, Invoke, PostDetailMatchResult, VisualReferenceSample } from "./types";

type Props = {
  invoke: Invoke;
  state?: State | null;
  visualReferences: VisualReferenceSample[];
  contentRoi: Rect | null;
  lastMatch: PostDetailMatchResult | null;
  onContentRoi: (roi: Rect | null) => void;
  onMatch: (match: PostDetailMatchResult | null) => void;
  onScreenshot: (shot: { id: string; dataUrl: string; width: number; height: number } | null) => void;
  onProbeRefresh: () => Promise<BrowserProbe | null>;
  onBack: () => void;
  onNext: () => void;
};

type DragState = { kind: "select"; startX: number; startY: number; currentX: number; currentY: number };
type HostClient = { left: number; top: number; width: number; height: number };

export function VisualRegionStep({
  invoke,
  state,
  visualReferences,
  contentRoi,
  lastMatch,
  onContentRoi,
  onMatch,
  onScreenshot,
  onProbeRefresh,
  onBack,
  onNext,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(
    "Chụp frame hiện tại rồi chạy visual matching trên các visual reference samples.",
  );
  const [shot, setShot] = useState<{ id: string; dataUrl: string; width: number; height: number }>();
  const [frozen, setFrozen] = useState(false);
  const [roi, setRoi] = useState<Rect | undefined>(contentRoi ?? undefined);
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const [manualConfirmRequired, setManualConfirmRequired] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const hostClientRef = useRef<HostClient | null>(null);
  const imageBoxRef = useRef<{ width: number; height: number } | null>(null);
  const imageSizeRef = useRef({ width: 0, height: 0 });

  const imageWidth = shot?.width ?? 0;
  const imageHeight = shot?.height ?? 0;
  imageSizeRef.current = { width: imageWidth, height: imageHeight };

  const imageBox = useMemo(() => {
    if (!hostClient || !imageWidth || !imageHeight) return null;
    const width = hostClient.width;
    const height = (imageHeight / imageWidth) * width;
    return { width, height };
  }, [hostClient, imageWidth, imageHeight]);
  imageBoxRef.current = imageBox;

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
    void collectorSetBrowserVisible(invoke, true).then(() => {
      requestAnimationFrame(safePublish);
    });
    return () => {
      for (const id of rafIds) cancelAnimationFrame(id);
      ro?.disconnect();
      window.removeEventListener("resize", safePublish);
      window.removeEventListener("scroll", safePublish, true);
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
  }, [electron, invoke, publishHost]);

  async function captureAndMatch() {
    if (!invoke || busy) return;
    if (!visualReferences.length) {
      setError("Cần ít nhất một visual reference từ Step 1.");
      setManualConfirmRequired(true);
      return;
    }
    setBusy(true);
    setError("");
    setMessage("Đang capture + visual match...");
    try {
      const probe = await onProbeRefresh();
      assertCaptureFromSocialPage(probe?.url || state?.url || "");
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      setShot(image);
      onScreenshot(image);
      setFrozen(true);
      publishHost();

      const target = await imageToCanvas(image.dataUrl);
      const allScores: number[] = [];
      let best: { score: number; templateId: string; bbox: Rect } | null = null;

      for (const sample of visualReferences) {
        if (!sample.dataUrl) continue;
        const tpl = await imageToCanvas(sample.dataUrl);
        const result = await TemplateMatcher.match(tpl, target, "grayscale", 0.55);
        for (const m of result.matches) {
          allScores.push(m.score);
          if (!best || m.score > best.score) {
            best = { score: m.score, templateId: sample.sampleId, bbox: m.bbox };
          }
        }
      }

      const status = classifyVisualMatchStatus(allScores);
      const match: PostDetailMatchResult = {
        status,
        score: best?.score ?? null,
        templateId: best?.templateId ?? null,
        bbox: best?.bbox ?? null,
        candidateCount: allScores.length,
        scores: allScores.slice(0, 8),
        screenshotDataUrl: image.dataUrl,
        notes: [
          TemplateMatcher.isOpenCvReady()
            ? "OpenCV matcher available"
            : "Pure-JS NCC fallback (OpenCV.js not loaded in shell)",
          `templates tried: ${visualReferences.length}`,
        ],
      };
      onMatch(match);

      if (status === "MATCHED" && contentRoi) {
        setRoi(contentRoi);
        onContentRoi(contentRoi);
        setManualConfirmRequired(false);
        setMessage(`MATCHED (score=${best?.score?.toFixed(3)}) · dùng content ROI đã xác nhận từ Step 1.`);
      } else if (status === "MATCHED" && best?.bbox) {
        setRoi(undefined);
        setManualConfirmRequired(true);
        setMessage(
          `MATCHED anchor ${Math.round(best.bbox.width)}×${Math.round(best.bbox.height)}. Xác nhận ROI OCR thủ công.`,
        );
      } else {
        setManualConfirmRequired(true);
        setMessage(
          `${status}${best ? ` (best=${best.score.toFixed(3)})` : ""} · Không đủ bằng chứng — kéo ROI thủ công.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function exitToLive() {
    if (!invoke) return;
    setFrozen(false);
    setShot(undefined);
    await collectorSetBrowserVisible(invoke, true);
    publishHost();
  }

  function pointerPos(e: { clientX: number; clientY: number }) {
    const box = imageBoxRef.current;
    const { width: iw, height: ih } = imageSizeRef.current;
    if (!box || !iw || !ih || !previewScrollRef.current) return { x: 0, y: 0 };
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
      box,
      iw,
      ih,
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!frozen || !shot) return;
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
    if (nextRoi) {
      setRoi(nextRoi);
      onContentRoi(nextRoi);
      setManualConfirmRequired(false);
      setMessage(`User confirmed OCR ROI ${nextRoi.width}×${nextRoi.height}.`);
    }
  }

  hostClientRef.current = hostClient;
  const liveRoi = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : roi;

  if (!electron) {
    return <div className="pdc-alert pdc-alert-warn">{BROWSER_CORE_UNAVAILABLE}</div>;
  }

  return (
    <div className="pdc-step pdc-step-calibration">
      <div className="pdc-section-header">
        <div>
          <h2>Step 2 — Visual Region Detection</h2>
          <p className="pdc-subtitle">Capture chỉ khi trang hiện tại là Facebook/Threads. TemplateMatcher tái sử dụng Lab.</p>
        </div>
        <div className="pdc-btn-row">
          <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy} onClick={onBack}>
            ← Back
          </button>
          <button type="button" className="pdc-btn pdc-btn-primary" disabled={busy} onClick={() => void captureAndMatch()}>
            Capture & Match
          </button>
          {frozen && (
            <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy} onClick={() => void exitToLive()}>
              Live Mode
            </button>
          )}
        </div>
      </div>

      {error && <div className="pdc-alert pdc-alert-error">{error}</div>}
      {message && <div className="pdc-alert pdc-alert-info">{message}</div>}
      {manualConfirmRequired && (
        <div className="pdc-alert pdc-alert-warn">Cần user xác nhận ROI — không tự chọn vùng OCR khi bằng chứng yếu.</div>
      )}

      <div className="pdc-calibration-workspace">
        <div className="pdc-crop-container">
          <div className="collector-capture-workspace collector-browser-workspace">
            <div ref={hostRef} className="collector-browser-host" data-browser-core-host="" aria-label="Browser Core host" />
          </div>
        </div>
        <div className="pdc-side-panel">
          <h3>Match result</h3>
          {lastMatch ? (
            <dl className="pdc-dl">
              <dt>Status</dt>
              <dd className={`pdc-status-${lastMatch.status.toLowerCase()}`}>{lastMatch.status}</dd>
              <dt>Score</dt>
              <dd>{lastMatch.score != null ? lastMatch.score.toFixed(3) : "—"}</dd>
              <dt>Template</dt>
              <dd>{lastMatch.templateId || "—"}</dd>
              <dt>Candidates</dt>
              <dd>{lastMatch.candidateCount}</dd>
              <dt>Notes</dt>
              <dd>{lastMatch.notes.join(" · ")}</dd>
            </dl>
          ) : (
            <p className="pdc-muted">Chưa chạy match.</p>
          )}
          <p className="pdc-panel-desc">References: {visualReferences.length}</p>
          <button type="button" className="pdc-btn pdc-btn-primary" disabled={!roi && !contentRoi} onClick={onNext}>
            Next: OCR Preview →
          </button>
        </div>
      </div>

      {frozen && shot && hostClient && imageBox && (
        <div
          className="collector-capture-freeze snapshot"
          style={{
            position: "fixed",
            left: hostClient.left,
            top: hostClient.top,
            width: hostClient.width,
            height: hostClient.height,
            zIndex: 40,
            margin: 0,
            boxSizing: "border-box",
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
                src={shot.dataUrl}
                alt="Match frame"
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
              {lastMatch?.bbox && (
                <div
                  className="collector-roi-highlight"
                  style={{
                    left: (lastMatch.bbox.x / imageWidth) * imageBox.width,
                    top: (lastMatch.bbox.y / imageHeight) * imageBox.height,
                    width: (lastMatch.bbox.width / imageWidth) * imageBox.width,
                    height: (lastMatch.bbox.height / imageHeight) * imageBox.height,
                    border: "2px solid #fbbf24",
                    background: "rgba(251, 191, 36, 0.15)",
                    position: "absolute",
                    pointerEvents: "none",
                  }}
                />
              )}
              {liveRoi && liveRoi.width > 0 && (
                <div
                  className="collector-roi-highlight"
                  style={{
                    left: (liveRoi.x / imageWidth) * imageBox.width,
                    top: (liveRoi.y / imageHeight) * imageBox.height,
                    width: (liveRoi.width / imageWidth) * imageBox.width,
                    height: (liveRoi.height / imageHeight) * imageBox.height,
                    border: "2px solid #34d399",
                    background: "rgba(52, 211, 153, 0.2)",
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
  );
}
