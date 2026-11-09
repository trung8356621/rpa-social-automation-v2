import test from "node:test";
import assert from "node:assert/strict";
import type { Rect, OcrResult, OcrSegment } from "../src/shared/contracts.js";
import type {
  CollectorDraft,
  CollectorDomSnapshot,
  CollectorDomElement,
} from "../src/shared/collectors/types.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  addRegionToDraft,
  saveAsVersion,
  revertDraftToVersion,
  confirmCaptureAudit,
  auditForCapture,
  applyAuditActionAndAdvance,
} from "../src/shared/collectors/ops.js";
import {
  assignSegmentMapping,
  buildLearnedAnchorRules,
  createCollectorRegion,
  evaluateLiveBeginCandidates,
  executeLiveBrowserMatchTest,
  findAnchorCandidates,
  getGroupTagSuggestions,
  getLearnedCandidateVariablesForGroup,
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

// ---------------------------------------------------------------------------
// C2.11.3 Issue A: Candidate Variables Auto-Fill Tests
// ---------------------------------------------------------------------------

test("C2.11.3 Issue A: getLearnedCandidateVariablesForGroup inherits candidate variables matching groupTag and type", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(3);
  const [cap1, cap2, cap3] = capIds;

  draft.variables = [
    { id: "v1", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
    { id: "v2", key: "created_at", label: "Created At", valueType: "string", required: true, mappings: [] },
    { id: "v3", key: "like_count", label: "Likes", valueType: "number", required: false, mappings: [] },
  ];

  // Confirmed BEGIN on sample 1 with author & created_at
  const b1 = createCollectorRegion({
    id: "b1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 1",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
    candidateVariableKeys: ["author", "created_at"],
    confirmed: true,
  });

  // Confirmed END on sample 1 with like_count
  const e1 = createCollectorRegion({
    id: "e1",
    captureItemId: cap1,
    type: "END",
    groupTag: "post-main",
    label: "Footer 1",
    box: { x: 20, y: 500, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
    candidateVariableKeys: ["like_count"],
    confirmed: true,
  });

  // Confirmed BEGIN on sample 2 also with author
  const b2 = createCollectorRegion({
    id: "b2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 2",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
    candidateVariableKeys: ["author"],
    confirmed: true,
  });

  let d = addRegionToDraft(draft, b1);
  d = addRegionToDraft(d, e1);
  d = addRegionToDraft(d, b2);

  // When creating a BEGIN anchor on sample 3 for "post-main":
  const learnedBegin = getLearnedCandidateVariablesForGroup(d, "post-main", "BEGIN", cap3);
  assert.equal(learnedBegin.sampleCount, 2);
  assert.ok(learnedBegin.variableKeys.includes("author"));
  assert.ok(learnedBegin.variableKeys.includes("created_at"));
  // Rule: Never mix BEGIN variables with END variables
  assert.ok(!learnedBegin.variableKeys.includes("like_count"));

  // When creating an END anchor on sample 3 for "post-main":
  const learnedEnd = getLearnedCandidateVariablesForGroup(d, "post-main", "END", cap3);
  assert.equal(learnedEnd.sampleCount, 1);
  assert.deepEqual(learnedEnd.variableKeys, ["like_count"]);
  assert.ok(!learnedEnd.variableKeys.includes("author"));
});

// ---------------------------------------------------------------------------
// C2.11.3 Issue B: Canonical Region Prioritization & Live Match Heuristics
// ---------------------------------------------------------------------------

test("C2.11.3 Issue B: Prioritizes confirmed OCR regions over blank unconfirmed regions during live match", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;
  draft.teachingCaptureId = cap2; // Active capture is sample 2, but has blank unconfirmed regions

  const confirmedBegin = createCollectorRegion({
    id: "cb1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "post-main Begin",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
    ocrText: "Nguyễn Văn A · 2 giờ",
    confirmed: true,
  });

  const confirmedEnd = createCollectorRegion({
    id: "ce1",
    captureItemId: cap1,
    type: "END",
    groupTag: "post-main",
    label: "post-main End",
    box: { x: 20, y: 500, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
    ocrText: "Thích Bình luận Chia sẻ",
    confirmed: true,
  });

  const blankBegin = createCollectorRegion({
    id: "bb2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "post-main Begin",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
    confirmed: false,
  });

  const blankEnd = createCollectorRegion({
    id: "be2",
    captureItemId: cap2,
    type: "END",
    groupTag: "post-main",
    label: "post-main End",
    box: { x: 20, y: 500, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
    confirmed: false,
  });

  let d = addRegionToDraft(draft, confirmedBegin);
  d = addRegionToDraft(d, confirmedEnd);
  d = addRegionToDraft(d, blankBegin);
  d = addRegionToDraft(d, blankEnd);

  // Live snapshot with real social post structure
  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/123",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "feed_1",
        tagName: "DIV",
        role: "feed",
        rect: { x: 200, y: 0, width: 680, height: 1600 },
        textSnippet: "",
        attributes: { role: "feed" },
        depth: 1,
        childrenIds: ["post_1"],
        isFeedContainer: true,
      },
      {
        id: "post_1",
        tagName: "DIV",
        rect: { x: 200, y: 80, width: 680, height: 500 },
        textSnippet: "Trần Thị B · 5 phút ... Chia sẻ",
        attributes: {},
        depth: 2,
        parentId: "feed_1",
        childrenIds: ["header_1", "footer_1"],
        isArticleOrCard: true,
      },
      {
        id: "header_1",
        tagName: "A",
        role: "link",
        rect: { x: 220, y: 100, width: 250, height: 40 },
        textSnippet: "Trần Thị B · 5 phút",
        attributes: { href: "/user/tran.thi.b", role: "link" },
        depth: 3,
        parentId: "post_1",
        childrenIds: [],
      },
      {
        id: "footer_1",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 220, y: 520, width: 640, height: 40 },
        textSnippet: "Thích Bình luận Chia sẻ",
        attributes: { role: "toolbar" },
        depth: 3,
        parentId: "post_1",
        childrenIds: [],
      },
    ],
  };

  const result = executeLiveBrowserMatchTest(d.regions ?? [], snapshot, d);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedPostCount, 1);
  assert.equal(result.groups[0]?.status, "MATCHED");
  assert.equal(result.groups[0]?.domAssociationStatus, "CONFIRMED");
  assert.equal(result.matchedItems?.[0]?.domResolved, true);
});

test("C2.11.3 Issue B: findAnchorCandidates recognizes social header and actions bar", () => {
  const beginRegion = createCollectorRegion({
    captureItemId: "s1",
    type: "BEGIN",
    groupTag: "post-main",
    label: "post-main Begin",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
    candidateVariableKeys: ["author", "created_at"],
  });

  const endRegion = createCollectorRegion({
    captureItemId: "s1",
    type: "END",
    groupTag: "post-main",
    label: "post-main End",
    box: { x: 20, y: 500, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
    candidateVariableKeys: ["like_count"],
  });

  const elements = [
    {
      id: "h1",
      tagName: "A",
      role: "link",
      rect: { x: 200, y: 100, width: 200, height: 35 },
      textSnippet: "Nguyễn Văn C · 15 phút",
      attributes: { href: "/profile.php?id=1000" },
      childrenIds: [],
    },
    {
      id: "f1",
      tagName: "DIV",
      role: "toolbar",
      rect: { x: 200, y: 480, width: 500, height: 40 },
      textSnippet: "Thích Bình luận Chia sẻ",
      attributes: { role: "toolbar" },
      childrenIds: [],
    },
  ];

  const beginCands = findAnchorCandidates(beginRegion, elements as any);
  assert.ok(beginCands.length > 0, "Should generate candidate for social header");
  assert.ok(beginCands[0].score >= 40, `Header score should meet threshold: ${beginCands[0].score}`);

  const endCands = findAnchorCandidates(endRegion, elements as any);
  assert.ok(endCands.length > 0, "Should generate candidate for social action bar");
  assert.ok(endCands[0].score >= 40, `Footer score should meet threshold: ${endCands[0].score}`);
});

// ---------------------------------------------------------------------------
// C2.11.4 Free-Form Sample Confirmation Tests
// ---------------------------------------------------------------------------

test("C2.11.4: Confirm Audit succeeds regardless of missing anchors or incomplete anchor groups", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;

  // Sample 1 has ZERO regions/anchors defined
  const confirmedDraft1 = confirmCaptureAudit(draft, cap1);
  const audit1 = auditForCapture(confirmedDraft1, cap1);
  assert.equal(audit1.status, "confirmed", "Confirm Audit must succeed with 0 anchors");

  // Sample 2 has only a BEGIN anchor (no END anchor)
  const beginOnly = createCollectorRegion({
    id: "b_only",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Incomplete Begin",
    box: { x: 10, y: 10, width: 200, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
    confirmed: false,
  });
  const withRegion = addRegionToDraft(confirmedDraft1, beginOnly);
  const confirmedDraft2 = confirmCaptureAudit(withRegion, cap2);
  const audit2 = auditForCapture(confirmedDraft2, cap2);
  assert.equal(audit2.status, "confirmed", "Confirm Audit must succeed with incomplete anchor group");

  // Confirmed region becomes confirmed
  const reg = confirmedDraft2.regions?.find((r) => r.id === "b_only");
  assert.equal(reg?.confirmed, true, "Region on confirmed sample is confirmed");
});

test("C2.11.4: Confirm Audit succeeds with unmapped required variables without fabricating info", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1] = capIds;

  draft.variables = [
    { id: "v_req", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
    { id: "v_opt", key: "url", label: "Post URL", valueType: "string", required: false, mappings: [] },
  ];

  // User mapped nothing for cap1
  const confirmedDraft = confirmCaptureAudit(draft, cap1);
  const audit = auditForCapture(confirmedDraft, cap1);
  assert.equal(audit.status, "confirmed", "Confirm Audit must succeed with unmapped required variables");

  // Verify: Must NOT fabricate missing information or mark as not_present
  const vReq = confirmedDraft.variables.find((v) => v.id === "v_req");
  const mapping = vReq?.mappings.find((m) => m.sampleId === cap1);
  assert.equal(mapping, undefined, "Must not fabricate missing mapping");

  // Advance works cleanly
  const advResult = applyAuditActionAndAdvance(draft, cap1, "confirm");
  assert.equal(advResult.advanced, true);
  assert.equal(auditForCapture(advResult.draft, cap1).status, "confirmed");
});

test("C2.11.4: Preserves user-provided mappings and evidence without fabrication", () => {
  const { draft, capIds } = makeTestDraftWithCaptures(1);
  const [cap1] = capIds;

  draft.variables = [
    {
      id: "v1",
      key: "author",
      label: "Author",
      valueType: "string",
      required: true,
      mappings: [
        {
          sampleId: cap1,
          regionId: "reg1",
          presence: "mapped",
          method: "OCR_TEXT",
          text: "Real Author",
          segmentId: "seg1",
          confirmed: false,
        },
      ],
    },
    {
      id: "v2",
      key: "likes",
      label: "Likes",
      valueType: "number",
      required: false,
      mappings: [], // unmapped
    },
  ];

  const confirmed = confirmCaptureAudit(draft, cap1);
  const v1 = confirmed.variables.find((v) => v.id === "v1");
  const m1 = v1?.mappings.find((m) => m.sampleId === cap1);
  assert.equal(m1?.confirmed, true, "Existing mapping is confirmed");
  assert.equal(m1?.text, "Real Author", "Existing text evidence preserved");
  assert.equal(m1?.method, "OCR_TEXT", "Existing method preserved");

  const v2 = confirmed.variables.find((v) => v.id === "v2");
  const m2 = v2?.mappings.find((m) => m.sampleId === cap1);
  assert.equal(m2, undefined, "Unmapped variable remains untouched without fake not_present");
});

// ---------------------------------------------------------------------------
// C2.11.5 BEGIN/END Pairing & Candidate Filtering Tests
// ---------------------------------------------------------------------------

test("C2.11.5: Rejects fixed chrome elements and top header bar (y < 45) for END anchors", () => {
  const endRegion = createCollectorRegion({
    captureItemId: "s1",
    type: "END",
    groupTag: "post-main",
    label: "post-main End",
    box: { x: 20, y: 500, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });

  const elements = [
    {
      id: "sticky_nav_group",
      tagName: "SPAN",
      role: "group",
      rect: { x: 10, y: 2, width: 200, height: 35 },
      textSnippet: "",
      attributes: { role: "group" },
      isFixed: true,
      childrenIds: [],
    },
    {
      id: "top_bar_at_y2",
      tagName: "SPAN",
      role: "group",
      rect: { x: 10, y: 2, width: 200, height: 35 },
      textSnippet: "",
      attributes: { role: "group" },
      isFixed: false,
      childrenIds: [],
    },
    {
      id: "real_post_action_bar",
      tagName: "DIV",
      role: "toolbar",
      rect: { x: 10, y: 450, width: 500, height: 40 },
      textSnippet: "Thích · Bình luận · Chia sẻ",
      attributes: { role: "toolbar" },
      isFixed: false,
      childrenIds: [],
    },
  ];

  const cands = findAnchorCandidates(endRegion, elements as any);
  assert.equal(cands.length, 1, "Only the real action bar should qualify as END candidate");
  assert.equal(cands[0].el.id, "real_post_action_bar");
  assert.equal(cands[0].el.rect.y, 450);
});

test("C2.11.5: Rejects sticky navigation links (e.g. 'Bài viết', 'Giới thiệu') from BEGIN author candidates", () => {
  const beginRegion = createCollectorRegion({
    captureItemId: "s1",
    type: "BEGIN",
    groupTag: "post-main",
    label: "post-main Begin",
    box: { x: 20, y: 20, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });

  const elements = [
    {
      id: "nav_tab_discussion",
      tagName: "A",
      role: "tab",
      rect: { x: 20, y: 58, width: 80, height: 40 },
      textSnippet: "Bài viết",
      attributes: { href: "/groups/123/" },
      isFixed: true,
      childrenIds: [],
    },
    {
      id: "nav_tab_about",
      tagName: "A",
      role: "tab",
      rect: { x: 110, y: 58, width: 80, height: 40 },
      textSnippet: "Giới thiệu",
      attributes: { href: "/groups/123/about" },
      isFixed: false, // even if not flagged fixed, rejected by navTextRegex
      childrenIds: [],
    },
    {
      id: "real_post_author",
      tagName: "A",
      role: "link",
      rect: { x: 30, y: 150, width: 160, height: 25 },
      textSnippet: "Trần Minh Quân",
      attributes: { href: "/user/1000123" },
      isFixed: false,
      childrenIds: [],
    },
  ];

  const cands = findAnchorCandidates(beginRegion, elements as any);
  assert.equal(cands.length, 1, "Only genuine author link should qualify as BEGIN candidate");
  assert.equal(cands[0].el.id, "real_post_author");
  assert.equal(cands[0].el.rect.y, 150);
});

test("C2.11.5: Successful BEGIN/END pairing resolves post container and generates rich candidate diagnostics", () => {
  let draft = createEmptyDraft({ name: "C2.11.5 Test" });
  draft = addCaptureItem(draft, {
    imageAsset: "00000001-0000-0000-0000-000000000000.png",
    captureUrl: "https://facebook.com/groups/123",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0].id;

  const bReg = createCollectorRegion({
    captureItemId: capId,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Author Header",
    box: { x: 20, y: 20, width: 300, height: 50 },
    imageWidth: 800,
    imageHeight: 600,
  });

  const eReg = createCollectorRegion({
    captureItemId: capId,
    type: "END",
    groupTag: "post-main",
    label: "Action Footer",
    box: { x: 20, y: 400, width: 500, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });

  draft = addRegionToDraft(draft, bReg);
  draft = addRegionToDraft(draft, eReg);

  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/123",
    capturedAt: new Date().toISOString(),
    viewport: { width: 610, height: 600, scrollX: 0, scrollY: 300, dpr: 1 },
    elements: [
      {
        id: "post_container_1",
        tagName: "DIV",
        role: "article",
        rect: { x: 10, y: 100, width: 590, height: 450 },
        textSnippet: "Post content",
        attributes: { role: "article" },
        depth: 1,
        isArticleOrCard: true,
        childrenIds: ["b_node", "e_node"],
      },
      {
        id: "b_node",
        tagName: "A",
        role: "link",
        rect: { x: 20, y: 120, width: 180, height: 25 },
        textSnippet: "Phan Văn Đức",
        attributes: { href: "/user/999" },
        depth: 2,
        parentId: "post_container_1",
        childrenIds: [],
      },
      {
        id: "e_node",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 20, y: 500, width: 450, height: 35 },
        textSnippet: "Thích · Bình luận",
        attributes: { role: "toolbar" },
        depth: 2,
        parentId: "post_container_1",
        childrenIds: [],
      },
    ],
  };

  const res = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft);
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 1);

  const grp = res.groups[0];
  assert.equal(grp.status, "MATCHED");
  assert.equal(grp.domAssociationStatus, "CONFIRMED");
  assert.ok(grp.candidateDiagnostics);
  assert.equal(grp.candidateDiagnostics.topBeginCandidates.length, 1);
  assert.equal(grp.candidateDiagnostics.topBeginCandidates[0].id, "b_node");
  assert.equal(grp.candidateDiagnostics.topBeginCandidates[0].isViewportRelative, true);
  assert.equal(grp.candidateDiagnostics.topEndCandidates.length, 1);
  assert.equal(grp.candidateDiagnostics.topEndCandidates[0].id, "e_node");
  assert.equal(grp.candidateDiagnostics.topEndCandidates[0].isViewportRelative, true);
  assert.equal(grp.candidateDiagnostics.selectedPair?.beginId, "b_node");
  assert.equal(grp.candidateDiagnostics.selectedPair?.endId, "e_node");
  assert.equal(grp.candidateDiagnostics.selectedPair?.containerId, "post_container_1");
});

// ---------------------------------------------------------------------------
// CHECKPOINT D: C2.11.8 BEGIN-Only Matching with Multi-Sample Learning
// ---------------------------------------------------------------------------

test("C2.11.8 TEST A: Multi-Sample Aggregation into ONE learned rule with trainingSampleCount: 3", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(3);
  const [cap1, cap2, cap3] = capIds;
  let draft = baseDraft;

  // Add confirmed BEGIN regions across 3 distinct samples for groupTag "post-main"
  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 1",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName", "postTimestamp"],
  });
  reg1.ocr = makeRegionOcr([
    { id: "s1", text: "Nguyễn Văn Hùng", bbox: { x: 70, y: 35, width: 140, height: 20 }, confidence: 95 },
    { id: "s2", text: "2 giờ trước", bbox: { x: 70, y: 60, width: 70, height: 16 }, confidence: 93 },
  ], box1);

  const box2 = { x: 20, y: 35, width: 420, height: 65 };
  const reg2 = createCollectorRegion({
    id: "r2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 2",
    box: box2,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName", "postTimestamp"],
  });
  reg2.ocr = makeRegionOcr([
    { id: "s3", text: "Trần Thị Mai", bbox: { x: 75, y: 40, width: 130, height: 20 }, confidence: 96 },
    { id: "s4", text: "Vừa xong", bbox: { x: 75, y: 65, width: 60, height: 16 }, confidence: 94 },
  ], box2);

  const box3 = { x: 18, y: 28, width: 410, height: 58 };
  const reg3 = createCollectorRegion({
    id: "r3",
    captureItemId: cap3,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 3",
    box: box3,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName", "postTimestamp"],
  });
  reg3.ocr = makeRegionOcr([
    { id: "s5", text: "Lê Hoàng Long", bbox: { x: 72, y: 32, width: 135, height: 20 }, confidence: 97 },
    { id: "s6", text: "Hôm qua lúc 10:00", bbox: { x: 72, y: 56, width: 95, height: 16 }, confidence: 92 },
  ], box3);

  draft = addRegionToDraft(draft, reg1);
  draft = addRegionToDraft(draft, reg2);
  draft = addRegionToDraft(draft, reg3);

  const rulesMap = buildLearnedAnchorRules(draft);
  assert.equal(rulesMap.size, 1);
  assert.ok(rulesMap.has("post-main"));

  const group = rulesMap.get("post-main")!;
  assert.ok(group.beginRule);

  const beginRule = group.beginRule;
  // Multi-sample aggregation: ONE unified rule
  assert.equal(beginRule.groupTag, "post-main");
  assert.equal(beginRule.type, "BEGIN");
  assert.equal(beginRule.trainingSampleCount, 3);
  assert.equal(beginRule.exampleCount, 3);

  // Features learned with weights & support count
  assert.ok(beginRule.features && beginRule.features.length >= 4);
  const featureNames = beginRule.features.map((f) => f.feature);
  assert.ok(featureNames.includes("header_layout"));
  assert.ok(featureNames.includes("author_link_structure"));
  assert.ok(featureNames.includes("timestamp_indicator"));

  // Dynamic characteristics strictly separated from stable tokens
  const varTokens = beginRule.variableTokens;
  assert.ok(varTokens.includes("nguyễn") || varTokens.includes("hùng"));
  assert.ok(varTokens.includes("trần") || varTokens.includes("mai"));
  assert.ok(varTokens.includes("lê") || varTokens.includes("long"));

  // Author names must NEVER be in stableTokens
  const stableTokens = beginRule.stableTokens;
  assert.ok(!stableTokens.includes("nguyễn"));
  assert.ok(!stableTokens.includes("trần"));
  assert.ok(!stableTokens.includes("lê"));

  // Evidence strength is high and uncertainty is low
  assert.ok((beginRule.evidenceStrength ?? 0) >= 90);
  assert.ok((beginRule.uncertainty ?? 100) <= 10);
});

test("C2.11.8 TEST B: Dynamic Robustness: Matches new author and timestamp without literal text match", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(2);
  const [cap1, cap2] = capIds;
  let draft = baseDraft;

  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 1",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName"],
  });
  reg1.ocr = makeRegionOcr([{ id: "s1", text: "Nguyễn Văn A", bbox: { x: 70, y: 35, width: 140, height: 20 }, confidence: 95 }], box1);

  const box2 = { x: 20, y: 35, width: 420, height: 65 };
  const reg2 = createCollectorRegion({
    id: "r2",
    captureItemId: cap2,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header 2",
    box: box2,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName"],
  });
  reg2.ocr = makeRegionOcr([{ id: "s2", text: "Trần Thị B", bbox: { x: 75, y: 40, width: 130, height: 20 }, confidence: 96 }], box2);

  draft = addRegionToDraft(draft, reg1);
  draft = addRegionToDraft(draft, reg2);

  const rulesMap = buildLearnedAnchorRules(draft);
  const beginRule = rulesMap.get("post-main")!.beginRule!;

  // Live DOM with completely DIFFERENT author "Phạm Quốc Bảo" and timestamp "5 phút trước"
  const elements: CollectorDomElement[] = [
    {
      id: "hdr_container",
      tagName: "DIV",
      rect: { x: 20, y: 120, width: 500, height: 55 },
      textSnippet: "Phạm Quốc Bảo\n5 phút trước",
      depth: 2,
      attributes: {},
      childrenIds: ["link_author", "link_time"],
    },
    {
      id: "link_author",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 125, width: 150, height: 20 },
      textSnippet: "Phạm Quốc Bảo",
      attributes: { href: "/groups/512/user/1000" },
      parentId: "hdr_container",
      depth: 3,
      childrenIds: [],
    },
    {
      id: "link_time",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 150, width: 70, height: 16 },
      textSnippet: "5 phút trước",
      attributes: { href: "/permalink/123" },
      parentId: "hdr_container",
      depth: 3,
      childrenIds: [],
    },
  ];

  const evalResult = evaluateLiveBeginCandidates(beginRule, elements);
  assert.ok(evalResult.deduplicatedCandidates.length >= 1);
  const topCandidate = evalResult.deduplicatedCandidates[0]!;
  assert.ok(topCandidate.score >= 70, `Expected score >= 70 but got ${topCandidate.score}`);
  assert.ok(topCandidate.featuresMatched.includes("author_link_structure"));
  assert.ok(topCandidate.featuresMatched.includes("timestamp_indicator"));
});

test("C2.11.8 TEST D: Header deduplication coalesces avatar, author, time, container into ONE candidate", () => {
  const elements: CollectorDomElement[] = [
    // Post 1 Header Cluster
    {
      id: "hdr_1",
      tagName: "DIV",
      rect: { x: 20, y: 100, width: 520, height: 60 },
      textSnippet: "Nguyễn Văn Hùng\n2 giờ trước",
      depth: 2,
      attributes: {},
      childrenIds: ["avt_1", "author_1", "time_1"],
    },
    {
      id: "avt_1",
      tagName: "IMG",
      role: "img",
      rect: { x: 25, y: 105, width: 40, height: 40 },
      textSnippet: "",
      depth: 3,
      attributes: {},
      parentId: "hdr_1",
      childrenIds: [],
    },
    {
      id: "author_1",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 108, width: 130, height: 20 },
      textSnippet: "Nguyễn Văn Hùng",
      attributes: { href: "/user/1" },
      depth: 3,
      parentId: "hdr_1",
      childrenIds: [],
    },
    {
      id: "time_1",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 130, width: 65, height: 16 },
      textSnippet: "2 giờ trước",
      attributes: { href: "/post/1" },
      depth: 3,
      parentId: "hdr_1",
      childrenIds: [],
    },

    // Post 2 Header Cluster
    {
      id: "hdr_2",
      tagName: "DIV",
      rect: { x: 20, y: 350, width: 520, height: 60 },
      textSnippet: "Trần Mai Anh\n15 phút trước",
      depth: 2,
      attributes: {},
      childrenIds: ["avt_2", "author_2", "time_2"],
    },
    {
      id: "avt_2",
      tagName: "IMG",
      role: "img",
      rect: { x: 25, y: 355, width: 40, height: 40 },
      textSnippet: "",
      depth: 3,
      attributes: {},
      parentId: "hdr_2",
      childrenIds: [],
    },
    {
      id: "author_2",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 358, width: 120, height: 20 },
      textSnippet: "Trần Mai Anh",
      attributes: { href: "/user/2" },
      depth: 3,
      parentId: "hdr_2",
      childrenIds: [],
    },
    {
      id: "time_2",
      tagName: "A",
      role: "link",
      rect: { x: 75, y: 380, width: 75, height: 16 },
      textSnippet: "15 phút trước",
      attributes: { href: "/post/2" },
      depth: 3,
      parentId: "hdr_2",
      childrenIds: [],
    },
  ];

  const evalResult = evaluateLiveBeginCandidates(undefined, elements);
  // Before deduplication: 8 atomic candidate elements
  assert.ok(evalResult.allCandidatesBeforeDeduplication.length >= 6);

  // After deduplication: exactly 2 logical BEGIN candidates (1 per post header)
  assert.equal(evalResult.deduplicatedCandidates.length, 2);

  const post1 = evalResult.deduplicatedCandidates[0]!;
  const post2 = evalResult.deduplicatedCandidates[1]!;

  assert.equal(post1.el.id, "hdr_1");
  assert.equal(post2.el.id, "hdr_2");
  assert.ok(post1.score >= 85);
  assert.ok(post2.score >= 85);
});

test("C2.11.8 TEST E: False Positive Protection: Navigation tabs, sticky bar, composer, and comments rejected", () => {
  const elements: CollectorDomElement[] = [
    // 1. Sticky header
    {
      id: "sticky_nav",
      tagName: "DIV",
      isFixed: true,
      rect: { x: 0, y: 0, width: 1200, height: 56 },
      textSnippet: "Facebook Navigation",
      depth: 1,
      attributes: {},
      childrenIds: [],
    },
    // 2. Global top nav (y < 45)
    {
      id: "top_icon",
      tagName: "A",
      role: "link",
      rect: { x: 10, y: 10, width: 40, height: 30 },
      textSnippet: "Facebook",
      depth: 2,
      attributes: {},
      childrenIds: [],
    },
    // 3. Group navigation tab ("Bài viết", "Giới thiệu")
    {
      id: "tab_posts",
      tagName: "SPAN",
      role: "tab",
      rect: { x: 20, y: 65, width: 80, height: 40 },
      textSnippet: "Bài viết",
      depth: 3,
      attributes: {},
      childrenIds: [],
    },
    {
      id: "tab_about",
      tagName: "A",
      rect: { x: 110, y: 65, width: 80, height: 40 },
      textSnippet: "Giới thiệu",
      depth: 3,
      attributes: {},
      childrenIds: [],
    },
    // 4. Post composer box
    {
      id: "composer_box",
      tagName: "DIV",
      rect: { x: 20, y: 120, width: 500, height: 60 },
      textSnippet: "Bạn đang nghĩ gì?",
      depth: 2,
      attributes: {},
      childrenIds: [],
    },
    // 5. Comment author header
    {
      id: "comment_author",
      tagName: "A",
      role: "link",
      className: "comment-author-link",
      rect: { x: 80, y: 400, width: 120, height: 18 },
      textSnippet: "Bình luận của Nguyễn Văn C",
      depth: 5,
      attributes: {},
      childrenIds: [],
    },
  ];

  const evalResult = evaluateLiveBeginCandidates(undefined, elements);
  assert.equal(evalResult.deduplicatedCandidates.length, 0);
  assert.ok(evalResult.rejectedElements.length >= 5);

  const reasons = evalResult.rejectedElements.map((r) => r.reason);
  assert.ok(reasons.some((r) => r.includes("Fixed/sticky")));
  assert.ok(reasons.some((r) => r.includes("Top viewport")));
  assert.ok(reasons.some((r) => r.includes("navigation tab")));
  assert.ok(reasons.some((r) => r.includes("composer box")));
  assert.ok(reasons.some((r) => r.includes("Comment")));
});

test("C2.11.8 TEST F: Step 3 BEGIN-only isolation passes without END defined", () => {
  const { draft: baseDraft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0];
  let draft = baseDraft;

  // Add ONLY a BEGIN anchor (no END anchor at all)
  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName", "postTimestamp"],
  });
  reg1.ocr = makeRegionOcr([
    { id: "s1", text: "Trịnh Thăng Bình", bbox: { x: 70, y: 35, width: 140, height: 20 }, confidence: 95 },
    { id: "s2", text: "1 giờ trước", bbox: { x: 70, y: 60, width: 70, height: 16 }, confidence: 93 },
  ], box1);

  draft = addRegionToDraft(draft, reg1);

  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/test",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "hdr_div",
        tagName: "DIV",
        rect: { x: 20, y: 150, width: 500, height: 60 },
        textSnippet: "Trịnh Thăng Bình\n1 giờ trước",
        depth: 2,
        attributes: {},
        childrenIds: ["author_node", "time_node"],
      },
      {
        id: "author_node",
        tagName: "A",
        role: "link",
        rect: { x: 75, y: 155, width: 140, height: 20 },
        textSnippet: "Trịnh Thăng Bình",
        attributes: { href: "/user/99" },
        depth: 3,
        parentId: "hdr_div",
        childrenIds: [],
      },
      {
        id: "time_node",
        tagName: "A",
        role: "link",
        rect: { x: 75, y: 180, width: 70, height: 16 },
        textSnippet: "1 giờ trước",
        attributes: { href: "/post/99" },
        depth: 3,
        parentId: "hdr_div",
        childrenIds: [],
      },
    ],
  };

  const res = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft, { mode: "BEGIN_ONLY" });
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 1);
  assert.equal(res.groups.length, 1);

  const grp = res.groups[0]!;
  assert.equal(grp.status, "MATCHED");
  assert.equal(grp.domAssociationStatus, "CONFIRMED");
  assert.ok(grp.beginMatch?.matched);
  assert.equal(grp.beginMatch.matchedElementId, "hdr_div");
  assert.equal(grp.candidateDiagnostics?.mode, "BEGIN_ONLY");
  assert.equal(grp.candidateDiagnostics?.topEndCandidates.length, 0);
});

test("C2.11.9: Outer post container resolution walks up ancestors and stops at post boundary", () => {
  let { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0]!;

  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
    candidateVariableKeys: ["authorName", "postTimestamp"],
  });
  reg1.ocr = makeRegionOcr([
    { id: "s1", text: "Trần Anh Vũ", bbox: { x: 70, y: 35, width: 140, height: 20 }, confidence: 95 },
    { id: "s2", text: "3 giờ trước", bbox: { x: 70, y: 60, width: 70, height: 16 }, confidence: 93 },
  ], box1);

  draft = addRegionToDraft(draft, reg1);

  // Snapshot structure:
  // feed_root (role="feed")
  //   post_card_1 (role="article", y: 100, height: 350)
  //     inner_wrapper (y: 100, height: 350)
  //       hdr_div (BEGIN match: y: 100, height: 50)
  //       body_div (y: 155, height: 200)
  //       toolbar_div (role="toolbar", y: 360, height: 40, text: "Thích Bình luận Chia sẻ")
  //   post_card_2 (role="article", y: 480, height: 300)
  //     hdr_div_2 (y: 480, height: 50, text: "Lê Minh\n5 giờ trước")
  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/test",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 1000, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "feed_root",
        tagName: "DIV",
        role: "feed",
        isFeedContainer: true,
        rect: { x: 0, y: 0, width: 800, height: 1200 },
        textSnippet: "",
        depth: 0,
        attributes: {},
        childrenIds: ["post_card_1", "post_card_2"],
      },
      {
        id: "post_card_1",
        tagName: "DIV",
        role: "article",
        isArticleOrCard: true,
        rect: { x: 50, y: 100, width: 600, height: 350 },
        textSnippet: "Trần Anh Vũ\n3 giờ trước\nBài viết mẫu số 1\nThích Bình luận Chia sẻ",
        depth: 1,
        parentId: "feed_root",
        attributes: {},
        childrenIds: ["inner_wrapper"],
      },
      {
        id: "inner_wrapper",
        tagName: "DIV",
        rect: { x: 50, y: 100, width: 600, height: 350 },
        textSnippet: "",
        depth: 2,
        parentId: "post_card_1",
        attributes: {},
        childrenIds: ["hdr_div", "body_div", "toolbar_div"],
      },
      {
        id: "hdr_div",
        tagName: "DIV",
        rect: { x: 60, y: 100, width: 400, height: 50 },
        textSnippet: "Trần Anh Vũ\n3 giờ trước",
        depth: 3,
        parentId: "inner_wrapper",
        attributes: {},
        childrenIds: ["author_node"],
      },
      {
        id: "author_node",
        tagName: "SPAN",
        rect: { x: 70, y: 105, width: 120, height: 20 },
        textSnippet: "Trần Anh Vũ",
        depth: 4,
        parentId: "hdr_div",
        attributes: {},
        childrenIds: [],
      },
      {
        id: "body_div",
        tagName: "DIV",
        rect: { x: 60, y: 155, width: 580, height: 200 },
        textSnippet: "Bài viết mẫu số 1",
        depth: 3,
        parentId: "inner_wrapper",
        attributes: {},
        childrenIds: [],
      },
      {
        id: "toolbar_div",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 60, y: 360, width: 580, height: 40 },
        textSnippet: "Thích Bình luận Chia sẻ",
        depth: 3,
        parentId: "inner_wrapper",
        attributes: {},
        childrenIds: [],
      },
      {
        id: "post_card_2",
        tagName: "DIV",
        role: "article",
        isArticleOrCard: true,
        rect: { x: 50, y: 480, width: 600, height: 300 },
        textSnippet: "Lê Minh\n5 giờ trước",
        depth: 1,
        parentId: "feed_root",
        attributes: {},
        childrenIds: ["hdr_div_2"],
      },
      {
        id: "hdr_div_2",
        tagName: "DIV",
        rect: { x: 60, y: 480, width: 400, height: 50 },
        textSnippet: "Lê Minh\n5 giờ trước",
        depth: 2,
        parentId: "post_card_2",
        attributes: {},
        childrenIds: [],
      },
    ],
  };

  const res = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft, { mode: "BEGIN_ONLY" });
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 2);
  assert.equal(res.matchedItems?.length, 2);

  const matchedItem1 = res.matchedItems![0]!;
  assert.equal(matchedItem1.domResolved, true);
  // Post 1 must resolve to post_card_1 (not hdr_div, not inner_wrapper, and not feed_root)
  assert.equal(matchedItem1.containerId, "post_card_1");
  assert.equal(matchedItem1.containerRect?.height, 350);
  assert.equal(matchedItem1.containerRect?.y, 100);

  const matchedItem2 = res.matchedItems![1]!;
  assert.equal(matchedItem2.domResolved, true);
  // Post 2 must resolve to post_card_2 (not feed_root)
  assert.equal(matchedItem2.containerId, "post_card_2");
  assert.equal(matchedItem2.containerRect?.height, 300);
  assert.equal(matchedItem2.containerRect?.y, 480);

  // Verify candidate diagnostics contain outer container resolution and deduplication
  const grp = res.groups[0]!;
  assert.ok(grp.candidateDiagnostics);
  assert.equal(grp.candidateDiagnostics.finalUniquePostCount, 2);
  assert.ok((grp.candidateDiagnostics.outerContainerDiagnostics?.length ?? 0) > 0);
  const outerDiag = grp.candidateDiagnostics.outerContainerDiagnostics![0]!;
  assert.equal(outerDiag.selectedOuterContainer?.id, "post_card_1");
  assert.equal(outerDiag.selectedOuterContainer?.rect.height, 350);
  assert.ok(outerDiag.ancestorCandidates.length >= 2);
});

test("C2.11.9: Deduplicates multiple nested BEGIN matches in same outer container", () => {
  let { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0]!;

  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
  });
  reg1.ocr = makeRegionOcr([
    { id: "s1", text: "Nguyễn Hải", bbox: { x: 70, y: 35, width: 120, height: 20 }, confidence: 95 },
    { id: "s2", text: "2 giờ trước", bbox: { x: 70, y: 55, width: 80, height: 16 }, confidence: 92 },
  ], box1);

  draft = addRegionToDraft(draft, reg1);

  // Two elements in the same post both match BEGIN:
  // inner header div and its parent wrapper
  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/test",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "post_root",
        tagName: "DIV",
        role: "article",
        rect: { x: 40, y: 80, width: 600, height: 400 },
        textSnippet: "Nguyễn Hải\n2 giờ trước\nNội dung chính\nThích Bình luận",
        depth: 1,
        attributes: {},
        childrenIds: ["inner_row", "toolbar"],
      },
      {
        id: "inner_row",
        tagName: "DIV",
        rect: { x: 50, y: 90, width: 300, height: 40 },
        textSnippet: "Nguyễn Hải\n2 giờ trước",
        depth: 2,
        parentId: "post_root",
        attributes: {},
        childrenIds: ["inner_span"],
      },
      {
        id: "inner_span",
        tagName: "SPAN",
        rect: { x: 50, y: 90, width: 280, height: 35 },
        textSnippet: "Nguyễn Hải\n2 giờ trước",
        depth: 3,
        parentId: "inner_row",
        attributes: {},
        childrenIds: [],
      },
      {
        id: "toolbar",
        tagName: "DIV",
        role: "toolbar",
        rect: { x: 50, y: 440, width: 500, height: 35 },
        textSnippet: "Thích Bình luận",
        depth: 2,
        parentId: "post_root",
        attributes: {},
        childrenIds: [],
      },
    ],
  };

  const res = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft, { mode: "BEGIN_ONLY" });
  assert.equal(res.status, "MATCHED");
  // Should deduplicate multiple hits resolving to post_root into 1 unique post item
  assert.equal(res.matchedPostCount, 1);
  assert.equal(res.matchedItems?.length, 1);
  assert.equal(res.matchedItems![0]!.containerId, "post_root");
  assert.equal(res.matchedItems![0]!.containerRect?.height, 400);

  const grp = res.groups[0]!;
  assert.equal(grp.candidateDiagnostics?.finalUniquePostCount, 1);
});

test("C2.11.9: Outer post container resolution succeeds without role='article' using engagement and feed structure", () => {
  let { draft, capIds } = makeTestDraftWithCaptures(1);
  const cap1 = capIds[0]!;

  const box1 = { x: 20, y: 30, width: 400, height: 60 };
  const reg1 = createCollectorRegion({
    id: "r1",
    captureItemId: cap1,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header",
    box: box1,
    imageWidth: 800,
    imageHeight: 600,
    confirmed: true,
  });
  reg1.ocr = makeRegionOcr([
    { id: "s1", text: "Trang Thông Tin", bbox: { x: 70, y: 35, width: 150, height: 20 }, confidence: 95 },
    { id: "s2", text: "10 phút trước", bbox: { x: 70, y: 55, width: 80, height: 16 }, confidence: 92 },
  ], box1);

  draft = addRegionToDraft(draft, reg1);

  // No role="article" on any element, but feed_parent is role="feed"
  // and outer_card is direct child of feed with engagement actions
  const snapshot: CollectorDomSnapshot = {
    url: "https://facebook.com/groups/test",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "feed_parent",
        tagName: "DIV",
        role: "feed",
        rect: { x: 0, y: 0, width: 900, height: 1500 },
        textSnippet: "",
        depth: 0,
        attributes: {},
        childrenIds: ["outer_card"],
      },
      {
        id: "outer_card",
        tagName: "DIV",
        // NO role="article"
        rect: { x: 50, y: 120, width: 620, height: 380 },
        textSnippet: "Trang Thông Tin\n10 phút trước\nBản tin sáng\nThích Bình luận Chia sẻ",
        depth: 1,
        parentId: "feed_parent",
        attributes: {},
        childrenIds: ["card_header", "card_body"],
      },
      {
        id: "card_header",
        tagName: "DIV",
        rect: { x: 60, y: 120, width: 400, height: 50 },
        textSnippet: "Trang Thông Tin\n10 phút trước",
        depth: 2,
        parentId: "outer_card",
        attributes: {},
        childrenIds: [],
      },
      {
        id: "card_body",
        tagName: "DIV",
        rect: { x: 60, y: 175, width: 600, height: 320 },
        textSnippet: "Bản tin sáng\nThích Bình luận Chia sẻ",
        depth: 2,
        parentId: "outer_card",
        attributes: {},
        childrenIds: [],
      },
    ],
  };

  const res = executeLiveBrowserMatchTest(draft.regions!, snapshot, draft, { mode: "BEGIN_ONLY" });
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matchedPostCount, 1);
  const item = res.matchedItems![0]!;
  assert.equal(item.containerId, "outer_card");
  assert.equal(item.containerRect?.height, 380);
});
