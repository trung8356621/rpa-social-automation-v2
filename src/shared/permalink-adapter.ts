/**
 * Platform Permalink Adapters for Facebook and Threads.
 * Extracts and normalizes post identities, discarding non-post URLs, queries, and hashes.
 */

export interface PostIdentity {
  platform: "facebook" | "threads" | "generic";
  postId: string;
  scope?: string;
  canonicalUrl: string;
  rawUrl: string;
}

export interface PlatformPermalinkAdapter {
  platform: "facebook" | "threads" | "generic";
  matchesPlatform(urlOrHost: string): boolean;
  extractPostIdentity(href: string, basePageUrl?: string): PostIdentity | null;
}

export class FacebookPermalinkAdapter implements PlatformPermalinkAdapter {
  readonly platform = "facebook" as const;

  matchesPlatform(urlOrHost: string): boolean {
    return /(?:facebook\.com|fb\.com)/i.test(urlOrHost);
  }

  extractPostIdentity(href: string, basePageUrl = "https://www.facebook.com/"): PostIdentity | null {
    if (!href || typeof href !== "string") return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return null;

    let parsed: URL;
    try {
      parsed = new URL(trimmed, basePageUrl);
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!/(?:^|\.)(?:facebook\.com|fb\.com)$/.test(hostname)) {
      return null;
    }

    const pathname = parsed.pathname;

    // 0. Special exception for group photo permalinks:
    // /photo/?fbid=...&set=gm.{postId}&idorvanity={groupId}
    // /photo/?fbid=...&set=pcb.{postId}&idorvanity={groupId}
    // Must extract postId from gm.{postId} or pcb.{postId}, not fbid. Reject if gm/pcb is missing or malformed.
    if (/^\/(?:photo|photo\.php)\/?$/i.test(pathname)) {
      const setParam = parsed.searchParams.get("set");
      const match = setParam ? /^(?:gm|pcb)\.([0-9a-zA-Z_-]+)$/.exec(setParam.trim()) : null;
      if (match && match[1]) {
        const postId = match[1];
        const idorvanity = parsed.searchParams.get("idorvanity");
        const scope = idorvanity && /^[0-9a-zA-Z._-]+$/.test(idorvanity.trim()) ? idorvanity.trim() : undefined;
        const canonicalUrl = scope
          ? `https://www.facebook.com/groups/${scope}/posts/${postId}`
          : `https://www.facebook.com/permalink.php?story_fbid=${postId}`;
        return {
          platform: "facebook",
          postId,
          scope,
          canonicalUrl,
          rawUrl: trimmed,
        };
      }
      return null;
    }

    // 1. Explicit negative filter: profiles without posts, photos, media, videos, watch, stories, reels, navigation, group subpages
    if (
      /^\/(?:photo|photos|media|videos|video|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace|search|friends|settings|help|login|recover|pages|share)\b/i.test(
        pathname,
      ) ||
      /\/(?:photo|photos|media|videos|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace)\b/i.test(
        pathname,
      ) ||
      /^\/groups\/[^/]+\/(?:about|members|media|files|events|announcements_rules|discussion|buy_sell_discussion)\b/i.test(
        pathname,
      )
    ) {
      return null;
    }

    // 2. Facebook Group Posts & Group Permalinks:
    // A. /groups/{groupIdOrSlug}/posts/{postId}/
    // B. /groups/{groupIdOrSlug}/permalink/{postId}/
    const groupMatch = /^\/groups\/([^/]+)\/(?:posts|permalink)\/([0-9a-zA-Z_-]+)\/?$/i.exec(pathname);
    if (groupMatch) {
      const scope = groupMatch[1];
      const postId = groupMatch[2];
      return {
        platform: "facebook",
        postId,
        scope,
        canonicalUrl: `https://www.facebook.com/groups/${scope}/posts/${postId}`,
        rawUrl: trimmed,
      };
    }

    // 3. Facebook Page / Profile Posts:
    // C. /{pageOrUsername}/posts/{postId}/
    const userPostMatch = /^\/([a-zA-Z0-9._-]+)\/posts\/([0-9a-zA-Z_-]+)\/?$/i.exec(pathname);
    if (userPostMatch) {
      const scope = userPostMatch[1];
      const postId = userPostMatch[2];
      if (
        !/^(?:home|groups|settings|help|login|recover|pages|share|marketplace|watch|gaming|bookmarks|friends|messages|notifications|events|stories|reels|reel|photo|photos|media|videos|hashtag|search)$/i.test(
          scope,
        )
      ) {
        return {
          platform: "facebook",
          postId,
          scope,
          canonicalUrl: `https://www.facebook.com/${scope}/posts/${postId}`,
          rawUrl: trimmed,
        };
      }
    }

    // 4. Query-based posts:
    // D. permalink.php?story_fbid={postId}&id={ownerId}
    // E. story.php?story_fbid={postId}&id={ownerId}
    // and profile.php?id={ownerId}&story_fbid={postId}
    if (/^\/(?:permalink|story|profile)\.php$/i.test(pathname)) {
      const fbid = parsed.searchParams.get("story_fbid") || parsed.searchParams.get("fbid");
      const ownerId = parsed.searchParams.get("id");
      if (fbid && /^[0-9a-zA-Z_-]+$/.test(fbid)) {
        const canonical = `https://www.facebook.com/permalink.php?story_fbid=${fbid}${ownerId ? `&id=${ownerId}` : ""}`;
        return {
          platform: "facebook",
          postId: fbid,
          scope: ownerId || undefined,
          canonicalUrl: canonical,
          rawUrl: trimmed,
        };
      }
    }

    return null;
  }
}

/**
 * Returns raw browser JS code for extracting Facebook post permalinks inside Chromium.
 * Guaranteed to share the exact same parsing rules with FacebookPermalinkAdapter.
 */
export function buildFacebookPermalinkExtractorJs(): string {
  return `function extractFacebookPost(href, baseOrigin) {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return null;

    let parsed;
    try {
      parsed = new URL(trimmed, baseOrigin || location.origin);
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!/(?:^|\\.)(?:facebook\\.com|fb\\.com)$/.test(hostname)) return null;

    const pathname = parsed.pathname;

    if (/^\\/(?:photo|photo\\.php)\\/?$/i.test(pathname)) {
      const setParam = parsed.searchParams.get("set");
      const match = setParam ? /^(?:gm|pcb)\\.([0-9a-zA-Z_-]+)$/.exec(setParam.trim()) : null;
      if (match && match[1]) {
        const postId = match[1];
        const idorvanity = parsed.searchParams.get("idorvanity");
        const scope = (idorvanity && /^[0-9a-zA-Z._-]+$/.test(idorvanity.trim())) ? idorvanity.trim() : undefined;
        const canonicalUrl = scope
          ? 'https://www.facebook.com/groups/' + scope + '/posts/' + postId
          : 'https://www.facebook.com/permalink.php?story_fbid=' + postId;
        return {
          platform: "facebook",
          postId: postId,
          scope: scope,
          canonicalUrl: canonicalUrl,
          rawUrl: trimmed
        };
      }
      return null;
    }

    if (/^\\/(?:photo|photos|media|videos|video|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace|search|friends|settings|help|login|recover|pages|share)\\b/i.test(pathname) ||
        /\\/(?:photo|photos|media|videos|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace)\\b/i.test(pathname) ||
        /^\\/groups\\/[^/]+\\/(?:about|members|media|files|events|announcements_rules|discussion|buy_sell_discussion)\\b/i.test(pathname)) {
      return null;
    }

    const groupMatch = /^\\/groups\\/([^/]+)\\/(?:posts|permalink)\\/([0-9a-zA-Z_-]+)\\/?$/i.exec(pathname);
    if (groupMatch) {
      const scope = groupMatch[1];
      const postId = groupMatch[2];
      return {
        platform: "facebook",
        postId: postId,
        scope: scope,
        canonicalUrl: 'https://www.facebook.com/groups/' + scope + '/posts/' + postId,
        rawUrl: trimmed
      };
    }

    const userPostMatch = /^\\/([a-zA-Z0-9._-]+)\\/posts\\/([0-9a-zA-Z_-]+)\\/?$/i.exec(pathname);
    if (userPostMatch) {
      const scope = userPostMatch[1];
      const postId = userPostMatch[2];
      if (!/^(?:home|groups|settings|help|login|recover|pages|share|marketplace|watch|gaming|bookmarks|friends|messages|notifications|events|stories|reels|reel|photo|photos|media|videos|hashtag|search)$/i.test(scope)) {
        return {
          platform: "facebook",
          postId: postId,
          scope: scope,
          canonicalUrl: 'https://www.facebook.com/' + scope + '/posts/' + postId,
          rawUrl: trimmed
        };
      }
    }

    if (/^\\/(?:permalink|story|profile)\\.php$/i.test(pathname)) {
      const fbid = parsed.searchParams.get("story_fbid") || parsed.searchParams.get("fbid");
      const ownerId = parsed.searchParams.get("id");
      if (fbid && /^[0-9a-zA-Z_-]+$/.test(fbid)) {
        const canonical = 'https://www.facebook.com/permalink.php?story_fbid=' + fbid + (ownerId ? '&id=' + ownerId : '');
        return {
          platform: "facebook",
          postId: fbid,
          scope: ownerId || undefined,
          canonicalUrl: canonical,
          rawUrl: trimmed
        };
      }
    }

    return null;
  }`;
}

export class ThreadsPermalinkAdapter implements PlatformPermalinkAdapter {
  readonly platform = "threads" as const;

  matchesPlatform(urlOrHost: string): boolean {
    return /(?:threads\.net|threads\.com)/i.test(urlOrHost);
  }

  extractPostIdentity(href: string, basePageUrl = "https://www.threads.net/"): PostIdentity | null {
    if (!href || typeof href !== "string") return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return null;

    let parsed: URL;
    try {
      parsed = new URL(trimmed, basePageUrl);
    } catch {
      return null;
    }

    if (!/(?:threads\.net|threads\.com)$/i.test(parsed.hostname)) {
      return null;
    }

    const pathname = parsed.pathname;

    // Pattern: /@username/post/{postId}
    const match = /^\/@([a-zA-Z0-9._-]+)\/post\/([0-9a-zA-Z_-]+)/i.exec(pathname);
    if (match) {
      const username = match[1];
      const postId = match[2];
      return {
        platform: "threads",
        postId,
        scope: `@${username}`,
        canonicalUrl: `https://www.threads.net/@${username}/post/${postId}`,
        rawUrl: trimmed,
      };
    }

    return null;
  }
}

export function createDefaultPermalinkAdapters(): PlatformPermalinkAdapter[] {
  return [new FacebookPermalinkAdapter(), new ThreadsPermalinkAdapter()];
}

export function findPermalinkAdapter(urlOrHost: string, adapters = createDefaultPermalinkAdapters()): PlatformPermalinkAdapter | null {
  return adapters.find((adapter) => adapter.matchesPlatform(urlOrHost)) ?? null;
}
