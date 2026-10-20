import React, { useState } from "react";
import type { Payload } from "../shared/contracts";
import { matchToLabel, effectiveMatchTo } from "../shared/match-to";
import { UiPopover } from "./ui-popover";

export function TargetModal({
  name,
  target,
  image,
  confirmed,
  ocrControls,
  matchControls,
  locked,
  canCapture,
  crop,
  close,
}: {
  name: string;
  target: Payload["target"];
  image: string;
  confirmed: React.ReactNode;
  ocrControls: React.ReactNode;
  matchControls: React.ReactNode;
  locked: boolean;
  canCapture: boolean;
  crop: () => void;
  close: () => void;
}) {
  const [section, setSection] = useState<"image" | "ocr" | "match">("image");
  const box = target?.ocr?.bbox;
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
              {section === "ocr" && box && (
                <span
                  className="target-ocr-box"
                  aria-hidden="true"
                  style={{
                    left: `${(box.x / target.roi.width) * 100}%`,
                    top: `${(box.y / target.roi.height) * 100}%`,
                    width: `${(box.width / target.roi.width) * 100}%`,
                    height: `${(box.height / target.roi.height) * 100}%`,
                  }}
                />
              )}
            </div>
          ) : (
            <div className="target-empty">
              Chụp và crop để chọn target cho step này.
            </div>
          )}
          <figcaption>
            {section === "image"
              ? "Ảnh crop đang chọn"
              : section === "ocr"
                ? "Chữ nhận diện · khung xanh là bbox đã lưu"
                : `Phạm vi tìm: ${matchToLabel(effectiveMatchTo({ target }))}`}
          </figcaption>
        </figure>
        <div className="target-confirmed">{confirmed}</div>
        <div className="target-settings">
          <nav aria-label="Cấu hình target">
            {(
              [
                ["image", "Ảnh crop"],
                ["ocr", "OCR text"],
                ["match", "Match To"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-pressed={section === id}
                onClick={() => setSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <section
            className="target-settings-content"
            aria-label={
              section === "image"
                ? "Ảnh crop"
                : section === "ocr"
                  ? "OCR text"
                  : "Match To"
            }
          >
            {section === "image" ? (
              <>
                <button disabled={locked || !canCapture} onClick={crop}>
                  {target ? "Chụp & crop lại" : "Chụp & crop ROI"}
                </button>
                {!canCapture && (
                  <p className="hint">Tạo hoặc chọn flow trước khi chụp.</p>
                )}
                {target && (
                  <details>
                    <summary>Thông số ảnh</summary>
                    <p className="hint">
                      {target.roi.width}×{target.roi.height} · ROI x
                      {target.roi.x}, y{target.roi.y}
                      {target.environment && (
                        <>
                          {" "}
                          · Viewport {target.environment.width}×
                          {target.environment.height} · Zoom{" "}
                          {target.environment.zoom * 100}%
                        </>
                      )}
                    </p>
                  </details>
                )}
              </>
            ) : section === "ocr" ? (
              target ? (
                ocrControls
              ) : (
                <p className="hint">Crop target trước khi đọc OCR.</p>
              )
            ) : (
              matchControls || (
                <p className="hint">
                  Crop target trước khi cấu hình phạm vi tìm.
                </p>
              )
            )}
          </section>
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
