import { buildFacebookPermalinkExtractorJs } from "./permalink-adapter.js";

/**
 * READ-ONLY runtime diagnostic for missing permalinks in feed cards.
 * Lists every <a href> inside each feed card intersecting the viewport and
 * classifies it with the same Facebook parser used by the Boundary probe.
 * Never clicks, navigates or mutates the DOM.
 */
export type PermalinkRejectionReason =
  | "ACCEPTED_POST"
  | "ACCEPTED_COMMENT_PERMALINK"
  | "PLACEHOLDER_HASH"
  | "QUERY_ONLY_PLACEHOLDER"
  | "GROUP_MEMBER"
  | "GROUP_HOME"
  | "HASHTAG"
  | "PROFILE_OR_PAGE"
  | "NON_FACEBOOK"
  | "UNRECOGNIZED";

export interface PermalinkDiagnosticAnchor {
  cardIndex: number;
  anchorIndex: number;
  rawHref: string;
  normalizedHref: string;
  classification: PermalinkRejectionReason;
  postIdentity: { platform: string; postId: string; scope?: string } | null;
  rejectionReason: string | null;
  text: string;
  ariaLabel: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
}

export interface PermalinkDiagnosticCard {
  cardIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  textSnippet: string;
  anchorCount: number;
  postIdentityKeys: string[];
  placeholderAnchorCount: number;
}

export interface PermalinkDiagnosticSnapshot {
  pageUrl: string;
  scrollY: number;
  viewport: { width: number; height: number };
  feedFound: boolean;
  cards: PermalinkDiagnosticCard[];
  anchors: PermalinkDiagnosticAnchor[];
}

export interface PermalinkHoverObservation {
  cardIndex: number;
  anchorIndex: number;
  point: { x: number; y: number };
  hrefBefore: string;
  hrefAfter: string | null;
  changed: boolean;
  classificationAfter: PermalinkRejectionReason | null;
  postIdentityAfter: { platform: string; postId: string; scope?: string } | null;
}

/** Shared in-page classifier source (also evaluated in tests via `new Function`). */
export function buildHrefClassifierJs(): string {
  return `${buildFacebookPermalinkExtractorJs()}
  function classifyDiagnosticHref(rawHref, baseUrl) {
    const raw = (rawHref || '').trim();
    if (!raw || raw === '#' || raw.startsWith('#')) {
      return { classification: 'PLACEHOLDER_HASH', normalizedHref: raw, post: null, reason: 'href is empty or a fragment (#); no path to parse' };
    }
    let parsed;
    try { parsed = new URL(raw, baseUrl); } catch (e) {
      return { classification: 'UNRECOGNIZED', normalizedHref: raw, post: null, reason: 'URL parse failed' };
    }
    const normalizedHref = parsed.href;
    if (raw.startsWith('?')) {
      return { classification: 'QUERY_ONLY_PLACEHOLDER', normalizedHref, post: null,
        reason: 'href is query-only (resolves to current page ' + parsed.pathname + '); real permalink is not present in the attribute' };
    }
    if (!/(?:^|\\.)(?:facebook\\.com|fb\\.com)$/i.test(parsed.hostname)) {
      return { classification: 'NON_FACEBOOK', normalizedHref, post: null, reason: 'host ' + parsed.hostname + ' is not Facebook' };
    }
    const post = extractFacebookPost(raw, baseUrl);
    if (post) {
      const isComment = parsed.searchParams.has('comment_id') || parsed.searchParams.has('reply_comment_id');
      return { classification: isComment ? 'ACCEPTED_COMMENT_PERMALINK' : 'ACCEPTED_POST', normalizedHref,
        post: { platform: post.platform, postId: post.postId, scope: post.scope }, reason: null };
    }
    const p = parsed.pathname;
    if (/^\\/groups\\/[^/]+\\/user\\//i.test(p)) return { classification: 'GROUP_MEMBER', normalizedHref, post: null, reason: 'group member/profile link' };
    if (/^\\/hashtag\\//i.test(p)) return { classification: 'HASHTAG', normalizedHref, post: null, reason: 'hashtag link' };
    if (/^\\/groups\\/[^/]+\\/?$/i.test(p)) return { classification: 'GROUP_HOME', normalizedHref, post: null, reason: 'group homepage link' };
    if (/^\\/(?:profile\\.php|[A-Za-z0-9._-]+)\\/?$/.test(p)) return { classification: 'PROFILE_OR_PAGE', normalizedHref, post: null, reason: 'profile/page link' };
    return { classification: 'UNRECOGNIZED', normalizedHref, post: null, reason: 'no permalink rule matched path ' + p };
  }`;
}

export function buildPermalinkDiagnosticScript(): string {
  return `(() => {
    ${buildHrefClassifierJs()}
    const vw = window.innerWidth, vh = window.innerHeight;
    const r2o = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
    let cardEls = [];
    for (const feed of feeds) {
      for (const child of Array.from(feed.children)) {
        const r = child.getBoundingClientRect();
        if (r.height > 0 && r.bottom > 0 && r.top < vh) cardEls.push(child);
      }
    }
    const feedFound = feeds.length > 0;
    if (!feedFound) cardEls = [document.body];
    const cards = [], anchors = [];
    cardEls.forEach((card, cardIndex) => {
      const list = Array.from(card.querySelectorAll('a[href]'));
      const keys = new Set();
      let placeholders = 0;
      list.forEach((a, anchorIndex) => {
        const rawHref = a.getAttribute('href') || '';
        const c = classifyDiagnosticHref(rawHref, location.href);
        if (c.post) keys.add(c.post.platform + ':' + c.post.postId);
        if (c.classification === 'PLACEHOLDER_HASH' || c.classification === 'QUERY_ONLY_PLACEHOLDER') placeholders++;
        const r = a.getBoundingClientRect();
        anchors.push({
          cardIndex, anchorIndex, rawHref: rawHref.slice(0, 400), normalizedHref: c.normalizedHref.slice(0, 400),
          classification: c.classification, postIdentity: c.post, rejectionReason: c.reason,
          text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          ariaLabel: (a.getAttribute('aria-label') || '').slice(0, 80),
          rect: r2o(r), inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
        });
      });
      cards.push({
        cardIndex, rect: r2o(card.getBoundingClientRect()),
        textSnippet: (card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        anchorCount: list.length, postIdentityKeys: Array.from(keys), placeholderAnchorCount: placeholders,
      });
    });
    return { pageUrl: location.href, scrollY: window.scrollY, viewport: { width: vw, height: vh }, feedFound, cards, anchors };
  })()`;
}

/** Read the anchor under a viewport point (after a trusted hover). Read-only. */
export function buildAnchorAtPointScript(x: number, y: number): string {
  return `(() => {
    ${buildHrefClassifierJs()}
    const el = document.elementFromPoint(${Number(x) || 0}, ${Number(y) || 0});
    const a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return null;
    const rawHref = a.getAttribute('href') || '';
    const c = classifyDiagnosticHref(rawHref, location.href);
    return { rawHref: rawHref.slice(0, 400), classification: c.classification, postIdentity: c.post };
  })()`;
}
