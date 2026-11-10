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

    if (!/(?:facebook\.com|fb\.com)$/i.test(parsed.hostname)) {
      return null;
    }

    const pathname = parsed.pathname;

    // 1. Explicit negative filter: photos, media, navigation, interactions, profiles
    if (
      /\/(?:photo|photos|media|videos|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace|groups\/[^/]+\/(?:about|members|media|files))\b/i.test(
        pathname,
      )
    ) {
      return null;
    }

    // 2. Facebook Group Posts: /groups/{group}/posts/{postId} or /groups/{group}/permalink/{postId}
    const groupMatch = /^\/groups\/([^/]+)\/(?:posts|permalink)\/([0-9a-zA-Z_-]+)/i.exec(pathname);
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

    // 3. User / Page Posts: /{username}/posts/{postId}
    const userPostMatch = /^\/([a-zA-Z0-9._-]+)\/posts\/([0-9a-zA-Z_-]+)/i.exec(pathname);
    if (userPostMatch && !/^(?:home|groups|settings|help|login|recover|pages|share)$/i.test(userPostMatch[1])) {
      const scope = userPostMatch[1];
      const postId = userPostMatch[2];
      return {
        platform: "facebook",
        postId,
        scope,
        canonicalUrl: `https://www.facebook.com/${scope}/posts/${postId}`,
        rawUrl: trimmed,
      };
    }

    // 4. Query-based permalinks: permalink.php?story_fbid={id} or story.php?story_fbid={id}
    if (/^\/(?:permalink|story)\.php$/i.test(pathname)) {
      const fbid = parsed.searchParams.get("story_fbid") || parsed.searchParams.get("fbid");
      if (fbid && /^[0-9a-zA-Z_-]+$/.test(fbid)) {
        return {
          platform: "facebook",
          postId: fbid,
          scope: parsed.searchParams.get("id") || undefined,
          canonicalUrl: `https://www.facebook.com/permalink.php?story_fbid=${fbid}`,
          rawUrl: trimmed,
        };
      }
    }

    return null;
  }
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
