import React, { useState } from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import { PermalinkRuleRegistry, type UserPermalinkRule } from "../../../shared/permalink-rules";
import type { PostIdentity } from "../../../shared/permalink-adapter";
import type { Command } from "../../../shared/contracts";

type Invoke = <T>(command: Command) => Promise<T>;

export type InspectableUrl = {
  url: string;
  rawUrl?: string;
  canonicalUrl?: string;
  level: number;
  tag: string;
  role: string | null;
  matchedRuleId?: string;
  identity?: PostIdentity;
  isFeedLevel: boolean;
  status: "MATCHED" | "UNRECOGNIZED" | "CONFLICT";
};

export function resolveFullUrl(
  rawUrl: string,
  baseOrigin = "https://www.facebook.com",
): string {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("?")) {
    try {
      return new URL(trimmed, baseOrigin).href;
    } catch {
      return `${baseOrigin.replace(/\/$/, "")}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
    }
  }
  return trimmed;
}

export function validateNavigableUrl(
  url: string,
  baseOrigin = "https://www.facebook.com",
): { valid: boolean; reason?: string; resolvedUrl?: string } {
  try {
    const resolved = resolveFullUrl(url, baseOrigin);
    if (!resolved) {
      return { valid: false, reason: "URL không đúng định dạng." };
    }
    const parsed = new URL(resolved);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, reason: "Chỉ hỗ trợ scheme HTTP/HTTPS." };
    }
    const host = parsed.hostname.toLowerCase();
    const isFacebook = host.includes("facebook.com") || host.includes("fb.com");
    const isThreads = host.includes("threads.net") || host.includes("threads.com");
    if (!isFacebook && !isThreads) {
      return { valid: false, reason: `Domain ${parsed.hostname} không thuộc Facebook hoặc Threads.` };
    }
    return { valid: true, resolvedUrl: parsed.href };
  } catch {
    return { valid: false, reason: "URL không đúng định dạng." };
  }
}

export function PermalinkInspector({
  candidate,
  rules,
  onUseUrl,
  invoke,
  isLiveRunning,
}: {
  candidate: LiveCandidate;
  rules: UserPermalinkRule[];
  onUseUrl: (url: string) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [navigatingUrl, setNavigatingUrl] = useState<string | null>(null);
  const [navResult, setNavResult] = useState<{
    url: string;
    webContentsId: number;
    title: string;
    previewDataUrl?: string;
  } | null>(null);
  const [navError, setNavError] = useState<string | null>(null);

  const registry = new PermalinkRuleRegistry(rules);
  const boundary = candidate.boundary;
  const crossedLevel = boundary?.boundaryCrossedLevel ?? Infinity;

  const currentItemUrls: InspectableUrl[] = [];
  const feedNeighborUrls: InspectableUrl[] = [];
  const seenUrls = new Set<string>();

  for (const step of boundary?.ancestorSteps ?? []) {
    const isFeed = step.level >= crossedLevel || step.role === "feed";
    for (const u of step.rawUrls ?? []) {
      const fullUrl = resolveFullUrl(u);
      const match = registry.match(fullUrl) ?? registry.match(u);
      const isMatched = Boolean(match?.ruleId);

      const info: InspectableUrl = {
        url: fullUrl,
        rawUrl: u !== fullUrl ? u : undefined,
        canonicalUrl: match?.identity?.canonicalUrl,
        level: step.level,
        tag: step.tag,
        role: step.role,
        matchedRuleId: match?.ruleId,
        identity: match?.identity,
        isFeedLevel: isFeed,
        status: isMatched ? "MATCHED" : "UNRECOGNIZED",
      };

      const dedupKey = `${isFeed ? "feed" : "item"}:${fullUrl}`;
      if (!seenUrls.has(dedupKey)) {
        seenUrls.add(dedupKey);
        if (isFeed) {
          feedNeighborUrls.push(info);
        } else {
          currentItemUrls.push(info);
        }
      }
    }
  }

  currentItemUrls.sort((a, b) => {
    if (a.status === "MATCHED" && b.status !== "MATCHED") return -1;
    if (a.status !== "MATCHED" && b.status === "MATCHED") return 1;
    return a.level - b.level;
  });

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
    if (isLiveRunning) {
      setNavError("Không thể điều hướng BrowserCore khi Live Scroll Test đang chạy.");
      return;
    }
    const check = validateNavigableUrl(url);
    if (!check.valid || !check.resolvedUrl) {
      setNavError(`Lỗi URL: ${check.reason}`);
      return;
    }
    const targetUrl = check.resolvedUrl;
    setNavigatingUrl(url);
    setNavError(null);
    try {
      const res = await invoke<{
        ok: boolean;
        url: string;
        webContentsId: number;
        title: string;
        previewDataUrl?: string;
      }>({
        type: "visualMatchLabNavigateBrowserCore",
        url: targetUrl,
      });
      if (res.ok) {
        setNavResult(res);
      } else {
        setNavError("Điều hướng BrowserCore không thành công.");
      }
    } catch (e) {
      setNavError(e instanceof Error ? e.message : String(e));
    } finally {
      setNavigatingUrl(null);
    }
  };

  return (
    <div className="permalink-inspector-section">
      <h5 className="section-subtitle">
        🔗 Permalink &amp; URL Classification
      </h5>

      {/* BrowserCore Navigation Result Modal / Overlay */}
      {navResult && (
        <div className="browsercore-nav-modal">
          <div className="nav-modal-header">
            <span className="nav-modal-title">
              🌐 BrowserCore (webContents #{navResult.webContentsId})
            </span>
            <button
              type="button"
              className="nav-modal-close-btn"
              onClick={() => setNavResult(null)}
              title="Quay lại Frame Inspector"
            >
              ✕ Quay lại Inspector
            </button>
          </div>
          <div className="nav-modal-body">
            <div className="nav-modal-url">
              <b>URL hiện tại:</b> <code>{navResult.url}</code>
            </div>
            <div className="nav-modal-notice">
              ℹ Đã điều hướng trên BrowserCore có sẵn session/cookie Facebook (không tạo session mới). Thao tác mở URL thành công không thay thế bằng chứng sở hữu post (post ownership).
            </div>
            {navResult.previewDataUrl ? (
              <div className="nav-modal-preview">
                <span className="preview-label">Live Viewport Capture (1024×560):</span>
                <img
                  src={navResult.previewDataUrl}
                  alt="BrowserCore live viewport"
                  className="browsercore-live-img"
                  style={{ width: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 4, border: "1px solid var(--border-color)", marginTop: 6 }}
                />
              </div>
            ) : null}
            <div className="nav-modal-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="toolbar-btn active"
                onClick={() => setNavResult(null)}
              >
                ← Quay lại Frame Inspector
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Error Message */}
      {navError && (
        <div className="browsercore-nav-error">
          <span>⚠ {navError}</span>
          <button type="button" onClick={() => setNavError(null)}>✕</button>
        </div>
      )}

      {/* 1. Current Item URLs */}
      <div className="url-category-block current-item-block">
        <div className="category-header">
          <span className="category-title">Current Item URLs ({currentItemUrls.length})</span>
          <span className="category-hint">
            Subtree ancestors L0 &ndash; L{crossedLevel !== Infinity ? crossedLevel - 1 : "max"}
          </span>
        </div>

        {currentItemUrls.length === 0 ? (
          <div className="empty-url-msg">
            Không tìm thấy URL nào trong subtree của current post. (Có thể là bài ẩn danh hoặc link tương đối).
          </div>
        ) : (
          <div className="url-interactive-list">
            {currentItemUrls.map((item, idx) => {
              const isCopied = copiedUrl === item.url;
              const isThisNavigating = navigatingUrl === item.url;
              return (
                <div key={idx} className={`url-interactive-card ${item.status.toLowerCase()}`}>
                  <div className="card-top-meta">
                    <div className="meta-left">
                      <span className="level-badge">L{item.level}</span>
                      <span className="tag-badge">&lt;{item.tag}{item.role ? ` role="${item.role}"` : ""}&gt;</span>
                      <span className="scope-tag current">CURRENT_ITEM</span>
                    </div>
                    <div className="meta-right">
                      <span className={`status-pill ${item.status.toLowerCase()}`}>
                        {item.status === "MATCHED" ? `✔ ${item.matchedRuleId}` : `✖ ${item.status}`}
                      </span>
                    </div>
                  </div>

                  {/* Full Raw URL with multi-line break */}
                  <div className="url-raw-display">
                    <b>Raw URL:</b> <span className="raw-url-text">{item.url}</span>
                  </div>

                  {item.canonicalUrl && (
                    <div className="url-canonical-display">
                      <b>Canonical:</b> <span className="canonical-url-text">{item.canonicalUrl}</span>
                    </div>
                  )}

                  {item.identity && (
                    <div className="url-identity-display">
                      <b>Extracted ID:</b> <code>{item.identity.platform}:{item.identity.postId}</code>
                    </div>
                  )}

                  {/* Actions Bar */}
                  <div className="url-actions-bar">
                    <button
                      type="button"
                      className="url-act-btn open-btn"
                      onClick={() => handleOpenInBrowserCore(item.url)}
                      disabled={isLiveRunning || isThisNavigating}
                      title={
                        isLiveRunning
                          ? "Không thể điều hướng BrowserCore khi Live Scroll Test đang chạy"
                          : "Điều hướng BrowserCore hiện tại (dùng đúng session/cookie Facebook có sẵn)"
                      }
                    >
                      {isThisNavigating ? "⏳ Navigating Browser..." : "🌐 Open in BrowserCore"}
                    </button>
                    <button
                      type="button"
                      className="url-act-btn copy-btn"
                      onClick={() => handleCopy(item.url)}
                      title="Sao chép toàn bộ URL vào clipboard"
                    >
                      {isCopied ? "✔ Copied!" : "📋 Copy URL"}
                    </button>
                    <button
                      type="button"
                      className="url-act-btn use-btn"
                      onClick={() => onUseUrl(item.url)}
                      title="Chuyển URL này vào URL Template Editor phía dưới để tạo rule"
                    >
                      ⚡ Use This URL
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Feed / Neighbor URLs */}
      <div className="url-category-block feed-neighbor-block">
        <div className="category-header">
          <span className="category-title">Feed / Neighbor URLs ({feedNeighborUrls.length})</span>
          <span className="category-hint">Multi-item container (L &ge; {crossedLevel !== Infinity ? crossedLevel : "feed"})</span>
        </div>

        {feedNeighborUrls.length === 0 ? (
          <div className="empty-url-msg">Không có URL lân cận vượt ngoài ranh giới feed.</div>
        ) : (
          <div className="url-interactive-list">
            {feedNeighborUrls.map((item, idx) => {
              const isCopied = copiedUrl === item.url;
              const isThisNavigating = navigatingUrl === item.url;
              return (
                <div key={idx} className="url-interactive-card neighbor">
                  <div className="card-top-meta">
                    <div className="meta-left">
                      <span className="level-badge neighbor">L{item.level}</span>
                      <span className="tag-badge">&lt;{item.tag}{item.role ? ` role="${item.role}"` : ""}&gt;</span>
                      <span className="scope-tag neighbor">FEED_NEIGHBOR</span>
                    </div>
                    <div className="meta-right">
                      <span className="status-pill neighbor">
                        {item.matchedRuleId ? `[neighbor] ${item.identity?.postId}` : `[neighbor unrec]`}
                      </span>
                    </div>
                  </div>

                  <div className="url-raw-display">
                    <b>Raw URL:</b> <span className="raw-url-text neighbor">{item.url}</span>
                  </div>

                  <div className="url-actions-bar">
                    <button
                      type="button"
                      className="url-act-btn open-btn"
                      onClick={() => handleOpenInBrowserCore(item.url)}
                      disabled={isLiveRunning || isThisNavigating}
                      title={
                        isLiveRunning
                          ? "Không thể điều hướng BrowserCore khi Live Scroll Test đang chạy"
                          : "Điều hướng BrowserCore hiện tại (dùng đúng session/cookie Facebook có sẵn)"
                      }
                    >
                      {isThisNavigating ? "⏳ Navigating Browser..." : "🌐 Open in BrowserCore"}
                    </button>
                    <button type="button" className="url-act-btn copy-btn" onClick={() => handleCopy(item.url)}>
                      {isCopied ? "✔ Copied!" : "📋 Copy URL"}
                    </button>
                    <button
                      type="button"
                      className="url-act-btn use-btn"
                      onClick={() => onUseUrl(item.url)}
                      title="Chuyển URL này vào URL Template Editor phía dưới để tạo rule"
                    >
                      ⚡ Use This URL
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
