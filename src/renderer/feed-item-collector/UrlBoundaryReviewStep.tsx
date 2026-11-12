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
import { computeFrameCandidateCounts } from "./scroll-sampling";
import {
  validatePostUrlForConfirmation,
  reevaluateCandidateBoundaryOffline,
  type ReevaluateResult,
} from "./boundary-reevaluation";
import { CurrentItemUrlList } from "../experiments/visual-match-lab/CurrentItemUrlList";
import { UrlVerificationPanel } from "../experiments/visual-match-lab/UrlVerificationPanel";
import { PermalinkRuleEditor } from "../experiments/visual-match-lab/PermalinkRuleEditor";
import type { FrameReport, Invoke, LiveCandidate } from "./types";
import type {
  PermalinkDiagnosticSnapshot,
  PermalinkHoverObservation,
} from "../../shared/permalink-diagnostic";

type PermalinkDiagnosticResult = {
  savedPath: string;
  hoverEnabled: boolean;
  before: PermalinkDiagnosticSnapshot;
  hoverObservations: PermalinkHoverObservation[];
};

export function UrlBoundaryReviewStep({
  reports,
  rules,
  currentRunId,
  selectedFrameIndex,
  selectedCandidateIndex,
  invoke,
  onSelectFrame,
  onSelectCandidate,
  onUpdateCandidate,
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
  onUpdateCandidate?: (frameIndex: number, candIndex: number, updatedCandidate: LiveCandidate) => void;
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
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [latestReeval, setLatestReeval] = useState<ReevaluateResult | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagHover, setDiagHover] = useState(false);
  const [diagResult, setDiagResult] = useState<PermalinkDiagnosticResult | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  // Reset local URL inspection state when switching frame or candidate
  useEffect(() => {
    setSelectedUrl(null);
    setPrefillUrl(null);
    setNavResult(null);
    setNavError(null);
    setNavigatingUrl(null);
    setConfirmError(null);
    setLatestReeval(null);
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
      // NAVIGATION_SUCCESS does NOT automatically change boundary or candidate status
      if (res.status === "SUCCESS" && activeCandidate) {
        const types = new Set(activeCandidate.verificationTypes ?? []);
        types.add("NAVIGATION_SUCCESS");
        onUpdateCandidate?.(selectedFrameIndex, selectedCandidateIndex, {
          ...activeCandidate,
          verificationTypes: Array.from(types),
        });
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

  const handleConfirmPostUrl = (urlToConfirm: string) => {
    if (!activeCandidate) return;
    setConfirmError(null);

    const validation = validatePostUrlForConfirmation(urlToConfirm, rules, inferredBaseUrl);
    if (!validation.valid) {
      setConfirmError(validation.reason || "URL không thể xác nhận làm Post URL.");
      return;
    }

    const res = reevaluateCandidateBoundaryOffline({
      candidate: activeCandidate,
      rules,
      confirmedUrl: urlToConfirm,
      source: "USER_CONFIRMATION",
      basePageUrl: inferredBaseUrl,
    });

    if (!res.success) {
      setConfirmError(`Lỗi đánh giá lại boundary: ${res.reason}`);
      return;
    }

    setLatestReeval(res);
    if (onUpdateCandidate) {
      onUpdateCandidate(selectedFrameIndex, selectedCandidateIndex, res.updatedCandidate);
    } else {
      onUpdateBoundary(selectedFrameIndex, selectedCandidateIndex, res.updatedCandidate.boundary!);
    }
  };

  const handleRuleSavedAndReevaluate = (newRule: UserPermalinkRule) => {
    onSaveRule(newRule);
    const updatedRules = [newRule, ...rules.filter((r) => r.id !== newRule.id)];
    if (activeCandidate) {
      const res = reevaluateCandidateBoundaryOffline({
        candidate: activeCandidate,
        rules: updatedRules,
        confirmedUrl: activeCandidate.confirmedUrl || selectedUrl || undefined,
        source: "RULE_SAVED",
        ruleId: newRule.id,
        basePageUrl: inferredBaseUrl,
      });
      if (res.success) {
        setLatestReeval(res);
        if (onUpdateCandidate) {
          onUpdateCandidate(selectedFrameIndex, selectedCandidateIndex, res.updatedCandidate);
        } else {
          onUpdateBoundary(selectedFrameIndex, selectedCandidateIndex, res.updatedCandidate.boundary!);
        }
      }
    }
  };

  const selectedVerification = deriveUrlVerificationStatus(selectedCandidateUrl, navResult);

  const handleRunDiagnostic = async () => {
    setDiagRunning(true);
    setDiagError(null);
    try {
      const res = await invoke<PermalinkDiagnosticResult>({
        type: "feedItemPermalinkDiagnostic",
        hover: diagHover,
        runId: currentRunId ?? undefined,
        candidateId: activeCandidate?.candidateId,
      });
      setDiagResult(res);
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagRunning(false);
    }
  };

  const isNavSuccess =
    activeCandidate?.verificationTypes?.includes("NAVIGATION_SUCCESS") ||
    navResult?.status === "SUCCESS";
  const isUrlVerified =
    activeCandidate?.verificationTypes?.includes("URL_VERIFIED") ||
    Boolean(activeCandidate?.confirmedUrl);
  const isBoundaryConfirmed = activeCandidate?.boundaryStatus === "BOUNDARY_FOUND";

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
            const counts = computeFrameCandidateCounts(rep.candidates);
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
                <small className="fic-frame-tab-status">
                  {counts.found} FOUND &middot; {counts.needsAttention} ATTN &middot; {counts.duplicate} DUP
                </small>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Review Workspace */}
      <div className="fic-review-layout">
        {/* Left Column: Evidence Screenshot + Candidate Switcher */}
        <div className="fic-review-left card">
          {(() => {
            const counts = computeFrameCandidateCounts(candidates);
            return (
              <div className="fic-review-card-header">
                <h4>
                  Evidence Sample #{currentReport.frame} &middot;{" "}
                  <span className={`fic-badge badge-${currentReport.boundaryStatus.toLowerCase()}`}>
                    {counts.found} FOUND &middot; {counts.needsAttention} NEEDS_ATTENTION &middot; {counts.duplicate} DUPLICATE
                  </span>
                </h4>
                <small>scrollY={currentReport.capture.viewport.scrollY}</small>
              </div>
            );
          })()}

          {/* Candidate selector chips */}
          {candidates.length > 0 ? (
            <div className="fic-candidate-chips">
              <span className="fic-chip-label">Action Row Candidates:</span>
              {candidates.map((cand, cIdx) => {
                const displayStatus =
                  cand.dedupeStatus === "DUPLICATE" || cand.status === "DUPLICATE"
                    ? "DUPLICATE"
                    : cand.boundaryStatus === "BOUNDARY_FOUND"
                      ? "FOUND"
                      : "NEEDS_ATTENTION";
                return (
                  <button
                    key={cand.candidateId || cIdx}
                    type="button"
                    className={`fic-chip ${cIdx === selectedCandidateIndex ? "active" : ""}`}
                    onClick={() => onSelectCandidate(cIdx)}
                  >
                    Candidate #{cIdx + 1} ({Math.round(cand.matchScore * 100)}% &middot; {displayStatus})
                  </button>
                );
              })}
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
          {activeCandidate && (() => {
            const displayStatus =
              activeCandidate.dedupeStatus === "DUPLICATE" || activeCandidate.status === "DUPLICATE"
                ? "DUPLICATE"
                : activeCandidate.boundaryStatus === "BOUNDARY_FOUND"
                  ? "FOUND"
                  : "NEEDS_ATTENTION";
            return (
              <div className="fic-candidate-meta-box">
                <div className="fic-meta-row">
                  <b>Candidate ID:</b>
                  <code style={{ fontSize: 11 }}>{activeCandidate.candidateId}</code>
                </div>
                <div className="fic-meta-row">
                  <b>Candidate Status:</b>
                  <span className={`fic-badge badge-${displayStatus.toLowerCase()}`}>
                    {displayStatus}
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
                <div className="fic-meta-row">
                  <b>Dedupe Status:</b>
                  <span>
                    {activeCandidate.dedupeStatus}
                    {activeCandidate.dedupeReason ? ` (${activeCandidate.dedupeReason})` : ""}
                  </span>
                </div>
                <div className="fic-meta-row">
                  <b>Post Identity:</b>
                  <span>
                    {activeCandidate.postIdentity?.postId
                      ? `${activeCandidate.postIdentity.platform}:${activeCandidate.postIdentity.postId}`
                      : "Chưa có Post ID"}
                  </span>
                </div>
                {activeCandidate.evidenceRef && (
                  <div className="fic-meta-row">
                    <b>Evidence Ref:</b>
                    <small>{activeCandidate.evidenceRef}</small>
                  </div>
                )}
                {displayStatus === "NEEDS_ATTENTION" && (
                  <div className="fic-meta-row fic-risk-note">
                    <b>Lý do cần chú ý:</b>{" "}
                    <span>
                      {activeCandidate.boundary?.riskReason ||
                        "Chưa đủ bằng chứng xác thực permalink bài viết trong candidate container"}
                    </span>
                  </div>
                )}
              </div>
            );
          })()}
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

              {/* 2b. User Confirmation & Offline Boundary Re-evaluation */}
              <div className="fic-confirmation-card card">
                <div className="fic-confirm-header">
                  <h5>2b. Xác nhận URL & Đánh giá lại Boundary</h5>
                  <span className="fic-offline-badge">⚡ Offline Re-evaluation</span>
                </div>

                {/* 3-Tier Verification Status */}
                <div className="fic-verification-trio">
                  <div className={`fic-trio-item ${isNavSuccess ? "active" : ""}`}>
                    <span className="fic-trio-dot" />
                    <span className="fic-trio-label">1. NAVIGATION_SUCCESS</span>
                    <small>{isNavSuccess ? "Đã mở thành công" : "Chưa kiểm tra"}</small>
                  </div>
                  <div className={`fic-trio-item ${isUrlVerified ? "active" : ""}`}>
                    <span className="fic-trio-dot" />
                    <span className="fic-trio-label">2. URL_VERIFIED</span>
                    <small>{isUrlVerified ? "Đã xác nhận đúng bài" : "Chưa xác nhận"}</small>
                  </div>
                  <div className={`fic-trio-item ${isBoundaryConfirmed ? "active" : ""}`}>
                    <span className="fic-trio-dot" />
                    <span className="fic-trio-label">3. BOUNDARY_CONFIRMED</span>
                    <small>
                      {isBoundaryConfirmed
                        ? "Container chuẩn xác"
                        : activeCandidate?.boundaryStatus === "BOUNDARY_AMBIGUOUS"
                          ? "Cần chú ý (Ambiguous)"
                          : "Chưa xác nhận container"}
                    </small>
                  </div>
                </div>

                {/* User Confirmation action */}
                {selectedCandidateUrl ? (
                  <div className="fic-confirm-action-box">
                    <div className="fic-confirm-url-preview">
                      <b>URL đang chọn:</b> <code>{selectedCandidateUrl.url}</code>
                    </div>
                    <div className="fic-confirm-buttons">
                      <button
                        type="button"
                        className="fic-btn-success"
                        disabled={Boolean(navigatingUrl)}
                        onClick={() => handleConfirmPostUrl(selectedCandidateUrl.url)}
                      >
                        ✔ Đúng bài này (Confirm Post)
                      </button>
                    </div>
                    {confirmError && (
                      <div className="fic-confirm-error-alert" role="alert">
                        <div className="fic-alert-title">⚠ Không thể chấp nhận làm Post URL:</div>
                        <div className="fic-alert-body">{confirmError}</div>
                        <small className="fic-alert-hint">
                          URL Group Member, Profile, Group Homepage hoặc chỉ có query tracking không được chấp nhận làm Post URL.
                          Hãy chọn URL khác từ danh sách hoặc tạo Permalink Rule mới ở mục 3.
                        </small>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="fic-confirm-hint">
                    Chọn một URL từ danh sách Current Item URLs ở trên để xác nhận hoặc kiểm tra trên BrowserCore.
                  </div>
                )}

                {/* Before / After Evaluation Display */}
                {activeCandidate?.latestRevision && (
                  <div className="fic-reeval-box">
                    <div className="fic-reeval-title">
                      <span>
                        📋 Kết quả Re-evaluation ({activeCandidate.latestRevision.source} &middot; {activeCandidate.latestRevision.revisionId})
                      </span>
                      <small>{new Date(activeCandidate.latestRevision.timestamp).toLocaleTimeString()}</small>
                    </div>

                    <table className="fic-reeval-table">
                      <thead>
                        <tr>
                          <th>Tiêu chí</th>
                          <th>Trước re-evaluate</th>
                          <th>Sau re-evaluate</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td><b>Boundary Status</b></td>
                          <td>
                            <span className={`fic-badge badge-${activeCandidate.latestRevision.beforeStatus.toLowerCase()}`}>
                              {activeCandidate.latestRevision.beforeStatus}
                            </span>
                          </td>
                          <td>
                            <span className={`fic-badge badge-${activeCandidate.latestRevision.afterStatus.toLowerCase()}`}>
                              {activeCandidate.latestRevision.afterStatus}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td><b>Candidate Status</b></td>
                          <td>
                            <span className={`fic-badge badge-${activeCandidate.latestRevision.beforeCandidateStatus.toLowerCase()}`}>
                              {activeCandidate.latestRevision.beforeCandidateStatus}
                            </span>
                          </td>
                          <td>
                            <span className={`fic-badge badge-${activeCandidate.latestRevision.afterCandidateStatus.toLowerCase()}`}>
                              {activeCandidate.latestRevision.afterCandidateStatus}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td><b>Container Element</b></td>
                          <td><code>{activeCandidate.latestRevision.beforeContainerSummary || "None"}</code></td>
                          <td><code>{activeCandidate.latestRevision.afterContainerSummary || "None"}</code></td>
                        </tr>
                        <tr>
                          <td><b>Post ID</b></td>
                          <td colSpan={2}>
                            {activeCandidate.postIdentity?.postId
                              ? `${activeCandidate.postIdentity.platform}:${activeCandidate.postIdentity.postId}`
                              : "Chưa có Post ID"}
                          </td>
                        </tr>
                        {activeCandidate.latestRevision.afterRiskReason && (
                          <tr>
                            <td><b>Ghi chú / Rủi ro</b></td>
                            <td colSpan={2} className="fic-risk-note">
                              {activeCandidate.latestRevision.afterRiskReason}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>

                    <div className="fic-reeval-footer-note">
                      ⚡ Đánh giá offline hoàn toàn dựa trên ancestor trajectory đã lưu trong evidence, không can thiệp DOM trang bài viết đang mở trong BrowserCore.
                    </div>
                  </div>
                )}

                {/* Revision history */}
                {activeCandidate?.evaluationRevisions && activeCandidate.evaluationRevisions.length > 1 && (
                  <div className="fic-history-section">
                    <button
                      type="button"
                      className="fic-btn-link"
                      onClick={() => setShowHistory(!showHistory)}
                    >
                      {showHistory
                        ? "▼ Thu gọn lịch sử đánh giá"
                        : `▶ Xem lịch sử đánh giá (${activeCandidate.evaluationRevisions.length} lần)`}
                    </button>
                    {showHistory && (
                      <ul className="fic-history-list">
                        {activeCandidate.evaluationRevisions.map((rev) => (
                          <li key={rev.revisionId} className="fic-history-item">
                            <div className="fic-history-item-header">
                              <code>{rev.revisionId}</code> &middot; <span>{rev.source}</span> &middot;{" "}
                              <small>{new Date(rev.timestamp).toLocaleTimeString()}</small>
                            </div>
                            <div>
                              {rev.beforeStatus} → <b>{rev.afterStatus}</b> ({rev.afterCandidateStatus})
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* 2c. Read-only Permalink Runtime Diagnostic */}
              <div className="fic-confirmation-card card">
                <div className="fic-confirm-header">
                  <h5>2c. Permalink Runtime Diagnostic (read-only)</h5>
                  <span className="fic-offline-badge">BrowserCore hiện tại</span>
                </div>
                <div className="fic-confirm-hint">
                  Cuộn BrowserCore (Bước 1) tới bài cần kiểm tra rồi chạy. Không click, không điều hướng; kết quả lưu file mới trong scratch/diagnostics.
                </div>
                <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={diagHover} onChange={(e) => setDiagHover(e.target.checked)} />
                  Bước có kiểm soát: hover (mouse-move, không click) lên link placeholder để so href trước/sau
                </label>
                <div className="fic-confirm-buttons">
                  <button type="button" className="fic-btn fic-btn-secondary" disabled={diagRunning} onClick={() => void handleRunDiagnostic()}>
                    {diagRunning ? "⏳ Đang chẩn đoán..." : "🔍 Chạy chẩn đoán"}
                  </button>
                </div>
                {diagError && (
                  <div className="fic-confirm-error-alert" role="alert">
                    <div className="fic-alert-body">{diagError}</div>
                  </div>
                )}
                {diagResult && (
                  <div className="fic-reeval-box">
                    <div className="fic-reeval-title">
                      <span>{diagResult.before.cards.length} card trong viewport · scrollY={diagResult.before.scrollY}</span>
                      <small>{diagResult.savedPath}</small>
                    </div>
                    <table className="fic-reeval-table">
                      <thead>
                        <tr><th>Card</th><th>Anchors</th><th>Placeholder</th><th>Post IDs</th></tr>
                      </thead>
                      <tbody>
                        {diagResult.before.cards.map((c) => (
                          <tr key={c.cardIndex}>
                            <td title={c.textSnippet}>#{c.cardIndex} {c.textSnippet.slice(0, 40)}</td>
                            <td>{c.anchorCount}</td>
                            <td>{c.placeholderAnchorCount}</td>
                            <td>{c.postIdentityKeys.join(", ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {diagResult.hoverEnabled && (
                      <table className="fic-reeval-table">
                        <thead>
                          <tr><th>Card/Anchor</th><th>href trước</th><th>href sau hover</th><th>Kết quả</th></tr>
                        </thead>
                        <tbody>
                          {diagResult.hoverObservations.map((h) => (
                            <tr key={`${h.cardIndex}-${h.anchorIndex}`}>
                              <td>#{h.cardIndex}/{h.anchorIndex}</td>
                              <td><code>{h.hrefBefore.slice(0, 50)}</code></td>
                              <td><code>{(h.hrefAfter ?? "—").slice(0, 70)}</code></td>
                              <td>{h.changed ? `CHANGED → ${h.classificationAfter}${h.postIdentityAfter ? ` (${h.postIdentityAfter.postId})` : ""}` : "unchanged"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>

              {/* 3. Permalink Rule Editor */}
              <PermalinkRuleEditor
                frameNumber={currentReport.frame}
                candidateIndex={selectedCandidateIndex}
                candidate={activeCandidate}
                capture={currentReport.capture}
                rules={rules}
                onRuleSaved={handleRuleSavedAndReevaluate}
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
