import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Rect, State } from "../../shared/contracts";
import { domRectToShellBounds, dragToCaptureRoi } from "../../shared/collector-browser-host";
import { clientToImageCoords } from "../../shared/collectors/roi-preview-interaction";
import { readAdminUiZoom } from "../ui-zoom";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorNavigate,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import defaultRealTemplates from "../experiments/visual-match-lab/default-real-templates.json";
import type { Invoke, LiveIconKind, LiveIconTemplates } from "./types";

type Props = {
  templates: LiveIconTemplates;
  invoke: Invoke;
  state?: State | null;
  onUpdateTemplates: (tpl: LiveIconTemplates) => void;
  onNext: () => void;
};

type DragState = {
  kind: "select";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type HostClient = { left: number; top: number; width: number; height: number };

export function CalibrationStep({
  templates,
  invoke,
  state,
  onUpdateTemplates,
  onNext,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  const [url, setUrl] = useState(state?.url || "https://www.facebook.com");
  const [opened, setOpened] = useState(
    Boolean(state?.url && state.url !== "about:blank" && /^https?:\/\//i.test(state.url)),
  );
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("Browser Live Mode: Hãy cuộn tìm bài viết chứa cụm icon Like / Comment / Share.");
  const [shot, setShot] = useState<{ id: string; dataUrl: string; width: number; height: number }>();
  const [roi, setRoi] = useState<Rect>();
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const [kind, setKind] = useState<LiveIconKind>("like");
  const [showHelpExample, setShowHelpExample] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  const dragRef = useRef<DragState | undefined>(undefined);
  const roiRef = useRef<Rect | undefined>(undefined);
  const shotRef = useRef<typeof shot>(undefined);
  const hostClientRef = useRef<HostClient | null>(null);
  const frozenRef = useRef(frozen);

  dragRef.current = drag;
  roiRef.current = roi;
  shotRef.current = shot;
  hostClientRef.current = hostClient;
  frozenRef.current = frozen;

  const imageWidth = shot?.width ?? 0;
  const imageHeight = shot?.height ?? 0;
  const imageSizeRef = useRef({ width: 0, height: 0 });
  imageSizeRef.current = { width: imageWidth, height: imageHeight };

  const imageBox = useMemo(() => {
    if (!hostClient || !imageWidth || !imageHeight) return null;
    const width = hostClient.width;
    const height = (imageHeight / imageWidth) * width;
    return { width, height };
  }, [hostClient, imageWidth, imageHeight]);
  const imageBoxRef = useRef<{ width: number; height: number } | null>(null);
  imageBoxRef.current = imageBox;

  const publishHost = React.useCallback(() => {
    if (!electron || !invoke) return;
    const el = hostRef.current;
    if (!el) {
      setHostClient(null);
      void collectorReportBrowserHost(invoke, null);
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      return;
    }
    setHostClient({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    const zoom = readAdminUiZoom();
    const next = domRectToShellBounds(rect, zoom);
    void collectorReportBrowserHost(invoke, { ...next, active: true });
  }, [electron, invoke]);

  // Mount/unmount lifecycle for BrowserCore WebContentsView in Live Mode
  useEffect(() => {
    if (!electron || !invoke) return;
    publishHost();
    const rafId = requestAnimationFrame(publishHost);
    const el = hostRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => publishHost()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", publishHost);
    window.addEventListener("scroll", publishHost, true);

    // Default to Browser Live Mode
    void collectorSetBrowserVisible(invoke, true).then(() => {
      requestAnimationFrame(publishHost);
    });

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener("resize", publishHost);
      window.removeEventListener("scroll", publishHost, true);
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    };
  }, [electron, invoke, publishHost]);

  // Sync active URL if changed from main process
  useEffect(() => {
    if (state?.url && state.url !== "about:blank" && /^https?:\/\//i.test(state.url)) {
      setUrl(state.url);
      setOpened(true);
    }
  }, [state?.url]);

  async function openUrl() {
    if (!invoke || busy || frozen) return;
    setError("");
    setBusy(true);
    try {
      await collectorNavigate(invoke, url);
      setOpened(true);
      setFrozen(false);
      setShot(undefined);
      setRoi(undefined);
      setMessage("BrowserCore đã điều hướng tới URL. Bạn có thể cuộn và tương tác.");
      publishHost();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Toggle Capture Mode: ON (Freeze current screen)
  async function enterCaptureMode() {
    if (!invoke || busy) return;
    setError("");
    setBusy(true);
    setMessage("Đang đóng băng ảnh từ BrowserCore...");
    try {
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      if (!image.bounds || image.bounds.width < 4 || image.bounds.height < 4) {
        throw new Error("Không lấy được kích thước viewport BrowserCore.");
      }
      setShot(image);
      shotRef.current = image;
      setRoi(undefined);
      setDrag(undefined);
      setFrozen(true);
      frozenRef.current = true;
      publishHost();
      setMessage("Capture Mode: ON · Kéo chuột trên ảnh đóng băng để khoanh vùng icon.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFrozen(false);
      frozenRef.current = false;
      setShot(undefined);
      try {
        await collectorSetBrowserVisible(invoke, true);
        publishHost();
      } catch {}
    } finally {
      setBusy(false);
    }
  }

  // Return to Browser Live Mode
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
    } catch {}
    const d = dragRef.current;
    if (!d) return;
    setDrag(undefined);
    dragRef.current = undefined;
    const nextRoi = dragToCaptureRoi(d.startX, d.startY, d.currentX, d.currentY);
    if (nextRoi && nextRoi.width >= 4 && nextRoi.height >= 4) {
      setRoi(nextRoi);
      roiRef.current = nextRoi;
      setMessage(
        `Đã chọn vùng ${Math.round(nextRoi.width)}×${Math.round(nextRoi.height)}px cho icon ${kind.toUpperCase()}. Bấm "Lưu ${kind.toUpperCase()}" để xác nhận.`,
      );
    } else {
      setRoi(undefined);
      roiRef.current = undefined;
    }
  }

  async function confirmSaveTemplate() {
    if (!shot || !roi || roi.width < 4 || roi.height < 4) return;
    setBusy(true);
    setError("");
    try {
      const img = new Image();
      img.src = shot.dataUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Không thể tải ảnh screenshot"));
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(roi.width);
      canvas.height = Math.round(roi.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context không khả dụng");
      ctx.drawImage(
        img,
        Math.round(roi.x),
        Math.round(roi.y),
        Math.round(roi.width),
        Math.round(roi.height),
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const croppedDataUrl = canvas.toDataURL("image/png");
      const nextTemplates: LiveIconTemplates = {
        ...templates,
        [kind]: {
          kind,
          dataUrl: croppedDataUrl,
          width: canvas.width,
          height: canvas.height,
          sourceFrameId: shot.id,
          bbox: roi,
        },
      };
      onUpdateTemplates(nextTemplates);

      // Return to Live Mode automatically!
      await exitCaptureMode(
        `Đã lưu template ${kind.toUpperCase()} (${canvas.width}×${canvas.height}px)! Tự động quay về Browser Live Mode.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const useDefaultTemplates = () => {
    const next = { ...(defaultRealTemplates as LiveIconTemplates), ...templates };
    onUpdateTemplates(next);
  };

  const isReady = Boolean(templates.like && templates.comment && templates.share);

  const liveRoi = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : roi;

  if (!electron) {
    return (
      <div className="fic-step-calibration">
        <div className="fic-alert fic-alert-warn">{BROWSER_CORE_UNAVAILABLE}</div>
      </div>
    );
  }

  return (
    <div className="fic-step-calibration">
      {/* Top Header & Mode Toggle */}
      <div className="fic-section-header">
        <div>
          <h2>Bước 1: Browser Capture & Like/Comment/Share Calibration</h2>
          <p className="fic-subtitle">
            Mặc định là <b>Browser Live Mode</b>. Bạn có thể cuộn và lướt Facebook bình thường. Bật{" "}
            <b>Capture Mode: ON</b> để đóng băng màn hình và khoanh vùng icon mẫu.
          </p>
        </div>

        <div className="fic-header-actions">
          {/* Capture Mode Toggle: OFF / ON */}
          <button
            type="button"
            className={`fic-btn ${frozen ? "fic-btn-capture-active" : "fic-btn-primary"}`}
            disabled={busy}
            onClick={() => {
              if (frozen) {
                void exitCaptureMode();
              } else {
                void enterCaptureMode();
              }
            }}
          >
            {frozen ? "⏹ Thoát sang Live Mode (Tắt Capture)" : "📷 Capture Mode: ON (Đóng băng ảnh)"}
          </button>
          <button
            type="button"
            className="fic-btn fic-btn-secondary"
            onClick={() => setShowHelpExample(!showHelpExample)}
          >
            {showHelpExample ? "Ẩn mẫu Facebook (Help)" : "ℹ Xem mẫu Facebook (Help)"}
          </button>
        </div>
      </div>

      {/* Navigation & Status Bar */}
      <div className="fic-toolbar card">
        <div className="fic-address-bar">
          <span className="fic-address-label">URL:</span>
          <input
            type="text"
            className="fic-url-input"
            disabled={busy || frozen}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.facebook.com"
          />
          <button
            type="button"
            className="fic-btn fic-btn-small fic-btn-secondary"
            disabled={busy || frozen}
            onClick={() => void openUrl()}
          >
            Đi tới URL
          </button>
        </div>

        <div className="fic-mode-indicator">
          <span className={`fic-dot ${frozen ? "dot-frozen" : "dot-live"}`} />
          <b className={frozen ? "fic-text-warn" : "fic-text-success"}>
            {frozen ? "CAPTURE MODE: ON (Ảnh đóng băng)" : "BROWSER LIVE MODE (Tương tác trực tiếp)"}
          </b>
        </div>
      </div>

      {error && <div className="fic-alert fic-alert-error">⚠ {error}</div>}
      {message && <div className="fic-alert fic-alert-info">{message}</div>}

      {/* Collapsible Help / Example Section */}
      {showHelpExample && (
        <div className="fic-help-drawer card">
          <div className="fic-help-header">
            <h4>Mẫu Facebook tiêu chuẩn (Chỉ dùng tham khảo / Hướng dẫn)</h4>
            <button
              type="button"
              className="fic-btn fic-btn-small fic-btn-secondary"
              onClick={useDefaultTemplates}
            >
              Áp dụng mẫu Facebook tiêu chuẩn
            </button>
          </div>
          <p className="fic-help-desc">
            Dưới đây là hình ảnh mẫu icon Facebook chuẩn. Lưu ý: đây chỉ là ảnh ví dụ để tham khảo, không phải là trình duyệt BrowserCore live.
          </p>
          <div className="fic-help-templates">
            {(["like", "comment", "share"] as LiveIconKind[]).map((k) => {
              const def = (defaultRealTemplates as LiveIconTemplates)[k];
              return (
                <div key={k} className="fic-help-template-item">
                  <span className="fic-kind-label">{k.toUpperCase()}</span>
                  {def ? <img src={def.dataUrl} alt={`Default ${k}`} /> : <span>Không có</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Workspace Layout */}
      <div className="fic-calibration-workspace">
        {/* Left Column: BrowserCore Live Host or Frozen Overlay */}
        <div className="fic-crop-container card">
          <div className="collector-capture-workspace collector-browser-workspace">
            <div
              ref={hostRef}
              className="collector-browser-host"
              aria-label="Browser Core live workspace"
              data-browser-core-host=""
            >
              {!opened && !frozen && (
                <div className="collector-sample-empty collector-browser-host-placeholder">
                  Đang tải BrowserCore... Bạn có thể nhập URL Facebook và bấm "Đi tới URL".
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Template Management & Calibration Controls */}
        <div className="fic-sidebar-panel card">
          <h3>Templates Hiệu Chuẩn</h3>
          <p className="fic-panel-desc">
            Cần có đủ 3 icon: Like, Comment và Share. Khi bật <b>Capture Mode: ON</b>, chọn loại icon tương ứng rồi kéo khoanh vùng để lưu.
          </p>

          {/* Icon Kind Selector for cropping */}
          {frozen && (
            <div className="fic-freeze-toolbar">
              <span className="fic-tool-label">Chọn icon đang crop:</span>
              <div className="fic-icon-chips">
                {(["like", "comment", "share"] as LiveIconKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`fic-chip ${kind === k ? "active" : ""}`}
                    onClick={() => {
                      setKind(k);
                      setRoi(undefined);
                    }}
                  >
                    {k.toUpperCase()}
                  </button>
                ))}
              </div>

              {roi && (
                <div className="fic-roi-summary">
                  <span>
                    Vùng crop: <b>{Math.round(roi.width)}×{Math.round(roi.height)}px</b>
                  </span>
                  <div className="fic-roi-actions">
                    <button
                      type="button"
                      className="fic-btn fic-btn-small fic-btn-primary"
                      disabled={busy}
                      onClick={() => void confirmSaveTemplate()}
                    >
                      Lưu {kind.toUpperCase()}
                    </button>
                    <button
                      type="button"
                      className="fic-btn fic-btn-small fic-btn-secondary"
                      onClick={() => setRoi(undefined)}
                    >
                      Reset ROI
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Previews of Confirmed Templates */}
          <div className="fic-preview-cards">
            {(["like", "comment", "share"] as LiveIconKind[]).map((k) => {
              const tpl = templates[k];
              return (
                <div key={k} className={`fic-preview-card ${tpl ? "confirmed" : "missing"}`}>
                  <div className="fic-preview-meta">
                    <b>{k.toUpperCase()}</b>
                    <span className={`fic-badge ${tpl ? "badge-success" : "badge-warn"}`}>
                      {tpl ? "ĐÃ CÓ" : "CHƯA CÓ"}
                    </span>
                  </div>
                  <div className="fic-preview-thumb">
                    {tpl ? (
                      <img src={tpl.dataUrl} alt={`${k} template`} />
                    ) : (
                      <div className="fic-missing-placeholder">Chưa crop</div>
                    )}
                  </div>
                  {tpl && (
                    <small className="fic-preview-dim">
                      {tpl.width} × {tpl.height}px
                    </small>
                  )}
                </div>
              );
            })}
          </div>

          <div className="fic-status-box">
            <span className={`fic-status-indicator ${isReady ? "ready" : "pending"}`} />
            <span>
              {isReady
                ? "Đã đủ 3 template (Like, Comment, Share)."
                : "Chưa đủ 3 template. Bật Capture Mode để crop thêm."}
            </span>
          </div>

          <div className="fic-step-footer">
            <button
              type="button"
              className="fic-btn fic-btn-primary fic-btn-large"
              disabled={!isReady}
              onClick={onNext}
            >
              Tiếp tục sang Bước 2: Auto Match →
            </button>
          </div>
        </div>
      </div>

      {/* Frozen Overlay for ROI Selection (matches Collector V1) */}
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
            <div
              style={{
                width: imageBox.width,
                height: imageBox.height,
                position: "relative",
              }}
            >
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
                    border: "2px solid #38bdf8",
                    background: "rgba(56, 189, 248, 0.2)",
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
