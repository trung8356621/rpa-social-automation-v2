import test from "node:test";
import assert from "node:assert/strict";
import type { OcrResult, OcrSegment } from "../src/shared/contracts.js";
import type { CollectorDraft, CollectorVariable } from "../src/shared/collectors/types.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  applyAuditActionAndAdvance,
  auditForCapture,
  saveAsVersion,
  stepValidationErrors,
} from "../src/shared/collectors/ops.js";
import {
  assignOcrSegmentToVariable,
  extractTeachingContext,
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
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600 } });
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
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600 } });
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
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 50, y: 100, width: 832, height: 1600 } });
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567892.png", roi: { x: 50, y: 100, width: 832, height: 1700 } });
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
  assert.ok(cap2AuthorMapping.confidence >= 50, "Confidence should reflect match score");
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
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567891.png", roi: { x: 0, y: 0, width: 832, height: 3200 } }); // long PNG
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567892.png", roi: { x: 0, y: 0, width: 832, height: 2800 } });
  draft = addCaptureItem(draft, { imageAsset: "a1b2c3d4-e5f6-7890-abcd-ef1234567893.png", roi: { x: 0, y: 0, width: 832, height: 3000 } });

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
  assert.equal(v0.captures.length, 3);
  assert.equal(v0.captures[0]!.ocr?.segments.length, 5);
  assert.equal(v0.variables[0]!.mappings.length, 3);
  assert.equal(v0.variables[0]!.mappings[2]?.text, "950 lượt thích");
});
