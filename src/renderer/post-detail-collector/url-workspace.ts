import type { PostDetailParentConfig } from "../../shared/post-detail-collector/types";
import { extractPostIdentityFromUrl, parseBatchUrls } from "./batch-validation";
import type { PostDetailDomStrategy, PostDetailUrlItem } from "./types";

const now = () => new Date().toISOString();

export function stableUrlId(url: string): string {
  const identity = extractPostIdentityFromUrl(url);
  return identity ? `${identity.platform}:${identity.postId}` : `url:${url.trim()}`;
}

function canonicalPostUrl(url: string): string {
  const identity = extractPostIdentityFromUrl(url);
  if (!identity.valid || !identity.postId) return identity.normalizedUrl || url;
  if (identity.platform === "threads") return identity.normalizedUrl.split(/[?#]/)[0];
  return `https://www.facebook.com/posts/${identity.postId}`;
}

export function mergeUrlWorkspace(text: string, previous: PostDetailUrlItem[]): PostDetailUrlItem[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  return parseBatchUrls(text).items.map(parsed => {
    const id = stableUrlId(parsed.url);
    const existing = byId.get(id);
    const identity = extractPostIdentityFromUrl(parsed.url);
    return existing || {
      id,
      originalUrl: parsed.url,
      canonicalUrl: canonicalPostUrl(parsed.url),
      postId: parsed.postId,
      platform: parsed.platform,
      status: parsed.valid ? "PENDING" : "FAILED",
      diagnostics: parsed.valid ? [] : [parsed.error || "Invalid URL"],
      updatedAt: now(),
    };
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
