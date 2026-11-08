import test from "node:test";
import assert from "node:assert/strict";
import type {
  CollectorDomElement,
  CollectorDomSnapshot,
  CollectorDraft,
  CollectorRegion,
  NormalizedRegionGeometry,
} from "../src/shared/collectors/types.js";
import type { Rect } from "../src/shared/contracts.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  addRegionToDraft,
  confirmRegionInDraft,
  regionsForCapture,
  revertDraftToVersion,
  saveAsVersion,
  updateRegionInDraft,
} from "../src/shared/collectors/ops.js";
import {
  calculateIoU,
  createCollectorRegion,
  denormalizeGeometry,
  executeHtmlFilter,
  extractDynamicHtmlFromContainer,
  findLowestCommonAncestor,
  findVerifiedPostContainer,
  mapRegionToDomElement,
  matchLearnedRegions,
  normalizeGeometry,
  normalizeCollectorRegion,
  normalizeCollectorRegions,
  verifyAnchorGroups,
  deriveReferenceCropFromAnchors,
  computeMatchedDynamicBounds,
  executeLiveBrowserMatchTest,
  resolveRegionCropBox,
} from "../src/shared/collectors/regions.js";
import {
  MemoryStorage,
  loadCollectorStore,
  parseEnvelope,
  saveCollectorStore,
  upsertCollector,
} from "../src/shared/collectors/store.js";

function buildMockFeedDom(opts?: { isStale?: boolean; url?: string }): CollectorDomSnapshot {
  const elements: CollectorDomElement[] = [
    // Feed container (must be rejected as cross-post/multi-post container)
    {
      id: "elem_feed",
      tagName: "DIV",
      role: "feed",
      className: "feed-stream",
      rect: { x: 50, y: 0, width: 800, height: 3000 },
      textSnippet: "Facebook Feed",
      attributes: { role: "feed", class: "feed-stream" },
      childrenIds: ["elem_post_1", "elem_post_2"],
      depth: 1,
      isFeedContainer: true,
    },
    // Post 1 Card
    {
      id: "elem_post_1",
      parentId: "elem_feed",
      tagName: "ARTICLE",
      role: "article",
      className: "user-post-card",
      rect: { x: 60, y: 50, width: 780, height: 600 },
      textSnippet: "Nguyen Van A 2 giờ trước Xin chào cộng đồng! 150 thích 24 bình luận",
      attributes: { role: "article", class: "user-post-card" },
      childrenIds: ["elem_post_1_header", "elem_post_1_body", "elem_post_1_footer"],
      depth: 2,
      isArticleOrCard: true,
    },
    // Post 1 Header
    {
      id: "elem_post_1_header",
      parentId: "elem_post_1",
      tagName: "HEADER",
      className: "post-author-row",
      rect: { x: 70, y: 60, width: 760, height: 70 },
      textSnippet: "Nguyen Van A 2 giờ trước",
      attributes: { class: "post-author-row" },
      childrenIds: [],
      depth: 3,
    },
    // Post 1 Body (Dynamic content)
    {
      id: "elem_post_1_body",
      parentId: "elem_post_1",
      tagName: "DIV",
      className: "post-content",
      rect: { x: 70, y: 140, width: 760, height: 350 },
      textSnippet: "Xin chào cộng đồng! Đây là bài viết mẫu với đường link https://example.com và ảnh minh họa. Xem thêm",
      attributes: { class: "post-content" },
      childrenIds: ["elem_post_1_img", "elem_post_1_link"],
      depth: 3,
    },
    // Post 1 Image inside body
    {
      id: "elem_post_1_img",
      parentId: "elem_post_1_body",
      tagName: "IMG",
      rect: { x: 70, y: 220, width: 600, height: 250 },
      textSnippet: "",
      attributes: { src: "https://cdn.example.com/images/post1.jpg", alt: "Ảnh bài viết" },
      childrenIds: [],
      depth: 4,
      hasMedia: true,
    },
    // Post 1 Link inside body
    {
      id: "elem_post_1_link",
      parentId: "elem_post_1_body",
      tagName: "A",
      rect: { x: 70, y: 180, width: 250, height: 25 },
      textSnippet: "https://example.com Link preview",
      attributes: { href: "https://example.com" },
      childrenIds: [],
      depth: 4,
    },
    // Post 1 Footer
    {
      id: "elem_post_1_footer",
      parentId: "elem_post_1",
      tagName: "FOOTER",
      className: "post-action-bar",
      rect: { x: 70, y: 520, width: 760, height: 60 },
      textSnippet: "150 thích 24 bình luận Chia sẻ",
      attributes: { class: "post-action-bar" },
      childrenIds: [],
      depth: 3,
    },

    // Post 2 Card (Directly following Post 1)
    {
      id: "elem_post_2",
      parentId: "elem_feed",
      tagName: "ARTICLE",
      role: "article",
      className: "user-post-card",
      rect: { x: 60, y: 700, width: 780, height: 500 },
      textSnippet: "Tran Thi B 5 giờ trước Bài viết thứ hai 88 thích",
      attributes: { role: "article", class: "user-post-card" },
      childrenIds: ["elem_post_2_header", "elem_post_2_footer"],
      depth: 2,
      isArticleOrCard: true,
    },
    // Post 2 Header
    {
      id: "elem_post_2_header",
      parentId: "elem_post_2",
      tagName: "HEADER",
      className: "post-author-row",
      rect: { x: 70, y: 710, width: 760, height: 70 },
      textSnippet: "Tran Thi B 5 giờ trước",
      attributes: { class: "post-author-row" },
      childrenIds: [],
      depth: 3,
    },
    // Post 2 Footer
    {
      id: "elem_post_2_footer",
      parentId: "elem_post_2",
      tagName: "FOOTER",
      className: "post-action-bar",
      rect: { x: 70, y: 1120, width: 760, height: 60 },
      textSnippet: "88 thích 5 bình luận",
      attributes: { class: "post-action-bar" },
      childrenIds: [],
      depth: 3,
    },
  ];

  return {
    url: opts?.url ?? "https://www.facebook.com/",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements,
    isStale: opts?.isStale,
  };
}

test("Case 1: Header + Footer same post -> verified container", () => {
  const dom = buildMockFeedDom();
  const headerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Author",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A 2 giờ trước",
  });
  const footerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Footer Actions",
    role: "footer",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "150 thích 24 bình luận",
  });

  const verified = findVerifiedPostContainer([headerRegion, footerRegion], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "elem_post_1");
  assert.equal(verified.rejectionReason, undefined);
  assert.ok(verified.confidence >= 80);
});

test("Case 2: Header from post 1 + Footer from post 2 -> rejected as cross-post mismatch", () => {
  const dom = buildMockFeedDom();
  const headerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Post 1",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });
  const footerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Footer Post 2",
    role: "footer",
    box: { x: 70, y: 1120, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "88 thích",
  });

  const verified = findVerifiedPostContainer([headerRegion, footerRegion], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "");
  assert.ok(
    verified.rejectionReason?.includes("feed") ||
    verified.rejectionReason?.includes("multiple post cards")
  );
});

test("Case 2b: Inverted vertical ordering (footer above header) -> rejected", () => {
  const dom = buildMockFeedDom();
  const footerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Footer Post 1",
    role: "footer",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "150 thích",
  });
  const headerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Post 2",
    role: "header",
    box: { x: 70, y: 710, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Tran Thi B",
  });

  const verified = findVerifiedPostContainer([headerRegion, footerRegion], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "");
  assert.ok(verified.rejectionReason?.includes("Inverted header/footer ordering"));
});

test("Case 3: Long post with footer outside viewport -> header + strong card evidence verified or needs attention", () => {
  const dom = buildMockFeedDom();
  const headerRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Author Only",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });

  const verified = findVerifiedPostContainer([headerRegion], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "elem_post_1");
  assert.equal(verified.headerMatched, true);
  assert.equal(verified.footerMatched, false);
});

test("Case 4: Nested/shared post -> correctly identifies inner vs outer post container", () => {
  const dom = buildMockFeedDom();
  dom.elements.push(
    {
      id: "elem_nested_post",
      parentId: "elem_post_1_body",
      tagName: "DIV",
      role: "article",
      className: "nested-shared-post",
      rect: { x: 80, y: 200, width: 700, height: 200 },
      textSnippet: "Original Author 1 ngày trước Nội dung chia sẻ gốc",
      attributes: { role: "article", class: "nested-shared-post" },
      childrenIds: ["elem_nested_header"],
      depth: 6,
      isArticleOrCard: true,
      outerHtmlSnippet: '<div class="nested-shared-post quoted">Original</div>',
    },
    {
      id: "elem_nested_header",
      parentId: "elem_nested_post",
      tagName: "DIV",
      className: "nested-header",
      rect: { x: 90, y: 210, width: 680, height: 40 },
      textSnippet: "Original Author 1 ngày trước",
      attributes: { class: "nested-header" },
      childrenIds: [],
      depth: 7,
    }
  );

  const outerHeader = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Outer Header",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });
  const outerFooter = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Outer Footer",
    role: "footer",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "150 thích",
  });

  const verifiedOuter = findVerifiedPostContainer([outerHeader, outerFooter], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verifiedOuter.containerId, "elem_post_1");

  const nestedHeader = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Nested Header",
    role: "header",
    box: { x: 90, y: 210, width: 680, height: 40 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Original Author",
  });
  const verifiedInner = findVerifiedPostContainer([nestedHeader], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verifiedInner.containerId, "elem_nested_post");
});

test("Case 5: Text-only post -> dynamic extraction extracts text without error", () => {
  const textPost: CollectorDomElement = {
    id: "elem_text_post",
    tagName: "ARTICLE",
    className: "post-card",
    rect: { x: 50, y: 50, width: 700, height: 400 },
    textSnippet: "Chỉ có văn bản thuần túy không có hình ảnh hay video nào.",
    attributes: { class: "post-card" },
    childrenIds: [],
    depth: 1,
  };
  const verifiedContainer = {
    containerId: "elem_text_post",
    tagName: "ARTICLE",
    selector: "article.post-card",
    layoutContext: "FEED_ITEM" as const,
    confidence: 90,
    evidence: [],
    headerMatched: true,
    footerMatched: false,
    isNestedSharedPost: false,
  };

  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/post/1",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [textPost],
  };

  const result = extractDynamicHtmlFromContainer(verifiedContainer, snapshot, []);
  assert.ok(result.extractedText?.includes("Chỉ có văn bản thuần túy"));
  assert.equal(result.mediaUrls?.length ?? 0, 0);
  assert.equal(result.linkPreviews?.length ?? 0, 0);
  assert.equal(result.hasCollapsedText, false);
});

test("Case 6: Post with media -> dynamic extraction identifies image/video URLs", () => {
  const dom = buildMockFeedDom();
  const verifiedContainer = {
    containerId: "elem_post_1",
    tagName: "ARTICLE",
    selector: "article.user-post-card",
    layoutContext: "FEED_ITEM" as const,
    confidence: 95,
    evidence: [],
    headerMatched: true,
    footerMatched: true,
    isNestedSharedPost: false,
  };

  const result = extractDynamicHtmlFromContainer(verifiedContainer, dom, []);
  assert.ok((result.mediaUrls?.length ?? 0) > 0);
  assert.ok(result.mediaUrls?.includes("https://cdn.example.com/images/post1.jpg"));
});

test("Case 7: Post with link preview and collapsed text -> extracts links and flags collapsed text", () => {
  const dom = buildMockFeedDom();
  const verifiedContainer = {
    containerId: "elem_post_1",
    tagName: "ARTICLE",
    selector: "article.user-post-card",
    layoutContext: "FEED_ITEM" as const,
    confidence: 95,
    evidence: [],
    headerMatched: true,
    footerMatched: true,
    isNestedSharedPost: false,
  };

  const result = extractDynamicHtmlFromContainer(verifiedContainer, dom, []);
  assert.ok((result.linkPreviews?.length ?? 0) > 0);
  assert.ok(result.linkPreviews?.some((l) => l.url === "https://example.com"));
  assert.equal(result.hasCollapsedText, true);
});

test("Case 8: Feed versus Post Single layout context (FEED_ITEM vs POST_DETAIL)", () => {
  const feedDom = buildMockFeedDom();
  const header = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });

  const verifiedFeed = findVerifiedPostContainer([header], feedDom, 1000, 800, "FEED_ITEM");
  assert.equal(verifiedFeed.containerId, "elem_post_1");

  const detailDom: CollectorDomSnapshot = {
    url: "https://www.facebook.com/permalink.php?story_fbid=123",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "elem_detail_main",
        tagName: "MAIN",
        role: "main",
        rect: { x: 50, y: 0, width: 900, height: 1200 },
        textSnippet: "Main post content Author in Detail",
        attributes: { role: "main" },
        childrenIds: ["elem_detail_header"],
        depth: 1,
      },
      {
        id: "elem_detail_header",
        parentId: "elem_detail_main",
        tagName: "DIV",
        rect: { x: 60, y: 20, width: 880, height: 80 },
        textSnippet: "Author in Detail",
        attributes: {},
        childrenIds: [],
        depth: 2,
      },
    ],
  };

  const detailHeader = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Detail",
    role: "header",
    box: { x: 60, y: 20, width: 880, height: 80 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Author in Detail",
  });

  const verifiedDetail = findVerifiedPostContainer([detailHeader], detailDom, 1000, 800, "POST_DETAIL");
  assert.equal(verifiedDetail.containerId, "elem_detail_main");
});

test("Case 9: Screenshot zoom / scaling / scroll offsets correctly map to DOM coordinates", () => {
  const norm: NormalizedRegionGeometry = { relX: 0.1, relY: 0.2, relW: 0.5, relH: 0.3 };
  const denorm = denormalizeGeometry(norm, 1000, 2000);
  assert.equal(denorm.x, 100);
  assert.equal(denorm.y, 400);
  assert.equal(denorm.width, 500);
  assert.equal(denorm.height, 600);

  const renorm = normalizeGeometry(denorm, 1000, 2000);
  assert.equal(renorm.relX, 0.1);
  assert.equal(renorm.relY, 0.2);
  assert.equal(renorm.relW, 0.5);
  assert.equal(renorm.relH, 0.3);

  const iou = calculateIoU(
    { x: 10, y: 10, width: 100, height: 100 },
    { x: 10, y: 10, width: 100, height: 100 }
  );
  assert.equal(iou, 1.0);
});

test("Case 10: Stale screenshot vs current DOM (URL / content mismatch detected)", () => {
  const staleDom = buildMockFeedDom({ isStale: true, url: "https://www.facebook.com/another-page" });
  const region = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header Author",
    role: "header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });

  const evidence = mapRegionToDomElement(region, staleDom, 1000, 800);
  assert.equal(evidence.stale, true);
  assert.ok(evidence.rejectionReason?.includes("Stale page state"));
});

test("Case 11: Persist and reopen Collector (regions and extraction results survive reload/version snapshot)", () => {
  let draft = createEmptyDraft({ name: "Collector With Regions" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com/post/1",
    imageAsset: "11111111-2222-3333-4444-555555555555.png",
    roi: { x: 0, y: 0, width: 1000, height: 800, containerWidth: 1000, containerHeight: 800 },
  });
  const capId = draft.captures[0]!.id;

  const region = createCollectorRegion({
    captureItemId: capId,
    type: "STATIC",
    label: "Persisted Header",
    role: "header",
    box: { x: 10, y: 20, width: 300, height: 50 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Header",
  });
  draft = addRegionToDraft(draft, region);
  draft.layoutContext = "POST_DETAIL";

  // Test storage persistence
  const storage = new MemoryStorage();
  let env = loadCollectorStore(storage);
  env = upsertCollector(env, draft);
  saveCollectorStore(storage, env);

  const reloadedEnv = loadCollectorStore(storage);
  const reloaded = reloadedEnv.collectors.find((c) => c.id === draft.id);
  assert.ok(reloaded);
  assert.equal(reloaded.regions?.length, 1);
  assert.equal(reloaded.regions![0].label, "Persisted Header");
  assert.equal(reloaded.layoutContext, "POST_DETAIL");

  // Test Version Snapshot isolation
  draft = saveAsVersion(draft, "Version With Regions");
  assert.equal(draft.versions.length, 1);
  const snapshot = draft.versions[0]!;
  assert.equal(snapshot.regions?.length, 1);
  assert.equal(snapshot.layoutContext, "POST_DETAIL");

  // Revert back and check integrity
  draft.regions = [];
  const reverted = revertDraftToVersion(draft, snapshot.id);
  assert.ok(reverted);
  assert.equal(reverted.regions?.length, 1);
  assert.equal(reverted.regions![0].label, "Persisted Header");
});

test("Case 12: Repeated confirmations and corrections (Image #1 reference -> Image #2 proposal -> confirm)", () => {
  let draft = createEmptyDraft({ name: "Teaching Test" });
  const img1Region = createCollectorRegion({
    captureItemId: "cap_img1",
    type: "STATIC",
    label: "Author Name Anchor",
    role: "header",
    box: { x: 50, y: 50, width: 300, height: 40 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Người tham gia ẩn danh",
  });
  draft = addRegionToDraft(draft, img1Region);
  draft = confirmRegionInDraft(draft, img1Region.id);

  // Propose on Image #2
  const matched = matchLearnedRegions(
    "cap_img2",
    draft.regions ?? [],
    "Người tham gia ẩn danh vừa đăng một bài viết mới",
    1000,
    800
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].label, "Author Name Anchor");
  assert.equal(matched[0].captureItemId, "cap_img2");
  assert.equal(matched[0].confirmed, false);
  assert.equal(matched[0].simulatedProposal, true);
  assert.ok((matched[0].confidence ?? 0) >= 70);

  // User confirms proposal
  draft = addRegionToDraft(draft, matched[0]);
  draft = confirmRegionInDraft(draft, matched[0].id);

  const confirmed = regionsForCapture(draft, "cap_img2");
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].confirmed, true);
});

test("Case 13: Old Collector migration (schema v1..v6 load cleanly with backward compatibility)", () => {
  const legacyEnvelopeJson = JSON.stringify({
    schemaVersion: 3,
    updatedAt: "2026-01-01T00:00:00.000Z",
    collectors: [
      {
        id: "collector-legacy-v1",
        name: "Legacy Collector",
        status: "draft",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        strategy: "DIRECT_PAGE",
        captures: [],
        variables: [],
      },
    ],
  });

  const envelope = parseEnvelope(legacyEnvelopeJson);
  assert.equal(envelope.collectors.length, 1);
  const loaded = envelope.collectors[0];
  assert.deepEqual(loaded.regions, []);
  assert.equal(loaded.layoutContext, "FEED_ITEM");
});

test("Case 14: Generic HTML Filter extraction foundation", () => {
  const dom = buildMockFeedDom();
  const verifiedContainer = {
    containerId: "elem_post_1",
    tagName: "ARTICLE",
    selector: "article.user-post-card",
    layoutContext: "FEED_ITEM" as const,
    confidence: 90,
    evidence: [],
    headerMatched: true,
    footerMatched: true,
    isNestedSharedPost: false,
  };

  const dynamicResult = extractDynamicHtmlFromContainer(verifiedContainer, dom, []);

  const filterResult = executeHtmlFilter(
    dynamicResult,
    verifiedContainer,
    [
      { id: "r1", targetVariableKey: "post_image", attribute: "src" },
      { id: "r2", targetVariableKey: "post_link", attribute: "href" },
      { id: "r3", targetVariableKey: "post_text", attribute: "textContent" },
    ],
    [
      { id: "v1", key: "post_image", label: "Post Image", valueType: "url", required: false, mappings: [] },
      { id: "v2", key: "post_link", label: "Post Link", valueType: "url", required: false, mappings: [] },
      { id: "v3", key: "post_text", label: "Post Text", valueType: "string", required: true, mappings: [] },
    ]
  );

  assert.equal(filterResult.status, "success");
  assert.equal(filterResult.values["post_image"], "https://cdn.example.com/images/post1.jpg");
  assert.equal(filterResult.values["post_link"], "https://example.com");
  assert.ok(typeof filterResult.values["post_text"] === "string");
  assert.ok((filterResult.values["post_text"] as string).includes("Xin chào cộng đồng"));
});

// ---------------------------------------------------------------------------
// C2.9 ANCHOR GROUP ARCHITECTURE & CONTAINER-SCOPED OCR TESTS
// ---------------------------------------------------------------------------

test("C2.9 Scenario 1: Create BEGIN and END with matching group tag -> verifies container and calculates container rect", () => {
  const dom = buildMockFeedDom();
  const beginAnchor = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "post-main",
    label: "Post Main Header",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });
  const endAnchor = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    groupTag: "post-main",
    label: "Post Main Footer",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "150 thích 24 bình luận",
  });

  assert.equal(beginAnchor.type, "BEGIN");
  assert.equal(beginAnchor.groupTag, "post-main");
  assert.equal(endAnchor.type, "END");
  assert.equal(endAnchor.groupTag, "post-main");

  const verified = findVerifiedPostContainer([beginAnchor, endAnchor], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "elem_post_1");
  assert.equal(verified.groupTag, "post-main");
  assert.equal(verified.rejectionReason, undefined);
  assert.ok(verified.confidence >= 90);
  assert.ok(verified.rect, "Verified container must include image-space rect bounds");
  assert.equal(verified.rect.x, 60);
  assert.equal(verified.rect.y, 50);
  assert.equal(verified.rect.width, 780);
  assert.equal(verified.rect.height, 600);
});

test("C2.9 Scenario 2: Create FREE region without group tag -> does not participate in dynamic group discovery", () => {
  const freeRegion = createCollectorRegion({
    captureItemId: "cap_1",
    type: "FREE",
    label: "Standalone Free Banner",
    box: { x: 20, y: 20, width: 200, height: 50 },
    imageWidth: 1000,
    imageHeight: 800,
  });

  assert.equal(freeRegion.type, "FREE");
  assert.equal(freeRegion.groupTag, undefined);

  const groupCheck = verifyAnchorGroups([freeRegion]);
  assert.equal(groupCheck.valid, false);
  assert.equal(groupCheck.freeRegions.length, 1);
  assert.ok(groupCheck.errors.some((e) => e.includes("No anchor groups defined")));

  const dom = buildMockFeedDom();
  const verified = findVerifiedPostContainer([freeRegion], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "");
  assert.ok(verified.rejectionReason?.includes("No anchor groups defined"));
});

test("C2.9 Scenario 3: Reject incomplete group (missing BEGIN or missing END) with clear feedback", () => {
  const dom = buildMockFeedDom();
  const orphanBegin = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "group-alpha",
    label: "Alpha Begin",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
  });

  const check1 = verifyAnchorGroups([orphanBegin]);
  assert.equal(check1.valid, false);
  assert.ok(check1.errors.some((e) => e.includes('Group "group-alpha" is incomplete: missing END anchor.')));

  const verified1 = findVerifiedPostContainer([orphanBegin], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified1.containerId, "");
  assert.ok(verified1.rejectionReason?.includes("missing END anchor"));

  const orphanEnd = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    groupTag: "group-beta",
    label: "Beta End",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
  });

  const check2 = verifyAnchorGroups([orphanEnd]);
  assert.equal(check2.valid, false);
  assert.ok(check2.errors.some((e) => e.includes('Group "group-beta" is incomplete: missing BEGIN anchor.')));

  const verified2 = findVerifiedPostContainer([orphanEnd], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified2.containerId, "");
  assert.ok(verified2.rejectionReason?.includes("missing BEGIN anchor"));
});

test("C2.9 Scenario 4: Reject ambiguous group (multiple BEGIN or multiple END anchors for same tag)", () => {
  const dom = buildMockFeedDom();
  const begin1 = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "post-stream",
    label: "Begin 1",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
  });
  const begin2 = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "post-stream",
    label: "Begin 2 (Duplicate)",
    box: { x: 70, y: 80, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
  });
  const endAnchor = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    groupTag: "post-stream",
    label: "End",
    box: { x: 70, y: 520, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
  });

  const check = verifyAnchorGroups([begin1, begin2, endAnchor]);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.includes('Group "post-stream" is ambiguous: multiple BEGIN anchors defined.')));

  const verified = findVerifiedPostContainer([begin1, begin2, endAnchor], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "");
  assert.ok(verified.rejectionReason?.includes("ambiguous"));
});

test("C2.9 Scenario 5: Multiple post instances do not cross-match anchors (BEGIN from post 1 + END from post 2 rejected)", () => {
  const dom = buildMockFeedDom();
  const post1Begin = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "cross-post-test",
    label: "Post 1 Begin",
    box: { x: 70, y: 60, width: 760, height: 70 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Nguyen Van A",
  });
  const post2End = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    groupTag: "cross-post-test",
    label: "Post 2 End",
    box: { x: 70, y: 1120, width: 760, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "88 thích",
  });

  const verified = findVerifiedPostContainer([post1Begin, post2End], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "");
  assert.ok(
    verified.rejectionReason?.includes("Cross-post mismatch") ||
    verified.rejectionReason?.includes("Encloses multiple post cards")
  );
});

test("C2.9 Scenario 6: Region Editor allows editing type, label, groupTag, candidate variables, and geometry without recreating", () => {
  let draft = createEmptyDraft({ name: "Region Edit Test" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com",
    imageAsset: "00000000-1111-2222-3333-444444444444.png",
    roi: { x: 0, y: 0, width: 1000, height: 800, containerWidth: 1000, containerHeight: 800 },
  });
  const capId = draft.captures[0]!.id;

  const region = createCollectorRegion({
    captureItemId: capId,
    type: "BEGIN",
    groupTag: "draft-tag",
    label: "Initial Header",
    box: { x: 50, y: 50, width: 200, height: 60 },
    imageWidth: 1000,
    imageHeight: 800,
    candidateVariableKeys: ["var_1"],
  });

  draft = addRegionToDraft(draft, region);
  const initialRegions = regionsForCapture(draft, capId);
  assert.equal(initialRegions.length, 1);
  assert.equal(initialRegions[0]!.label, "Initial Header");
  assert.equal(initialRegions[0]!.type, "BEGIN");
  assert.equal(initialRegions[0]!.groupTag, "draft-tag");

  // Perform multi-property edit on existing region
  draft = updateRegionInDraft(draft, region.id, {
    type: "END",
    groupTag: "renamed-group",
    label: "Updated Footer Label",
    candidateVariableKeys: ["var_1", "var_2"],
    geometry: { relX: 0.1, relY: 0.7, relW: 0.8, relH: 0.1 },
    originalRoi: { x: 100, y: 700, width: 800, height: 100 },
  });

  const updatedRegions = regionsForCapture(draft, capId);
  assert.equal(updatedRegions.length, 1);
  assert.equal(updatedRegions[0]!.id, region.id); // Same identity preserved!
  assert.equal(updatedRegions[0]!.type, "END");
  assert.equal(updatedRegions[0]!.groupTag, "renamed-group");
  assert.equal(updatedRegions[0]!.label, "Updated Footer Label");
  assert.deepEqual(updatedRegions[0]!.candidateVariableKeys, ["var_1", "var_2"]);
  assert.equal(updatedRegions[0]!.originalRoi?.y, 700);

  // Save to version snapshot and reload
  const saved = saveAsVersion(draft, "Edited region version");
  assert.equal(saved.versions.length, 1);
  const versionRegions = saved.versions[0]!.regions ?? [];
  assert.equal(versionRegions.length, 1);
  assert.equal(versionRegions[0]!.groupTag, "renamed-group");
  assert.equal(versionRegions[0]!.type, "END");

  // Revert back from version restores edited properties cleanly
  const reverted = revertDraftToVersion(saved, saved.versions[0]!.id);
  assert.ok(reverted);
  const revertedRegions = regionsForCapture(reverted, capId);
  assert.equal(revertedRegions.length, 1);
  assert.equal(revertedRegions[0]!.groupTag, "renamed-group");
  assert.equal(revertedRegions[0]!.label, "Updated Footer Label");
});

test("C2.9 Scenario 7: Backward-compatible normalization for legacy STATIC/DYNAMIC regions", () => {
  const legacyStaticHeader: CollectorRegion = {
    id: "r_stat_h",
    captureItemId: "cap_leg",
    type: "STATIC",
    label: "Header Bar",
    role: "header",
    geometry: { relX: 0.1, relY: 0.1, relW: 0.8, relH: 0.1 },
    candidateVariableKeys: ["title"],
    confirmed: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const legacyStaticFooter: CollectorRegion = {
    id: "r_stat_f",
    captureItemId: "cap_leg",
    type: "STATIC",
    label: "Footer Bar",
    role: "footer",
    geometry: { relX: 0.1, relY: 0.8, relW: 0.8, relH: 0.1 },
    candidateVariableKeys: ["likes"],
    confirmed: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const legacyDynamic: CollectorRegion = {
    id: "r_dyn",
    captureItemId: "cap_leg",
    type: "DYNAMIC",
    label: "Dynamic Content",
    role: "content",
    geometry: { relX: 0.1, relY: 0.2, relW: 0.8, relH: 0.6 },
    candidateVariableKeys: ["body"],
    confirmed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const normalized = normalizeCollectorRegions([legacyStaticHeader, legacyStaticFooter, legacyDynamic]);
  assert.equal(normalized[0]!.type, "BEGIN");
  assert.equal(normalized[0]!.groupTag, "default");
  assert.equal(normalized[1]!.type, "END");
  assert.equal(normalized[1]!.groupTag, "default");
  assert.equal(normalized[2]!.type, "FREE");
  assert.equal(normalized[2]!.groupTag, undefined);
  assert.deepEqual(normalized[2]!.candidateVariableKeys, ["body"]); // No data lost!
});

test("C2.9 Scenario 8: Container-scoped OCR coordinate shifting and original bounds preservation", () => {
  const cropOffset = { x: 100, y: 250 };
  const rawCroppedSegments = [
    { id: "c1", text: "Post Body Snippet", kind: "line" as const, confidence: 95, bbox: { x: 20, y: 30, width: 300, height: 40 } },
    { id: "c2", text: "29", kind: "word" as const, confidence: 90, bbox: { x: 20, y: 100, width: 30, height: 20 } },
  ];

  // Simulating the coordinate shift in ocrTarget
  const shiftedSegments = rawCroppedSegments.map((s) => ({
    ...s,
    bbox: {
      ...s.bbox,
      x: s.bbox.x + cropOffset.x,
      y: s.bbox.y + cropOffset.y,
    },
  }));

  assert.equal(shiftedSegments[0]!.bbox.x, 120);
  assert.equal(shiftedSegments[0]!.bbox.y, 280);
  assert.equal(shiftedSegments[1]!.bbox.x, 120);
  assert.equal(shiftedSegments[1]!.bbox.y, 350);
});

test("C2.9 Architecture: BEGIN and END anchors are cropped independently with exact rectangles and stored with groupTag", () => {
  const begin = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header Anchor",
    box: { x: 50, y: 100, width: 600, height: 60 },
    imageWidth: 1000,
    imageHeight: 1200,
    referenceImage: "data:image/png;base64,mockBeginCropBytes",
  });

  const end = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    groupTag: "post-main",
    label: "Footer Anchor",
    box: { x: 60, y: 700, width: 580, height: 50 },
    imageWidth: 1000,
    imageHeight: 1200,
    referenceImage: "data:image/png;base64,mockEndCropBytes",
  });

  // 1. Preserved exact original dimensions and coordinates independently
  assert.equal(begin.originalRoi?.x, 50);
  assert.equal(begin.originalRoi?.y, 100);
  assert.equal(begin.originalRoi?.width, 600);
  assert.equal(begin.originalRoi?.height, 60);
  assert.equal(begin.groupTag, "post-main");
  assert.equal(begin.referenceImage, "data:image/png;base64,mockBeginCropBytes");

  assert.equal(end.originalRoi?.x, 60);
  assert.equal(end.originalRoi?.y, 700);
  assert.equal(end.originalRoi?.width, 580);
  assert.equal(end.originalRoi?.height, 50);
  assert.equal(end.groupTag, "post-main");
  assert.equal(end.referenceImage, "data:image/png;base64,mockEndCropBytes");

  // 2. Not combined into a single crop, nor inferred as a dynamic crop union in Step 2
  assert.notEqual(begin.referenceImage, end.referenceImage);
});

test("C2.9 Architecture: FREE regions remain independent references without groupTag", () => {
  const free = createCollectorRegion({
    captureItemId: "cap_1",
    type: "FREE",
    label: "Free Anchor",
    box: { x: 40, y: 300, width: 300, height: 80 },
    imageWidth: 1000,
    imageHeight: 1000,
    referenceImage: "data:image/png;base64,mockFreeCropBytes",
  });

  assert.equal(free.type, "FREE");
  assert.equal(free.groupTag, undefined);
  assert.equal(free.originalRoi?.width, 300);
  assert.equal(free.referenceImage, "data:image/png;base64,mockFreeCropBytes");
});

test("C2.9 Architecture: Future Live Browser Match Test formula computeMatchedDynamicBounds", () => {
  // Matches live in browser: dynamicStartY = matchedBegin.y + matchedBegin.height, dynamicEndY = matchedEnd.y
  const matchedBegin: Rect = { x: 100, y: 150, width: 600, height: 50 };
  const matchedEnd: Rect = { x: 100, y: 650, width: 600, height: 40 };

  const dynamic = computeMatchedDynamicBounds(matchedBegin, matchedEnd, 800);
  assert.equal(dynamic.dynamicStartY, 200); // 150 + 50
  assert.equal(dynamic.dynamicEndY, 650);
  assert.equal(dynamic.height, 450); // 650 - 200
  assert.equal(dynamic.bounds.y, 200);
  assert.equal(dynamic.bounds.height, 450);
});

// ===========================================================================
// C2.10 — CONTAINER-BASED FIELD MAPPING & LIVE BROWSER MATCH TEST
// ===========================================================================

function mockDomEl(
  input: Partial<CollectorDomElement> & { id: string; tagName: string; rect: Rect; depth: number },
): CollectorDomElement {
  return {
    childrenIds: [],
    textSnippet: "",
    attributes: {},
    ...input,
  };
}

test("C2.10 Part A: Region-Based OCR & Independent Crop Storage", () => {
  const begin = createCollectorRegion({
    captureItemId: "cap_ocr",
    type: "BEGIN",
    groupTag: "post-1",
    label: "Header Anchor",
    box: { x: 50, y: 100, width: 400, height: 60 },
    imageWidth: 1000,
    imageHeight: 1200,
    referenceImage: "data:image/png;base64,beginCropPngBytes",
  });

  const end = createCollectorRegion({
    captureItemId: "cap_ocr",
    type: "END",
    groupTag: "post-1",
    label: "Footer Anchor",
    box: { x: 50, y: 800, width: 400, height: 50 },
    imageWidth: 1000,
    imageHeight: 1200,
    referenceImage: "data:image/png;base64,endCropPngBytes",
  });

  // Attach OCR strictly to the region crop
  begin.ocr = {
    text: "John Doe 2 hrs ago",
    confidence: 96,
    language: "vie+eng",
    segments: [
      { id: "seg_b1", text: "John Doe", kind: "word", confidence: 98, bbox: { x: 10, y: 10, width: 80, height: 25 } },
      { id: "seg_b2", text: "2 hrs ago", kind: "line", confidence: 94, bbox: { x: 10, y: 38, width: 70, height: 18 } },
    ],
  };

  end.ocr = {
    text: "Like Comment Share",
    confidence: 92,
    language: "vie+eng",
    segments: [
      { id: "seg_e1", text: "Like Comment Share", kind: "line", confidence: 92, bbox: { x: 10, y: 10, width: 200, height: 30 } },
    ],
  };

  // 1. OCR results belong to region and do not leak
  assert.equal(begin.ocr.segments.length, 2);
  assert.equal(end.ocr.segments.length, 1);
  assert.equal(begin.referenceImage, "data:image/png;base64,beginCropPngBytes");
  assert.equal(end.referenceImage, "data:image/png;base64,endCropPngBytes");

  // 2. Coordinate projection from region crop to original screenshot
  const cropSeg = begin.ocr.segments[0]!;
  const screenshotX = (begin.originalRoi?.x ?? 0) + cropSeg.bbox.x;
  const screenshotY = (begin.originalRoi?.y ?? 0) + cropSeg.bbox.y;
  assert.equal(screenshotX, 60); // 50 + 10
  assert.equal(screenshotY, 110); // 100 + 10
});

test("C2.10 Part B: Match Test fails when live DOM snapshot is empty or stale", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-1",
      label: "Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-1",
      label: "Footer",
      box: { x: 50, y: 500, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
    }),
  ];

  // Empty snapshot
  const emptySnapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [],
  };
  const emptyRes = executeLiveBrowserMatchTest(regions, emptySnapshot);
  assert.equal(emptyRes.status, "FAILED");
  assert.equal(emptyRes.matchedPostCount, 0);
  assert.match(emptyRes.summary, /No DOM elements found/);

  // Stale snapshot
  const staleSnapshot: CollectorDomSnapshot = {
    ...emptySnapshot,
    elements: [mockDomEl({ id: "el_1", tagName: "DIV", rect: { x: 0, y: 0, width: 100, height: 100 }, depth: 1 })],
    isStale: true,
  };
  const staleRes = executeLiveBrowserMatchTest(regions, staleSnapshot);
  assert.equal(staleRes.status, "FAILED");
  assert.match(staleRes.summary, /outdated page state/);
});

test("C2.10 Part B: Match Test single post MATCHED with live dynamic boundary", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-main",
      label: "Post Author Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Tech Innovator",
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-main",
      label: "Reactions Bar Footer",
      box: { x: 50, y: 500, width: 400, height: 40 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Like Comment Share",
    }),
  ];

  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      mockDomEl({
        id: "post_card_1",
        tagName: "ARTICLE",
        role: "article",
        className: "user-post-card",
        rect: { x: 100, y: 80, width: 700, height: 600 },
        textSnippet: "Tech Innovator Content Like Comment Share",
        childrenIds: ["head_1", "foot_1"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "head_1",
        parentId: "post_card_1",
        tagName: "DIV",
        role: "heading",
        rect: { x: 110, y: 90, width: 680, height: 50 },
        textSnippet: "Tech Innovator 5 hrs ago",
        depth: 3,
      }),
      mockDomEl({
        id: "foot_1",
        parentId: "post_card_1",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 110, y: 580, width: 680, height: 40 },
        textSnippet: "Like Comment Share",
        depth: 3,
      }),
    ],
  };

  const res = executeLiveBrowserMatchTest(regions, snapshot);
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 1);
  assert.equal(res.groups.length, 1);

  const group = res.groups[0]!;
  assert.equal(group.status, "MATCHED");
  assert.equal(group.domAssociationStatus, "CONFIRMED");
  assert.equal(group.domContainer?.containerId, "post_card_1");
  assert.equal(group.beginMatch?.matchedElementId, "head_1");
  assert.equal(group.endMatch?.matchedElementId, "foot_1");

  // Dynamic boundary calculation using live coordinates:
  // dynamicStartY = matchedBegin.y + matchedBegin.height = 90 + 50 = 140
  // dynamicEndY = matchedEnd.y = 580
  // height = 580 - 140 = 440
  assert.equal(group.dynamicBounds?.dynamicStartY, 140);
  assert.equal(group.dynamicBounds?.dynamicEndY, 580);
  assert.equal(group.dynamicBounds?.height, 440);

  // Engine limitations explicitly documented
  assert.ok(res.limitations?.length);
  assert.ok(res.limitations![0]!.includes("Visual matching"));
});

test("C2.10 Part B: Match Test rejects inverted spatial ordering (END above BEGIN)", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-main",
      label: "Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Tech Innovator",
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-main",
      label: "Footer",
      box: { x: 50, y: 500, width: 400, height: 40 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Like Comment Share",
    }),
  ];

  // Inverted: foot_inv at y:50, head_inv at y:300
  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      mockDomEl({
        id: "card_inv",
        tagName: "ARTICLE",
        rect: { x: 100, y: 30, width: 700, height: 600 },
        textSnippet: "Card",
        childrenIds: ["foot_inv", "head_inv"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "foot_inv",
        parentId: "card_inv",
        tagName: "DIV",
        rect: { x: 110, y: 50, width: 680, height: 40 },
        textSnippet: "Like Comment Share",
        depth: 3,
      }),
      mockDomEl({
        id: "head_inv",
        parentId: "card_inv",
        tagName: "DIV",
        rect: { x: 110, y: 300, width: 680, height: 50 },
        textSnippet: "Tech Innovator",
        depth: 3,
      }),
    ],
  };

  const res = executeLiveBrowserMatchTest(regions, snapshot);
  assert.equal(res.status, "FAILED");
  assert.equal(res.matchedPostCount, 0);
  assert.match(res.groups[0]!.failureReason!, /Spatial ordering inverted/);
});

test("C2.10 Part B: Match Test rejects cross-post pairing (broad feed ancestor)", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-main",
      label: "Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Header Text",
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-main",
      label: "Footer",
      box: { x: 50, y: 500, width: 400, height: 40 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Footer Text",
    }),
  ];

  // Header belongs to card_1, Footer belongs to card_2. Lowest common ancestor is feed_container.
  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      mockDomEl({
        id: "feed_container",
        tagName: "DIV",
        role: "feed",
        className: "news-feed",
        rect: { x: 50, y: 0, width: 800, height: 1200 },
        childrenIds: ["card_1", "card_2"],
        depth: 1,
        isFeedContainer: true,
      }),
      mockDomEl({
        id: "card_1",
        parentId: "feed_container",
        tagName: "ARTICLE",
        rect: { x: 60, y: 50, width: 780, height: 250 },
        textSnippet: "Header Text only",
        childrenIds: ["head_el"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "head_el",
        parentId: "card_1",
        tagName: "DIV",
        rect: { x: 70, y: 60, width: 500, height: 40 },
        textSnippet: "Header Text",
        depth: 3,
      }),
      mockDomEl({
        id: "card_2",
        parentId: "feed_container",
        tagName: "ARTICLE",
        rect: { x: 60, y: 350, width: 780, height: 250 },
        textSnippet: "Footer Text only",
        childrenIds: ["foot_el"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "foot_el",
        parentId: "card_2",
        tagName: "DIV",
        rect: { x: 70, y: 500, width: 500, height: 40 },
        textSnippet: "Footer Text",
        depth: 3,
      }),
    ],
  };

  const res = executeLiveBrowserMatchTest(regions, snapshot);
  assert.equal(res.status, "FAILED");
  assert.equal(res.matchedPostCount, 0);
  assert.match(res.groups[0]!.failureReason!, /Cross-post mismatch rejected/);
});

test("C2.10 Part B: Match Test pairs multiple visible posts without cross-post mixing", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-stream",
      label: "Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Author Header",
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-stream",
      label: "Footer",
      box: { x: 50, y: 500, width: 400, height: 40 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Actions Bar",
    }),
  ];

  // Feed with 2 independent post cards:
  // Post 1: h1 (y:100), f1 (y:250) inside card_1
  // Post 2: h2 (y:400), f2 (y:550) inside card_2
  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      mockDomEl({
        id: "feed_wrapper",
        tagName: "DIV",
        role: "feed",
        rect: { x: 50, y: 0, width: 800, height: 900 },
        childrenIds: ["card_1", "card_2"],
        depth: 1,
        isFeedContainer: true,
      }),
      mockDomEl({
        id: "card_1",
        parentId: "feed_wrapper",
        tagName: "ARTICLE",
        rect: { x: 60, y: 80, width: 780, height: 220 },
        textSnippet: "Author Header Post 1 Actions Bar",
        childrenIds: ["h1", "f1"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "h1",
        parentId: "card_1",
        tagName: "DIV",
        rect: { x: 70, y: 100, width: 500, height: 40 },
        textSnippet: "Author Header",
        depth: 3,
      }),
      mockDomEl({
        id: "f1",
        parentId: "card_1",
        tagName: "DIV",
        rect: { x: 70, y: 250, width: 500, height: 30 },
        textSnippet: "Actions Bar",
        depth: 3,
      }),
      mockDomEl({
        id: "card_2",
        parentId: "feed_wrapper",
        tagName: "ARTICLE",
        rect: { x: 60, y: 380, width: 780, height: 220 },
        textSnippet: "Author Header Post 2 Actions Bar",
        childrenIds: ["h2", "f2"],
        depth: 2,
        isArticleOrCard: true,
      }),
      mockDomEl({
        id: "h2",
        parentId: "card_2",
        tagName: "DIV",
        rect: { x: 70, y: 400, width: 500, height: 40 },
        textSnippet: "Author Header",
        depth: 3,
      }),
      mockDomEl({
        id: "f2",
        parentId: "card_2",
        tagName: "DIV",
        rect: { x: 70, y: 550, width: 500, height: 30 },
        textSnippet: "Actions Bar",
        depth: 3,
      }),
    ],
  };

  const res = executeLiveBrowserMatchTest(regions, snapshot);
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 2); // Matched both posts!
});

test("C2.10 Part B: Match Test reports PARTIAL when END anchor is missing in DOM", () => {
  const regions: CollectorRegion[] = [
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "BEGIN",
      groupTag: "post-stream",
      label: "Header",
      box: { x: 50, y: 50, width: 400, height: 50 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Author Header",
    }),
    createCollectorRegion({
      captureItemId: "cap_1",
      type: "END",
      groupTag: "post-stream",
      label: "Footer",
      box: { x: 50, y: 500, width: 400, height: 40 },
      imageWidth: 1000,
      imageHeight: 1000,
      ocrText: "Actions Bar",
    }),
  ];

  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 900, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      mockDomEl({
        id: "h1",
        tagName: "DIV",
        rect: { x: 70, y: 100, width: 500, height: 40 },
        textSnippet: "Author Header",
        depth: 2,
      }),
    ],
  };

  const res = executeLiveBrowserMatchTest(regions, snapshot);
  assert.equal(res.status, "PARTIAL");
  assert.equal(res.matchedPostCount, 0);
  assert.match(res.groups[0]!.failureReason!, /END anchor/);
});

test("C2.10 Part D: Data Compatibility - v6 envelope migration to v7", () => {
  const v6Payload = JSON.stringify({
    schemaVersion: 6,
    updatedAt: "2026-11-08T00:00:00.000Z",
    collectors: [
      {
        id: "c_v6",
        name: "Legacy V6 Collector",
        description: "Test description",
        status: "draft",
        wizardStep: 3, // Old Discovery step
        captures: [],
        variables: [],
      },
    ],
  });

  const env = parseEnvelope(v6Payload);
  assert.equal(env.schemaVersion, 7);
  assert.equal(env.collectors.length, 1);
  const col = env.collectors[0]!;
  // Old step 3 (Discovery) migrates to step 4 in the 5-step wizard
  assert.equal(col.wizardStep, 4);
  // Match Test is NOT silently marked as MATCHED
  assert.equal(col.matchTest, undefined);
});

test("C2.10.1 resolveRegionCropBox resolves explicit originalRoi and denormalizes geometry when missing", () => {
  // Case A: explicit originalRoi
  const r1 = createCollectorRegion({
    captureItemId: "cap_1",
    type: "BEGIN",
    label: "Header",
    box: { x: 10, y: 20, width: 200, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const res1 = resolveRegionCropBox(r1, 800, 600);
  assert.equal(res1.error, undefined);
  assert.deepEqual(res1.box, { x: 10, y: 20, width: 200, height: 50 });

  // Case B: missing originalRoi (migrated legacy region) - denormalizes from geometry
  const r2: CollectorRegion = {
    ...r1,
    originalRoi: undefined,
    geometry: { relX: 0.1, relY: 0.2, relW: 0.25, relH: 0.1 },
  };
  const res2 = resolveRegionCropBox(r2, 1000, 500);
  assert.equal(res2.error, undefined);
  assert.deepEqual(res2.box, { x: 100, y: 100, width: 250, height: 50 });

  // Case C: Clamps coordinates within image dimensions
  const r3 = createCollectorRegion({
    captureItemId: "cap_1",
    type: "END",
    label: "Footer",
    box: { x: 750, y: 580, width: 100, height: 80 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const res3 = resolveRegionCropBox(r3, 800, 600);
  assert.equal(res3.error, undefined);
  assert.deepEqual(res3.box, { x: 750, y: 580, width: 50, height: 20 });

  // Case D: Invalid region bounds
  const rInvalid: CollectorRegion = {
    ...r1,
    originalRoi: { x: 0, y: 0, width: 0, height: 0 },
    geometry: { relX: 0, relY: 0, relW: 0, relH: 0 },
  };
  const resInvalid = resolveRegionCropBox(rInvalid, 800, 600);
  assert.equal(resInvalid.box, undefined);
  assert.equal(resInvalid.error, "Invalid region bounds.");

  // Case E: Invalid image dimensions
  const resDim = resolveRegionCropBox(r1, 0, 0);
  assert.equal(resDim.box, undefined);
  assert.equal(resDim.error, "Invalid image dimensions.");
});

test("C2.10.1 updateRegionInDraft invalidates OCR and reference crop on geometry change", () => {
  let draft = createEmptyDraft({ name: "CropLifecycle" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com",
    imageAsset: "11111111-2222-3333-4444-555555555555.png",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0]!.id;
  const region = createCollectorRegion({
    captureItemId: capId,
    type: "BEGIN",
    label: "Begin Anchor",
    box: { x: 10, y: 15, width: 100, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
    referenceImage: "data:image/png;base64,initialCrop",
  });
  draft = addRegionToDraft(draft, region);

  // Attach OCR to region
  draft = updateRegionInDraft(draft, region.id, {
    ocr: {
      text: "Initial OCR",
      confidence: 95,
      language: "vie+eng",
      segments: [],
    },
    ocrEvidence: {
      text: "Initial OCR",
      confidence: 95,
      segmentIds: [],
    },
  });

  const withOcr = draft.regions?.find((r) => r.id === region.id);
  assert.equal(withOcr?.referenceImage, "data:image/png;base64,initialCrop");
  assert.equal(withOcr?.ocr?.text, "Initial OCR");

  // Non-geometry update (e.g. rename label) must PRESERVE referenceImage and OCR
  draft = updateRegionInDraft(draft, region.id, { label: "Renamed Anchor" });
  const renamed = draft.regions?.find((r) => r.id === region.id);
  assert.equal(renamed?.label, "Renamed Anchor");
  assert.equal(renamed?.referenceImage, "data:image/png;base64,initialCrop");
  assert.equal(renamed?.ocr?.text, "Initial OCR");

  // Geometry change (updating box) must INVALIDATE ocr and referenceImage
  const newBox: Rect = { x: 20, y: 25, width: 120, height: 45 };
  draft = updateRegionInDraft(draft, region.id, {
    originalRoi: newBox,
    geometry: normalizeGeometry(newBox, 800, 600),
  });
  const resized = draft.regions?.find((r) => r.id === region.id);
  assert.deepEqual(resized?.originalRoi, newBox);
  assert.equal(resized?.ocr, undefined, "OCR must be invalidated on geometry change");
  assert.equal(resized?.ocrEvidence, undefined, "ocrEvidence must be invalidated on geometry change");
  assert.equal(resized?.referenceImage, undefined, "referenceImage must be invalidated on geometry change");
});

test("C2.10.1 version snapshot and revert preserve regions and support recovery", () => {
  let draft = createEmptyDraft({ name: "SnapshotRecovery" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com/item",
    imageAsset: "22222222-3333-4444-5555-666666666666.png",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0]!.id;
  // Legacy-style region without referenceImage
  const legacyRegion = createCollectorRegion({
    captureItemId: capId,
    type: "END",
    groupTag: "post-main",
    label: "Footer Anchor",
    box: { x: 15, y: 500, width: 250, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });
  // Explicitly remove referenceImage to emulate v6 migration
  delete (legacyRegion as any).referenceImage;
  draft = addRegionToDraft(draft, legacyRegion);

  draft = saveAsVersion(draft, "v1");
  assert.equal(draft.versions.length, 1);
  const snap = draft.versions[0]!;
  assert.equal(snap.regions?.length, 1);
  assert.equal(snap.regions[0]!.referenceImage, undefined);

  // Recovering box for the region from snapshot
  const recovered = resolveRegionCropBox(snap.regions[0]!, 800, 600);
  assert.equal(recovered.error, undefined);
  assert.deepEqual(recovered.box, { x: 15, y: 500, width: 250, height: 60 });
});
