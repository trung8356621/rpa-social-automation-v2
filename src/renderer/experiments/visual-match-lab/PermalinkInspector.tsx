import React, { useState, useEffect } from "react";
import type { LiveCandidate } from "./LiveScrollTest";
import type { LiveCapture } from "./types";
import type { BoundaryProbeResult } from "../../../shared/boundary-probe";
import {
  PermalinkRuleRegistry,
  type UserPermalinkRule,
} from "../../../shared/permalink-rules";
import type { PostIdentity } from "../../../shared/permalink-adapter";
import type {
  BrowserCoreNavigationResult,
  Command,
} from "../../../shared/contracts";
import { CurrentItemUrlList } from "./CurrentItemUrlList";
import { UrlVerificationPanel } from "./UrlVerificationPanel";
import { PermalinkRuleEditor } from "./PermalinkRuleEditor";
import { PermalinkTechnicalDetails } from "./PermalinkTechnicalDetails";

type Invoke = <T>(command: Command) => Promise<T>;

export type RecognitionBadgeStatus = "RECOGNIZED" | "UNRECOGNIZED";
export type UrlVerificationStatus = "NOT_TESTED" | "VERIFIED" | "MISMATCH";

export type UrlVerificationInfo = {
  status: UrlVerificationStatus;
  label: string;
  reason?: string;
};

export type InspectableUrl = {
  index: number;
  url: string;
  rawUrl?: string;
  canonicalUrl?: string;
  shortUrl: string;
  classificationLabel: string;
  level: number;
  tag: string;
  role: string | null;
  matchedRuleId?: string;
  matchedRuleName?: string;
  identity?: PostIdentity;
  isFeedLevel: boolean;
  status: "MATCHED" | "UNRECOGNIZED" | "CONFLICT";
  recognitionBadge: RecognitionBadgeStatus;
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
      return `${baseOrigin.replace(/\/$/, "")}${
        trimmed.startsWith("/") ? "" : "/"
      }${trimmed}`;
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
    const isThreads =
      host.includes("threads.net") || host.includes("threads.com");
    if (!isFacebook && !isThreads) {
      return {
        valid: false,
        reason: `Domain ${parsed.hostname} không thuộc Facebook hoặc Threads.`,
      };
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
      if (
        k.startsWith("__cft__") ||
        k === "__tn__" ||
        k === "refid" ||
        k === "_rdr"
      ) {
        keysToDelete.push(k);
      }
    });
    for (const k of keysToDelete) parsed.searchParams.delete(k);
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

export function classifyUrlCandidate(
  fullUrl: string,
  matchedRule?: UserPermalinkRule,
): string {
  if (matchedRule?.name) {
    return matchedRule.name;
  }
  try {
    const parsed = new URL(resolveFullUrl(fullUrl));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    if (host.includes("threads.net") || host.includes("threads.com")) {
      if (/^\/@[^/]+\/post\/[^/]+/i.test(pathname)) return "Threads Post";
      return "Threads Link";
    }

    if (/^\/groups\/[^/]+\/posts\/[^/]+/i.test(pathname)) {
      return "Facebook Group Post";
    }
    if (/^\/groups\/[^/]+\/permalink\/[^/]+/i.test(pathname)) {
      return "Facebook Group Permalink";
    }
    if (/^\/groups\/[^/]+\/user\/[^/]+/i.test(pathname)) {
      return "Facebook Group Member";
    }
    if (/^\/groups\/[^/]+\/?$/i.test(pathname)) {
      return "Facebook Group";
    }
    if (/^\/(?:photo|photo\.php)\/?$/i.test(pathname)) {
      const setParam = parsed.searchParams.get("set") ?? "";
      if (setParam.startsWith("gm.")) return "Facebook Group Photo (gm)";
      if (setParam.startsWith("pcb.")) return "Facebook Post Photo (pcb)";
      return "Facebook Photo";
    }
    if (/^\/(?:permalink|story)\.php$/i.test(pathname)) {
      return "Facebook Permalink";
    }
    if (/^\/[^/]+\/posts\/[^/]+/i.test(pathname)) {
      return "Facebook Page / Profile Post";
    }
    return "Facebook Link";
  } catch {
    return "Unknown URL";
  }
}

export function formatShortUrl(rawOrFullUrl: string, maxChars = 76): string {
  try {
    const parsed = new URL(resolveFullUrl(rawOrFullUrl));
    let pathDisplay = parsed.pathname || "/";

    // Shorten overly long path segments in the middle if needed
    const segments = pathDisplay.split("/").filter(Boolean);
    if (segments.length >= 3) {
      const shortenedSegments = segments.map((seg) =>
        seg.length > 22 ? `${seg.slice(0, 10)}...${seg.slice(-6)}` : seg,
      );
      pathDisplay =
        "/" +
        shortenedSegments.join("/") +
        (pathDisplay.endsWith("/") ? "/" : "");
    }

    // Build compact query representation
    const meaningfulParams: string[] = [];
    let hasTracking = false;
    parsed.searchParams.forEach((val, key) => {
      if (
        key.startsWith("__cft__") ||
        key === "__tn__" ||
        key === "refid" ||
        key === "_rdr"
      ) {
        hasTracking = true;
      } else {
        const shortVal =
          val.length > 20 ? `${val.slice(0, 12)}...${val.slice(-4)}` : val;
        meaningfulParams.push(`${key}=${shortVal}`);
      }
    });

    let queryDisplay = "";
    if (meaningfulParams.length > 0) {
      queryDisplay = `?${meaningfulParams.join("&")}${
        hasTracking ? "&__cft__..." : ""
      }`;
    } else if (hasTracking) {
      queryDisplay = "?__cft__...";
    }

    const combined = `${pathDisplay}${queryDisplay}`;
    if (combined.length <= maxChars) {
      return combined;
    }
    return `${combined.slice(0, maxChars - 3)}...`;
  } catch {
    const trimmed = (rawOrFullUrl ?? "").trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, maxChars - 3)}...`;
  }
}

export function extractInspectableUrls(
  boundary: BoundaryProbeResult | undefined,
  rules: UserPermalinkRule[],
): {
  currentItemUrls: InspectableUrl[];
  feedNeighborUrls: InspectableUrl[];
  inferredBaseUrl: string;
} {
  const registry = new PermalinkRuleRegistry(rules);
  const crossedLevel = boundary?.boundaryCrossedLevel ?? Infinity;

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
  if (
    inferredBaseUrl === "https://www.facebook.com/" &&
    boundary?.postIdentities?.[0]?.scope
  ) {
    const scope = boundary.postIdentities[0].scope;
    if (!scope.startsWith("@")) {
      inferredBaseUrl = `https://www.facebook.com/groups/${scope}/`;
    }
  }

  const rawCurrentUrls: Omit<InspectableUrl, "index">[] = [];
  const rawNeighborUrls: Omit<InspectableUrl, "index">[] = [];
  const seenUrls = new Set<string>();

  for (const step of boundary?.ancestorSteps ?? []) {
    const isFeed = step.level >= crossedLevel || step.role === "feed";
    for (const u of step.rawUrls ?? []) {
      if (!u || u.trim() === "#") continue;
      const fullUrl = resolveFullUrl(u, inferredBaseUrl);
      const match = registry.match(fullUrl) ?? registry.match(u);
      const isMatched = Boolean(match?.ruleId);
      const matchedRule = match?.ruleId
        ? registry.getRule(match.ruleId)
        : undefined;

      const info: Omit<InspectableUrl, "index"> = {
        url: fullUrl,
        rawUrl: u !== fullUrl ? u : undefined,
        canonicalUrl: match?.identity?.canonicalUrl,
        shortUrl: formatShortUrl(fullUrl),
        classificationLabel: classifyUrlCandidate(fullUrl, matchedRule),
        level: step.level,
        tag: step.tag,
        role: step.role,
        matchedRuleId: match?.ruleId,
        matchedRuleName: matchedRule?.name,
        identity: match?.identity,
        isFeedLevel: isFeed,
        status: isMatched ? "MATCHED" : "UNRECOGNIZED",
        recognitionBadge: isMatched ? "RECOGNIZED" : "UNRECOGNIZED",
      };

      const dedupKey = `${isFeed ? "feed" : "item"}:${fullUrl}`;
      if (!seenUrls.has(dedupKey)) {
        seenUrls.add(dedupKey);
        if (isFeed) {
          rawNeighborUrls.push(info);
        } else {
          rawCurrentUrls.push(info);
        }
      }
    }
  }

  rawCurrentUrls.sort((a, b) => {
    if (a.status === "MATCHED" && b.status !== "MATCHED") return -1;
    if (a.status !== "MATCHED" && b.status === "MATCHED") return 1;
    return a.level - b.level;
  });

  const currentItemUrls: InspectableUrl[] = rawCurrentUrls.map((item, idx) => ({
    ...item,
    index: idx + 1,
  }));

  const feedNeighborUrls: InspectableUrl[] = rawNeighborUrls.map(
    (item, idx) => ({
      ...item,
      index: idx + 1,
    }),
  );

  return { currentItemUrls, feedNeighborUrls, inferredBaseUrl };
}

export function deriveUrlVerificationStatus(
  candidateUrl: InspectableUrl | null,
  navResult: BrowserCoreNavigationResult | null,
): UrlVerificationInfo {
  if (!candidateUrl || !navResult) {
    return {
      status: "NOT_TESTED",
      label: "Chưa kiểm tra",
    };
  }

  const cleanCandidateUrl = stripFacebookTrackingParams(candidateUrl.url);
  const isSameTarget =
    navResult.requestedUrl === candidateUrl.url ||
    navResult.requestedUrl === cleanCandidateUrl;

  if (!isSameTarget) {
    return {
      status: "NOT_TESTED",
      label: "Chưa kiểm tra",
    };
  }

  if (navResult.status === "FAILED" || !navResult.ok) {
    return {
      status: "MISMATCH",
      label: "Lỗi điều hướng",
      reason: navResult.error || "Không thể điều hướng tới URL này.",
    };
  }

  if (navResult.redirected || navResult.status === "REDIRECTED") {
    return {
      status: "MISMATCH",
      label: "Đã bị Redirect (Không khớp)",
      reason:
        navResult.redirectReason ||
        "Facebook đã chuyển hướng URL sang trang khác.",
    };
  }

  // Only mark VERIFIED when BrowserCore navigation succeeded without redirect AND the URL has a recognized Post ID present in the final destination
  if (
    navResult.status === "SUCCESS" &&
    !navResult.redirected &&
    candidateUrl.recognitionBadge === "RECOGNIZED" &&
    candidateUrl.identity?.postId &&
    navResult.finalUrl &&
    navResult.finalUrl.includes(candidateUrl.identity.postId)
  ) {
    return {
      status: "VERIFIED",
      label: "Đã xác minh (Đúng đích)",
      reason: `BrowserCore mở đúng bài viết (${candidateUrl.identity.platform}:${candidateUrl.identity.postId}).`,
    };
  }

  return {
    status: "NOT_TESTED",
    label: "Chưa đủ bằng chứng Post ID",
    reason:
      "Đã mở trên BrowserCore nhưng URL chưa có Post ID hợp lệ để tự động xác nhận VERIFIED.",
  };
}

export function PermalinkInspector({
  frameNumber = 1,
  candidateIndex = 0,
  candidate,
  capture,
  rules,
  onRuleSaved,
  onUpdateBoundary,
  onUseUrl,
  invoke,
  isLiveRunning,
  onInspectInBrowserCore,
  activeUrlInspection,
  captureStatus,
  pipelineStatus,
  templateStatus,
  detectionStatus,
  rawIconMatches,
  actionClusters,
}: {
  frameNumber?: number;
  candidateIndex?: number;
  candidate: LiveCandidate;
  capture?: LiveCapture | null;
  rules: UserPermalinkRule[];
  onRuleSaved?: (newRule: UserPermalinkRule) => void;
  onUpdateBoundary?: (
    newBoundary: BoundaryProbeResult,
    evidenceUrl?: string,
  ) => void;
  onUseUrl?: (url: string) => void;
  invoke: Invoke;
  isLiveRunning?: boolean;
  onInspectInBrowserCore?: (result: BrowserCoreNavigationResult | null) => void;
  activeUrlInspection?: BrowserCoreNavigationResult | null;
  captureStatus?: string;
  pipelineStatus?: string;
  templateStatus?: string;
  detectionStatus?: string;
  rawIconMatches?: number;
  actionClusters?: number;
}) {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [prefillUrl, setPrefillUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [navigatingUrl, setNavigatingUrl] = useState<string | null>(null);
  const [localNavResult, setLocalNavResult] =
    useState<BrowserCoreNavigationResult | null>(null);
  const [navError, setNavError] = useState<string | null>(null);

  const navResult = activeUrlInspection ?? localNavResult;

  // Reset per-frame / per-candidate state on Next/Prev or Row switch so previous frame's candidate is never kept
  useEffect(() => {
    setSelectedUrl(null);
    setPrefillUrl(null);
    setLocalNavResult(null);
    setNavError(null);
    setNavigatingUrl(null);
  }, [frameNumber, candidateIndex]);

  const { currentItemUrls, inferredBaseUrl } = extractInspectableUrls(
    candidate.boundary,
    rules,
  );

  const selectedCandidate =
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
    if (isLiveRunning) {
      setNavError(
        "Không thể điều hướng BrowserCore khi Live Scroll Test đang chạy.",
      );
      return;
    }
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
            () =>
              reject(
                new Error(
                  "Quá thời gian chờ (16s) khi điều hướng BrowserCore.",
                ),
              ),
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

  const handleOpenCard = (item: InspectableUrl) => {
    setSelectedUrl(item.url);
    void handleOpenInBrowserCore(item.url);
  };

  const handleUseCardUrl = (item: InspectableUrl) => {
    setSelectedUrl(item.url);
    setPrefillUrl(item.url);
    onUseUrl?.(item.url);
  };

  const handleCloseInspection = () => {
    setLocalNavResult(null);
    onInspectInBrowserCore?.(null);
  };

  const selectedVerification = deriveUrlVerificationStatus(
    selectedCandidate,
    navResult,
  );

  return (
    <div className="permalink-inspector-section">
      {/* 1. Current Item URLs (Feed / Neighbor URLs hidden from UI) */}
      <CurrentItemUrlList
        urls={currentItemUrls}
        selectedUrl={selectedUrl}
        getVerification={(item) => deriveUrlVerificationStatus(item, navResult)}
        copiedUrl={copiedUrl}
        navigatingUrl={navigatingUrl}
        isLiveRunning={isLiveRunning}
        onOpen={handleOpenCard}
        onCopy={(u) => void handleCopy(u)}
        onUseUrl={handleUseCardUrl}
      />

      {/* 2. URL Verification */}
      <UrlVerificationPanel
        selectedCandidate={selectedCandidate}
        verification={selectedVerification}
        navResult={navResult}
        navError={navError}
        isNavigating={Boolean(navigatingUrl)}
        isLiveRunning={isLiveRunning}
        onOpenInBrowserCore={(u) => void handleOpenInBrowserCore(u)}
        onCloseInspection={handleCloseInspection}
        onDismissError={() => setNavError(null)}
      />

      {/* 3. User-configurable Permalink Rule Editor */}
      {capture && onRuleSaved && onUpdateBoundary && (
        <PermalinkRuleEditor
          frameNumber={frameNumber}
          candidateIndex={candidateIndex}
          candidate={candidate}
          capture={capture}
          rules={rules}
          onRuleSaved={onRuleSaved}
          onUpdateBoundary={onUpdateBoundary}
          prefillUrl={prefillUrl}
          invoke={invoke}
        />
      )}

      {/* 4. Technical Details (collapsed by default) */}
      <PermalinkTechnicalDetails
        selectedCandidate={selectedCandidate}
        allCurrentUrls={currentItemUrls}
        navResult={navResult}
        boundary={candidate.boundary}
        frameNumber={frameNumber}
        scrollY={capture?.viewport.scrollY}
        dimensions={capture ? `${capture.width}×${capture.height}` : "1024×560"}
        captureStatus={captureStatus}
        detectionStatus={detectionStatus}
        pipelineStatus={pipelineStatus}
        templateStatus={templateStatus}
        rawIconMatches={rawIconMatches}
        actionClusters={actionClusters}
        matchScore={`${(candidate.score * 100).toFixed(1)}%`}
        candidateStatus={candidate.status}
        candidateContext={candidate.context}
        copiedUrl={copiedUrl}
        onCopy={(u) => void handleCopy(u)}
      />
    </div>
  );
}
