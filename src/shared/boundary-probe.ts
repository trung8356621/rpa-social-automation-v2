import type { PlatformPermalinkAdapter, PostIdentity } from "./permalink-adapter.js";

export type BoundaryStatus = "BOUNDARY_FOUND" | "BOUNDARY_AMBIGUOUS" | "BOUNDARY_NOT_FOUND";

export interface ContainerElementInfo {
  level: number;
  tag: string;
  id: string;
  className: string;
  role: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

export interface AncestorStep {
  level: number;
  tag: string;
  id: string;
  className: string;
  role: string | null;
  rect: { x: number; y: number; width: number; height: number };
  postIdentities: PostIdentity[];
  uniqueKeys: string[];
  hasNestedArticle: boolean;
  hasQuoteOrReplyHint: boolean;
}

export interface BoundaryProbeResult {
  status: BoundaryStatus;
  actionPoint: { x: number; y: number };
  ancestorsChecked: number;
  firstPermalinkLevel: number | null;
  secondPermalinkLevel: number | null;
  boundaryCrossedLevel: number | null;
  postIdentities: PostIdentity[];
  candidateContainer: ContainerElementInfo | null;
  crossedContainer: ContainerElementInfo | null;
  hasQuoteOrSharedPostRisk: boolean;
  riskReason: string | null;
  ownershipEvidence: {
    isArticle: boolean;
    hasDistinctCardLayout: boolean;
    containsActionRow: boolean;
    notes: string[];
  };
}

/**
 * Core Boundary Resolver.
 * Pure logic independent of specific platform regexes.
 * Uses ancestor steps and permalink count transitions:
 * 0 -> 1 -> 2 (BOUNDARY_CROSSED at 2; candidate container at 1).
 */
export function resolveBoundaryFromAncestors(
  ancestors: AncestorStep[],
  actionPoint: { x: number; y: number },
  actionRowRect?: { x: number; y: number; width: number; height: number },
): BoundaryProbeResult {
  let firstPermalinkLevel: number | null = null;
  let secondPermalinkLevel: number | null = null;
  let boundaryCrossedLevel: number | null = null;
  let candidateContainer: ContainerElementInfo | null = null;
  let crossedContainer: ContainerElementInfo | null = null;
  let hasQuoteOrSharedPostRisk = false;
  let riskReason: string | null = null;
  const postIdentitiesMap = new Map<string, PostIdentity>();

  for (let i = 0; i < ancestors.length; i++) {
    const step = ancestors[i];
    for (const id of step.postIdentities) {
      const key = `${id.platform}:${id.postId}`;
      if (!postIdentitiesMap.has(key)) {
        postIdentitiesMap.set(key, id);
      }
    }

    const count = step.uniqueKeys.length;

    if (count >= 1 && firstPermalinkLevel === null) {
      firstPermalinkLevel = step.level;
    }

    if (count >= 2 && secondPermalinkLevel === null) {
      secondPermalinkLevel = step.level;

      // Check transition: did it transition from 1 to 2?
      const prevStep = i > 0 ? ancestors[i - 1] : null;
      if (prevStep && prevStep.uniqueKeys.length === 1) {
        boundaryCrossedLevel = step.level;
        candidateContainer = {
          level: prevStep.level,
          tag: prevStep.tag,
          id: prevStep.id,
          className: prevStep.className,
          role: prevStep.role,
          rect: prevStep.rect,
        };
        crossedContainer = {
          level: step.level,
          tag: step.tag,
          id: step.id,
          className: step.className,
          role: step.role,
          rect: step.rect,
        };

        if (prevStep.hasNestedArticle || prevStep.hasQuoteOrReplyHint) {
          hasQuoteOrSharedPostRisk = true;
          riskReason = "Candidate subtree contains nested article or quote/reply indicator (risk of false boundary)";
        }
      } else {
        // Count jumped directly from 0 to >= 2 (e.g. without single post state)
        boundaryCrossedLevel = step.level;
        crossedContainer = {
          level: step.level,
          tag: step.tag,
          id: step.id,
          className: step.className,
          role: step.role,
          rect: step.rect,
        };
        hasQuoteOrSharedPostRisk = true;
        riskReason = "Permalink count transitioned directly from 0 to >= 2 without intermediate single-post state";
      }
      break;
    }
  }

  const postIdentities = [...postIdentitiesMap.values()];

  // Evaluate ownership evidence
  const notes: string[] = [];
  let isArticle = false;
  let hasDistinctCardLayout = false;
  let containsActionRow = false;

  if (candidateContainer) {
    isArticle = candidateContainer.role === "article" || candidateContainer.tag.toLowerCase() === "article";
    if (isArticle) notes.push("Element has semantic role=article or <article> tag");

    const r = candidateContainer.rect;
    hasDistinctCardLayout = r.width >= 200 && r.height >= 80 && !["body", "html", "main"].includes(candidateContainer.tag.toLowerCase());
    if (hasDistinctCardLayout) notes.push(`Valid card dimensions ${Math.round(r.width)}×${Math.round(r.height)}`);
    else notes.push(`Invalid or trivial container dimensions ${Math.round(r.width)}×${Math.round(r.height)}`);

    if (actionRowRect) {
      // Bounding box inclusion with 6px padding tolerance
      const tol = 6;
      containsActionRow =
        r.x <= actionRowRect.x + tol &&
        r.y <= actionRowRect.y + tol &&
        r.x + r.width >= actionRowRect.x + actionRowRect.width - tol &&
        r.y + r.height >= actionRowRect.y + actionRowRect.height - tol;
      if (containsActionRow) notes.push("Candidate container encloses action row");
      else notes.push("Candidate container does not fully enclose action row");
    } else {
      containsActionRow = true;
    }
  }

  // Determine final status
  let status: BoundaryStatus;
  if (!candidateContainer || boundaryCrossedLevel === null) {
    status = "BOUNDARY_NOT_FOUND";
    riskReason ??= firstPermalinkLevel === null
      ? "No valid post permalinks found in ancestor subtree"
      : "Single permalink found but no 1->2 boundary crossing occurred within inspected ancestors";
  } else if (hasQuoteOrSharedPostRisk || !containsActionRow || !hasDistinctCardLayout) {
    status = "BOUNDARY_AMBIGUOUS";
    riskReason ??= !containsActionRow
      ? "Candidate does not enclose action row"
      : !hasDistinctCardLayout
        ? "Candidate lacks card-like layout boundaries"
        : "Ambiguous boundary transition";
  } else {
    // Only BOUNDARY_FOUND when candidate has verified ownership evidence
    status = "BOUNDARY_FOUND";
  }

  return {
    status,
    actionPoint,
    ancestorsChecked: ancestors.length,
    firstPermalinkLevel,
    secondPermalinkLevel,
    boundaryCrossedLevel,
    postIdentities,
    candidateContainer,
    crossedContainer,
    hasQuoteOrSharedPostRisk,
    riskReason,
    ownershipEvidence: {
      isArticle,
      hasDistinctCardLayout,
      containsActionRow,
      notes,
    },
  };
}

/**
 * Script executed inside the target WebContents to perform DOM hit-test,
 * ancestor traversal, permalink filtering, and optional visual highlighting.
 */
export function buildBoundaryProbeScript(
  point: { x: number; y: number },
  actionRowBbox?: { x: number; y: number; width: number; height: number },
  options: { highlight?: boolean } = {},
): string {
  return `(() => {
    const point = ${JSON.stringify(point)};
    const actionRowBbox = ${JSON.stringify(actionRowBbox ?? null)};
    const highlight = ${JSON.stringify(options.highlight ?? true)};

    // Clean up any stale highlights first
    document.querySelectorAll('[data-boundary-probe-highlight]').forEach(n => n.remove());

    let el = document.elementFromPoint(point.x, point.y);
    if (!el) {
      return {
        status: "BOUNDARY_NOT_FOUND",
        actionPoint: point,
        ancestorsChecked: 0,
        firstPermalinkLevel: null,
        secondPermalinkLevel: null,
        boundaryCrossedLevel: null,
        postIdentities: [],
        candidateContainer: null,
        crossedContainer: null,
        hasQuoteOrSharedPostRisk: false,
        riskReason: "No DOM element found at hit-test point",
        ownershipEvidence: { isArticle: false, hasDistinctCardLayout: false, containsActionRow: false, notes: ["Hit-test returned null"] }
      };
    }

    // Platform-specific permalink extractor
    const pageUrl = location.href;
    const isFacebook = /(?:facebook\\.com|fb\\.com)/i.test(location.hostname);
    const isThreads = /(?:threads\\.net|threads\\.com)/i.test(location.hostname);

    function extractPost(href) {
      if (!href || typeof href !== 'string') return null;
      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return null;

      let parsed;
      try { parsed = new URL(trimmed, location.origin); } catch { return null; }

      if (isFacebook) {
        if (!/(?:facebook\\.com|fb\\.com)$/i.test(parsed.hostname)) return null;
        const p = parsed.pathname;
        if (/\\/(?:photo|photos|media|videos|watch|stories|reels|reel|hashtag|events|messages|notifications|marketplace|groups\\/[^/]+\\/(?:about|members|media|files))\\b/i.test(p)) return null;

        const gm = /^\\/groups\\/([^/]+)\\/(?:posts|permalink)\\/([0-9a-zA-Z_-]+)/i.exec(p);
        if (gm) return { platform: "facebook", scope: gm[1], postId: gm[2], canonicalUrl: 'https://www.facebook.com/groups/' + gm[1] + '/posts/' + gm[2], rawUrl: trimmed };

        const um = /^\\/([a-zA-Z0-9._-]+)\\/posts\\/([0-9a-zA-Z_-]+)/i.exec(p);
        if (um && !/^(?:home|groups|settings|help|login|recover|pages|share)$/i.test(um[1])) {
          return { platform: "facebook", scope: um[1], postId: um[2], canonicalUrl: 'https://www.facebook.com/' + um[1] + '/posts/' + um[2], rawUrl: trimmed };
        }

        if (/^\\/(?:permalink|story)\\.php$/i.test(p)) {
          const fbid = parsed.searchParams.get("story_fbid") || parsed.searchParams.get("fbid");
          if (fbid && /^[0-9a-zA-Z_-]+$/.test(fbid)) {
            return { platform: "facebook", postId: fbid, scope: parsed.searchParams.get("id") || undefined, canonicalUrl: 'https://www.facebook.com/permalink.php?story_fbid=' + fbid, rawUrl: trimmed };
          }
        }
      } else if (isThreads) {
        if (!/(?:threads\\.net|threads\\.com)$/i.test(parsed.hostname)) return null;
        const tm = /^\\/@([a-zA-Z0-9._-]+)\\/post\\/([0-9a-zA-Z_-]+)/i.exec(parsed.pathname);
        if (tm) return { platform: "threads", scope: '@' + tm[1], postId: tm[2], canonicalUrl: 'https://www.threads.net/@' + tm[1] + '/post/' + tm[2], rawUrl: trimmed };
      }
      return null;
    }

    const ancestors = [];
    let curr = el;
    let level = 0;

    while (curr && curr !== document.documentElement && level < 35) {
      const anchors = (curr.tagName && curr.tagName.toLowerCase() === 'a' && curr.hasAttribute('href'))
        ? [curr, ...Array.from(curr.querySelectorAll('a[href]'))]
        : Array.from(curr.querySelectorAll('a[href]'));
      const posts = [];
      const keys = new Set();

      for (const a of anchors) {
        const item = extractPost(a.getAttribute('href') || a.href);
        if (item) {
          const k = item.platform + ':' + item.postId;
          if (!keys.has(k)) {
            keys.add(k);
            posts.push(item);
          }
        }
      }

      const rect = curr.getBoundingClientRect();
      const hasNestedArticle = Boolean(curr.querySelector('[role="article"] [role="article"], article article'));
      const text = (curr.innerText || '').slice(0, 300);
      const hasQuoteOrReplyHint = /\\b(?:trả lời|reply|chia sẻ lại|reposted|quoted)\\b/i.test(text);

      ancestors.push({
        level,
        tag: curr.tagName.toLowerCase(),
        id: curr.id || '',
        className: (curr.className && typeof curr.className === 'string') ? curr.className.slice(0, 100) : '',
        role: curr.getAttribute('role'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        postIdentities: posts,
        uniqueKeys: Array.from(keys),
        hasNestedArticle,
        hasQuoteOrReplyHint,
      });

      // Stop once we crossed into multiple posts and have a parent
      if (keys.size >= 2 && level >= 3) break;

      curr = curr.parentElement;
      level++;
    }

    // Solve boundary from ancestor steps
    let firstPermalinkLevel = null;
    let secondPermalinkLevel = null;
    let boundaryCrossedLevel = null;
    let candidateContainer = null;
    let crossedContainer = null;
    let hasQuoteOrSharedPostRisk = false;
    let riskReason = null;
    const postIdentitiesMap = new Map();

    for (let i = 0; i < ancestors.length; i++) {
      const step = ancestors[i];
      for (const id of step.postIdentities) {
        const key = id.platform + ':' + id.postId;
        if (!postIdentitiesMap.has(key)) postIdentitiesMap.set(key, id);
      }

      const count = step.uniqueKeys.length;
      if (count >= 1 && firstPermalinkLevel === null) firstPermalinkLevel = step.level;

      if (count >= 2 && secondPermalinkLevel === null) {
        secondPermalinkLevel = step.level;
        const prevStep = i > 0 ? ancestors[i - 1] : null;
        if (prevStep && prevStep.uniqueKeys.length === 1) {
          boundaryCrossedLevel = step.level;
          candidateContainer = {
            level: prevStep.level,
            tag: prevStep.tag,
            id: prevStep.id,
            className: prevStep.className,
            role: prevStep.role,
            rect: prevStep.rect
          };
          crossedContainer = {
            level: step.level,
            tag: step.tag,
            id: step.id,
            className: step.className,
            role: step.role,
            rect: step.rect
          };
          if (prevStep.hasNestedArticle || prevStep.hasQuoteOrReplyHint) {
            hasQuoteOrSharedPostRisk = true;
            riskReason = "Candidate subtree contains nested article or quote/reply indicator";
          }
        } else {
          boundaryCrossedLevel = step.level;
          crossedContainer = {
            level: step.level,
            tag: step.tag,
            id: step.id,
            className: step.className,
            role: step.role,
            rect: step.rect
          };
          hasQuoteOrSharedPostRisk = true;
          riskReason = "Permalink count jumped directly from 0 to >= 2";
        }
        break;
      }
    }

    const postIdentities = Array.from(postIdentitiesMap.values());
    const notes = [];
    let isArticle = false;
    let hasDistinctCardLayout = false;
    let containsActionRow = false;

    if (candidateContainer) {
      isArticle = candidateContainer.role === "article" || candidateContainer.tag.toLowerCase() === "article";
      if (isArticle) notes.push("role=article confirmed");

      const r = candidateContainer.rect;
      hasDistinctCardLayout = r.width >= 200 && r.height >= 80 && !["body", "html", "main"].includes(candidateContainer.tag.toLowerCase());
      if (hasDistinctCardLayout) notes.push("Card layout: " + Math.round(r.width) + "x" + Math.round(r.height));

      if (actionRowBbox) {
        const tol = 8;
        containsActionRow =
          r.x <= actionRowBbox.x + tol &&
          r.y <= actionRowBbox.y + tol &&
          r.x + r.width >= actionRowBbox.x + actionRowBbox.width - tol &&
          r.y + r.height >= actionRowBbox.y + actionRowBbox.height - tol;
        if (containsActionRow) notes.push("Encloses action row");
      } else {
        containsActionRow = true;
      }
    }

    let status = "BOUNDARY_NOT_FOUND";
    if (!candidateContainer || boundaryCrossedLevel === null) {
      status = "BOUNDARY_NOT_FOUND";
      riskReason = riskReason || (firstPermalinkLevel === null ? "No valid post permalinks found" : "Single permalink found, no 1->2 boundary crossing");
    } else if (hasQuoteOrSharedPostRisk || !containsActionRow || !hasDistinctCardLayout) {
      status = "BOUNDARY_AMBIGUOUS";
      riskReason = riskReason || (!containsActionRow ? "Candidate does not enclose action row" : "Ambiguous boundary");
    } else {
      status = "BOUNDARY_FOUND";
    }

    // Apply temporary overlays if highlight option requested
    if (highlight) {
      const isVerified = status === "BOUNDARY_FOUND";
      const borderColor = isVerified ? "#22c55e" : "#eab308";
      const bgColor = isVerified ? "rgba(34, 197, 94, 0.08)" : "rgba(234, 179, 8, 0.08)";

      if (candidateContainer) {
        const box = document.createElement("div");
        box.dataset.boundaryProbeHighlight = "true";
        Object.assign(box.style, {
          position: "fixed",
          left: candidateContainer.rect.x + "px",
          top: candidateContainer.rect.y + "px",
          width: candidateContainer.rect.width + "px",
          height: candidateContainer.rect.height + "px",
          border: "3px solid " + borderColor,
          backgroundColor: bgColor,
          zIndex: "2147483646",
          pointerEvents: "none",
          boxSizing: "border-box"
        });
        const tag = document.createElement("div");
        tag.innerText = (isVerified ? "Post Container [BOUNDARY_FOUND]" : "Candidate Container [" + status + "]") + " L" + candidateContainer.level;
        Object.assign(tag.style, {
          position: "absolute",
          top: "-22px",
          left: "0px",
          background: borderColor,
          color: "#000",
          fontSize: "11px",
          fontWeight: "bold",
          padding: "2px 6px",
          borderRadius: "3px",
          pointerEvents: "none"
        });
        box.appendChild(tag);
        document.documentElement.appendChild(box);
      }

      if (crossedContainer) {
        const crossed = document.createElement("div");
        crossed.dataset.boundaryProbeHighlight = "true";
        Object.assign(crossed.style, {
          position: "fixed",
          left: crossedContainer.rect.x + "px",
          top: crossedContainer.rect.y + "px",
          width: crossedContainer.rect.width + "px",
          height: crossedContainer.rect.height + "px",
          border: "2px dashed #ef4444",
          backgroundColor: "rgba(239, 68, 68, 0.04)",
          zIndex: "2147483645",
          pointerEvents: "none",
          boxSizing: "border-box"
        });
        const tag = document.createElement("div");
        tag.innerText = "Crossed Boundary [L" + crossedContainer.level + " >= 2 posts]";
        Object.assign(tag.style, {
          position: "absolute",
          bottom: "-20px",
          right: "0px",
          background: "#ef4444",
          color: "#fff",
          fontSize: "10px",
          fontWeight: "bold",
          padding: "1px 5px",
          borderRadius: "2px",
          pointerEvents: "none"
        });
        crossed.appendChild(tag);
        document.documentElement.appendChild(crossed);
      }

      if (actionRowBbox) {
        const row = document.createElement("div");
        row.dataset.boundaryProbeHighlight = "true";
        Object.assign(row.style, {
          position: "fixed",
          left: actionRowBbox.x + "px",
          top: actionRowBbox.y + "px",
          width: actionRowBbox.width + "px",
          height: actionRowBbox.height + "px",
          border: "2px solid #3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.15)",
          zIndex: "2147483647",
          pointerEvents: "none",
          boxSizing: "border-box"
        });
        document.documentElement.appendChild(row);
      }
    }

    return {
      status,
      actionPoint: point,
      ancestorsChecked: ancestors.length,
      firstPermalinkLevel,
      secondPermalinkLevel,
      boundaryCrossedLevel,
      postIdentities,
      candidateContainer,
      crossedContainer,
      hasQuoteOrSharedPostRisk,
      riskReason,
      ownershipEvidence: {
        isArticle,
        hasDistinctCardLayout,
        containsActionRow,
        notes
      }
    };
  })()`;
}

export function buildRemoveBoundaryHighlightsScript(): string {
  return `(() => {
    document.querySelectorAll('[data-boundary-probe-highlight]').forEach(n => n.remove());
    return true;
  })()`;
}
