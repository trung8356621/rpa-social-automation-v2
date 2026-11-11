import React, { useState, useEffect } from "react";
import type { LiveCapture } from "./types";
import type { LiveCandidate } from "./LiveScrollTest";

export function FrameScreenshot({
  capture,
  highlightedEvidenceUrl,
  candidates,
  selectedCandidateIndex,
  onSelectCandidate,
  frameNumber,
  runId,
  evidenceSavedPath,
}: {
  capture: LiveCapture | null;
  highlightedEvidenceUrl?: string;
  candidates: LiveCandidate[];
  selectedCandidateIndex: number;
  onSelectCandidate: (index: number) => void;
  frameNumber: number;
  runId: string;
  evidenceSavedPath?: string;
}) {
  const [viewMode, setViewMode] = useState<"highlighted" | "original">("highlighted");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Reset zoom and image load state on frame, run, or mode change
  useEffect(() => {
    setZoomLevel(1);
    setImageLoaded(false);
    setImageError(false);
  }, [frameNumber, runId, viewMode]);

  const hasHighlighted = Boolean(highlightedEvidenceUrl);
  const hasOriginal = Boolean(capture?.dataUrl);

  // Selected image source based on mode and availability
  const activeImageSrc =
    viewMode === "highlighted"
      ? (highlightedEvidenceUrl || capture?.dataUrl || "")
      : (capture?.dataUrl || highlightedEvidenceUrl || "");

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 0.25, 0.5));
  const handleResetZoom = () => setZoomLevel(1);

  const selectedCandidate = candidates[selectedCandidateIndex] ?? candidates[0];
  const containerRect = selectedCandidate?.boundary?.candidateContainer?.rect;
  const viewportW = capture?.viewport?.width || 1024;
  const viewportH = capture?.viewport?.height || 560;
  const captureW = capture?.width || 1024;
  const captureH = capture?.height || 560;

  const expectedImagePath =
    evidenceSavedPath || `scratch/boundary-evidence-f${frameNumber}-r0.png`;

  // The highlighted evidence PNG already has the DOM-probe annotations baked into
  // its pixels. Drawing React bboxes on it duplicates annotations, and for saved runs
  // capture.dataUrl IS that same highlighted PNG. Only overlay on a raw capture.
  const imageIsAnnotated = Boolean(highlightedEvidenceUrl) && activeImageSrc === highlightedEvidenceUrl;
  const showOverlays = imageLoaded && !imageError && Boolean(activeImageSrc) && !imageIsAnnotated;

  return (
    <div className="frame-screenshot-wrapper">
      {/* 1. Viewer Toolbar - Always outside viewport, unclipped, structured */}
      <div className="screenshot-toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">View:</span>
          <button
            type="button"
            className={`toolbar-btn ${viewMode === "highlighted" ? "active" : ""}`}
            onClick={() => setViewMode("highlighted")}
            disabled={!hasHighlighted && !hasOriginal}
            title={hasHighlighted ? "Hiển thị ảnh bằng chứng DOM highlight đã lưu" : "Chưa có ảnh highlighted"}
          >
            Highlighted {hasHighlighted ? "✔" : "(N/A)"}
          </button>
          <button
            type="button"
            className={`toolbar-btn ${viewMode === "original" ? "active" : ""}`}
            onClick={() => setViewMode("original")}
            disabled={!hasOriginal && !hasHighlighted}
            title="Hiển thị ảnh gốc nguyên bản kèm vector boundary overlays"
          >
            Original {hasOriginal ? "" : "(N/A)"}
          </button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Zoom:</span>
          <button type="button" className="toolbar-btn" onClick={handleZoomOut} title="Zoom Out" disabled={zoomLevel <= 0.5}>
            -
          </button>
          <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
          <button type="button" className="toolbar-btn" onClick={handleZoomIn} title="Zoom In" disabled={zoomLevel >= 3}>
            +
          </button>
          <button type="button" className="toolbar-btn" onClick={handleResetZoom} title="Reset to Fit">
            Reset
          </button>
        </div>

        <div className="toolbar-group metadata">
          <span>{captureW}×{captureH} (viewport: {viewportW}×{viewportH})</span>
        </div>
      </div>

      {/* 2. Notice banner when highlighted is missing */}
      {viewMode === "highlighted" && !hasHighlighted && hasOriginal && (
        <div className="screenshot-notice">
          ℹ Không có ảnh highlight DOM cho frame này. Đang hiển thị ảnh gốc capture.
        </div>
      )}

      {viewMode === "original" && imageIsAnnotated && (
        <div className="screenshot-notice">
          ℹ Run đã lưu không có ảnh gốc (chỉ lưu ảnh highlighted). Không vẽ thêm overlay để tránh trùng annotation.
        </div>
      )}

      {/* 3. Error banner when image fails or is missing on disk - Do not draw bbox on black box */}
      {(!activeImageSrc || imageError) && (
        <div className="screenshot-missing-error">
          <div className="error-title">
            ⚠ Không thể hiển thị ảnh bằng chứng cho Frame #{frameNumber} (Run: {runId})
          </div>
          <div className="error-desc">
            Không tìm thấy file ảnh hoặc ảnh bị lỗi khi đọc từ đĩa. Bounding box overlay tạm thời bị ẩn để tránh hiển thị sai lệch.
          </div>
          <div className="error-path">
            Đường dẫn cần kiểm tra: <code>{expectedImagePath}</code>
          </div>
        </div>
      )}

      {/* 4. Viewport Area with Unified Layout Stage */}
      {activeImageSrc && !imageError && (
        <div
          className="screenshot-viewport"
          style={{
            overflow: zoomLevel > 1 ? "auto" : "hidden",
            position: "relative",
            width: "100%",
            maxHeight: 600,
          }}
        >
          <div
            className="screenshot-stage-outer"
            style={{
              width: zoomLevel > 1 ? `${zoomLevel * 100}%` : "100%",
              minWidth: "100%",
              display: "inline-block",
              position: "relative",
            }}
          >
            <div
              className="screenshot-canvas-area"
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "1024 / 560",
                display: "block",
              }}
            >
              <img
                key={`${runId}_f${frameNumber}_${viewMode}`}
                src={activeImageSrc}
                alt={`Frame ${frameNumber} evidence`}
                className="screenshot-img"
                onLoad={() => {
                  setImageLoaded(true);
                  setImageError(false);
                }}
                onError={() => {
                  setImageLoaded(false);
                  setImageError(true);
                }}
                style={{ width: "100%", height: "100%", display: "block" }}
              />

              {/* ONLY draw container boundary overlay if image has successfully loaded and in original view */}
              {showOverlays && containerRect && (
                <div
                  key={`${runId}_f${frameNumber}_container`}
                  className="overlay-container-box"
                  style={{
                    position: "absolute",
                    left: `${(containerRect.x / viewportW) * 100}%`,
                    top: `${(containerRect.y / viewportH) * 100}%`,
                    width: `${(containerRect.width / viewportW) * 100}%`,
                    height: `${(containerRect.height / viewportH) * 100}%`,
                    border: "2px dashed #22c55e",
                    background: "rgba(34, 197, 94, 0.08)",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    zIndex: 5,
                  }}
                  title={`Candidate Container: ${Math.round(containerRect.width)}×${Math.round(containerRect.height)}`}
                />
              )}

              {/* ONLY draw action-row candidate bboxes if image has successfully loaded */}
              {showOverlays && candidates.map((cand, idx) => {
                const isSelected = idx === selectedCandidateIndex;
                const leftPct = (cand.bbox.x / captureW) * 100;
                const topPct = (cand.bbox.y / captureH) * 100;
                const widthPct = (cand.bbox.width / captureW) * 100;
                const heightPct = (cand.bbox.height / captureH) * 100;

                const borderColor =
                  cand.status === "NEW_ITEM"
                    ? "#22c55e"
                    : cand.status === "DUPLICATE"
                      ? "#38bdf8"
                      : cand.status === "COMMENT_ACTION"
                        ? "#c084fc"
                        : "#f59e0b";

                const isNearTop = cand.bbox.y < 24;
                const boxBorder = `${isSelected ? "3px" : "2px"} solid ${borderColor}`;
                const boxBg = isSelected ? "rgba(56, 189, 248, 0.25)" : "rgba(245, 158, 11, 0.1)";

                return (
                  <div
                    key={`${runId}_f${frameNumber}_r${idx}`}
                    className={`overlay-action-row ${isSelected ? "selected" : ""}`}
                    onClick={() => onSelectCandidate(idx)}
                    style={{
                      position: "absolute",
                      left: `${leftPct}%`,
                      top: `${topPct}%`,
                      width: `${widthPct}%`,
                      height: `${heightPct}%`,
                      border: boxBorder,
                      background: boxBg,
                      cursor: "pointer",
                      boxSizing: "border-box",
                      zIndex: isSelected ? 10 : 8,
                    }}
                    title={`Row ${idx + 1}: ${cand.status} (score: ${(cand.score * 100).toFixed(1)}%) - Click to inspect`}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: isNearTop ? "2px" : "-18px",
                        left: "0",
                        background: borderColor,
                        color: "#0f172a",
                        fontSize: "10px",
                        fontWeight: "bold",
                        padding: "1px 4px",
                        borderRadius: "2px",
                        whiteSpace: "nowrap",
                        zIndex: 12,
                      }}
                    >
                      Row {idx + 1}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
