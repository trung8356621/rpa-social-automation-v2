import test from "node:test";
import assert from "node:assert/strict";
import type { Rect, OcrResult, OcrSegment } from "../src/shared/contracts.js";
import type {
  CollectorDraft,
  CollectorDomSnapshot,
} from "../src/shared/collectors/types.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  addRegionToDraft,
  saveAsVersion,
  revertDraftToVersion,
} from "../src/shared/collectors/ops.js";
import {
  assignSegmentMapping,
  buildLearnedAnchorRules,
  createCollectorRegion,
  executeLiveBrowserMatchTest,
  getGroupTagSuggestions,
  proposeRegionQuickFill,
  confirmQuickFillMapping,
  rejectQuickFillMapping,
} from "../src/shared/collectors/regions.js";
import { proposeLearnedMappings } from "../src/shared/collectors/ocr-learning.js";
import { MemoryStorage, loadCollectorStore, saveCollectorStore, upsertCollector } from "../src/shared/collectors/store.js";

function makeTestDraftWithCaptures(count = 2): { draft: CollectorDraft; capIds: string[] } {
  let draft = createEmptyDraft({ name: "C2.11 Test Collector" });
  const capIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const hex = i.toString(16).padStart(8, "0");
    const asset = `${hex}-0000-0000-0000-000000000000.png`;
    draft = addCaptureItem(draft, {
      imageAsset: asset,
      captureUrl: `https://example.com/post/${i}`,
      roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
    });
    capIds.push(draft.captures[draft.captures.length - 1].id);
  }
  return { draft, capIds };
}

function makeRegionOcr(segments: OcrSegment[], roi: Rect): OcrResult {
  return {
    text: segments.map((s) => s.text).join("\n"),
    confidence: 94,
    language: "vie+eng",
    containerCrop: { ...roi },
    cropOffset: { x: roi.x, y: roi.y },
    segments,
  };
}

// ---------------------------------------------------------------------------
// CHECKPOINT A: Group Tag Auto-complete Tests
// ---------------------------------------------------------------------------

test("Checkpoint A: getGroupTagSuggestions discovers existing group tags from draft and captures", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0];

  const reg1 = createCollectorRegion({
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: { x: 50, y: 50, width: 400, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const reg2 = createCollectorRegion({
    captureItemId: cap1,
    type: "END",
    groupTag: "post-comments",
    label: "Comments Footer",
    box: { x: 50, y: 500, width: 400, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
  });

  let draftWithRegions = addRegionToDraft(draft, reg1);
  draftWithRegions = addRegionToDraft(draftWithRegions, reg2);

  const suggestions = getGroupTagSuggestions(draftWithRegions, cap1, "BEGIN", "");
  assert.ok(suggestions.length >= 2);
  const tags = suggestions.map((s) => s.tag);
  assert.ok(tags.includes("post-main"));
  assert.ok(tags.includes("post-comments"));
});

test("Checkpoint A: Prioritizes unpaired BEGIN missing END when creating END anchor", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0];

  // BEGIN for "post-main", no END yet
  const begin = createCollectorRegion({
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Post Main Begin",
    box: { x: 50, y: 50, width: 400, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });
  // Both BEGIN and END for "sidebar"
  const sideBegin = createCollectorRegion({
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "sidebar",
    label: "Sidebar Begin",
    box: { x: 500, y: 50, width: 200, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const sideEnd = createCollectorRegion({
    captureItemId: cap1,
    type: "END",
    groupTag: "sidebar",
    label: "Sidebar End",
    box: { x: 500, y: 400, width: 200, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });

  let d = addRegionToDraft(draft, begin);
  d = addRegionToDraft(d, sideBegin);
  d = addRegionToDraft(d, sideEnd);

  // When creating END anchor in cap1:
  const suggestions = getGroupTagSuggestions(d, cap1, "END", "");
  assert.ok(suggestions.length > 0);
  assert.equal(suggestions[0].tag, "post-main");
  assert.equal(suggestions[0].kind, "unpaired_in_sample");
  assert.equal(suggestions[0].hasBeginInSample, true);
  assert.equal(suggestions[0].hasEndInSample, false);
});

test("Checkpoint A: Suggests previously used group names from other samples when creating BEGIN", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;

  const cap1Begin = createCollectorRegion({
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "facebook-feed-item",
    label: "Feed Item Begin",
    box: { x: 20, y: 20, width: 300, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const d = addRegionToDraft(draft, cap1Begin);

  const suggestions = getGroupTagSuggestions(d, cap2, "BEGIN", "");
  const fbItem = suggestions.find((s) => s.tag === "facebook-feed-item");
  assert.ok(fbItem, "Should suggest group tag from cap1");
  assert.equal(fbItem.kind, "other_sample");
  assert.equal(fbItem.sampleCount, 1);
});

test("Checkpoint A: Free regions do not require group tags and return no suggestions", () => {
  const base = createEmptyDraft({ name: "Free Region Test" });
  const suggestions = getGroupTagSuggestions(base, "cap_1", "FREE", "post");
  assert.deepEqual(suggestions, []);
});

test("Checkpoint A: Provides 'create_new' option for novel input without mutating existing tags", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0];

  const reg = createCollectorRegion({
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "existing-group",
    label: "Begin",
    box: { x: 10, y: 10, width: 100, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const d = addRegionToDraft(draft, reg);

  const suggestions = getGroupTagSuggestions(d, cap1, "BEGIN", "brand-new-tag");
  const createNew = suggestions.find((s) => s.kind === "create_new");
  assert.ok(createNew);
  assert.equal(createNew.tag, "brand-new-tag");

  // Existing tags in draft remain completely intact
  const currentTags = (d.regions ?? []).map((r) => r.groupTag);
  assert.deepEqual(currentTags, ["existing-group"]);
});

// ---------------------------------------------------------------------------
// CHECKPOINT B: Region-Based Quick Fill Tests
// ---------------------------------------------------------------------------

test("Checkpoint B: Propose mappings for Sample 2 using confirmed Sample 1 reference and region.ocr", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [sample1, sample2] = capIds;
  let draft = baseDraft;

  // 1. Setup Sample 1 confirmed BEGIN anchor with region-specific OCR
  const refRoi: Rect = { x: 50, y: 50, width: 400, height: 100 };
  const refOcr = makeRegionOcr(
    [
      { id: "ref_seg_author", text: "Nguyễn Văn A", kind: "line", confidence: 96, bbox: { x: 10, y: 10, width: 180, height: 25 } },
      { id: "ref_seg_time", text: "2 giờ trước", kind: "line", confidence: 92, bbox: { x: 10, y: 40, width: 110, height: 20 } },
      { id: "ref_seg_link", text: "Xem bài viết", kind: "line", confidence: 95, bbox: { x: 10, y: 70, width: 130, height: 20 } },
    ],
    refRoi,
  );

  const refRegion = createCollectorRegion({
    id: "ref_begin_1",
    captureItemId: sample1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Post Header",
    role: "header",
    box: refRoi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: refOcr,
    confirmed: true,
  });
  draft = addRegionToDraft(draft, refRegion);

  draft.variables = [
    { id: "var_author", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
    { id: "var_time", key: "created_at", label: "Created At", valueType: "string", required: false, mappings: [] },
    { id: "var_url", key: "post_url", label: "Post URL", valueType: "url", required: false, mappings: [] },
  ];

  draft = assignSegmentMapping(
    draft,
    sample1,
    "var_author",
    refOcr.segments[0],
    refRegion.id,
    "OCR_TEXT",
  );
  draft = assignSegmentMapping(
    draft,
    sample1,
    "var_time",
    refOcr.segments[1],
    refRegion.id,
    "OCR_TEXT",
  );
  draft = assignSegmentMapping(
    draft,
    sample1,
    "var_url",
    refOcr.segments[2],
    refRegion.id,
    "DOM_ATTRIBUTE",
    "href",
  );

  // 2. Setup Sample 2 new BEGIN anchor with its own region.ocr (NO capture.ocr)
  const targetRoi: Rect = { x: 50, y: 60, width: 410, height: 105 };
  const targetOcr = makeRegionOcr(
    [
      { id: "target_seg_author", text: "Trần Thị B", kind: "line", confidence: 97, bbox: { x: 12, y: 12, width: 175, height: 24 } },
      { id: "target_seg_time", text: "5 phút trước", kind: "line", confidence: 93, bbox: { x: 11, y: 42, width: 105, height: 20 } },
      { id: "target_seg_link", text: "Chi tiết bài viết", kind: "line", confidence: 94, bbox: { x: 10, y: 72, width: 135, height: 21 } },
    ],
    targetRoi,
  );

  const targetRegion = createCollectorRegion({
    id: "target_begin_2",
    captureItemId: sample2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Post Header S2",
    role: "header",
    box: targetRoi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: targetOcr,
    confirmed: false,
  });
  draft = addRegionToDraft(draft, targetRegion);

  const targetCap = draft.captures.find((c) => c.id === sample2);
  assert.equal(targetCap?.ocr, undefined, "Sample 2 must not rely on capture.ocr");

  // 3. Run proposeRegionQuickFill
  const result = proposeRegionQuickFill(draft, targetRegion.id, 800, 600);
  assert.equal(result.appliedCount, 3, "All 3 variables must be proposed");
  assert.equal(result.proposals.length, 3);

  // Rule 4: Preserves extraction methods and attribute names
  const authorProp = result.proposals.find((p) => p.variableKey === "author")!;
  const timeProp = result.proposals.find((p) => p.variableKey === "created_at")!;
  const urlProp = result.proposals.find((p) => p.variableKey === "post_url")!;

  assert.equal(authorProp.method, "OCR_TEXT");
  assert.equal(timeProp.method, "OCR_TEXT");
  assert.equal(urlProp.method, "DOM_ATTRIBUTE");
  assert.equal(urlProp.attribute, "href");

  // Rule 5: Do NOT copy old segment IDs directly!
  assert.equal(authorProp.targetSegmentId, "target_seg_author");
  assert.notEqual(authorProp.targetSegmentId, "ref_seg_author");
  assert.equal(timeProp.targetSegmentId, "target_seg_time");
  assert.notEqual(timeProp.targetSegmentId, "ref_seg_time");
  assert.equal(urlProp.targetSegmentId, "target_seg_link");
  assert.notEqual(urlProp.targetSegmentId, "ref_seg_link");

  // Rule 7: Mark automatic proposals as SUGGESTED (confirmed: false, simulatedProposal: true)
  const updatedDraft = result.draft;
  for (const v of updatedDraft.variables) {
    const targetMapping = v.mappings.find((m) => m.sampleId === sample2);
    assert.ok(targetMapping, `Variable ${v.key} must have target mapping`);
    assert.equal(targetMapping.confirmed, false, "Proposal must not be marked confirmed");
    assert.equal(targetMapping.simulatedProposal, true, "Proposal must be flagged simulatedProposal");
    assert.ok(targetMapping.confidence != null && targetMapping.confidence >= 50);
  }

  // Rule 8: Accept proposal marks it confirmed
  const acceptedDraft = confirmQuickFillMapping(updatedDraft, sample2, "var_author", targetRegion.id);
  const authorMapping = acceptedDraft.variables.find((v) => v.id === "var_author")!.mappings.find((m) => m.sampleId === sample2)!;
  assert.equal(authorMapping.confirmed, true);
  assert.equal(authorMapping.simulatedProposal, false);

  // Reject proposal removes it
  const rejectedDraft = rejectQuickFillMapping(acceptedDraft, sample2, "var_time", targetRegion.id);
  const timeMapping = rejectedDraft.variables.find((v) => v.id === "var_time")!.mappings.find((m) => m.sampleId === sample2);
  assert.equal(timeMapping, undefined);
});

test("Checkpoint B: Rule 9 — Never overwrites existing confirmed manual mappings", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [sample1, sample2] = capIds;
  let draft = baseDraft;

  const refRoi: Rect = { x: 50, y: 50, width: 400, height: 100 };
  const refOcr = makeRegionOcr(
    [{ id: "ref_seg", text: "Ref Author", kind: "line", confidence: 95, bbox: { x: 10, y: 10, width: 100, height: 20 } }],
    refRoi,
  );
  const refRegion = createCollectorRegion({
    id: "ref_1",
    captureItemId: sample1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: refRoi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: refOcr,
    confirmed: true,
  });
  draft = addRegionToDraft(draft, refRegion);

  draft.variables = [
    { id: "var_1", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
  ];
  draft = assignSegmentMapping(draft, sample1, "var_1", refOcr.segments[0], refRegion.id, "OCR_TEXT");

  const targetRoi: Rect = { x: 50, y: 50, width: 400, height: 100 };
  const targetOcr = makeRegionOcr(
    [{ id: "target_seg", text: "Target Author", kind: "line", confidence: 96, bbox: { x: 10, y: 10, width: 100, height: 20 } }],
    targetRoi,
  );
  const targetRegion = createCollectorRegion({
    id: "target_1",
    captureItemId: sample2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header S2",
    box: targetRoi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: targetOcr,
    confirmed: false,
  });
  draft = addRegionToDraft(draft, targetRegion);

  // User ALREADY manually confirmed a mapping on Sample 2
  draft.variables[0].mappings.push({
    sampleId: sample2,
    regionId: targetRegion.id,
    presence: "mapped",
    confirmed: true, // MANUALLY CONFIRMED
    method: "OCR_TEXT",
    segmentId: "manual_seg",
    text: "Manual Confirmation Text",
    confidence: 100,
    bbox: { x: 10, y: 10, width: 100, height: 20 },
  });

  // Run Quick Fill
  const res = proposeRegionQuickFill(draft, targetRegion.id, 800, 600);
  assert.equal(res.appliedCount, 0, "Must not propose over confirmed mapping");

  const v = res.draft.variables[0];
  const m = v.mappings.find((item) => item.sampleId === sample2);
  assert.equal(m?.confirmed, true);
  assert.equal(m?.segmentId, "manual_seg");
  assert.equal(m?.text, "Manual Confirmation Text");
});

test("Checkpoint B: proposeLearnedMappings uses region.ocr and does not depend on capture.ocr", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [sample1, sample2] = capIds;
  let draft = baseDraft;

  const roi: Rect = { x: 0, y: 0, width: 300, height: 80 };
  const ocr1 = makeRegionOcr(
    [{ id: "s1_seg", text: "John Doe", kind: "line", confidence: 95, bbox: { x: 5, y: 5, width: 120, height: 20 } }],
    roi,
  );
  const r1 = createCollectorRegion({
    id: "reg_1",
    captureItemId: sample1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: roi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: ocr1,
    confirmed: true,
  });
  draft = addRegionToDraft(draft, r1);

  draft.variables = [
    { id: "var_user", key: "username", label: "Username", valueType: "string", required: true, mappings: [] },
  ];
  draft = assignSegmentMapping(draft, sample1, "var_user", ocr1.segments[0], r1.id, "OCR_TEXT");

  const ocr2 = makeRegionOcr(
    [{ id: "s2_seg", text: "Jane Smith", kind: "line", confidence: 96, bbox: { x: 5, y: 5, width: 130, height: 22 } }],
    roi,
  );
  const r2 = createCollectorRegion({
    id: "reg_2",
    captureItemId: sample2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header S2",
    box: roi,
    imageWidth: 800,
    imageHeight: 600,
    ocr: ocr2,
    confirmed: false,
  });
  draft = addRegionToDraft(draft, r2);

  const proposedDraft = proposeLearnedMappings(draft, sample2, 800, 600);
  const mapping = proposedDraft.variables[0].mappings.find((m) => m.sampleId === sample2);
  assert.ok(mapping, "proposeLearnedMappings must succeed via region.ocr");
  assert.equal(mapping.segmentId, "s2_seg");
  assert.equal(mapping.simulatedProposal, true);
});

// ---------------------------------------------------------------------------
// CHECKPOINT C: Learned Anchor Rule Foundation Tests
// ---------------------------------------------------------------------------

test("Checkpoint C: buildLearnedAnchorRules aggregates multi-sample confirmed examples into reusable rules", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;
  let draft = baseDraft;

  // Sample 1: BEGIN post-main with Author 1 and Timestamp 1
  const b1Roi: Rect = { x: 40, y: 40, width: 380, height: 80 };
  const b1Ocr = makeRegionOcr(
    [
      { id: "b1_author", text: "Nguyễn Văn Hùng", kind: "line", confidence: 96, bbox: { x: 10, y: 10, width: 180, height: 25 } },
      { id: "b1_time", text: "2 giờ trước", kind: "line", confidence: 94, bbox: { x: 10, y: 40, width: 110, height: 20 } },
    ],
    b1Roi,
  );
  const begin1 = createCollectorRegion({
    id: "begin_1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header Anchor S1",
    role: "header",
    domEvidence: { tagName: "DIV", role: "heading" },
    box: b1Roi,
    imageWidth: 800,
    imageHeight: 1000,
    ocr: b1Ocr,
    confirmed: true,
  });
  begin1.candidateVariableKeys = ["author", "created_at"];

  // Sample 1: END post-main with Action Buttons
  const e1Roi: Rect = { x: 40, y: 500, width: 380, height: 50 };
  const e1Ocr = makeRegionOcr(
    [
      { id: "e1_btn", text: "Thích Bình luận Chia sẻ", kind: "line", confidence: 95, bbox: { x: 10, y: 10, width: 250, height: 25 } },
    ],
    e1Roi,
  );
  const end1 = createCollectorRegion({
    id: "end_1",
    captureItemId: cap1,
    type: "END",
    groupTag: "post-main",
    label: "Footer Anchor S1",
    role: "footer",
    box: e1Roi,
    imageWidth: 800,
    imageHeight: 1000,
    ocr: e1Ocr,
    confirmed: true,
  });

  // Sample 2: BEGIN post-main with DIFFERENT author and timestamp
  const b2Roi: Rect = { x: 45, y: 42, width: 390, height: 82 };
  const b2Ocr = makeRegionOcr(
    [
      { id: "b2_author", text: "Trần Mai Anh", kind: "line", confidence: 95, bbox: { x: 10, y: 10, width: 170, height: 25 } },
      { id: "b2_time", text: "Hôm qua lúc 15:30", kind: "line", confidence: 92, bbox: { x: 10, y: 40, width: 140, height: 20 } },
    ],
    b2Roi,
  );
  const begin2 = createCollectorRegion({
    id: "begin_2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header Anchor S2",
    role: "header",
    domEvidence: { tagName: "DIV", role: "heading" },
    box: b2Roi,
    imageWidth: 800,
    imageHeight: 1000,
    ocr: b2Ocr,
    confirmed: true,
  });
  begin2.candidateVariableKeys = ["author", "created_at"];

  // Sample 2: END post-main with matching stable action buttons
  const e2Roi: Rect = { x: 45, y: 520, width: 390, height: 52 };
  const e2Ocr = makeRegionOcr(
    [
      { id: "e2_btn", text: "Thích Bình luận Chia sẻ", kind: "line", confidence: 96, bbox: { x: 10, y: 10, width: 250, height: 25 } },
    ],
    e2Roi,
  );
  const end2 = createCollectorRegion({
    id: "end_2",
    captureItemId: cap2,
    type: "END",
    groupTag: "post-main",
    label: "Footer Anchor S2",
    role: "footer",
    box: e2Roi,
    imageWidth: 800,
    imageHeight: 1000,
    ocr: e2Ocr,
    confirmed: true,
  });

  draft = addRegionToDraft(draft, begin1);
  draft = addRegionToDraft(draft, end1);
  draft = addRegionToDraft(draft, begin2);
  draft = addRegionToDraft(draft, end2);

  draft.variables = [
    {
      id: "v_author",
      key: "author",
      label: "Author",
      valueType: "string",
      required: true,
      mappings: [
        { sampleId: cap1, regionId: "begin_1", presence: "mapped", confirmed: true, text: "Nguyễn Văn Hùng", segmentId: "b1_author" },
        { sampleId: cap2, regionId: "begin_2", presence: "mapped", confirmed: true, text: "Trần Mai Anh", segmentId: "b2_author" },
      ],
    },
    {
      id: "v_time",
      key: "created_at",
      label: "Timestamp",
      valueType: "string",
      required: false,
      mappings: [
        { sampleId: cap1, regionId: "begin_1", presence: "mapped", confirmed: true, text: "2 giờ trước", segmentId: "b1_time" },
        { sampleId: cap2, regionId: "begin_2", presence: "mapped", confirmed: true, text: "Hôm qua lúc 15:30", segmentId: "b2_time" },
      ],
    },
  ];

  const rules = buildLearnedAnchorRules(draft);
  assert.ok(rules.has("post-main"));

  const postMainRule = rules.get("post-main")!;
  assert.equal(postMainRule.sampleIds.length, 2);
  assert.ok(postMainRule.beginRule);
  assert.ok(postMainRule.endRule);

  // 1. Geometry Profile computed across both samples
  const geom = postMainRule.beginRule.geometryProfile;
  assert.ok(geom.minRelX <= geom.avgRelX && geom.avgRelX <= geom.maxRelX);
  assert.ok(geom.minRelY <= geom.avgRelY && geom.avgRelY <= geom.maxRelY);
  assert.ok(geom.minRelW <= geom.avgRelW && geom.avgRelW <= geom.maxRelW);
  assert.ok(geom.minRelH <= geom.avgRelH && geom.avgRelH <= geom.maxRelH);

  // 2. Distinguishes variable content from stable text
  const varTokens = postMainRule.beginRule.variableTokens;
  assert.ok(
    varTokens.some((t) => ["nguyen", "van", "hung", "tran", "mai", "anh"].includes(t)),
    "Author tokens must be classified as variable content",
  );

  const stableTokens = postMainRule.endRule.stableTokens;
  assert.ok(
    stableTokens.some((t) => ["thich", "binh", "luan", "chia", "se"].includes(t)),
    "Action button text must be recognized as stable anchor tokens",
  );

  // 3. Match Test against live browser DOM with a DIFFERENT author
  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "feed_root",
        tagName: "DIV",
        role: "feed",
        rect: { x: 100, y: 0, width: 680, height: 1600 },
        textSnippet: "",
        attributes: {},
        childrenIds: ["post_article_1"],
        depth: 0,
        isFeedContainer: true,
      },
      {
        id: "post_article_1",
        tagName: "DIV",
        role: "article",
        rect: { x: 100, y: 50, width: 680, height: 500 },
        textSnippet: "Lê Hoàng Long 10 phút trước Nội dung bài viết... Thích Bình luận Chia sẻ",
        attributes: {},
        childrenIds: ["live_header", "live_body", "live_footer"],
        parentId: "feed_root",
        depth: 1,
        isArticleOrCard: true,
      },
      {
        id: "live_header",
        tagName: "DIV",
        role: "heading",
        rect: { x: 110, y: 60, width: 660, height: 60 },
        textSnippet: "Lê Hoàng Long 10 phút trước", // DIFFERENT author & time!
        attributes: {},
        childrenIds: [],
        parentId: "post_article_1",
        depth: 2,
      },
      {
        id: "live_body",
        tagName: "DIV",
        rect: { x: 110, y: 130, width: 660, height: 350 },
        textSnippet: "Nội dung bài viết...",
        attributes: {},
        childrenIds: [],
        parentId: "post_article_1",
        depth: 2,
      },
      {
        id: "live_footer",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 110, y: 490, width: 660, height: 50 },
        textSnippet: "Thích Bình luận Chia sẻ",
        attributes: {},
        childrenIds: [],
        parentId: "post_article_1",
        depth: 2,
      },
    ],
  };

  const matchResult = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft);

  assert.equal(matchResult.status, "MATCHED");
  assert.equal(matchResult.matchedPostCount, 1);
  assert.ok(matchResult.groups[0].beginMatch?.matched);
  assert.ok(matchResult.groups[0].endMatch?.matched);
  assert.equal(matchResult.groups[0].domAssociationStatus, "CONFIRMED");
  assert.equal(matchResult.groups[0].domContainer?.containerId, "post_article_1");
  assert.ok(matchResult.groups[0].visualConfidence >= 65);
});

test("Checkpoint C: Version snapshots and saves preserve Quick Fill and learned rule data", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;
  let draft = baseDraft;

  const roi: Rect = { x: 10, y: 10, width: 300, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: roi,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
  });
  const reg2 = createCollectorRegion({
    id: "r2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header S2",
    box: roi,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: false,
    simulatedProposal: true,
  });
  draft = addRegionToDraft(draft, reg1);
  draft = addRegionToDraft(draft, reg2);

  draft.variables = [
    {
      id: "v1",
      key: "author",
      label: "Author",
      valueType: "string",
      required: true,
      mappings: [
        { sampleId: cap1, regionId: "r1", presence: "mapped", confirmed: true, text: "User 1", segmentId: "s1" },
        { sampleId: cap2, regionId: "r2", presence: "mapped", confirmed: false, simulatedProposal: true, text: "User 2", segmentId: "s2", confidence: 88 },
      ],
    },
  ];

  // 1. Save as Version
  const withVersion = saveAsVersion(draft, "v1.0-learned");
  const snap = withVersion.versions[0];
  assert.ok(snap);
  assert.equal(snap.regions?.length, 2);
  const snapVar = snap.variables[0];
  assert.equal(snapVar.mappings.length, 2);
  const snapProposal = snapVar.mappings.find((m) => m.sampleId === cap2);
  assert.equal(snapProposal?.confirmed, false);
  assert.equal(snapProposal?.simulatedProposal, true);

  // 2. Save to store and reload
  const storage = new MemoryStorage();
  let env = loadCollectorStore(storage);
  env = upsertCollector(env, withVersion);
  saveCollectorStore(storage, env);
  const loaded = loadCollectorStore(storage);
  const loadedDraft = loaded.collectors[0];
  assert.ok(loadedDraft);
  assert.equal(loadedDraft.versions.length, 1);
  assert.equal(loadedDraft.regions?.length, 2);

  // Revert test
  const reverted = revertDraftToVersion(loadedDraft, snap.id);
  assert.ok(reverted);
  assert.equal(reverted.regions?.length, 2);
  const revProposal = reverted.variables[0].mappings.find((m) => m.sampleId === cap2);
  assert.equal(revProposal?.confidence, 88);
  assert.equal(revProposal?.simulatedProposal, true);
});
