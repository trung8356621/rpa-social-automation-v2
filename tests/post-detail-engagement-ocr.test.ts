import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngagementOcr } from "../src/shared/post-detail-collector/engagement-ocr";
import type { OcrResult, OcrSegment } from "../src/shared/contracts";

const segment = (id: string, text: string, x: number, y = 20, confidence = 90): OcrSegment => ({ id, text, confidence, kind: "word", bbox: { x, y, width: Math.max(8, text.length * 7), height: 14 } });
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

test("numeric-like OCR overlapping an action icon is rejected", () => {
  const result = classify([segment("fake", "1", 420, 70), segment("n2", "6", 180), segment("c", "comments", 205), segment("n3", "3", 330), segment("s", "shares", 355)], [{ x: 410, y: 60, width: 40, height: 40 }]);
  assert.equal(result.fields.like_count.value, null);
  assert.match(result.diagnostics.join(" "), /overlaps an action\/icon region/);
});

test("missing role and unlabelled ambiguous counts are unresolved", () => {
  const result = classify([segment("a", "19", 10), segment("b", "6", 100), segment("c", "3", 190)]);
  assert.deepEqual(Object.values(result.fields).map(field => field.value), [null, null, null]);
});

test("a low-confidence numeric segment is not accepted", () => {
  const result = classify([segment("n", "8", 10, 20, 20), segment("l", "likes", 40)]);
  assert.equal(result.fields.like_count.value, null);
});
