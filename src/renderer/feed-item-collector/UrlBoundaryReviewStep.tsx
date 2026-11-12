import React, { useState, useEffect } from "react";
import type { BoundaryProbeResult } from "../../shared/boundary-probe";
import type { BrowserCoreNavigationResult } from "../../shared/contracts";
import type { UserPermalinkRule } from "../../shared/permalink-rules";
import {
  extractInspectableUrls,
  deriveUrlVerificationStatus,
  validateNavigableUrl,
  type InspectableUrl,
} from "../experiments/visual-match-lab/PermalinkInspector";
import { CurrentItemUrlList } from "../experiments/visual-match-lab/CurrentItemUrlList";
import { UrlVerificationPanel } from "../experiments/visual-match-lab/UrlVerificationPanel";
import { PermalinkRuleEditor } from "../experiments/visual-match-lab/PermalinkRuleEditor";
import type { FrameReport, Invoke, LiveCandidate } from "./types";

export function UrlBoundaryReviewStep({
  reports,
  rules,
  currentRunId,
  selectedFrameIndex,
  selectedCandidateIndex,
  invoke,
  onSelectFrame,
  onSelectCandidate,
  onUpdateBoundary,
  onSaveRule,
  onPrevious,
}: {
  reports: FrameReport[];
  rules: UserPermalinkRule[];
  currentRunId: string | null;
  selectedFrameIndex: number;
  selectedCandidateIndex: number;
  invoke: Invoke;
  onSelectFrame: (idx: number) => void;
  onSelectCandidate: (idx: number) => void;
  onUpdateBoundary: (frameIndex: number, candIndex: number, newBoundary: BoundaryProbeResult, evidenceUrl?: string) => void;
  onSaveRule: (rule: UserPermalinkRule) => void;
  onPrevious: () => void;
}) {
  const currentReport = reports[selectedFrameIndex] ?? reports[0];
  const candidates = currentReport?.candidates ?? [];
  const activeCandidate = candidates[selectedCandidateIndex] ?? candidates[0];

  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [prefillUrl, setPrefillUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [navigatingUrl, setNavigatingUrl] = useState<string | null>(null);
  const [navResult, setNavResult] = useState<BrowserCoreNavigationResult | null>(null);
  const [navError, setNavError] = useState<string | null>(null);

  // Reset local URL inspection state when switching frame or candidate
  useEffect(() => {
    setSelectedUrl(null);
    setPrefillUrl(null);
    setNavResult(null);
    setNavError(null);
    setNavigatingUrl(null);
  }, [selectedFrameIndex, selectedCandidateIndex]);

  if (!currentReport) {
    return (
      <div className="fic-step-review">
        <div className="fic-alert fic-alert-warn">
          Chưa có dữ liệu Sample nào để review. Hãy hoàn thành Bước 2 (Auto Match) trước.
        </div>
        <button type="button" className="fic-btn fic-btn-primary" onClick={onPrevious}>
          ← Quay lại Bước 2
        </button>
      </div>
    );
  }

  const { currentItemUrls, inferredBaseUrl } = activeCandidate
    ? extractInspectableUrls(activeCandidate.boundary, rules)
    : { currentItemUrls: [], inferredBaseUrl: "https://www.facebook.com" };

  const selectedCandidateUrl =
    currentItemUrls.find((item) => item.url === selectedUrl) ?? null;

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 1500);
    } catch {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 1500);
    }
  };

  const handleOpenInBrowserCore = async (url: string) => {
    const check = validateNavigableUrl(url, inferredBaseUrl);
    if (!check.valid || !check.resolvedUrl) {
      setNavError(`Lỗi URL: ${check.reason}`);
      return;
    }
    const targetUrl = check.resolvedUrl;
    setNavigatingUrl(url);
    setNavError(null);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        invoke<BrowserCoreNavigationResult>({
          type: "visualMatchLabNavigateBrowserCore",
          url: targetUrl,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Quá thời gian chờ (16s) khi điều hướng BrowserCore.")),
            16_000,
          );
        }),
      ]);
      setNavResult(res);
      if (res.status === "FAILED" && res.error) {
        setNavError(res.error);
      }
    } catch (e) {
      setNavError(e instanceof Error ? e.message : String(e));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      setNavigatingUrl(null);
    }
  };

  const handleOpenCard = (item: InspectableUrl) => {
    setSelectedUrl(item.url);
    void handleOpenInBrowserCore(item.url);
  };

  const handleUseCardUrl = (item: InspectableUrl) => {
    setSelectedUrl(item.url);
    setPrefillUrl(item.url);
  };

  const selectedVerification = deriveUrlVerificationStatus(selectedCandidateUrl, navResult);

  return (
    <div className="fic-step-review">
      <div className="fic-section-header">
        <div>
          <h2>Bước 3: URL & Boundary Review</h2>
          <p className="fic-subtitle">
            Kiểm tra danh sách Current Item URLs, xác minh Post ID và cấu hình Permalink Rules cho các bài viết chưa
            xác nhận.
          </p>
        </div>
        <div className="fic-header-actions">
          <button type="button" className="fic-btn fic-btn-secondary" onClick={onPrevious}>
            ← Quay lại Bước 2 (Auto Match)
          </button>
        </div>
      </div>

      {/* Frame Selection Bar */}
      <div className="fic-frame-selector card">
        <span className="fic-selector-label">Chọn Sample (1-5):</span>
        <div className="fic-frame-buttons">
          {reports.map((rep, idx) => {
            const isSelected = idx === selectedFrameIndex;
            return (
              <button
                key={rep.frame}
                type="button"
                className={`fic-frame-tab ${isSelected ? "active" : ""}`}
                onClick={() => {
                  onSelectFrame(idx);
                  onSelectCandidate(0);
                }}
              >
                <span className="fic-frame-tab-title">Sample #{rep.frame}</span>
                <span className={`fic-dot dot-${rep.boundaryStatus.toLowerCase()}`} />
                <small className="fic-frame-tab-status">{rep.boundaryStatus}</small>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Review Workspace */}
      <div className="fic-review-layout">
        {/* Left Column: Evidence Screenshot + Candidate Switcher */}
        <div className="fic-review-left card">
          <div className="fic-review-card-header">
            <h4>
              Evidence Sample #{currentReport.frame} &middot;{" "}
              <span className={`fic-badge badge-${currentReport.boundaryStatus.toLowerCase()}`}>
                {currentReport.boundaryStatus}
              </span>
            </h4>
            <small>scrollY={currentReport.capture.viewport.scrollY}</small>
          </div>

          {/* Candidate selector chips */}
          {candidates.length > 0 ? (
            <div className="fic-candidate-chips">
              <span className="fic-chip-label">Action Row Candidates:</span>
              {candidates.map((cand, cIdx) => (
                <button
                  key={cIdx}
                  type="button"
                  className={`fic-chip ${cIdx === selectedCandidateIndex ? "active" : ""}`}
                  onClick={() => onSelectCandidate(cIdx)}
                >
                  Candidate #{cIdx + 1} ({Math.round(cand.score * 100)}% &middot; {cand.status})
                </button>
              ))}
            </div>
          ) : (
            <div className="fic-empty-msg">Không phát hiện candidate Action Row trong sample này.</div>
          )}

          {/* Screenshot with overlay */}
          <div className="fic-screenshot-viewer">
            <img
              src={
                activeCandidate?.highlightedEvidenceUrl ||
                currentReport.capture.dataUrl
              }
              alt={`Evidence sample ${currentReport.frame}`}
              className="fic-review-image"
            />
          </div>

          {/* Active Candidate Details */}
          {activeCandidate && (
            <div className="fic-candidate-meta-box">
              <div className="fic-meta-row">
                <b>Candidate Status:</b>
                <span className={`fic-badge badge-${activeCandidate.status.toLowerCase()}`}>
                  {activeCandidate.status}
                </span>
              </div>
              <div className="fic-meta-row">
                <b>Boundary Result:</b>
                <span>
                  {activeCandidate.boundary
                    ? `${activeCandidate.boundary.status} (${activeCandidate.boundary.ancestorsChecked} ancestors probe)`
                    : "Chưa probe"}
                </span>
              </div>
              {activeCandidate.boundary?.riskReason && (
                <div className="fic-meta-row fic-risk-note">
                  <b>Chú ý rủi ro:</b> <span>{activeCandidate.boundary.riskReason}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Reused CurrentItemUrlList, UrlVerificationPanel, PermalinkRuleEditor */}
        <div className="fic-review-right">
          {activeCandidate ? (
            <div className="fic-inspector-container">
              {/* 1. Current Item URLs (Feed / Neighbor URLs hidden) */}
              <CurrentItemUrlList
                urls={currentItemUrls}
                selectedUrl={selectedUrl}
                getVerification={(item) => deriveUrlVerificationStatus(item, navResult)}
                copiedUrl={copiedUrl}
                navigatingUrl={navigatingUrl}
                onOpen={handleOpenCard}
                onCopy={(u) => void handleCopy(u)}
                onUseUrl={handleUseCardUrl}
              />

              {/* 2. URL Verification Panel */}
              <UrlVerificationPanel
                selectedCandidate={selectedCandidateUrl}
                verification={selectedVerification}
                navResult={navResult}
                navError={navError}
                isNavigating={Boolean(navigatingUrl)}
                onOpenInBrowserCore={(u) => void handleOpenInBrowserCore(u)}
                onCloseInspection={() => setNavResult(null)}
                onDismissError={() => setNavError(null)}
              />

              {/* 3. Permalink Rule Editor */}
              <PermalinkRuleEditor
                frameNumber={currentReport.frame}
                candidateIndex={selectedCandidateIndex}
                candidate={activeCandidate}
                capture={currentReport.capture}
                rules={rules}
                onRuleSaved={onSaveRule}
                onUpdateBoundary={(newBoundary, evidenceUrl) => {
                  onUpdateBoundary(
                    selectedFrameIndex,
                    selectedCandidateIndex,
                    newBoundary,
                    evidenceUrl,
                  );
                }}
                prefillUrl={prefillUrl}
                invoke={invoke}
              />
            </div>
          ) : (
            <div className="fic-empty-placeholder card">
              <p>Sample này không có Action Row để kiểm tra URL hoặc Boundary.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
