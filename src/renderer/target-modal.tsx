import React from "react";
import type { Payload } from "../shared/contracts";
import { predictedClickInAsset } from "../shared/click-anchor";
import { UiPopover } from "./ui-popover";

export function TargetModal({
  name,
  target,
  image,
  confirmed,
  ocrControls,
  locked,
  canCapture,
  crop,
  close,
  quickTagRows,
}: {
  name: string;
  target: Payload["target"];
  image: string;
  confirmed: React.ReactNode;
  ocrControls: React.ReactNode;
  locked: boolean;
  canCapture: boolean;
  crop: () => void;
  close: () => void;
  quickTagRows?: number;
}) {
  const predicted = target ? predictedClickInAsset(target) : undefined;
  return (
    <UiPopover
      variant="modal"
      label="Cấu hình target"
      close={close}
      className="target-modal"
    >
      <div className="target-modal-heading">
        <div>
          <small>Target · {name || "Step mới"}</small>
          <h2>{target?.ocr?.text || "Ảnh target"}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Đóng target"
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="target-modal-body">
        <figure className="target-hero">
          {image && target ? (
            <div
              className="target-image-frame"
              style={{
                width: Math.min(900, Math.max(280, target.roi.width * 1.5)),
                aspectRatio: `${target.roi.width} / ${target.roi.height}`,
              }}
            >
              <img src={image} alt="Ảnh crop của target đang chỉnh sửa" />
              {quickTagRows !== undefined && Number.isInteger(quickTagRows) && quickTagRows >= 1 && quickTagRows <= 20 && <span
                aria-label="Tọa độ click QUICK_TAG"
                title={`Click (${(target.roi.x + target.roi.width / 2).toFixed(1)}, ${(target.roi.y + target.roi.height / quickTagRows / 2).toFixed(1)}) DIP`}
                style={{ position: "absolute", left: "50%", top: `${50 / quickTagRows}%`, width: 12, height: 12,
                  borderRadius: "50%", background: "#ef4444", border: "2px solid white", transform: "translate(-50%, -50%)", pointerEvents: "none" }} />}
              {quickTagRows === undefined && predicted && (
                <>
                  <span
                    className="target-click-marker image"
                    aria-label="Điểm click ảnh (tâm ROI)"
                    title={`Ảnh · tâm ROI (${predicted.imageCenter.x.toFixed(0)}, ${predicted.imageCenter.y.toFixed(0)})`}
                    style={{
                      left: `${(predicted.imageCenter.x / target.roi.width) * 100}%`,
                      top: `${(predicted.imageCenter.y / target.roi.height) * 100}%`,
                    }}
                  />
                  {predicted.ocrCenter && (
                    <span
                      className="target-click-marker ocr"
                      aria-label="Tâm chữ OCR"
                      title={`OCR · tâm nhãn (${predicted.ocrCenter.x.toFixed(0)}, ${predicted.ocrCenter.y.toFixed(0)})`}
                      style={{
                        left: `${(predicted.ocrCenter.x / target.roi.width) * 100}%`,
                        top: `${(predicted.ocrCenter.y / target.roi.height) * 100}%`,
                      }}
                    />
                  )}
                  {target.ocr?.confirmed && (
                    <span
                      className="target-click-marker click"
                      aria-label="Điểm click dự kiến khi dùng OCR"
                      title={`Click OCR path (${predicted.clickPoint.x.toFixed(0)}, ${predicted.clickPoint.y.toFixed(0)}) · ${predicted.via}`}
                      style={{
                        left: `${(predicted.clickPoint.x / target.roi.width) * 100}%`,
                        top: `${(predicted.clickPoint.y / target.roi.height) * 100}%`,
                      }}
                    />
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="target-empty">
              Chụp và crop để chọn target cho step này.
            </div>
          )}
          <figcaption>
            {quickTagRows !== undefined
              ? "QUICK_TAG · chấm đỏ là tâm hàng đầu. Chọn theo vị trí, không xác minh danh tính."
              : predicted?.ocrCenter
                ? "Xanh dương = tâm ảnh · Vàng = tâm OCR · Đỏ = click OCR (+ offset nếu có). AUTO ưu tiên ảnh khi khớp duy nhất."
                : "Ảnh crop đang chọn · chấm xanh = tâm ROI (click ảnh)"}
          </figcaption>
        </figure>
        <div className="target-confirmed">{confirmed}</div>
        <div className="target-ocr-controls">{target && ocrControls}</div>
        <div className="target-crop-controls">
          <button disabled={locked || !canCapture} onClick={crop}>
            {target ? "Chụp & crop lại" : "Chụp & crop ROI"}
          </button>
          {!canCapture && <p className="hint">Tạo hoặc chọn flow trước khi chụp.</p>}
        </div>
      </div>
      <div className="target-modal-footer">
        <span>Thay đổi áp dụng khi lưu step.</span>
        <button className="primary" onClick={close}>
          Xong
        </button>
      </div>
    </UiPopover>
  );
}
