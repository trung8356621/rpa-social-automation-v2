import type { PostDetailParentConfig } from "../../shared/post-detail-collector/types";
import { canonicalPostUrl, extractPostIdentityFromUrl, parseBatchUrls } from "./batch-validation";
import type { PostDetailDomStrategy, PostDetailUrlItem } from "./types";

const now = () => new Date().toISOString();

export function stableUrlId(url: string): string {
  const identity = extractPostIdentityFromUrl(url);
  return identity.valid && identity.platform && identity.postId
    ? `${identity.platform}:${identity.postId}`
    : `url:${identity.normalizedUrl || url.trim()}`;
}

export function extractWorkspaceIdentity(url: string) {
  const identity = extractPostIdentityFromUrl(url);
  let groupSlug: string | undefined;
  let groupId: string | undefined;
  try {
    const group = /^\/groups\/([^/]+)/i.exec(new URL(url).pathname)?.[1];
    if (group) {
      const decoded = decodeURIComponent(group);
      if (/^\d+$/.test(decoded)) groupId = decoded;
      else groupSlug = decoded;
    }
  } catch { /* parser reports the URL error */ }
  return { ...identity, groupSlug, groupId };
}

export function mergeUrlWorkspace(text: string, previous: PostDetailUrlItem[]): PostDetailUrlItem[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  const seen = new Set<string>();
  return parseBatchUrls(text).items.flatMap(parsed => {
    const id = stableUrlId(parsed.url);
    if (seen.has(id)) return [];
    seen.add(id);
    const existing = byId.get(id);
    const identity = extractWorkspaceIdentity(parsed.url);
    return [existing || {
      id,
      originalUrl: parsed.url,
      canonicalUrl: canonicalPostUrl(parsed.url, parsed.postId),
      postId: parsed.postId,
      platform: parsed.platform,
      groupSlug: identity.groupSlug,
      groupId: identity.groupId,
      status: parsed.valid ? "PENDING" : "FAILED",
      diagnostics: parsed.valid ? [] : [parsed.error || "Invalid URL"],
      updatedAt: now(),
    }];
  });
}

export function legacyStrategies(parentConfigs: Record<string, PostDetailParentConfig>): PostDetailDomStrategy[] {
  return Object.entries(parentConfigs).map(([platform, config]) => ({
    id: `legacy:${platform}:${config.updatedAt || "unknown"}`,
    version: 1,
    platform,
    structuralSignature: JSON.stringify(config.actionRowSignature || {}),
    parentConfig: config,
    anchors: config.domAnchors || {},
    validationStatus: "LEGACY",
    successes: 0,
    failures: 0,
    createdAt: config.updatedAt || now(),
    updatedAt: config.updatedAt || now(),
  }));
}

export function upsertStrategyVariation(
  strategies: PostDetailDomStrategy[],
  config: PostDetailParentConfig,
): PostDetailDomStrategy[] {
  const signature = JSON.stringify(config.actionRowSignature || config.actionRowLocator || {});
  const existing = strategies.find(strategy =>
    strategy.platform === config.platform && strategy.structuralSignature === signature);
  if (existing) {
    return strategies.map(strategy => strategy.id === existing.id
      ? { ...strategy, parentConfig: config, anchors: config.domAnchors || strategy.anchors, updatedAt: now() }
      : strategy);
  }
  const createdAt = now();
  return [...strategies, {
    id: `strategy:${config.platform}:${createdAt}:${strategies.length + 1}`,
    version: 1,
    platform: config.platform,
    structuralSignature: signature,
    parentConfig: config,
    anchors: config.domAnchors || {},
    validationStatus: strategies.some(s => s.platform === config.platform) ? "VARIATION" : "CONFIRMED",
    successes: 0,
    failures: 0,
    createdAt,
    updatedAt: createdAt,
  }];
}

export function rankStrategies(strategies: PostDetailDomStrategy[], platform: string): PostDetailDomStrategy[] {
  return strategies.filter(s => s.platform === platform).sort((a, b) => {
    const verified = (s: PostDetailDomStrategy) => Object.values(s.anchors).filter(a => a?.verificationStatus === "VERIFIED").length;
    return verified(b) - verified(a) || b.successes - a.successes || a.failures - b.failures;
  });
}

export function effectiveStrategyConfig(strategy: PostDetailDomStrategy): PostDetailParentConfig {
  return {
    ...strategy.parentConfig,
    domAnchors: {
      ...(strategy.parentConfig.domAnchors || {}),
      ...strategy.anchors,
    },
  };
}

export function classifyAutoMatchGate(input: {
  status: string;
  postIdentityVerified: boolean;
  parentVerified: boolean;
  engagementAnchorsVerified: boolean;
}) {
  const canReview = input.status === "PARENT_MATCHED" && input.postIdentityVerified && input.parentVerified;
  return {
    canReview,
    engagementStatus: input.engagementAnchorsVerified ? "VERIFIED" as const : "NEEDS_ATTENTION" as const,
    reason: canReview ? (input.engagementAnchorsVerified ? "READY" : "PARENT_READY_ENGAGEMENT_UNVERIFIED") : "PARENT_OR_IDENTITY_UNVERIFIED",
  };
}
