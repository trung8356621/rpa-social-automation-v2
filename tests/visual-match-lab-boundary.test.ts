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

test("FacebookPermalinkAdapter extracts all required Facebook permalink formats (A-E)", () => {
  const adapter = new FacebookPermalinkAdapter();

  // A. Facebook Group Post: /groups/{groupIdOrSlug}/posts/{postId}/
  const groupPost1 = adapter.extractPostIdentity("https://www.facebook.com/groups/12345/posts/67890/");
  assert.equal(groupPost1?.platform, "facebook");
  assert.equal(groupPost1?.scope, "12345");
  assert.equal(groupPost1?.postId, "67890");
  assert.equal(groupPost1?.canonicalUrl, "https://www.facebook.com/groups/12345/posts/67890");

  // A with pfbid:
  const groupPostPfbid = adapter.extractPostIdentity(
    "https://www.facebook.com/groups/mmo_community/posts/pfbid02RkWuJ5q7XyZ8aBcD/?__cft__[0]=AZX&__tn__=%2CO%2CP-R"
  );
  assert.equal(groupPostPfbid?.postId, "pfbid02RkWuJ5q7XyZ8aBcD");
  assert.equal(groupPostPfbid?.scope, "mmo_community");
  assert.equal(groupPostPfbid?.canonicalUrl, "https://www.facebook.com/groups/mmo_community/posts/pfbid02RkWuJ5q7XyZ8aBcD");

  // B. Facebook Group Permalink: /groups/{groupIdOrSlug}/permalink/{postId}/
  const groupPermalink = adapter.extractPostIdentity("https://www.facebook.com/groups/mmo_community/permalink/67890/?mibextid=oXZ");
  assert.equal(groupPermalink?.postId, "67890");
  assert.equal(groupPermalink?.scope, "mmo_community");
  // Normalized to posts canonical form
  assert.equal(groupPermalink?.canonicalUrl, "https://www.facebook.com/groups/mmo_community/posts/67890");

  // C. Facebook Page / Profile Post: /{pageOrUsername}/posts/{postId}/
  const userPost1 = adapter.extractPostIdentity("https://www.facebook.com/zuck/posts/10114881478201?ref=share");
  assert.equal(userPost1?.postId, "10114881478201");
  assert.equal(userPost1?.scope, "zuck");
  assert.equal(userPost1?.canonicalUrl, "https://www.facebook.com/zuck/posts/10114881478201");

  const pagePostPfbid = adapter.extractPostIdentity("https://m.facebook.com/vtv24.tintuc/posts/pfbid039XyZ123/?rdid=abc");
  assert.equal(pagePostPfbid?.postId, "pfbid039XyZ123");
  assert.equal(pagePostPfbid?.scope, "vtv24.tintuc");
  assert.equal(pagePostPfbid?.canonicalUrl, "https://www.facebook.com/vtv24.tintuc/posts/pfbid039XyZ123");

  // D. Facebook Legacy Permalink: permalink.php?story_fbid={postId}&id={ownerId}
  const legacyPermalink = adapter.extractPostIdentity("https://www.facebook.com/permalink.php?story_fbid=987654321&id=10001&__cft__[0]=AZX");
  assert.equal(legacyPermalink?.postId, "987654321");
  assert.equal(legacyPermalink?.scope, "10001");
  assert.equal(legacyPermalink?.canonicalUrl, "https://www.facebook.com/permalink.php?story_fbid=987654321&id=10001");

  // E. Facebook Story Link: story.php?story_fbid={postId}&id={ownerId}
  const storyLink = adapter.extractPostIdentity("https://www.facebook.com/story.php?story_fbid=pfbid0Abc123&id=100085421&notif_t=feedback");
  assert.equal(storyLink?.postId, "pfbid0Abc123");
  assert.equal(storyLink?.scope, "100085421");
  // Normalized to canonical permalink.php form
  assert.equal(storyLink?.canonicalUrl, "https://www.facebook.com/permalink.php?story_fbid=pfbid0Abc123&id=100085421");

  // Profile.php with story_fbid
  const profilePost = adapter.extractPostIdentity("https://www.facebook.com/profile.php?id=100085421&story_fbid=pfbid0Abc123");
  assert.equal(profilePost?.postId, "pfbid0Abc123");
  assert.equal(profilePost?.scope, "100085421");
});

test("FacebookPermalinkAdapter deduplicates same post across group post and group permalink formats", () => {
  const adapter = new FacebookPermalinkAdapter();
  const url1 = "https://www.facebook.com/groups/community/posts/55555/";
  const url2 = "https://www.facebook.com/groups/community/permalink/55555/?mibextid=123";

  const p1 = adapter.extractPostIdentity(url1);
  const p2 = adapter.extractPostIdentity(url2);

  assert.notEqual(p1, null);
  assert.notEqual(p2, null);
  assert.equal(p1?.postId, p2?.postId);
  assert.equal(p1?.canonicalUrl, p2?.canonicalUrl);
  assert.equal(`${p1?.platform}:${p1?.postId}`, `${p2?.platform}:${p2?.postId}`);
});

test("FacebookPermalinkAdapter extracts group photo post identity from gm.{postId} and deduplicates", () => {
  const adapter = new FacebookPermalinkAdapter();

  // 1. Valid photo URL with gm.{postId} and idorvanity (like Frame 5 live evidence)
  const validUrl1 = "https://www.facebook.com/photo/?fbid=10229817286489953&set=gm.29295208876831216&idorvanity=295931577185665&__cft__[0]=AZhge30STAoEB4";
  const post1 = adapter.extractPostIdentity(validUrl1);
  assert.notEqual(post1, null);
  assert.equal(post1?.platform, "facebook");
  assert.equal(post1?.postId, "29295208876831216"); // extracted from gm.postId, NOT from fbid
  assert.equal(post1?.scope, "295931577185665");
  assert.equal(post1?.canonicalUrl, "https://www.facebook.com/groups/295931577185665/posts/29295208876831216");

  // Valid photo URL without idorvanity and /photo (no trailing slash)
  const validUrl2 = "https://www.facebook.com/photo?fbid=99999999&set=gm.29295208876831216";
  const post2 = adapter.extractPostIdentity(validUrl2);
  assert.notEqual(post2, null);
  assert.equal(post2?.postId, "29295208876831216");
  assert.equal(post2?.canonicalUrl, "https://www.facebook.com/permalink.php?story_fbid=29295208876831216");

  // Valid photo.php URL
  const validUrl3 = "https://www.facebook.com/photo.php?fbid=88888888&set=gm.29295208876831216&idorvanity=295931577185665";
  const post3 = adapter.extractPostIdentity(validUrl3);
  assert.notEqual(post3, null);
  assert.equal(post3?.postId, "29295208876831216");

  // 4. Multiple photos belonging to same post (different fbid, same gm.postId) deduplicate to same post identity
  const photoA = "https://www.facebook.com/photo/?fbid=10000000001&set=gm.29295208876831216&idorvanity=295931577185665";
  const photoB = "https://www.facebook.com/photo/?fbid=10000000002&set=gm.29295208876831216&idorvanity=295931577185665";
  const idA = adapter.extractPostIdentity(photoA);
  const idB = adapter.extractPostIdentity(photoB);
  assert.notEqual(idA, null);
  assert.notEqual(idB, null);
  assert.equal(idA?.postId, idB?.postId);
  assert.equal(`${idA?.platform}:${idA?.postId}`, `${idB?.platform}:${idB?.postId}`);

  // 2. URL missing gm (e.g. set=a.123 or no set) -> rejected
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229817286489953&set=a.123456789&idorvanity=295931577185665"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229817286489953"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo.php?fbid=10229817286489953"), null);

  // 3. Malformed gm parameter (e.g. set=gm. or set=gm or invalid chars) -> rejected
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229817286489953&set=gm&idorvanity=295931577185665"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229817286489953&set=gm.&idorvanity=295931577185665"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229817286489953&set=gm.@invalid!&idorvanity=295931577185665"), null);
});

test("FacebookPermalinkAdapter extracts group photo post identity from pcb.{postId} (Frame 14) and deduplicates", () => {
  const adapter = new FacebookPermalinkAdapter();

  // 1. Valid photo URL with pcb.{postId} from Frame 14 live evidence
  const photo1 = "https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb.29279737605045010&__cft__[0]=AZjP93Vxa48Jr0X7";
  const post1 = adapter.extractPostIdentity(photo1);
  assert.notEqual(post1, null);
  assert.equal(post1?.platform, "facebook");
  assert.equal(post1?.postId, "29279737605045010"); // extracted from pcb.{postId}, NOT from fbid
  assert.equal(post1?.canonicalUrl, "https://www.facebook.com/permalink.php?story_fbid=29279737605045010");

  // Valid photo URL with pcb.{postId} and idorvanity
  const photoWithScope = "https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb.29279737605045010&idorvanity=seovamarketing";
  const postWithScope = adapter.extractPostIdentity(photoWithScope);
  assert.notEqual(postWithScope, null);
  assert.equal(postWithScope?.postId, "29279737605045010");
  assert.equal(postWithScope?.scope, "seovamarketing");
  assert.equal(postWithScope?.canonicalUrl, "https://www.facebook.com/groups/seovamarketing/posts/29279737605045010");

  // 2. Multiple photos from same post (different fbid, same pcb.29279737605045010) deduplicate to same post identity
  const photo2 = "https://www.facebook.com/photo/?fbid=10229807578367256&set=pcb.29279737605045010&__cft__[0]=AZjP93Vxa48Jr0X7";
  const post2 = adapter.extractPostIdentity(photo2);
  assert.notEqual(post2, null);
  assert.equal(post2?.postId, "29279737605045010");
  assert.equal(post1?.postId, post2?.postId);
  assert.equal(`${post1?.platform}:${post1?.postId}`, `${post2?.platform}:${post2?.postId}`);

  // 3. Malformed pcb parameter -> rejected
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb."), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb.@invalid!"), null);
});

test("FacebookPermalinkAdapter rejects non-post URLs, profiles, photos, and navigation", () => {
  const adapter = new FacebookPermalinkAdapter();

  // Photo
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo.php?fbid=123"), null);
  assert.equal(adapter.extractPostIdentity("/zuck/photos/a.123/456/"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/photo/?fbid=123"), null);

  // Video / Watch
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/watch/?v=12345"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/zuck/videos/12345/"), null);

  // Profile only
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/zuck"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/profile.php?id=100012345"), null);
  assert.equal(adapter.extractPostIdentity("/groups/mmo_community/"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/groups/mmo_community/about/"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/groups/mmo_community/members/"), null);

  // Navigation
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/friends/requests"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/notifications"), null);
  assert.equal(adapter.extractPostIdentity("https://www.facebook.com/marketplace"), null);
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

test("resolveBoundaryFromAncestors flags jumpedZeroToTwoPlus when count transitions directly from 0 to >=2", () => {
  const p1 = { platform: "facebook" as const, postId: "post_1", canonicalUrl: "https://fb.com/p/1", rawUrl: "/p/1" };
  const p2 = { platform: "facebook" as const, postId: "post_2", canonicalUrl: "https://fb.com/p/2", rawUrl: "/p/2" };

  const ancestors: AncestorStep[] = [
    { level: 0, tag: "div", id: "", className: "action", role: null, rect: { x: 100, y: 100, width: 100, height: 30 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    { level: 1, tag: "div", id: "", className: "card-body", role: null, rect: { x: 100, y: 50, width: 500, height: 200 }, postIdentities: [], uniqueKeys: [], hasNestedArticle: false, hasQuoteOrReplyHint: false },
    // Jumps directly to 2 posts in feed:
    { level: 2, tag: "div", id: "", className: "feed", role: "feed", rect: { x: 100, y: 0, width: 500, height: 600 }, postIdentities: [p1, p2], uniqueKeys: ["facebook:post_1", "facebook:post_2"], hasNestedArticle: false, hasQuoteOrReplyHint: false },
  ];

  const result = resolveBoundaryFromAncestors(ancestors, { x: 150, y: 110 });
  assert.equal(result.status, "BOUNDARY_NOT_FOUND");
  assert.equal(result.candidateContainer, null);
  assert.equal(result.jumpedZeroToTwoPlus, true);
  assert.match(result.jumpReason ?? "", /0.*to 2/i);
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
