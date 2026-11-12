import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Rect, State } from "../../shared/contracts";
import { dragToCaptureRoi } from "../../shared/collector-browser-host";
import { clientToImageCoords } from "../../shared/collectors/roi-preview-interaction";
import { DEFAULT_POST_DETAIL_FIXTURE_URL } from "../../shared/post-detail-collector/types";
import {
  assertCaptureFromSocialPage,
  assertNavigateToSocialTarget,
} from "../../shared/post-detail-collector/social-url";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorNavigate,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import {
  claimCollectorHostOwner,
  isCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { cropDataUrl } from "./image-utils";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import type { BrowserProbe, Invoke, VisualReferenceSample } from "./types";

type Props = {
  invoke: Invoke;
  state?: State | null;
  sourceUrl: string;
  visualReferences: VisualReferenceSample[];
  contentRoi: Rect | null;
  onSourceUrl: (url: string) => void;
  onUpdateReferences: (samples: VisualReferenceSample[]) => void;
  onContentRoi: (roi: Rect | null) => void;
  onScreenshot: (shot: { id: string; dataUrl: string; width: number; height: number } | null) => void;
  onProbeRefresh: () => Promise<BrowserProbe | null>;
  onNext: () => void;
};

type DragState = { kind: "select"; startX: number; startY: number; currentX: number; currentY: number };
type HostClient = { left: number; top: number; width: number; height: number };

export function BrowserCaptureStep({
  invoke,
  state,
  sourceUrl,
  visualReferences,
  contentRoi,
  onSourceUrl,
  onUpdateReferences,
  onContentRoi,
  onScreenshot,
  onProbeRefresh,
  onNext,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  const [url, setUrl] = useState(sourceUrl || DEFAULT_POST_DETAIL_FIXTURE_URL);
  const [opened, setOpened] = useState(
    Boolean(state?.url && state.url !== "about:blank" && /^https?:\/\//i.test(state.url)),
  );
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(
    "Browser Live Mode: Open URL điều hướng tới Facebook/Threads từ bất kỳ trang hiện tại. Capture chỉ khi đã ở trang social.",
  );
  const [shot, setShot] = useState<{ id: string; dataUrl: string; width: number; height: number }>();
  const [roi, setRoi] = useState<Rect | undefined>(contentRoi ?? undefined);
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const [sampleLabel, setSampleLabel] = useState("content-region");

  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const shotRef = useRef<typeof shot>(undefined);
  const hostClientRef = useRef<HostClient | null>(null);
  const frozenRef = useRef(frozen);
  const imageBoxRef = useRef<{ width: number; height: number } | null>(null);
  const imageSizeRef = useRef({ width: 0, height: 0 });

  const imageWidth = shot?.width ?? 0;
  const imageHeight = shot?.height ?? 0;
  imageSizeRef.current = { width: imageWidth, height: imageHeight };
  frozenRef.current = frozen;

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
    const { ownerId } = claimCollectorHostOwner("pdc-step1");
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

  useEffect(() => {
    if (state?.url && state.url !== "about:blank" && /^https?:\/\//i.test(state.url)) {
      setUrl((prev) => (prev?.trim() ? prev : state.url!));
      setOpened(true);
    }
  }, [state?.url]);

  async function openUrl() {
    if (!invoke || busy || frozen) return;
    setError("");
    setBusy(true);
    try {
      const target = assertNavigateToSocialTarget(url);
      await collectorNavigate(invoke, target.url);
      const probe = await onProbeRefresh();
      if (!probe?.available) {
        throw new Error("BrowserCore probe failed after navigate.");
      }
      const actual = probe.url || "";
      let actualHost = "";
      try {
        actualHost = new URL(actual).hostname.toLowerCase();
      } catch {
        actualHost = actual;
      }
      const expectedHost = new URL(target.url).hostname.toLowerCase();
      const hostOk =
        actualHost === expectedHost ||
        actualHost.endsWith(`.${expectedHost.replace(/^www\./, "")}`) ||
        expectedHost.endsWith(`.${actualHost.replace(/^www\./, "")}`) ||
        (target.platform === "facebook" && (actualHost.includes("facebook.com") || actualHost.includes("fb.com"))) ||
        (target.platform === "threads" && (actualHost.includes("threads.net") || actualHost.includes("threads.com")));
      if (!hostOk) {
        throw new Error(
          `NAVIGATION_MISMATCH: expected ${expectedHost} but BrowserCore is at ${actual || "(empty)"}`,
        );
      }
      setOpened(true);
      setUrl(target.url);
      onSourceUrl(target.url);
      setFrozen(false);
      setShot(undefined);
      onScreenshot(null);
      setMessage(`Đã điều hướng tới ${probe.url}. Browser Live Mode — có thể tương tác bình thường.`);
      publishHost();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function enterCaptureMode() {
    if (!invoke || busy) return;
    setError("");
    setBusy(true);
    setMessage("Đang kiểm tra trang social rồi đóng băng screenshot...");
    try {
      const probe = await onProbeRefresh();
      assertCaptureFromSocialPage(probe?.url || state?.url || "");
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      if (!image.bounds || image.bounds.width < 4 || image.bounds.height < 4) {
        throw new Error("Không lấy được kích thước viewport BrowserCore.");
      }
      setShot(image);
      shotRef.current = image;
      onScreenshot(image);
      setRoi(undefined);
      setDrag(undefined);
      setFrozen(true);
      frozenRef.current = true;
      publishHost();
      setMessage("Capture Mode ON · Kéo ROI vùng nội dung trên ảnh đóng băng (overlay cố định theo host bounds).");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFrozen(false);
      frozenRef.current = false;
      setShot(undefined);
      try {
        await collectorSetBrowserVisible(invoke, true);
        publishHost();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function exitCaptureMode(status = "Đã quay lại Browser Live Mode. Giữ nguyên trang và scroll.") {
    if (!invoke) return;
    setBusy(true);
    setError("");
    setDrag(undefined);
    setShot(undefined);
    setRoi(undefined);
    setFrozen(false);
    frozenRef.current = false;
    try {
      await collectorSetBrowserVisible(invoke, true);
      publishHost();
      setMessage(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pointerPos(e: { clientX: number; clientY: number }) {
    const box = imageBoxRef.current;
    const { width: iw, height: ih } = imageSizeRef.current;
    if (!box || !iw || !ih) return { x: 0, y: 0 };
    const scroller = previewScrollRef.current;
    if (!scroller) {
      const host = hostClientRef.current;
      if (!host) return { x: 0, y: 0 };
      return clientToImageCoords(
        e.clientX,
        e.clientY,
        { left: host.left, top: host.top, scrollLeft: 0, scrollTop: 0 },
        box,
        iw,
        ih,
      );
    }
    const rect = scroller.getBoundingClientRect();
    return clientToImageCoords(
      e.clientX,
      e.clientY,
      { left: rect.left, top: rect.top, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop },
      box,
      iw,
      ih,
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!frozen || !shot || roi) return;
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
    const next: DragState = { ...d, currentX: p.x, currentY: p.y };
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
      setRoi(nextRoi);
      onContentRoi(nextRoi);
      setMessage(`Đã chọn ROI ${Math.round(nextRoi.width)}×${Math.round(nextRoi.height)}px.`);
    } else {
      setRoi(undefined);
      onContentRoi(null);
    }
  }

  async function saveVisualReference() {
    if (!shot || !roi) return;
    setBusy(true);
    setError("");
    try {
      const cropped = await cropDataUrl(shot.dataUrl, roi);
      const sample: VisualReferenceSample = {
        sampleId: `vr_${Date.now().toString(36)}`,
        label: sampleLabel.trim() || `sample-${visualReferences.length + 1}`,
        dataUrl: cropped.dataUrl,
        width: cropped.width,
        height: cropped.height,
        sourceCaptureId: shot.id,
        bbox: roi,
        createdAt: new Date().toISOString(),
      };
      onUpdateReferences([...visualReferences, sample]);
      onContentRoi(roi);
      setMessage(`Đã lưu visual reference “${sample.label}”.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndLive() {
    if (!roi) {
      setError("Cần ROI nội dung trước khi Confirm.");
      return;
    }
    onContentRoi(roi);
    if (shot) onScreenshot(shot);
    await exitCaptureMode("ROI đã xác nhận · quay lại Browser Live Mode.");
  }

  hostClientRef.current = hostClient;
  shotRef.current = shot;

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
          <h2>Step 1 — Browser & Detail Capture</h2>
          <p className="pdc-subtitle">
            BrowserCore Default session · host bounds đo từ DOM (giống Feed Item) · fixture Anh Tho chỉ là URL mặc định.
          </p>
        </div>
        <button
          type="button"
          className={`pdc-btn ${frozen ? "pdc-btn-warn" : "pdc-btn-primary"}`}
          disabled={busy}
          onClick={() => {
            if (frozen) void exitCaptureMode();
            else void enterCaptureMode();
          }}
        >
          {frozen ? "Thoát Capture → Live" : "Capture Mode ON"}
        </button>
      </div>

      <div className="pdc-toolbar">
        <input
          className="pdc-url-input"
          disabled={busy || frozen}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={DEFAULT_POST_DETAIL_FIXTURE_URL}
          aria-label="Post URL"
        />
        <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy || frozen} onClick={() => void openUrl()}>
          Open URL
        </button>
        <span className={`pdc-mode ${frozen ? "frozen" : "live"}`}>
          {frozen ? "CAPTURE MODE" : "BROWSER LIVE"}
        </span>
      </div>

      {error && <div className="pdc-alert pdc-alert-error">{error}</div>}
      {message && <div className="pdc-alert pdc-alert-info">{message}</div>}

      <div className="pdc-calibration-workspace">
        <div className="pdc-crop-container">
          <div className="collector-capture-workspace collector-browser-workspace">
            <div
              ref={hostRef}
              className="collector-browser-host"
              data-browser-core-host=""
              aria-label="Browser Core live workspace"
            >
              {!opened && !frozen && (
                <div className="collector-sample-empty collector-browser-host-placeholder">
                  Nhập Post URL rồi bấm Open URL. BrowserCore sẽ gắn đúng vào khung này.
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="pdc-side-panel">
          <h3>ROI & Visual References</h3>
          <p className="pdc-panel-desc">
            Visual reference ≠ OCR frame. Capture chỉ khi trang hiện tại là Facebook/Threads.
          </p>
          <label className="pdc-field">
            Sample label
            <input value={sampleLabel} disabled={!frozen || busy} onChange={(e) => setSampleLabel(e.target.value)} />
          </label>
          <div className="pdc-btn-row">
            <button type="button" className="pdc-btn pdc-btn-secondary" disabled={!frozen || !roi || busy} onClick={() => void saveVisualReference()}>
              Save visual reference
            </button>
            <button type="button" className="pdc-btn pdc-btn-primary" disabled={!roi || busy} onClick={() => void confirmAndLive()}>
              Confirm ROI → Live
            </button>
          </div>
          <ul className="pdc-sample-list">
            {visualReferences.map((s) => (
              <li key={s.sampleId}>
                {s.dataUrl ? <img src={s.dataUrl} alt={s.label} /> : null}
                <span>
                  {s.label} · {s.width}×{s.height}
                </span>
                <button
                  type="button"
                  className="pdc-btn pdc-btn-tiny"
                  onClick={() => onUpdateReferences(visualReferences.filter((x) => x.sampleId !== s.sampleId))}
                >
                  Remove
                </button>
              </li>
            ))}
            {!visualReferences.length && <li className="pdc-muted">Chưa có visual reference.</li>}
          </ul>
          <button type="button" className="pdc-btn pdc-btn-primary" disabled={!contentRoi && !roi} onClick={onNext}>
            Next: Visual Region →
          </button>
        </aside>
      </div>

      {frozen && shot && hostClient && imageBox && (
        <div
          ref={surfaceRef}
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
          role="img"
          aria-label="Frozen browser capture for ROI crop"
        >
          <div
            ref={previewScrollRef}
            className="collector-capture-preview-scroll"
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
          >
            <div style={{ width: imageBox.width, height: imageBox.height, position: "relative" }}>
              <img
                src={shot.dataUrl}
                alt="Frozen capture"
                draggable={false}
                style={{
                  display: "block",
                  width: imageBox.width,
                  height: imageBox.height,
                  maxWidth: "none",
                  maxHeight: "none",
                  objectFit: "fill",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
              {liveRoi && liveRoi.width > 0 && liveRoi.height > 0 && (
                <div
                  className="collector-roi-highlight"
                  style={{
                    left: (liveRoi.x / shot.width) * imageBox.width,
                    top: (liveRoi.y / shot.height) * imageBox.height,
                    width: (liveRoi.width / shot.width) * imageBox.width,
                    height: (liveRoi.height / shot.height) * imageBox.height,
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
