import React from "react";
import type { Payload } from "../shared/contracts";
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
            </div>
          ) : (
            <div className="target-empty">
              Chụp và crop để chọn target cho step này.
            </div>
          )}
          <figcaption>{quickTagRows !== undefined ? "QUICK_TAG · chấm đỏ là tâm hàng đầu. Chọn theo vị trí, không xác minh danh tính." : "Ảnh crop đang chọn"}</figcaption>
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
