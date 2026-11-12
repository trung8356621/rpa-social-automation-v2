import React, { useRef, useState } from "react";
import type { Rect } from "../../../experiments/visual-match-lab/src/types";
import defaultRealTemplates from "../experiments/visual-match-lab/default-real-templates.json";
import type { Invoke, LiveCapture, LiveIconKind, LiveIconTemplates } from "./types";

export function CalibrationStep({
  capture,
  templates,
  invoke,
  onCapture,
  onUpdateTemplates,
  onNext,
}: {
  capture: LiveCapture | null;
  templates: LiveIconTemplates;
  invoke: Invoke;
  onCapture: (cap: LiveCapture) => void;
  onUpdateTemplates: (tpl: LiveIconTemplates) => void;
  onNext: () => void;
}) {
  const [kind, setKind] = useState<LiveIconKind>("like");
  const [rect, setRect] = useState<Rect | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [showHelpExample, setShowHelpExample] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const takeCapture = async () => {
    setCapturing(true);
    setCaptureError(null);
    try {
      const next = await invoke<LiveCapture>({ type: "visualMatchLabCapture" });
      onCapture(next);
      setRect(null);
    } catch (err) {
      setCaptureError(String(err));
    } finally {
      setCapturing(false);
    }
  };

  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!capture) return { x: 0, y: 0 };
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(capture.width, ((event.clientX - bounds.left) * capture.width) / bounds.width)),
      y: Math.max(0, Math.min(capture.height, ((event.clientY - bounds.top) * capture.height) / bounds.height)),
    };
  };

  const saveCrop = async () => {
    if (!capture || !rect || rect.width < 4 || rect.height < 4) return;
    const image = new Image();
    image.src = capture.dataUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("FRAME_IMAGE_LOAD_FAILED"));
    });
    const crop = document.createElement("canvas");
    crop.width = Math.round(rect.width);
    crop.height = Math.round(rect.height);
    crop.getContext("2d")!.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    const next: LiveIconTemplates = {
      ...templates,
      [kind]: {
        kind,
        dataUrl: crop.toDataURL("image/png"),
        width: crop.width,
        height: crop.height,
        sourceFrameId: capture.id,
        bbox: rect,
      },
    };
    onUpdateTemplates(next);
    setRect(null);
  };

  const useDefaultTemplates = () => {
    const next = { ...(defaultRealTemplates as LiveIconTemplates), ...templates };
    onUpdateTemplates(next);
  };

  const isReady = Boolean(templates.like && templates.comment && templates.share);

  return (
    <div className="fic-step-calibration">
      <div className="fic-section-header">
        <div>
          <h2>Bước 1: Browser Capture & Like/Comment/Share Calibration</h2>
          <p className="fic-subtitle">
            Sử dụng BrowserCore đang đăng nhập Facebook/Threads. Chụp screenshot tĩnh, sau đó kéo chọn vùng icon
            Like / Comment / Share để hiệu chuẩn template nhận diện.
          </p>
        </div>
        <div className="fic-header-actions">
          <button
            type="button"
            className="fic-btn fic-btn-primary"
            disabled={capturing}
            onClick={() => void takeCapture()}
          >
            {capturing ? "Đang chụp..." : "📷 Chụp từ BrowserCore"}
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

      {captureError && <div className="fic-alert fic-alert-error">⚠ {captureError}</div>}

      {/* Collapsible Help / Example Section */}
      {showHelpExample && (
        <div className="fic-help-drawer card">
          <div className="fic-help-header">
            <h4>Mẫu Facebook tiêu chuẩn (Tham khảo)</h4>
            <button
              type="button"
              className="fic-btn fic-btn-small fic-btn-secondary"
              onClick={useDefaultTemplates}
            >
              Áp dụng mẫu Facebook tiêu chuẩn
            </button>
          </div>
          <p className="fic-help-desc">
            Dưới đây là các crop icon chuẩn của Facebook. Bạn có thể sử dụng mẫu có sẵn nếu không muốn crop thủ công.
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

      {/* Main Workspace */}
      <div className="fic-calibration-workspace">
        {/* Left / Center: Screenshot Crop Surface */}
        <div className="fic-crop-container card">
          <div className="fic-crop-toolbar">
            <div className="fic-icon-selector">
              <span className="fic-tool-label">Chọn icon để crop:</span>
              {(["like", "comment", "share"] as LiveIconKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`fic-chip ${kind === k ? "active" : ""}`}
                  onClick={() => {
                    setKind(k);
                    setRect(null);
                  }}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>

            <div className="fic-crop-actions">
              <button
                type="button"
                className="fic-btn fic-btn-small fic-btn-primary"
                disabled={!rect || rect.width < 4 || rect.height < 4}
                onClick={() => void saveCrop()}
              >
                Lưu crop {kind.toUpperCase()}
              </button>
              {rect && (
                <button
                  type="button"
                  className="fic-btn fic-btn-small fic-btn-secondary"
                  onClick={() => setRect(null)}
                >
                  Hủy chọn
                </button>
              )}
            </div>
          </div>

          <div
            className="fic-surface"
            onPointerDown={(e) => {
              if (!capture) return;
              start.current = point(e);
              setRect({ ...start.current, width: 0, height: 0 });
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!start.current || !capture) return;
              const end = point(e);
              const x = Math.min(start.current.x, end.x);
              const y = Math.min(start.current.y, end.y);
              setRect({
                x,
                y,
                width: Math.abs(end.x - start.current.x),
                height: Math.abs(end.y - start.current.y),
              });
            }}
            onPointerUp={(e) => {
              if (start.current && capture) {
                setRect((curr) =>
                  curr
                    ? {
                        ...curr,
                        x: Math.round(curr.x),
                        y: Math.round(curr.y),
                        width: Math.round(curr.width),
                        height: Math.round(curr.height),
                      }
                    : null,
                );
              }
              start.current = null;
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch {}
            }}
          >
            {capture ? (
              <>
                <img
                  src={capture.dataUrl}
                  alt="Evidence frame tĩnh từ BrowserCore"
                  draggable={false}
                  className="fic-surface-img"
                />
                {rect && (
                  <span
                    className="fic-crop-box"
                    style={{
                      left: `${(rect.x / capture.width) * 100}%`,
                      top: `${(rect.y / capture.height) * 100}%`,
                      width: `${(rect.width / capture.width) * 100}%`,
                      height: `${(rect.height / capture.height) * 100}%`,
                    }}
                  />
                )}
              </>
            ) : (
              <div className="fic-empty-surface">
                <p>Chưa có screenshot tĩnh.</p>
                <button
                  type="button"
                  className="fic-btn fic-btn-primary"
                  disabled={capturing}
                  onClick={() => void takeCapture()}
                >
                  {capturing ? "Đang chụp..." : "📷 Chụp từ BrowserCore để bắt đầu"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Template Previews & Calibration Readiness */}
        <div className="fic-sidebar-panel card">
          <h3>Trạng thái Templates</h3>
          <p className="fic-panel-desc">
            Cần có đủ cả 3 icon: Like, Comment và Share để làm mẫu đối sánh trước khi sang bước Auto Match.
          </p>

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
                ? "Đủ 3 template tiêu chuẩn (Like, Comment, Share)."
                : "Chưa đủ 3 template. Hãy crop các icon còn thiếu."}
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
    </div>
  );
}
