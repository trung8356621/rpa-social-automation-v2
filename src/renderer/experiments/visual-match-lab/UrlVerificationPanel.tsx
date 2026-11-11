import React from "react";
import type { BrowserCoreNavigationResult } from "../../../shared/contracts";
import {
  stripFacebookTrackingParams,
  type InspectableUrl,
  type UrlVerificationInfo,
} from "./PermalinkInspector";

export function UrlVerificationPanel({
  selectedCandidate,
  verification,
  navResult,
  navError,
  isNavigating,
  isLiveRunning,
  onOpenInBrowserCore,
  onCloseInspection,
  onDismissError,
}: {
  selectedCandidate: InspectableUrl | null;
  verification: UrlVerificationInfo;
  navResult: BrowserCoreNavigationResult | null;
  navError: string | null;
  isNavigating: boolean;
  isLiveRunning?: boolean;
  onOpenInBrowserCore: (url: string) => void;
  onCloseInspection: () => void;
  onDismissError: () => void;
}) {
  return (
    <section className="url-inspector-block url-verification-panel">
      <div className="url-block-header">
        <h5 className="section-subtitle">2. URL Verification</h5>
        <span
          className={`url-badge verification-${verification.status.toLowerCase()}`}
        >
          {verification.status}
        </span>
      </div>

      {navError && (
        <div className="browsercore-nav-error">
          <span>⚠ {navError}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Đóng thông báo lỗi"
          >
            ✕
          </button>
        </div>
      )}

      {!selectedCandidate ? (
        <div className="verification-empty-msg">
          Chưa chọn URL candidate. Nhấn <b>Use URL</b> hoặc <b>Open</b> trên một
          card ở trên để kiểm tra.
        </div>
      ) : (
        <div className="verification-candidate-summary">
          <div className="verification-row-top">
            <span className="verification-cand-title">
              URL #{selectedCandidate.index} &middot;{" "}
              {selectedCandidate.classificationLabel}
            </span>
            <span
              className={`url-badge recognition-${selectedCandidate.recognitionBadge.toLowerCase()}`}
            >
              {selectedCandidate.recognitionBadge}
            </span>
          </div>

          <div className="verification-short-url">
            {selectedCandidate.shortUrl}
          </div>

          <div className="verification-status-box">
            <div className="verification-kv">
              <span className="verification-k">Post ID:</span>
              <span className="verification-v">
                {selectedCandidate.identity
                  ? `${selectedCandidate.identity.platform}:${selectedCandidate.identity.postId}`
                  : "Chưa xác định"}
              </span>
            </div>
            <div className="verification-kv">
              <span className="verification-k">Trạng thái:</span>
              <span
                className={`verification-v verify-text-${verification.status.toLowerCase()}`}
              >
                {verification.label}
              </span>
            </div>
            {verification.reason && (
              <div className="verification-reason">{verification.reason}</div>
            )}
          </div>

          {navResult && (
            <div className="verification-live-box">
              <div className="verification-live-header">
                <span>
                  🌐 BrowserCore #{navResult.webContentsId} &middot;{" "}
                  {navResult.status === "SUCCESS"
                    ? "✔ Đúng đích"
                    : navResult.status === "REDIRECTED"
                      ? "⚠ Đã bị Redirect"
                      : "✖ Lỗi điều hướng"}
                </span>
                <button
                  type="button"
                  className="nav-modal-close-btn"
                  onClick={onCloseInspection}
                  title="Quay lại Frame Screenshot"
                >
                  ← Quay lại Frame
                </button>
              </div>

              {navResult.redirected && (
                <div className="verification-redirect-alert">
                  <div>
                    <b>⚠ Redirect:</b> {navResult.redirectReason}
                  </div>
                  {navResult.requestedUrl.includes("__cft__") && (
                    <button
                      type="button"
                      className="url-act-btn open-btn"
                      style={{ marginTop: 6 }}
                      disabled={isLiveRunning || isNavigating}
                      onClick={() =>
                        onOpenInBrowserCore(
                          stripFacebookTrackingParams(navResult.requestedUrl),
                        )
                      }
                    >
                      🔄 Thử mở URL sạch (bỏ __cft__/__tn__)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="verification-actions">
            <button
              type="button"
              className="url-act-btn open-btn"
              disabled={isLiveRunning || isNavigating}
              onClick={() => onOpenInBrowserCore(selectedCandidate.url)}
            >
              {isNavigating
                ? "⏳ Đang kiểm tra trên BrowserCore..."
                : "🌐 Kiểm tra trên BrowserCore"}
            </button>
            {navResult && (
              <button
                type="button"
                className="url-act-btn copy-btn"
                onClick={onCloseInspection}
              >
                ← Đóng chế độ xem BrowserCore
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
