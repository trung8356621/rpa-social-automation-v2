import test from "node:test";
import assert from "node:assert/strict";
import type { OcrResult, OcrSegment } from "../src/shared/contracts.js";
import type { CollectorDraft, CollectorVariable } from "../src/shared/collectors/types.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  applyAuditActionAndAdvance,
  auditForCapture,
  parseTypedValue,
  saveAsVersion,
  stepValidationErrors,
} from "../src/shared/collectors/ops.js";
import {
  assignOcrSegmentToVariable,
  extractTeachingContext,
  getSegmentsByLevel,
  groupOcrSegments,
  isAuthorCandidate,
  isEngagementText,
  isTimestampText,
  matchLearnedVariable,
  normalizeVietnameseText,
  proposeLearnedMappings,
  unmapVariableForCapture,
} from "../src/shared/collectors/ocr-learning.js";
import { validateCollectorDraft } from "../src/renderer/collectors/CollectorEditor.js";

// Helper OCR fixture representing a long scrolling Facebook post
function makeFacebookPostOcr(opts: {
  authorName?: string;
  postTime?: string;
  postBody?: string;
  reactionCount?: string;
  commentCount?: string;
  height?: number;
}): OcrResult {
  const author = opts.authorName ?? "Người tham gia ẩn danh";
  const time = opts.postTime ?? "6 tháng 11 lúc 23:03";
  const body = opts.postBody ?? "Dạ em đang học CNTT và muốn hỏi về lộ trình fullstack...";
  const reactions = opts.reactionCount ?? "40 lượt thích";
  const comments = opts.commentCount ?? "29 bình luận";
  const h = opts.height ?? 1600;

  const segments: OcrSegment[] = [
    { id: "seg_author", text: author, kind: "line", confidence: 96, bbox: { x: 80, y: 40, width: 280, height: 28 } },
    { id: "seg_time", text: time, kind: "line", confidence: 93, bbox: { x: 80, y: 78, width: 210, height: 22 } },
    { id: "seg_body", text: body, kind: "line", confidence: 95, bbox: { x: 80, y: 150, width: 620, height: 240 } },
    { id: "seg_reactions", text: reactions, kind: "line", confidence: 91, bbox: { x: 80, y: h - 140, width: 140, height: 26 } },
    { id: "seg_comments", text: comments, kind: "line", confidence: 89, bbox: { x: 260, y: h - 140, width: 150, height: 26 } },
  ];

  return {
    text: segments.map((s) => s.text).join("\n"),
    confidence: 93,
    language: "vie+eng",
    segments,
  };
}

test("Task A — Collector Save & Close validation", () => {
  const baseDraft = createEmptyDraft({ name: "FB Group Collector", description: "Post scraper" });

  // 1. Rejects empty name
  const emptyNameDraft: CollectorDraft = { ...baseDraft, name: "   " };
  const nameErrors = validateCollectorDraft(emptyNameDraft);
  assert.ok(nameErrors.includes("Collector Name is required."));

  // 2. Rejects duplicate variable keys
  const dupVarDraft: CollectorDraft = {
    ...baseDraft,
    variables: [
      { id: "v1", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
      { id: "v2", key: "author", label: "Author Dup", valueType: "string", required: false, mappings: [] },
    ],
  };
  const dupErrors = validateCollectorDraft(dupVarDraft);
  assert.ok(dupErrors.includes("Variable keys must be unique."));

  // 3. Rejects empty variable key
  const emptyKeyDraft: CollectorDraft = {
    ...baseDraft,
    variables: [
      { id: "v1", key: "  ", label: "No Key", valueType: "string", required: true, mappings: [] },
    ],
  };
  const keyErrors = validateCollectorDraft(emptyKeyDraft);
  assert.ok(keyErrors.includes("Every Variable needs a stable key."));

  // 4. Passes for valid draft
  const validDraft: CollectorDraft = {
    ...baseDraft,
    variables: [
      { id: "v1", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
      { id: "v2", key: "content", label: "Content", valueType: "string", required: true, mappings: [] },
    ],
  };
  assert.deepEqual(validateCollectorDraft(validDraft), []);

  // 5. Saving as version produces valid version snapshot preserving all fields
  const saved = saveAsVersion(validDraft);
  assert.equal(saved.dirty, false);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.versions[0]?.label, "v1");
  assert.equal(saved.versions[0]?.variables.length, 2);
});

test("Task B — Vietnamese Unicode text normalization and anchor context extraction", () => {
  // Unicode diacritics normalized correctly
  const raw1 = "Người tham gia ẩn danh";
  const raw2 = "NGƯỜI  THAM GIA   ẨN DANH";
  assert.equal(normalizeVietnameseText(raw1), normalizeVietnameseText(raw2));

  // Context extraction preserves normalized coordinates and immediate line neighbors
  const ocr = makeFacebookPostOcr({});
  const authorSeg = ocr.segments.find((s) => s.id === "seg_author")!;
  const timeSeg = ocr.segments.find((s) => s.id === "seg_time")!;

  const context = extractTeachingContext(timeSeg, ocr.segments, 832, 1600);
  assert.ok(context.normalizedBbox.relX > 0 && context.normalizedBbox.relX < 1);
  assert.ok(context.normalizedBbox.relY > 0 && context.normalizedBbox.relY < 1);
  // Preceding line anchor captures the author line above it
  assert.equal(context.nearbyAnchors.prevLineText, authorSeg.text);
});

test("Task B — Learning Contract: Image #1 (Manual Teaching) does NOT guess variables", () => {
  let draft = createEmptyDraft({ name: "FB Collector" });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/1", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600, containerWidth: 1000, containerHeight: 1800 } });
  const cap1 = draft.captures[0]!;
  draft = {
    ...draft,
    captures: [{ ...cap1, ocr: makeFacebookPostOcr({}) }],
    variables: [
      { id: "v_author", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
      { id: "v_content", key: "post_content", label: "Content", valueType: "string", required: true, mappings: [] },
    ],
  };

  // Run proposeLearnedMappings on Image #1 — MUST NOT automatically guess variables
  const proposed = proposeLearnedMappings(draft, cap1.id, 832, 1600);
  assert.equal(proposed.variables[0]?.mappings.length, 0, "Image #1 must have NO automatic proposals");
  assert.equal(proposed.variables[1]?.mappings.length, 0, "Image #1 must have NO automatic proposals");
});

test("Task B — Learning Contract: Image #1 Manual Assignment & Audit Confirmation", () => {
  let draft = createEmptyDraft({ name: "FB Collector" });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/1", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600, containerWidth: 1000, containerHeight: 1800 } });
  const cap1 = draft.captures[0]!;
  const ocr1 = makeFacebookPostOcr({ authorName: "Nguyễn Văn A" });
  draft = {
    ...draft,
    captures: [{ ...cap1, ocr: ocr1 }],
    variables: [
      { id: "v_author", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
      { id: "v_time", key: "post_time", label: "Time", valueType: "string", required: true, mappings: [] },
    ],
  };

  // User manually assigns author and time segments
  const authorSeg = ocr1.segments.find((s) => s.id === "seg_author")!;
  const timeSeg = ocr1.segments.find((s) => s.id === "seg_time")!;

  draft = assignOcrSegmentToVariable(draft, cap1.id, "v_author", authorSeg, 832, 1600);
  draft = assignOcrSegmentToVariable(draft, cap1.id, "v_time", timeSeg, 832, 1600);

  const mAuthor = draft.variables[0]!.mappings[0]!;
  assert.equal(mAuthor.text, "Nguyễn Văn A");
  assert.equal(mAuthor.presence, "mapped");
  assert.ok(mAuthor.normalizedBbox, "Normalized bbox must be preserved for teaching");
  assert.equal(mAuthor.evidence, "Manual teaching assignment (Reference)");

  // Confirm audit on Image #1 establishes it as teaching reference
  draft = { ...draft, teachingCaptureId: cap1.id };
  const auditRes = applyAuditActionAndAdvance(draft, cap1.id, "confirm");
  draft = auditRes.draft;

  assert.equal(auditForCapture(draft, cap1.id).status, "confirmed");
  assert.equal(draft.teachingCaptureId, cap1.id);
  assert.equal(draft.variables[0]!.mappings[0]!.confirmed, true);
});

test("Task B — Learning Contract: Image #2 (Apply Learned Rules from Image #1)", () => {
  // Setup confirmed Image #1
  let draft = createEmptyDraft({ name: "FB Collector" });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/1", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600, containerWidth: 1000, containerHeight: 1800 } });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/2", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567892.png", roi: { x: 50, y: 100, width: 832, height: 1700, containerWidth: 1000, containerHeight: 1900 } });
  const cap1 = draft.captures[0]!;
  const cap2 = draft.captures[1]!;

  const ocr1 = makeFacebookPostOcr({ authorName: "Trần Thị B", postTime: "10 phút trước" });
  const ocr2 = makeFacebookPostOcr({ authorName: "Lê Văn C", postTime: "2 giờ trước" });

  draft = {
    ...draft,
    teachingCaptureId: cap1.id,
    captures: [
      { ...cap1, ocr: ocr1 },
      { ...cap2, ocr: ocr2 },
    ],
    variables: [
      { id: "v_author", key: "author", label: "Author", valueType: "string", required: true, mappings: [] },
      { id: "v_time", key: "post_time", label: "Post Time", valueType: "string", required: true, mappings: [] },
    ],
  };

  // Image #1 is confirmed by user
  draft = assignOcrSegmentToVariable(draft, cap1.id, "v_author", ocr1.segments[0]!, 832, 1600);
  draft = assignOcrSegmentToVariable(draft, cap1.id, "v_time", ocr1.segments[1]!, 832, 1600);
  draft = applyAuditActionAndAdvance(draft, cap1.id, "confirm").draft;

  // Now on Image #2: propose learned mappings
  const proposedDraft = proposeLearnedMappings(draft, cap2.id, 832, 1700);

  // Author variable should have proposed mapping from Image #2
  const authorVar = proposedDraft.variables.find((v) => v.id === "v_author")!;
  const cap2AuthorMapping = authorVar.mappings.find((m) => m.sampleId === cap2.id);
  assert.ok(cap2AuthorMapping, "Image #2 should have a proposed mapping for author");
  assert.equal(cap2AuthorMapping.text, "Lê Văn C");
  assert.equal(cap2AuthorMapping.simulatedProposal, true);
  assert.equal(cap2AuthorMapping.confirmed, false);
  assert.ok((cap2AuthorMapping.confidence ?? 0) >= 50, "Confidence should reflect match score");
  assert.ok(cap2AuthorMapping.evidence?.includes("Match score"), "Evidence must provide explanation");

  // Post Time variable should have proposed mapping from Image #2
  const timeVar = proposedDraft.variables.find((v) => v.id === "v_time")!;
  const cap2TimeMapping = timeVar.mappings.find((m) => m.sampleId === cap2.id);
  assert.ok(cap2TimeMapping, "Image #2 should have a proposed mapping for time");
  assert.equal(cap2TimeMapping.text, "2 giờ trước");

  // Audit status for Image #2 becomes proposed
  assert.equal(auditForCapture(proposedDraft, cap2.id).status, "proposed");

  // User accepts / confirms Image #2 mappings
  const confirmedDraft = applyAuditActionAndAdvance(proposedDraft, cap2.id, "confirm").draft;
  assert.equal(auditForCapture(confirmedDraft, cap2.id).status, "confirmed");
  assert.equal(confirmedDraft.variables[0]!.mappings.find((m) => m.sampleId === cap2.id)?.confirmed, true);
});

test("Task B — Image #3 and later multi-reference learning & long scrolling PNG persistence", () => {
  let draft = createEmptyDraft({ name: "FB Multi-Item" });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/1", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 0, y: 0, width: 832, height: 3200, containerWidth: 1000, containerHeight: 3400 } }); // long PNG
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/2", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567892.png", roi: { x: 0, y: 0, width: 832, height: 2800, containerWidth: 1000, containerHeight: 3000 } });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/3", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567893.png", roi: { x: 0, y: 0, width: 832, height: 3000, containerWidth: 1000, containerHeight: 3200 } });

  const c1 = draft.captures[0]!;
  const c2 = draft.captures[1]!;
  const c3 = draft.captures[2]!;

  const ocr1 = makeFacebookPostOcr({ authorName: "User 1", reactionCount: "120 lượt thích", height: 3200 });
  const ocr2 = makeFacebookPostOcr({ authorName: "User 2", reactionCount: "350 lượt thích", height: 2800 });
  const ocr3 = makeFacebookPostOcr({ authorName: "User 3", reactionCount: "950 lượt thích", height: 3000 });

  draft = {
    ...draft,
    teachingCaptureId: c1.id,
    captures: [
      { ...c1, ocr: ocr1 },
      { ...c2, ocr: ocr2 },
      { ...c3, ocr: ocr3 },
    ],
    variables: [
      { id: "v_react", key: "reaction_count", label: "Reactions", valueType: "string", required: true, mappings: [] },
    ],
  };

  // C1 confirmed
  const reactSeg1 = ocr1.segments.find((s) => s.id === "seg_reactions")!;
  draft = assignOcrSegmentToVariable(draft, c1.id, "v_react", reactSeg1, 832, 3200);
  draft = applyAuditActionAndAdvance(draft, c1.id, "confirm").draft;

  // C2 proposed & confirmed
  draft = proposeLearnedMappings(draft, c2.id, 832, 2800);
  assert.equal(draft.variables[0]!.mappings.find((m) => m.sampleId === c2.id)?.text, "350 lượt thích");
  draft = applyAuditActionAndAdvance(draft, c2.id, "confirm").draft;

  // C3 proposed using both C1 and C2 as references
  draft = proposeLearnedMappings(draft, c3.id, 832, 3000);
  const m3 = draft.variables[0]!.mappings.find((m) => m.sampleId === c3.id);
  assert.ok(m3);
  assert.equal(m3.text, "950 lượt thích");
  assert.ok(m3.evidence?.includes("pattern match"));

  // Save to version & verify persistence
  const saved = saveAsVersion(draft);
  const v0 = saved.versions[0]!;
  assert.equal(v0.captures?.length, 3);
  assert.equal(v0.captures?.[0]?.ocr?.segments.length, 5);
  assert.equal(v0.variables[0]!.mappings.length, 3);
  assert.equal(v0.variables[0]!.mappings[2]?.text, "950 lượt thích");
});

test("C2.7.1 Task 1 — OCR Grouping: multiline paragraph grouping and boundary isolation", () => {
  // Multiline Facebook post with author, timestamp, 3-line body paragraph, and engagement row
  const ocr: OcrResult = {
    text: "Nguyễn Văn An\n5 giờ trước\nDòng 1: Chào mọi người em đang bắt đầu học lập trình.\nDòng 2: Em muốn hỏi nên học React trước hay Node trước ạ?\nDòng 3: Cảm ơn các anh chị nhiều lắm ạ!\n120 lượt thích\n45 bình luận",
    confidence: 94,
    language: "vie+eng",
    segments: [
      { id: "s1", text: "Nguyễn Văn An", kind: "line", confidence: 96, bbox: { x: 40, y: 30, width: 200, height: 24 } },
      { id: "s2", text: "5 giờ trước", kind: "line", confidence: 92, bbox: { x: 40, y: 60, width: 120, height: 18 } },
      // Multiline paragraph body (close vertical spacing ~28px gap, line height ~22px)
      { id: "s3", text: "Dòng 1: Chào mọi người em đang bắt đầu học lập trình.", kind: "line", confidence: 95, bbox: { x: 40, y: 110, width: 500, height: 22 } },
      { id: "s4", text: "Dòng 2: Em muốn hỏi nên học React trước hay Node trước ạ?", kind: "line", confidence: 95, bbox: { x: 40, y: 138, width: 520, height: 22 } },
      { id: "s5", text: "Dòng 3: Cảm ơn các anh chị nhiều lắm ạ!", kind: "line", confidence: 93, bbox: { x: 40, y: 166, width: 420, height: 22 } },
      // Engagement row (large vertical gap > 50px)
      { id: "s6", text: "120 lượt thích", kind: "line", confidence: 90, bbox: { x: 40, y: 250, width: 130, height: 20 } },
      { id: "s7", text: "45 bình luận", kind: "line", confidence: 88, bbox: { x: 200, y: 250, width: 120, height: 20 } },
    ],
  };

  const grouped = groupOcrSegments(ocr, 800, 1000);

  // 1. Author line must be its own block (NOT merged into body or timestamp)
  const authorBlock = grouped.blocks.find((b) => b.text.includes("Nguyễn Văn An"));
  assert.ok(authorBlock);
  assert.equal(authorBlock.text, "Nguyễn Văn An");
  assert.equal(authorBlock.kind, "block");

  // 2. Timestamp must be its own block (NOT merged into author or body)
  const timeBlock = grouped.blocks.find((b) => b.text.includes("5 giờ trước"));
  assert.ok(timeBlock);
  assert.equal(timeBlock.text, "5 giờ trước");

  // 3. Multiline body must be merged into ONE complete paragraph block
  const bodyBlock = grouped.blocks.find((b) => b.text.includes("Dòng 1:"));
  assert.ok(bodyBlock);
  assert.ok(bodyBlock.text.includes("Dòng 2:"));
  assert.ok(bodyBlock.text.includes("Dòng 3:"));
  assert.equal(bodyBlock.text.split("\n").length, 3);
  assert.equal(bodyBlock.bbox.y, 110);
  assert.equal(bodyBlock.bbox.height, 166 + 22 - 110); // Spans from line 1 top to line 3 bottom

  // 4. Reactions & Comments must NOT merge into the body block
  const reactionBlock = grouped.blocks.find((b) => b.text.includes("120 lượt thích"));
  assert.ok(reactionBlock);
  assert.ok(!reactionBlock.text.includes("Dòng 3:"));
  assert.ok(!bodyBlock.text.includes("120 lượt thích"));
});

test("C2.7.1 Task 1 — Instant Word / Line / Block level switching without re-running OCR", () => {
  const ocr: OcrResult = {
    text: "Học ReactJS cùng cộng đồng",
    confidence: 95,
    language: "vie+eng",
    segments: [
      { id: "w1", text: "Học", kind: "word", confidence: 95, bbox: { x: 20, y: 30, width: 40, height: 20 } },
      { id: "w2", text: "ReactJS", kind: "word", confidence: 96, bbox: { x: 65, y: 30, width: 70, height: 20 } },
      { id: "w3", text: "cùng", kind: "word", confidence: 94, bbox: { x: 140, y: 30, width: 45, height: 20 } },
      { id: "w4", text: "cộng", kind: "word", confidence: 93, bbox: { x: 190, y: 30, width: 45, height: 20 } },
      { id: "w5", text: "đồng", kind: "word", confidence: 93, bbox: { x: 240, y: 30, width: 45, height: 20 } },
    ],
  };

  const words = getSegmentsByLevel(ocr, "word", 800, 600);
  assert.equal(words.length, 5);
  assert.equal(words[0]!.kind, "word");
  assert.equal(words[1]!.text, "ReactJS");

  const lines = getSegmentsByLevel(ocr, "line", 800, 600);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.kind, "line");
  assert.equal(lines[0]!.text, "Học ReactJS cùng cộng đồng");

  const blocks = getSegmentsByLevel(ocr, "block", 800, 600);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, "block");
  assert.equal(blocks[0]!.text, "Học ReactJS cùng cộng đồng");
});

test("C2.7.1 Task 3 — Teaching Behavior: Image #2 matches multiline paragraph blocks", () => {
  let draft = createEmptyDraft({ name: "FB Paragraph Collector" });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/1", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 0, y: 0, width: 800, height: 1200, containerWidth: 1000, containerHeight: 1400 } });
  draft = addCaptureItem(draft, { captureUrl: "https://facebook.com/group/test/2", imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567892.png", roi: { x: 0, y: 0, width: 800, height: 1200, containerWidth: 1000, containerHeight: 1400 } });

  const c1 = draft.captures[0]!;
  const c2 = draft.captures[1]!;

  const ocr1: OcrResult = {
    text: "Tác giả 1\n10:00\nNội dung bài viết 1 dòng đầu.\nNội dung bài viết 1 dòng hai.",
    confidence: 94,
    language: "vie+eng",
    segments: [
      { id: "s1", text: "Tác giả 1", kind: "line", confidence: 95, bbox: { x: 50, y: 30, width: 150, height: 25 } },
      { id: "s2", text: "10:00", kind: "line", confidence: 90, bbox: { x: 50, y: 60, width: 80, height: 20 } },
      { id: "s3", text: "Nội dung bài viết 1 dòng đầu.", kind: "line", confidence: 95, bbox: { x: 50, y: 110, width: 450, height: 25 } },
      { id: "s4", text: "Nội dung bài viết 1 dòng hai.", kind: "line", confidence: 95, bbox: { x: 50, y: 140, width: 450, height: 25 } },
    ],
  };

  const ocr2: OcrResult = {
    text: "Tác giả 2\n11:30\nNội dung bài viết mới đoạn 1.\nNội dung bài viết mới đoạn 2.",
    confidence: 93,
    language: "vie+eng",
    segments: [
      { id: "s1b", text: "Tác giả 2", kind: "line", confidence: 95, bbox: { x: 50, y: 32, width: 160, height: 25 } },
      { id: "s2b", text: "11:30", kind: "line", confidence: 90, bbox: { x: 50, y: 62, width: 80, height: 20 } },
      { id: "s3b", text: "Nội dung bài viết mới đoạn 1.", kind: "line", confidence: 94, bbox: { x: 50, y: 115, width: 460, height: 25 } },
      { id: "s4b", text: "Nội dung bài viết mới đoạn 2.", kind: "line", confidence: 94, bbox: { x: 50, y: 145, width: 460, height: 25 } },
    ],
  };

  draft = {
    ...draft,
    teachingCaptureId: c1.id,
    captures: [
      { ...c1, ocr: ocr1 },
      { ...c2, ocr: ocr2 },
    ],
    variables: [
      { id: "v_body", key: "post_body", label: "Post Body", valueType: "text", required: true, mappings: [] },
    ],
  };

  // Image #1: Assign the grouped multiline block to post_body
  const c1Blocks = getSegmentsByLevel(ocr1, "block", 800, 1200);
  const c1BodyBlock = c1Blocks.find((b) => b.text.includes("Nội dung bài viết 1"))!;
  assert.ok(c1BodyBlock.text.includes("dòng hai"));

  draft = assignOcrSegmentToVariable(draft, c1.id, "v_body", c1BodyBlock, 800, 1200);
  draft = applyAuditActionAndAdvance(draft, c1.id, "confirm").draft;

  // Image #2: Propose learned mappings
  const proposed = proposeLearnedMappings(draft, c2.id, 800, 1200);
  const m2 = proposed.variables[0]!.mappings.find((m) => m.sampleId === c2.id);
  assert.ok(m2);
  assert.ok(m2.text?.includes("Nội dung bài viết mới đoạn 1."));
  assert.ok(m2.text?.includes("Nội dung bài viết mới đoạn 2."));
  assert.ok(m2.evidence?.includes("Match score"));
});

test("C2.7.1 Task 5 — Step 4 Output Schema parseTypedValue conversions", () => {
  // 1. Number parsing from strings with text/metrics
  assert.equal(parseTypedValue("number", "40 lượt thích"), 40);
  assert.equal(parseTypedValue("number", "1,500 bình luận"), 1500);
  assert.equal(parseTypedValue("number", "-12.5"), -12.5);
  assert.equal(parseTypedValue("number", "không có số"), null);
  assert.equal(parseTypedValue("number", undefined), null);

  // 2. Boolean parsing
  assert.equal(parseTypedValue("boolean", "true"), true);
  assert.equal(parseTypedValue("boolean", "Đã duyệt"), true);
  assert.equal(parseTypedValue("boolean", "false"), false);
  assert.equal(parseTypedValue("boolean", "0"), false);
  assert.equal(parseTypedValue("boolean", ""), false);

  // 3. Array parsing (comma/newline split)
  assert.deepEqual(parseTypedValue("array", "tag1, tag2, tag3"), ["tag1", "tag2", "tag3"]);
  assert.deepEqual(parseTypedValue("array", "dòng 1\ndòng 2"), ["dòng 1", "dòng 2"]);

  // 4. String/text passthrough
  assert.equal(parseTypedValue("string", "  Việt Nam vô địch  "), "Việt Nam vô địch");
  assert.equal(parseTypedValue("text", "Multiline\ntext"), "Multiline\ntext");
});
