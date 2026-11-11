import React, { useState } from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import { PermalinkRuleRegistry, type UserPermalinkRule } from "../../../shared/permalink-rules";
import type { PostIdentity } from "../../../shared/permalink-adapter";
import type { BrowserCoreNavigationResult, Command } from "../../../shared/contracts";

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
    const trimmed = (url ?? "").trim();
    if (!trimmed || trimmed === "#") {
      return { valid: false, reason: "URL rỗng hoặc chỉ là anchor (#)." };
    }
    const resolved = resolveFullUrl(trimmed, baseOrigin);
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

export function stripFacebookTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(resolveFullUrl(rawUrl));
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_v, k) => {
      if (k.startsWith("__cft__") || k === "__tn__" || k === "refid" || k === "_rdr") {
        keysToDelete.push(k);
      }
    });
    for (const k of keysToDelete) parsed.searchParams.delete(k);
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

export function PermalinkInspector({
  candidate,
  rules,
  onUseUrl,
  invoke,
  isLiveRunning,
  onInspectInBrowserCore,
  activeUrlInspection,
}: {
  candidate: LiveCandidate;
  rules: UserPermalinkRule[];
  onUseUrl: (url: string) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
  onInspectInBrowserCore?: (result: BrowserCoreNavigationResult | null) => void;
  activeUrlInspection?: BrowserCoreNavigationResult | null;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [navigatingUrl, setNavigatingUrl] = useState<string | null>(null);
  const [localNavResult, setLocalNavResult] = useState<BrowserCoreNavigationResult | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const navResult = activeUrlInspection ?? localNavResult;

  const registry = new PermalinkRuleRegistry(rules);
  const boundary = candidate.boundary;
  const crossedLevel = boundary?.boundaryCrossedLevel ?? Infinity;

  // Infer group/feed base URL from ancestor URLs or postIdentities so query-only hrefs (?__cft__[0]=...)
  // resolve against the active group page (e.g. https://www.facebook.com/groups/{groupId}/) instead of root "/"
  let inferredBaseUrl = "https://www.facebook.com/";
  for (const step of boundary?.ancestorSteps ?? []) {
    for (const u of step.rawUrls ?? []) {
      const m = /\/groups\/([^/?#]+)\//i.exec(u);
      if (m?.[1]) {
        inferredBaseUrl = `https://www.facebook.com/groups/${m[1]}/`;
        break;
      }
    }
    if (inferredBaseUrl !== "https://www.facebook.com/") break;
  }
  if (inferredBaseUrl === "https://www.facebook.com/" && boundary?.postIdentities?.[0]?.scope) {
    const scope = boundary.postIdentities[0].scope;
    if (!scope.startsWith("@")) {
      inferredBaseUrl = `https://www.facebook.com/groups/${scope}/`;
    }
  }

  const currentItemUrls: InspectableUrl[] = [];
  const feedNeighborUrls: InspectableUrl[] = [];
  const seenUrls = new Set<string>();

  for (const step of boundary?.ancestorSteps ?? []) {
    const isFeed = step.level >= crossedLevel || step.role === "feed";
    for (const u of step.rawUrls ?? []) {
      if (!u || u.trim() === "#") continue;
      const fullUrl = resolveFullUrl(u, inferredBaseUrl);
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
      setLocalNavResult(res);
      onInspectInBrowserCore?.(res);
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

  const handleCloseInspection = () => {
    setLocalNavResult(null);
    onInspectInBrowserCore?.(null);
  };

  return (
    <div className="permalink-inspector-section">
      <h5 className="section-subtitle">
        🔗 Permalink &amp; URL Classification
      </h5>

      {/* BrowserCore Navigation Log & Status Summary */}
      {navResult && (
        <div className="browsercore-nav-modal">
          <div className="nav-modal-header">
            <span className="nav-modal-title">
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
              onClick={handleCloseInspection}
              title="Quay lại Frame Inspector"
            >
              ← Quay lại Visual Match Lab
            </button>
          </div>
          <div className="nav-modal-body">
            <div className="nav-modal-url">
              <b>Requested URL:</b> <code>{navResult.requestedUrl}</code>
            </div>
            <div className="nav-modal-url" style={{ marginTop: 4 }}>
              <b>Final URL:</b> <code>{navResult.finalUrl}</code>
            </div>
            {navResult.redirected && (
              <div
                className="browsercore-nav-error"
                style={{ marginTop: 6, background: "rgba(245, 158, 11, 0.14)", borderColor: "#f59e0b", color: "#fde68a" }}
              >
                <div>
                  <b>⚠ Phát hiện Facebook Redirect:</b>
                  <div style={{ marginTop: 2 }}>{navResult.redirectReason}</div>
                  {navResult.requestedUrl.includes("__cft__") && (
                    <button
                      type="button"
                      className="toolbar-btn"
                      style={{ marginTop: 6 }}
                      onClick={() => void handleOpenInBrowserCore(stripFacebookTrackingParams(navResult.requestedUrl))}
                    >
                      🔄 Thử mở URL sạch (bỏ __cft__/__tn__)
                    </button>
                  )}
                </div>
              </div>
            )}
            {navResult.error && (
              <div className="browsercore-nav-error" style={{ marginTop: 6 }}>
                <span>⚠ Lỗi: {navResult.error}</span>
              </div>
            )}
            {navResult.events && navResult.events.length > 0 && (
              <details style={{ marginTop: 6, fontSize: 11 }} open={navResult.redirected || !navResult.ok}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  📋 Navigation Event Log ({navResult.events.length} events)
                </summary>
                <div
                  style={{
                    maxHeight: 140,
                    overflowY: "auto",
                    marginTop: 4,
                    padding: 6,
                    background: "rgba(0,0,0,0.3)",
                    borderRadius: 4,
                    fontFamily: "monospace",
                    fontSize: 10.5,
                  }}
                >
                  {navResult.events.map((ev, i) => (
                    <div key={i} style={{ marginBottom: 3, wordBreak: "break-all" }}>
                      <span style={{ color: "#93c5fd" }}>+{ev.atMs}ms</span>{" "}
                      <b>[{ev.type}]</b> {ev.url}
                      {ev.httpResponseCode ? ` (HTTP ${ev.httpResponseCode})` : ""}
                      {ev.errorCode ? ` (ERR ${ev.errorCode}: ${ev.errorDescription})` : ""}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div className="nav-modal-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="toolbar-btn active"
                onClick={handleCloseInspection}
              >
                ← Quay lại Visual Match Lab
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
