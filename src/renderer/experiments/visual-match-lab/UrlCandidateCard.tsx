import React from "react";
import type {
  InspectableUrl,
  UrlVerificationInfo,
} from "./PermalinkInspector";

export function UrlCandidateCard({
  item,
  isSelected,
  verification,
  isCopied,
  isNavigating,
  isLiveRunning,
  onOpen,
  onCopy,
  onUseUrl,
}: {
  item: InspectableUrl;
  isSelected: boolean;
  verification: UrlVerificationInfo;
  isCopied: boolean;
  isNavigating: boolean;
  isLiveRunning?: boolean;
  onOpen: (item: InspectableUrl) => void;
  onCopy: (url: string) => void;
  onUseUrl: (item: InspectableUrl) => void;
}) {
  const postIdDisplay = item.identity
    ? `${item.identity.platform}:${item.identity.postId}`
    : "Chưa xác định";

  return (
    <div
      className={`url-candidate-card ${item.recognitionBadge.toLowerCase()} ${
        isSelected ? "selected" : ""
      }`}
      data-testid={`url-candidate-card-${item.index}`}
    >
      {/* Top Row: URL #N + Selected indicator + Recognition Badge */}
      <div className="url-card-header">
        <div className="url-card-header-left">
          <span className="url-card-index">URL #{item.index}</span>
          {isSelected && (
            <span className="url-card-selected-pill">Đang chọn</span>
          )}
        </div>
        <div className="url-card-badges">
          <span
            className={`url-badge recognition-${item.recognitionBadge.toLowerCase()}`}
          >
            {item.recognitionBadge}
          </span>
          <span
            className={`url-badge verification-${verification.status.toLowerCase()}`}
          >
            {verification.status}
          </span>
        </div>
      </div>

      {/* Classification Label */}
      <div className="url-card-classification">{item.classificationLabel}</div>

      {/* Compact 2-line max Short URL */}
      <div className="url-card-short-url" title={item. classificationLabel}>
        {item.shortUrl}
      </div>

      {/* Post ID & Verification Summary */}
      <div className="url-card-meta-grid">
        <div className="url-card-meta-row">
          <span className="url-card-meta-label">Post ID:</span>
          <span
            className={`url-card-meta-val ${
              item.identity ? "has-id" : "missing-id"
            }`}
          >
            {postIdDisplay}
          </span>
        </div>
        <div className="url-card-meta-row">
          <span className="url-card-meta-label">Verification:</span>
          <span
            className={`url-card-meta-val verify-text-${verification.status.toLowerCase()}`}
          >
            {verification.label}
          </span>
        </div>
      </div>

      {/* Actions: Open / Copy / Use URL */}
      <div className="url-card-actions">
        <button
          type="button"
          className="url-act-btn open-btn"
          onClick={() => onOpen(item)}
          disabled={isLiveRunning || isNavigating}
          title={
            isLiveRunning
              ? "Không thể điều hướng BrowserCore khi Live Scroll Test đang chạy"
              : "Mở và kiểm tra URL này trên BrowserCore"
          }
        >
          {isNavigating ? "⏳ Opening..." : "Open"}
        </button>
        <button
          type="button"
          className="url-act-btn copy-btn"
          onClick={() => onCopy(item.url)}
          title="Sao chép toàn bộ URL vào clipboard"
        >
          {isCopied ? "✔ Copied" : "Copy"}
        </button>
        <button
          type="button"
          className={`url-act-btn use-btn ${isSelected ? "active" : ""}`}
          onClick={() => onUseUrl(item)}
          title="Chọn URL này để kiểm tra và tạo rule trong Rule Editor"
        >
          {isSelected ? "✓ Selected" : "Use URL"}
        </button>
      </div>
    </div>
  );
}
