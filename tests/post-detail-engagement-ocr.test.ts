import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngagementOcr } from "../src/shared/post-detail-collector/engagement-ocr";
import type { OcrResult, OcrSegment } from "../src/shared/contracts";

const segment = (id: string, text: string, x: number, y = 20, confidence = 90, width?: number, height = 14): OcrSegment => ({
  id, text, confidence, kind: "word",
  bbox: { x, y, width: width ?? Math.max(8, text.length * 7), height },
});
const classify = (segments: OcrSegment[], actionRects: Array<{ x: number; y: number; width: number; height: number }> = []) => classifyEngagementOcr({ ocr: { text: segments.map(s => s.text).join(" "), confidence: 90, language: "vie+eng", segments } as OcrResult, actionRects, cropHeight: 120 });

test("maps labelled OCR counts and uses one segment per role", () => {
  const result = classify([segment("n1", "19", 10), segment("n2", "6", 180), segment("c", "bình luận", 205), segment("n3", "3", 330), segment("s", "chia sẻ", 355)]);
  assert.equal(result.fields.like_count.value, 19);
  assert.equal(result.fields.comment_count.value, 6);
  assert.equal(result.fields.share_count.value, 3);
  const ids = Object.values(result.fields).flatMap(field => field.segmentIds.filter(id => id.startsWith("n")));
  assert.equal(new Set(ids).size, ids.length);
});

test("icon-only and unrelated numbers remain unresolved", () => {
  const result = classify([segment("comment-text", "2026", 20, 70), segment("word", "nội dung", 65, 70)]);
  assert.deepEqual(Object.values(result.fields).map(field => field.value), [null, null, null]);
});

test("numeric-like OCR overlapping a far-right decorative icon is rejected", () => {
  const result = classify([segment("fake", "1", 520, 70), segment("n2", "6", 180), segment("c", "comments", 205), segment("n3", "3", 330), segment("s", "shares", 355)], [{ x: 516, y: 66, width: 16, height: 16 }]);
  assert.equal(result.fields.like_count.value, null);
  assert.match(result.diagnostics.join(" "), /far-right decorative icon/);
});

test("tall non-square action strips must not reject adjacent counts", () => {
  // Live evidence had 16×42 reject zones covering "19"/"15" digit centers.
  const result = classify([
    segment("n1", "19", 55, 22, 90, 12, 10),
    segment("n2", "7", 130, 22, 90, 8, 10),
    segment("n3", "3", 205, 22, 90, 6, 10),
  ], [
    { x: 51, y: 5, width: 16, height: 42 },
    { x: 8, y: 10, width: 64, height: 32 },
  ]);
  assert.equal(result.fields.like_count.value, 19);
  assert.equal(result.fields.comment_count.value, 7);
  assert.equal(result.fields.share_count.value, 3);
});

test("unlabelled horizontal trio resolves by Action Row order", () => {
  const result = classify([segment("a", "19", 10), segment("b", "6", 100), segment("c", "3", 190)]);
  assert.deepEqual(Object.values(result.fields).map(field => field.value), [19, 6, 3]);
});

test("two unlabelled numbers stay unresolved without Action icon columns", () => {
  const result = classify([segment("a", "19", 10), segment("b", "6", 100)]);
  assert.deepEqual(Object.values(result.fields).map(field => field.value), [null, null, null]);
});

test("partial Share-only digit maps via Action icon columns (1/3)", () => {
  const result = classify(
    [segment("n", "1", 130, 22, 95, 8, 12)],
    [
      { x: 22, y: 18, width: 16, height: 16 },
      { x: 70, y: 18, width: 16, height: 16 },
      { x: 112, y: 18, width: 16, height: 16 },
    ],
  );
  assert.equal(result.fields.like_count.value, null);
  assert.equal(result.fields.comment_count.value, null);
  assert.equal(result.fields.share_count.value, 1);
  assert.equal(result.fields.like_count.failureReason, "ICON_ONLY_NO_COUNT");
  assert.equal(result.fields.comment_count.failureReason, "ICON_ONLY_NO_COUNT");
  assert.match(result.diagnostics.join(" "), /partial row allowed/);
});

test("tall full-height numeric blob is rejected as icon misread", () => {
  const result = classifyEngagementOcr({
    ocr: { text: "2", confidence: 76, language: "vie+eng", segments: [segment("blob", "2", 109, 0, 76, 32, 37)] } as OcrResult,
    actionRects: [],
    cropHeight: 53,
  });
  assert.deepEqual(Object.values(result.fields).map(field => field.value), [null, null, null]);
  assert.equal(result.fields.share_count.failureReason, "NO_NUMERIC_OCR");
});

test("a low-confidence numeric segment is not accepted", () => {
  const result = classify([segment("n", "8", 10, 20, 20), segment("l", "likes", 40)]);
  assert.equal(result.fields.like_count.value, null);
});

test("combined count+label tokens resolve comment and share roles", () => {
  const result = classify([
    segment("n1", "128", 10),
    segment("c", "12 comments", 180),
    segment("s", "3 shares", 330),
  ]);
  assert.equal(result.fields.comment_count.value, 12);
  assert.equal(result.fields.share_count.value, 3);
  assert.equal(result.fields.like_count.value, 128);
});

test("nearby icon does not reject a digit unless overlap is substantial", () => {
  const result = classify(
    [segment("n1", "128", 30), segment("c", "12 comments", 180), segment("s", "3 shares", 330)],
    [{ x: 8, y: 18, width: 16, height: 16 }],
  );
  assert.equal(result.fields.like_count.value, 128);
  assert.equal(result.fields.comment_count.value, 12);
});

test("unresolved roles expose explicit failure reasons", () => {
  const result = classify([segment("word", "hello", 20)]);
  assert.equal(result.fields.like_count.failureReason, "NO_NUMERIC_OCR");
  assert.equal(result.fields.comment_count.failureReason, "NO_NUMERIC_OCR");
  assert.equal(result.fields.share_count.failureReason, "NO_NUMERIC_OCR");
});

test("Latin-prefixed OCR noise still yields the trailing digit for LTR assignment", () => {
  const result = classify([
    segment("n1", "19", 40),
    segment("n2", "7", 120),
    segment("n3", "c3", 200),
  ]);
  assert.equal(result.fields.like_count.value, 19);
  assert.equal(result.fields.comment_count.value, 7);
  assert.equal(result.fields.share_count.value, 3);
});

test("Unicode-prefixed OCR junk is not treated as a count", () => {
  const result = classify([
    segment("junk", "ứ5", 20),
    segment("n1", "19", 55),
    segment("n2", "7", 130),
  ]);
  assert.equal(result.fields.like_count.value, null);
  assert.equal(result.fields.comment_count.value, null);
  assert.equal(result.fields.share_count.value, null);
  assert.match(result.diagnostics.join(" "), /need Action icon columns or 3 evidence counts|need 3 evidence counts/);
});

test("unlabeled horizontal icon+number counts assign like/comment/share by Action Row order", () => {
  const result = classify([
    segment("n1", "19", 40),
    segment("n2", "7", 120),
    segment("n3", "3", 200),
  ], [
    { x: 18, y: 18, width: 16, height: 16 },
    { x: 98, y: 18, width: 16, height: 16 },
    { x: 178, y: 18, width: 16, height: 16 },
    { x: 480, y: 18, width: 18, height: 18 },
  ]);
  assert.equal(result.fields.like_count.value, 19);
  assert.equal(result.fields.comment_count.value, 7);
  assert.equal(result.fields.share_count.value, 3);
  assert.match(result.diagnostics.join(" "), /LTR engagement counts/);
});

test("full action-button rects must not reject valid counts when only small icons are provided", () => {
  // Simulates the live bug: counts sit beside icons; reject zones are small icons only.
  const result = classify([
    segment("n1", "19", 55),
    segment("n2", "7", 130),
    segment("n3", "3", 205),
  ], [
    { x: 30, y: 18, width: 18, height: 18 },
    { x: 105, y: 18, width: 18, height: 18 },
    { x: 180, y: 18, width: 18, height: 18 },
  ]);
  assert.equal(result.fields.like_count.value, 19);
  assert.equal(result.fields.comment_count.value, 7);
  assert.equal(result.fields.share_count.value, 3);
});
