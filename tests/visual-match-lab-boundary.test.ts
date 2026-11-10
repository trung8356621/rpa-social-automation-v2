import assert from "node:assert/strict";
import test from "node:test";
import {
  FacebookPermalinkAdapter,
  ThreadsPermalinkAdapter,
  findPermalinkAdapter,
} from "../src/shared/permalink-adapter.js";
import {
  resolveBoundaryFromAncestors,
  buildBoundaryProbeScript,
  buildRemoveBoundaryHighlightsScript,
  type AncestorStep,
} from "../src/shared/boundary-probe.js";

test("FacebookPermalinkAdapter extracts group post permalinks and strips queries and hashes", () => {
  const adapter = new FacebookPermalinkAdapter();
  assert.equal(adapter.matchesPlatform("https://www.facebook.com/groups/123/posts/456"), true);
  assert.equal(adapter.matchesPlatform("https://fb.com"), true);
  assert.equal(adapter.matchesPlatform("https://threads.net"), false);

  const parsed = adapter.extractPostIdentity(
    "/groups/mmo_community/posts/101589324789/?comment_id=456&notif_t=feedback#top",
    "https://www.facebook.com/",
  );
  assert.notEqual(parsed, null);
  assert.equal(parsed?.platform, "facebook");
  assert.equal(parsed?.postId, "101589324789");
  assert.equal(parsed?.scope, "mmo_community");
  assert.equal(parsed?.canonicalUrl, "https://www.facebook.com/groups/mmo_community/posts/101589324789");
});

test("FacebookPermalinkAdapter extracts user posts and query permalinks", () => {
  const adapter = new FacebookPermalinkAdapter();

  const userPost = adapter.extractPostIdentity("https://www.facebook.com/zuck/posts/10114881478201?ref=share");
  assert.notEqual(userPost, null);
  assert.equal(userPost?.postId, "10114881478201");
  assert.equal(userPost?.scope, "zuck");
  assert.equal(userPost?.canonicalUrl, "https://www.facebook.com/zuck/posts/10114881478201");

  const queryPost = adapter.extractPostIdentity("/permalink.php?story_fbid=987654321&id=10001");
  assert.notEqual(queryPost, null);
  assert.equal(queryPost?.postId, "987654321");
  assert.equal(queryPost?.canonicalUrl, "https://www.facebook.com/permalink.php?story_fbid=987654321");
});

test("FacebookPermalinkAdapter rejects non-post URLs, profiles, photos, and navigation", () => {
  const adapter = new FacebookPermalinkAdapter();

  // Photo
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo.php?fbid=123"), null);
  assert.equal(adapter.extractPostIdentity("/zuck/photos/a.123/456/"), null);

  // Profile only
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/zuck"), null);
  assert.equal(adapter.extractPostIdentity("/groups/mmo_community/"), null);

  // Navigation
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/friends/requests"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/notifications"), null);
  assert.equal(adapter.extractPostIdentity("#"), null);
  assert.equal(adapter.extractPostIdentity("javascript:void(0)"), null);
});

test("ThreadsPermalinkAdapter extracts post permalinks and rejects profile/nav links", () => {
  const adapter = new ThreadsPermalinkAdapter();
  assert.equal(adapter.matchesPlatform("https://www.threads.net/@zuck/post/C_12345Abc"), true);

  const post = adapter.extractPostIdentity("https://www.threads.net/@alice.dev/post/C_998877?hl=vi#comments");
  assert.notEqual(post, null);
  assert.equal(post?.platform, "threads");
  assert.equal(post?.postId, "C_998877");
  assert.equal(post?.scope, "@alice.dev");
  assert.equal(post?.canonicalUrl, "https://www.threads.net/@alice.dev/post/C_998877");

  // Rejections
  assert.equal(adapter.extractPostIdentity("https://www.threads.net/@alice.dev"), null);
  assert.equal(adapter.extractPostIdentity("https://www.threads.net/@alice.dev/replies"), null);
  assert.equal(adapter.extractPostIdentity("https://www.threads.net/search"), null);
});

test("findPermalinkAdapter selects matching adapter by URL or hostname", () => {
  assert.equal(findPermalinkAdapter("https://www.facebook.com/feed")?.platform, "facebook");
  assert.equal(findPermalinkAdapter("https://www.threads.net/@zuck")?.platform, "threads");
  assert.equal(findPermalinkAdapter("https://example.com"), null);
});

test("resolveBoundaryFromAncestors identifies BOUNDARY_FOUND when permalink count transitions from 1 to 2", () => {
  const p1 = { platform: "facebook" as const, postId: "post_100", canonicalUrl: "https://fb.com/p/100", rawUrl: "/p/100" };
  const p2 = { platform: "facebook" as const, postId: "post_200", canonicalUrl: "https://fb.com/p/200", rawUrl: "/p/200" };

  const ancestors: AncestorStep[] = [
    { level: 0, tag: "span", id: "", className: "like-btn", role: null, rect: { x: 200, y: 300, width: 60, height: 24 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 1, tag: "div", id: "", className: "action-row", role: null, rect: { x: 190, y: 295, width: 200, height: 34 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 2, tag: "div", id: "", className: "card-body", role: null, rect: { x: 180, y: 150, width: 500, height: 200 }, postIdentities: [p1], uniqueKeys: ["facebook:post_100"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 3, tag: "div", id: "post-100", className: "post-card", role: "article", rect: { x: 180, y: 100, width: 500, height: 260 }, postIdentities: [p1], uniqueKeys: ["facebook:post_100"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 4, tag: "div", id: "", className: "feed-container", role: "feed", rect: { x: 180, y: 0, width: 500, height: 800 }, postIdentities: [p1, p2], uniqueKeys: ["facebook:post_100", "facebook:post_200"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
  ];

  const actionRowRect = { x: 190, y: 295, width: 200, height: 34 };
  const result = resolveBoundaryFromAncestors(ancestors, { x: 230, y: 312 }, actionRowRect);

  assert.equal(result.status, "BOUNDARY_FOUND");
  assert.equal(result.firstPermalinkLevel, 2);
  assert.equal(result.secondPermalinkLevel, 4);
  assert.equal(result.boundaryCrossedLevel, 4);
  assert.equal(result.candidateContainer?.level, 3);
  assert.equal(result.candidateContainer?.role, "article");
  assert.equal(result.candidateContainer?.id, "post-100");
  assert.equal(result.crossedContainer?.level, 4);
  assert.equal(result.hasQuoteOrSharedPostRisk, false);
});

test("resolveBoundaryFromAncestors flags BOUNDARY_AMBIGUOUS when nested quote or reply risk is present", () => {
  const p1 = { platform: "facebook" as const, postId: "post_100", canonicalUrl: "https://fb.com/p/100", rawUrl: "/p/100" };
  const p2 = { platform: "facebook" as const, postId: "post_quoted_999", canonicalUrl: "https://fb.com/p/999", rawUrl: "/p/999" };

  const ancestors: AncestorStep[] = [
    { level: 0, tag: "button", id: "", className: "like", role: "button", rect: { x: 200, y: 300, width: 60, height: 24 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 1, tag: "div", id: "", className: "quote-container", role: "article", rect: { x: 180, y: 100, width: 500, height: 250 }, postIdentities: [p1], uniqueKeys: ["facebook:post_100"], hasNestedArticle: true, hasQuoteOrReplyHint: true },
    { level: 2, tag: "div", id: "", className: "outer-feed", role: "feed", rect: { x: 180, y: 0, width: 500, height: 600 }, postIdentities: [p1, p2], uniqueKeys: ["facebook:post_100", "facebook:post_quoted_999"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
  ];

  const result = resolveBoundaryFromAncestors(ancestors, { x: 230, y: 312 });
  assert.equal(result.status, "BOUNDARY_AMBIGUOUS");
  assert.equal(result.hasQuoteOrSharedPostRisk, true);
  assert.match(result.riskReason ?? "", /nested article|quote/i);
});

test("resolveBoundaryFromAncestors returns BOUNDARY_NOT_FOUND when permalink transition to 2 never occurs", () => {
  const p1 = { platform: "facebook" as const, postId: "post_alone", canonicalUrl: "https://fb.com/p/alone", rawUrl: "/p/alone" };

  // Case 1: single post up to root
  const ancestors1: AncestorStep[] = [
    { level: 0, tag: "div", id: "", className: "action", role: null, rect: { x: 100, y: 100, width: 100, height: 30 }, postIdentities: [p1], uniqueKeys: ["facebook:post_alone"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 1, tag: "div", id: "", className: "card", role: "article", rect: { x: 100, y: 50, width: 500, height: 300 }, postIdentities: [p1], uniqueKeys: ["facebook:post_alone"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
  ];
  const result1 = resolveBoundaryFromAncestors(ancestors1, { x: 150, y: 115 });
  assert.equal(result1.status, "BOUNDARY_NOT_FOUND");
  assert.equal(result1.candidateContainer, null);

  // Case 2: zero permalinks
  const ancestors2: AncestorStep[] = [
    { level: 0, tag: "div", id: "", className: "random", role: null, rect: { x: 100, y: 100, width: 50, height: 20 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
  ];
  const result2 = resolveBoundaryFromAncestors(ancestors2, { x: 120, y: 110 });
  assert.equal(result2.status, "BOUNDARY_NOT_FOUND");
  assert.match(result2.riskReason ?? "", /No valid post permalinks found/i);
});

test("buildBoundaryProbeScript and buildRemoveBoundaryHighlightsScript produce clean scripts", () => {
  const probeScript = buildBoundaryProbeScript({ x: 400, y: 200 }, { x: 300, y: 180, width: 200, height: 40 }, { highlight: true });
  assert.match(probeScript, /document\.elementFromPoint\(point\.x, point\.y\)/);
  assert.match(probeScript, /data-boundary-probe-highlight/);
  assert.match(probeScript, /pointerEvents:\s*"none"/i);
  assert.match(probeScript, /position:\s*"fixed"/i);

  const cleanupScript = buildRemoveBoundaryHighlightsScript();
  assert.match(cleanupScript, /data-boundary-probe-highlight/);
  assert.match(cleanupScript, /remove\(\)/);
});
