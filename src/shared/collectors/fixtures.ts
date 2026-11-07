import type {
  CaptureScene,
  CollectorDraft,
  CollectorStrategy,
  CollectorVariable,
  DiscoveryCandidate,
  MockSampleAsset,
  ParentRangeState,
  ValidationOutcome,
  ValidationRun,
} from "./types.js";

export const DEFAULT_CLASSIFICATIONS = [
  "facebook.group.normal_post",
  "facebook.group.image_text",
  "facebook.group.recruitment",
  "facebook.group.shared_post",
  "facebook.group.mixed_media",
];

/** Deterministic SVG preview assets — referenced by id, not stored in localStorage. */
export const PREVIEW_ASSETS: Record<string, string> = {
  "preview.normal": svgCard("#1a3348", "Normal text post", "Chào nhóm, hôm nay trời đẹp."),
  "preview.image_text": svgCard("#3a2a18", "Image + OCR text", "Ảnh chứa dòng chữ trong ảnh"),
  "preview.recruitment": svgCard("#1f3a2a", "Recruitment label", "Tuyển NV · Part-time"),
  "preview.mixed": svgCard("#2a2440", "Mixed text/media", "Caption + 2 ảnh"),
  "preview.shared": svgCard("#3a1f2e", "Shared post", "Shared from Page X"),
  "preview.holdout": svgCard("#243040", "Holdout sample", "Không dùng để train"),
};

function svgCard(bg: string, title: string, body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">
    <rect width="480" height="280" fill="${bg}"/>
    <rect x="16" y="16" width="448" height="248" rx="8" fill="#0d1520" stroke="#45627a"/>
    <text x="32" y="56" fill="#9ec9ff" font-family="Segoe UI,sans-serif" font-size="16" font-weight="600">${escapeXml(title)}</text>
    <text x="32" y="96" fill="#dce9f8" font-family="Segoe UI,sans-serif" font-size="14">${escapeXml(body)}</text>
    <text x="32" y="240" fill="#90a5bf" font-family="Segoe UI,sans-serif" font-size="11">Mock preview · not live Facebook</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function previewSrc(assetId: string): string {
  return PREVIEW_ASSETS[assetId] ?? PREVIEW_ASSETS["preview.normal"]!;
}

export const MOCK_SAMPLES: MockSampleAsset[] = [
  {
    id: "sample.normal.1",
    title: "Normal text · morning",
    classification: "facebook.group.normal_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-20T08:12:00.000Z",
    previewAssetId: "preview.normal",
    summary: "Plain caption, no media.",
    kind: "normal_text",
    parentLevels: 3,
    observedValues: [
      { id: "n1.post_id", label: "post_id", value: "pfbid_normal_001", source: "network_json", channel: "network" },
      { id: "n1.url", label: "post_url", value: "https://facebook.example/groups/1/posts/normal_001", source: "network_json", channel: "network" },
      { id: "n1.author", label: "author", value: "Lan Nguyen", source: "network_json", channel: "meta" },
      { id: "n1.content", label: "content", value: "Chào nhóm, hôm nay trời đẹp.", source: "network_json", channel: "post_body" },
      { id: "n1.created", label: "created_at", value: "2026-10-20T08:00:00.000Z", source: "network_json", channel: "meta" },
      { id: "n1.eng", label: "engagement", value: '{"likes":12,"comments":3}', source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.normal.2",
    title: "Normal text · afternoon",
    classification: "facebook.group.normal_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-20T14:22:00.000Z",
    previewAssetId: "preview.normal",
    summary: "Another normal post for Sample B/C.",
    kind: "normal_text",
    parentLevels: 3,
    observedValues: [
      { id: "n2.post_id", label: "post_id", value: "pfbid_normal_002", source: "network_json", channel: "network" },
      { id: "n2.url", label: "post_url", value: "https://facebook.example/groups/1/posts/normal_002", source: "network_json", channel: "network" },
      { id: "n2.author", label: "author", value: "Minh Tran", source: "network_json", channel: "meta" },
      { id: "n2.content", label: "content", value: "Ai đi cafe cuối tuần không?", source: "network_json", channel: "post_body" },
      { id: "n2.created", label: "created_at", value: "2026-10-20T14:00:00.000Z", source: "network_json", channel: "meta" },
      { id: "n2.eng", label: "engagement", value: '{"likes":4,"comments":1}', source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.normal.3",
    title: "Normal text · evening",
    classification: "facebook.group.normal_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-20T19:05:00.000Z",
    previewAssetId: "preview.normal",
    summary: "Third normal training sample.",
    kind: "normal_text",
    parentLevels: 4,
    observedValues: [
      { id: "n3.post_id", label: "post_id", value: "pfbid_normal_003", source: "network_json", channel: "network" },
      { id: "n3.url", label: "post_url", value: "https://facebook.example/groups/1/posts/normal_003", source: "network_json", channel: "network" },
      { id: "n3.author", label: "author", value: "Hoa Le", source: "network_json", channel: "meta" },
      { id: "n3.content", label: "content", value: "Cảm ơn mọi người đã giúp.", source: "network_json", channel: "post_body" },
      { id: "n3.created", label: "created_at", value: "2026-10-20T19:00:00.000Z", source: "network_json", channel: "meta" },
      { id: "n3.eng", label: "engagement", value: '{"likes":20,"comments":6}', source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.image.1",
    title: "Image text · flyer",
    classification: "facebook.group.image_text",
    source: "Mock detail capture",
    capturedAt: "2026-10-21T09:10:00.000Z",
    previewAssetId: "preview.image_text",
    summary: "Caption separate from OCR text inside image.",
    kind: "image_text",
    parentLevels: 5,
    observedValues: [
      { id: "i1.post_id", label: "post_id", value: "pfbid_image_001", source: "visual_dom", channel: "meta" },
      { id: "i1.url", label: "post_url", value: "https://facebook.example/groups/1/posts/image_001", source: "visual_dom", channel: "meta" },
      { id: "i1.author", label: "author", value: "Shop ABC", source: "visual_dom", channel: "meta" },
      { id: "i1.content", label: "content (caption)", value: "Sale cuối tuần — xem ảnh.", source: "visual_dom", channel: "post_body" },
      { id: "i1.ocr", label: "image_text (OCR)", value: "GIẢM 50% · CHỈ HÔM NAY", source: "ocr_image", channel: "image_ocr" },
      { id: "i1.media", label: "media", value: '["mock://image_001.jpg"]', source: "visual_dom", channel: "meta" },
      { id: "i1.created", label: "created_at", value: "2026-10-21T09:00:00.000Z", source: "visual_dom", channel: "meta" },
    ],
  },
  {
    id: "sample.image.2",
    title: "Image text · menu",
    classification: "facebook.group.image_text",
    source: "Mock detail capture",
    capturedAt: "2026-10-21T11:40:00.000Z",
    previewAssetId: "preview.image_text",
    summary: "Second image-text sample.",
    kind: "image_text",
    parentLevels: 5,
    observedValues: [
      { id: "i2.post_id", label: "post_id", value: "pfbid_image_002", source: "visual_dom", channel: "meta" },
      { id: "i2.url", label: "post_url", value: "https://facebook.example/groups/1/posts/image_002", source: "visual_dom", channel: "meta" },
      { id: "i2.author", label: "author", value: "Cafe XYZ", source: "visual_dom", channel: "meta" },
      { id: "i2.content", label: "content (caption)", value: "Menu mới tuần này.", source: "visual_dom", channel: "post_body" },
      { id: "i2.ocr", label: "image_text (OCR)", value: "Cà phê sữa · 35k", source: "ocr_image", channel: "image_ocr" },
      { id: "i2.media", label: "media", value: '["mock://image_002.jpg"]', source: "visual_dom", channel: "meta" },
      { id: "i2.created", label: "created_at", value: "2026-10-21T11:30:00.000Z", source: "visual_dom", channel: "meta" },
    ],
  },
  {
    id: "sample.image.3",
    title: "Image text · poster",
    classification: "facebook.group.image_text",
    source: "Mock detail capture",
    capturedAt: "2026-10-21T16:00:00.000Z",
    previewAssetId: "preview.image_text",
    summary: "Third image-text sample.",
    kind: "image_text",
    parentLevels: 6,
    observedValues: [
      { id: "i3.post_id", label: "post_id", value: "pfbid_image_003", source: "visual_dom", channel: "meta" },
      { id: "i3.url", label: "post_url", value: "https://facebook.example/groups/1/posts/image_003", source: "visual_dom", channel: "meta" },
      { id: "i3.author", label: "author", value: "Event Hub", source: "visual_dom", channel: "meta" },
      { id: "i3.content", label: "content (caption)", value: "Poster sự kiện.", source: "visual_dom", channel: "post_body" },
      { id: "i3.ocr", label: "image_text (OCR)", value: "OPEN DAY 25/10", source: "ocr_image", channel: "image_ocr" },
      { id: "i3.media", label: "media", value: '["mock://image_003.jpg"]', source: "visual_dom", channel: "meta" },
      { id: "i3.created", label: "created_at", value: "2026-10-21T15:50:00.000Z", source: "visual_dom", channel: "meta" },
    ],
  },
  {
    id: "sample.recruit.1",
    title: "Recruitment · label",
    classification: "facebook.group.recruitment",
    source: "Mock feed capture",
    capturedAt: "2026-10-22T07:30:00.000Z",
    previewAssetId: "preview.recruitment",
    summary: "Recruitment post with label chip.",
    kind: "recruitment",
    parentLevels: 4,
    observedValues: [
      { id: "r1.post_id", label: "post_id", value: "pfbid_recruit_001", source: "network_json", channel: "network" },
      { id: "r1.url", label: "post_url", value: "https://facebook.example/groups/1/posts/recruit_001", source: "network_json", channel: "network" },
      { id: "r1.author", label: "author", value: "HR Desk", source: "network_json", channel: "meta" },
      { id: "r1.content", label: "content", value: "Tuyển NV part-time cuối tuần.", source: "network_json", channel: "post_body" },
      { id: "r1.labels", label: "post_labels", value: '["recruitment","part-time"]', source: "network_json", channel: "meta" },
      { id: "r1.created", label: "created_at", value: "2026-10-22T07:00:00.000Z", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.recruit.2",
    title: "Recruitment · full-time",
    classification: "facebook.group.recruitment",
    source: "Mock feed capture",
    capturedAt: "2026-10-22T10:15:00.000Z",
    previewAssetId: "preview.recruitment",
    summary: "Second recruitment sample.",
    kind: "recruitment",
    parentLevels: 4,
    observedValues: [
      { id: "r2.post_id", label: "post_id", value: "pfbid_recruit_002", source: "network_json", channel: "network" },
      { id: "r2.url", label: "post_url", value: "https://facebook.example/groups/1/posts/recruit_002", source: "network_json", channel: "network" },
      { id: "r2.author", label: "author", value: "Ops Team", source: "network_json", channel: "meta" },
      { id: "r2.content", label: "content", value: "Cần 2 bạn Full-time CSKH.", source: "network_json", channel: "post_body" },
      { id: "r2.labels", label: "post_labels", value: '["recruitment","full-time"]', source: "network_json", channel: "meta" },
      { id: "r2.created", label: "created_at", value: "2026-10-22T10:00:00.000Z", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.recruit.3",
    title: "Recruitment · intern",
    classification: "facebook.group.recruitment",
    source: "Mock feed capture",
    capturedAt: "2026-10-22T13:45:00.000Z",
    previewAssetId: "preview.recruitment",
    summary: "Third recruitment sample.",
    kind: "recruitment",
    parentLevels: 5,
    observedValues: [
      { id: "r3.post_id", label: "post_id", value: "pfbid_recruit_003", source: "network_json", channel: "network" },
      { id: "r3.url", label: "post_url", value: "https://facebook.example/groups/1/posts/recruit_003", source: "network_json", channel: "network" },
      { id: "r3.author", label: "author", value: "Startup Lab", source: "network_json", channel: "meta" },
      { id: "r3.content", label: "content", value: "Nhận Intern Marketing.", source: "network_json", channel: "post_body" },
      { id: "r3.labels", label: "post_labels", value: '["recruitment","intern"]', source: "network_json", channel: "meta" },
      { id: "r3.created", label: "created_at", value: "2026-10-22T13:30:00.000Z", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.mixed.1",
    title: "Mixed media · A",
    classification: "facebook.group.mixed_media",
    source: "Mock feed capture",
    capturedAt: "2026-10-23T08:00:00.000Z",
    previewAssetId: "preview.mixed",
    summary: "Caption plus multiple images.",
    kind: "mixed_media",
    parentLevels: 4,
    observedValues: [
      { id: "m1.post_id", label: "post_id", value: "pfbid_mixed_001", source: "network_json", channel: "network" },
      { id: "m1.content", label: "content", value: "Album cuối tuần.", source: "network_json", channel: "post_body" },
      { id: "m1.media", label: "media", value: '["mock://a.jpg","mock://b.jpg"]', source: "network_json", channel: "meta" },
      { id: "m1.author", label: "author", value: "Travel Club", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.mixed.2",
    title: "Mixed media · B",
    classification: "facebook.group.mixed_media",
    source: "Mock feed capture",
    capturedAt: "2026-10-23T09:00:00.000Z",
    previewAssetId: "preview.mixed",
    summary: "Second mixed sample.",
    kind: "mixed_media",
    parentLevels: 4,
    observedValues: [
      { id: "m2.post_id", label: "post_id", value: "pfbid_mixed_002", source: "network_json", channel: "network" },
      { id: "m2.content", label: "content", value: "Review quán mới.", source: "network_json", channel: "post_body" },
      { id: "m2.media", label: "media", value: '["mock://c.jpg","mock://d.jpg"]', source: "network_json", channel: "meta" },
      { id: "m2.author", label: "author", value: "Foodie", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.mixed.3",
    title: "Mixed media · C",
    classification: "facebook.group.mixed_media",
    source: "Mock feed capture",
    capturedAt: "2026-10-23T10:00:00.000Z",
    previewAssetId: "preview.mixed",
    summary: "Third mixed sample.",
    kind: "mixed_media",
    parentLevels: 5,
    observedValues: [
      { id: "m3.post_id", label: "post_id", value: "pfbid_mixed_003", source: "network_json", channel: "network" },
      { id: "m3.content", label: "content", value: "Behind the scenes.", source: "network_json", channel: "post_body" },
      { id: "m3.media", label: "media", value: '["mock://e.jpg"]', source: "network_json", channel: "meta" },
      { id: "m3.author", label: "author", value: "Studio", source: "network_json", channel: "meta" },
    ],
  },
  {
    id: "sample.shared.1",
    title: "Shared post · A",
    classification: "facebook.group.shared_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-24T08:00:00.000Z",
    previewAssetId: "preview.shared",
    summary: "Shared from an external page.",
    kind: "shared_post",
    parentLevels: 6,
    observedValues: [
      { id: "s1.post_id", label: "post_id", value: "pfbid_shared_001", source: "network_json", channel: "network" },
      { id: "s1.content", label: "content", value: "Chia sẻ bài viết hay.", source: "network_json", channel: "post_body" },
      { id: "s1.author", label: "author", value: "Share Bot", source: "network_json", channel: "meta" },
      { id: "s1.url", label: "post_url", value: "https://facebook.example/groups/1/posts/shared_001", source: "network_json", channel: "network" },
    ],
  },
  {
    id: "sample.shared.2",
    title: "Shared post · B",
    classification: "facebook.group.shared_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-24T09:00:00.000Z",
    previewAssetId: "preview.shared",
    summary: "Second shared sample.",
    kind: "shared_post",
    parentLevels: 6,
    observedValues: [
      { id: "s2.post_id", label: "post_id", value: "pfbid_shared_002", source: "network_json", channel: "network" },
      { id: "s2.content", label: "content", value: "Forward từ Page News.", source: "network_json", channel: "post_body" },
      { id: "s2.author", label: "author", value: "Editor", source: "network_json", channel: "meta" },
      { id: "s2.url", label: "post_url", value: "https://facebook.example/groups/1/posts/shared_002", source: "network_json", channel: "network" },
    ],
  },
  {
    id: "sample.shared.3",
    title: "Shared post · C",
    classification: "facebook.group.shared_post",
    source: "Mock feed capture",
    capturedAt: "2026-10-24T10:00:00.000Z",
    previewAssetId: "preview.shared",
    summary: "Third shared sample.",
    kind: "shared_post",
    parentLevels: 7,
    observedValues: [
      { id: "s3.post_id", label: "post_id", value: "pfbid_shared_003", source: "network_json", channel: "network" },
      { id: "s3.content", label: "content", value: "Repost khuyến mãi.", source: "network_json", channel: "post_body" },
      { id: "s3.author", label: "author", value: "Promo Desk", source: "network_json", channel: "meta" },
      { id: "s3.url", label: "post_url", value: "https://facebook.example/groups/1/posts/shared_003", source: "network_json", channel: "network" },
    ],
  },
  {
    id: "sample.holdout.normal",
    title: "Holdout · normal",
    classification: "facebook.group.normal_post",
    source: "Mock holdout set",
    capturedAt: "2026-10-25T12:00:00.000Z",
    previewAssetId: "preview.holdout",
    summary: "Holdout — never used for rule authoring.",
    kind: "normal_text",
    parentLevels: 3,
    observedValues: [
      { id: "h1.post_id", label: "post_id", value: "pfbid_holdout_001", source: "network_json", channel: "network" },
      { id: "h1.content", label: "content", value: "Holdout caption.", source: "network_json", channel: "post_body" },
      { id: "h1.author", label: "author", value: "Holdout User", source: "network_json", channel: "meta" },
      { id: "h1.url", label: "post_url", value: "https://facebook.example/groups/1/posts/holdout_001", source: "network_json", channel: "network" },
    ],
  },
];

export function sampleById(id: string | undefined | null): MockSampleAsset | undefined {
  if (!id) return undefined;
  return MOCK_SAMPLES.find((s) => s.id === id);
}

export function samplesForClassification(classification: string): MockSampleAsset[] {
  return MOCK_SAMPLES.filter((s) => s.classification === classification && !s.id.includes("holdout"));
}

export function holdoutForClassification(classification: string): MockSampleAsset | undefined {
  return MOCK_SAMPLES.find((s) => s.classification === classification && s.id.includes("holdout"))
    ?? MOCK_SAMPLES.find((s) => s.id.includes("holdout"));
}

export function defaultVariables(strategy?: CollectorStrategy | ""): CollectorVariable[] {
  const feed = strategy === "FEED_NETWORK_JSON";
  const visual = strategy === "POST_DETAIL_VISUAL";
  const primary: CollectorVariable["source"] = feed ? "network_json" : visual ? "visual_dom" : "manual";
  const base: Array<Omit<CollectorVariable, "id" | "mappings">> = [
    { key: "post_id", label: "Post ID", valueType: "string", required: true, source: primary },
    { key: "post_url", label: "Post URL", valueType: "url", required: true, source: primary },
    { key: "author", label: "Author", valueType: "string", required: true, source: primary },
    { key: "content", label: "Content", valueType: "text", required: true, source: primary },
    { key: "media", label: "Media", valueType: "array", required: false, source: primary },
    { key: "created_at", label: "Created At", valueType: "datetime", required: false, source: primary },
    { key: "post_labels", label: "Post Labels", valueType: "array", required: false, source: "network_json" },
    { key: "image_text", label: "Image Text (OCR)", valueType: "text", required: false, source: "ocr_image" },
    { key: "engagement", label: "Engagement", valueType: "object", required: false, source: "network_json" },
    { key: "comments", label: "Comments", valueType: "array", required: false, source: "network_json" },
  ];
  return base.map((item) => ({
    ...item,
    id: cryptoRandomId(),
    mappings: [],
  }));
}

/** Simulated Facebook-like feed for Capture Step — not Browser Core / not live. */
export const DEFAULT_CAPTURE_SCENE: CaptureScene = {
  id: "scene.group.feed.mock",
  title: "Mock group feed (simulated)",
  defaultUrl: "https://facebook.example/groups/demo-feed",
  posts: [
    {
      id: "post.region.1",
      label: "Post region 1",
      linkedSampleId: "sample.normal.1",
      bounds: { x: 0.08, y: 0.08, width: 0.84, height: 0.24 },
    },
    {
      id: "post.region.2",
      label: "Post region 2",
      linkedSampleId: "sample.image.1",
      bounds: { x: 0.08, y: 0.36, width: 0.84, height: 0.28 },
    },
    {
      id: "post.region.3",
      label: "Post region 3",
      linkedSampleId: "sample.recruit.1",
      bounds: { x: 0.08, y: 0.68, width: 0.84, height: 0.24 },
    },
  ],
};

export function resolveCaptureLinkedSample(
  scene: CaptureScene,
  roi: { x: number; y: number; width: number; height: number },
  containerWidth: number,
  containerHeight: number,
): string {
  const cx = (roi.x + roi.width / 2) / containerWidth;
  const cy = (roi.y + roi.height / 2) / containerHeight;
  for (const post of scene.posts) {
    const b = post.bounds;
    if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) {
      return post.linkedSampleId;
    }
  }
  return scene.posts[0]?.linkedSampleId ?? "sample.normal.1";
}

export function emptyParentRange(): ParentRangeState {
  return {
    sampleLevels: { A: 3, B: 3, C: 3 },
    observedMin: 3,
    observedMax: 3,
    suggestedTolerance: 1,
    parentUp: 0,
    childDown: 0,
    highlightedLevel: 3,
    multiPostWarning: false,
    excessiveUiWarning: false,
  };
}

export function discoveryCandidates(strategy: CollectorStrategy, classification: string): DiscoveryCandidate[] {
  if (strategy === "FEED_NETWORK_JSON") {
    return [
      {
        id: "cand.feed.primary",
        strategy,
        title: "GraphQL feed edge · story node",
        confidence: 0.91,
        evidence: `Matched ${classification} via data.node.group_feed.edges[*].node`,
        matchedVariableKeys: ["post_id", "post_url", "author", "content", "created_at"],
        decision: "pending",
        detail: {
          requestId: "req_feed_8821",
          jsonPath: "$.data.node.group_feed.edges[*].node",
          parentObject: "GroupFeedEdge.node",
          relatedResponseIds: ["resp_a1", "resp_a2"],
          rawSnippet: {
            __typename: "Story",
            post_id: "pfbid_normal_001",
            message: { text: "Chào nhóm, hôm nay trời đẹp." },
          },
        },
      },
      {
        id: "cand.feed.alt",
        strategy,
        title: "Alternate comet story payload",
        confidence: 0.72,
        evidence: "Secondary pattern for same classification — lower coverage on engagement",
        matchedVariableKeys: ["post_id", "content", "author"],
        decision: "pending",
        detail: {
          requestId: "req_feed_9901",
          jsonPath: "$.data.viewer.news_feed.edges[*].node.comet_sections",
          parentObject: "CometFeedStory",
          relatedResponseIds: ["resp_b1"],
          rawSnippet: { story_id: "pfbid_normal_001", actors: [{ name: "Lan Nguyen" }] },
        },
      },
    ];
  }
  return [
    {
      id: "cand.visual.primary",
      strategy,
      title: "Detail article · role=article container",
      confidence: 0.88,
      evidence: "Visual anchor near timestamp; OCR channel separated from caption",
      matchedVariableKeys: ["post_id", "content", "image_text", "author"],
      decision: "pending",
      detail: {
        visualAnchor: "time[datetime] near article header",
        candidateContainer: "div[role=article]",
        ocrValues: ["GIẢM 50% · CHỈ HÔM NAY"],
        htmlSource: "SSR + hydration label",
        rawSnippet: { caption: "Sale cuối tuần — xem ảnh.", ocr: "GIẢM 50% · CHỈ HÔM NAY" },
      },
    },
    {
      id: "cand.visual.alt",
      strategy,
      title: "Wider feed card container (noisy)",
      confidence: 0.54,
      evidence: "Container may include adjacent posts — reject recommended",
      matchedVariableKeys: ["content"],
      decision: "pending",
      detail: {
        visualAnchor: "group feed card chrome",
        candidateContainer: "div.feed-card-wide",
        ocrValues: [],
        htmlSource: "client hydration",
        warning: "multi_post_risk",
        rawSnippet: { note: "excessive surrounding UI" },
      },
    },
  ];
}

export function buildValidationRun(
  outcome: ValidationOutcome,
  trainingSampleIds: string[],
  variables: CollectorVariable[],
  opts?: {
    captureRefs?: Array<{ captureItemId: string; mockSampleId: string; auditStatus?: string }>;
    pendingCount?: number;
    needsAttentionCount?: number;
    excludedCount?: number;
  },
): ValidationRun {
  const holdout = holdoutForClassification(
    sampleById(trainingSampleIds[0] ?? "")?.classification ?? "facebook.group.normal_post",
  );
  const requiredKeys = variables.filter((v) => v.required).map((v) => v.key);
  const makeRecord = (
    sampleId: string,
    role: "training" | "holdout",
    slot: "A" | "B" | "C" | undefined,
    mutate: (expected: Record<string, string>, actual: Record<string, string>) => ValidationRun["records"][0],
    captureItemId?: string,
    auditStatus?: ValidationRun["records"][0]["auditStatus"],
  ) => {
    const sample = sampleById(sampleId);
    const expected: Record<string, string> = {};
    const actual: Record<string, string> = {};
    for (const variable of variables) {
      const observed = sample?.observedValues.find((o) => o.label.startsWith(variable.key) || o.label === variable.key);
      const value = observed?.value ?? "";
      expected[variable.key] = value;
      actual[variable.key] = value;
    }
    const base = mutate(expected, actual);
    return { ...base, captureItemId, auditStatus };
  };

  const refs = opts?.captureRefs?.length
    ? opts.captureRefs
    : trainingSampleIds.map((id, index) => ({
        captureItemId: id,
        mockSampleId: id,
        auditStatus: "confirmed",
      }));

  const records = refs.map((ref, index) => {
    const slot = index < 3 ? (["A", "B", "C"] as const)[index] : undefined;
    return makeRecord(ref.mockSampleId, "training", slot, (expected, actual) => {
      let missingRequired: string[] = [];
      let optionalMissing: string[] = [];
      let identityMismatch = false;
      let duplicateOf: string | undefined;
      let result: ValidationRun["records"][0]["result"] = "valid";

      if (outcome === "missing_required" && index === 0) {
        const key = requiredKeys[0] ?? "post_id";
        actual[key] = "";
        missingRequired = [key];
        result = "failed";
      } else if (outcome === "partial" && index === 1) {
        optionalMissing = variables.filter((v) => !v.required).slice(0, 2).map((v) => v.key);
        for (const key of optionalMissing) actual[key] = "";
        result = "partial";
      } else if (outcome === "failed" && index === Math.min(2, refs.length - 1)) {
        if (actual.content) actual.content = "WRONG_VALUE";
        identityMismatch = true;
        result = "failed";
      } else if (outcome === "ambiguous_match" && index === 0) {
        duplicateOf = refs[1]?.mockSampleId;
        identityMismatch = true;
        result = "partial";
      }
      return {
        sampleId: ref.mockSampleId,
        role: "training",
        slot,
        expected,
        actual,
        missingRequired,
        optionalMissing,
        identityMismatch,
        duplicateOf,
        result,
      };
    }, ref.captureItemId, ref.auditStatus as ValidationRun["records"][0]["auditStatus"]);
  });

  if (holdout) {
    records.push(
      makeRecord(holdout.id, "holdout", undefined, (expected, actual) => {
        let result: ValidationRun["records"][0]["result"] = "valid";
        let missingRequired: string[] = [];
        let identityMismatch = false;
        if (outcome === "failed" || outcome === "missing_required") {
          result = "failed";
          missingRequired = requiredKeys.slice(0, 1);
        } else if (outcome === "partial" || outcome === "ambiguous_match") {
          result = "partial";
          identityMismatch = outcome === "ambiguous_match";
        }
        return {
          sampleId: holdout.id,
          role: "holdout",
          expected,
          actual,
          missingRequired,
          optionalMissing: [],
          identityMismatch,
          result,
        };
      }),
    );
  }

  const matched = records.filter((r) => r.result === "valid").length;
  const partial = records.filter((r) => r.result === "partial").length;
  const unmatched = records.filter((r) => r.result === "failed").length;
  const duplicates = records.filter((r) => r.duplicateOf).length;

  return {
    id: cryptoRandomId(),
    outcome,
    ranAt: new Date().toISOString(),
    outdated: false,
    records,
    metrics: {
      matched,
      partial,
      unmatched,
      unique: records.length - duplicates,
      duplicates,
    },
    rawJson: {
      simulated: true,
      outcome,
      pendingReview: opts?.pendingCount ?? 0,
      needsAttention: opts?.needsAttentionCount ?? 0,
      excluded: opts?.excludedCount ?? 0,
      records: records.map((r) => ({
        sampleId: r.sampleId,
        captureItemId: r.captureItemId,
        auditStatus: r.auditStatus,
        result: r.result,
        actual: r.actual,
      })),
    },
    evidence: [
      `Confirmed audits used for training simulation: ${refs.length}`,
      `Pending review (not invalidating confirmed): ${opts?.pendingCount ?? 0}`,
      `Needs Attention (isolated): ${opts?.needsAttentionCount ?? 0}`,
      `Excluded: ${opts?.excludedCount ?? 0}`,
      `Simulated validation · outcome=${outcome}`,
      "No live Facebook data was accessed.",
      `Training samples: ${trainingSampleIds.join(", ") || "(none)"}`,
      holdout ? `Holdout: ${holdout.id}` : "Holdout: unavailable for classification",
    ],
  };
}

export function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createEmptyDraft(input: {
  name: string;
  description?: string;
  strategy?: CollectorStrategy | "";
  platformLabel?: string;
  classification?: string;
}): CollectorDraft {
  const now = new Date().toISOString();
  const strategy = input.strategy ?? "";
  const classification = (input.classification ?? "").trim();
  return {
    id: cryptoRandomId(),
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    strategy,
    platformLabel: (input.platformLabel ?? "").trim(),
    classification,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    wizardStep: 1,
    captures: [],
    captureAudits: [],
    schemaRevision: 1,
    samples: [
      { slot: "A", captureItemId: null },
      { slot: "B", captureItemId: null },
      { slot: "C", captureItemId: null },
    ],
    samplesCompatible: false,
    variables: defaultVariables(strategy),
    parentRange: emptyParentRange(),
    candidates: strategy
      ? discoveryCandidates(strategy, classification || "unclassified")
      : [],
    variants: [],
    auditActions: [],
    versions: [],
    dirty: true,
  };
}
