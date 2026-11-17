import type { OcrResult, OcrSegment, Rect } from "../contracts.js";
import type { EngagementFieldName, EngagementOcrField } from "./types.js";

const FIELDS: EngagementFieldName[] = ["like_count", "comment_count", "share_count"];
const LABELS: Record<EngagementFieldName, RegExp> = {
  like_count: /^(?:likes?|thích|lượt thích|reactions?|cảm xúc)$/iu,
  comment_count: /^(?:comments?|bình luận|lượt bình luận)$/iu,
  share_count: /^(?:shares?|chia sẻ|lượt chia sẻ)$/iu,
};

const centerY = (box: Rect) => box.y + box.height / 2;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const compactCount = (text: string): number | null => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*([kmb])?\s*$/iu.exec(text);
  if (!match) return null;
  const base = Number(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
  const factor = match[3]?.toLowerCase() === "k" ? 1_000 : match[3]?.toLowerCase() === "m" ? 1_000_000 : match[3]?.toLowerCase() === "b" ? 1_000_000_000 : 1;
  return Number.isFinite(base) ? Math.round(base * factor) : null;
};

export function classifyEngagementOcr(input: { ocr: OcrResult; actionRects: Rect[]; cropHeight: number }): { fields: Record<EngagementFieldName, EngagementOcrField>; diagnostics: string[] } {
  const used = new Set<string>();
  const diagnostics: string[] = [];
  const normalized = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
  const numbers = input.ocr.segments.flatMap(segment => {
    const value = compactCount(segment.text);
    if (value === null || segment.confidence < 45 || segment.bbox.width < 3 || segment.bbox.height < 5) return [];
    if (input.actionRects.some(rect => overlap(segment.bbox, rect) > 0)) {
      diagnostics.push(`Rejected numeric-like segment ${segment.id}: overlaps an action/icon region.`);
      return [];
    }
    return [{ segment, value }];
  });
  const labels = input.ocr.segments.flatMap(segment => FIELDS.flatMap(field => LABELS[field].test(normalized(segment.text)) ? [{ field, segment }] : []));
  const empty = (field: EngagementFieldName): EngagementOcrField => ({ field, value: null, status: "needs_attention", sourceMethod: "visual_ocr", rawText: "", confidence: null, segmentIds: [], failureReason: "UNRESOLVED_ROLE" });
  const fields = Object.fromEntries(FIELDS.map(field => [field, empty(field)])) as Record<EngagementFieldName, EngagementOcrField>;

  for (const { field, segment: label } of labels) {
    const candidates = numbers.filter(({ segment }) => !used.has(segment.id) && Math.abs(centerY(segment.bbox) - centerY(label.bbox)) <= Math.max(18, label.bbox.height * 1.4) && (segment.bbox.x + segment.bbox.width <= label.bbox.x + 24 || segment.bbox.x >= label.bbox.x - 24)).sort((a, b) => Math.abs(a.segment.bbox.x - label.bbox.x) - Math.abs(b.segment.bbox.x - label.bbox.x));
    if (candidates.length !== 1 && (candidates.length < 2 || Math.abs(candidates[0].segment.bbox.x - label.bbox.x) + 12 >= Math.abs(candidates[1].segment.bbox.x - label.bbox.x))) continue;
    const chosen = candidates[0];
    used.add(chosen.segment.id);
    fields[field] = { field, value: chosen.value, status: "verified", sourceMethod: "visual_ocr", rawText: `${chosen.segment.text} ${label.text}`.trim(), confidence: Math.min(chosen.segment.confidence, label.confidence), segmentIds: [chosen.segment.id, label.id] };
  }

  // Facebook commonly labels comments/shares but represents reactions visually. Accept the
  // remaining left-side number as Likes only when the other labelled roles establish one row.
  if (fields.like_count.value === null && fields.comment_count.value !== null && fields.share_count.value !== null) {
    const labelledBoxes = [...fields.comment_count.segmentIds, ...fields.share_count.segmentIds].map(id => input.ocr.segments.find(s => s.id === id)).filter((s): s is OcrSegment => Boolean(s));
    const bandY = labelledBoxes.reduce((sum, s) => sum + centerY(s.bbox), 0) / labelledBoxes.length;
    const candidates = numbers.filter(({ segment }) => !used.has(segment.id) && Math.abs(centerY(segment.bbox) - bandY) <= 20 && segment.bbox.x < Math.min(...labelledBoxes.map(s => s.bbox.x)));
    if (candidates.length === 1) {
      const chosen = candidates[0]; used.add(chosen.segment.id);
      fields.like_count = { field: "like_count", value: chosen.value, status: "verified", sourceMethod: "visual_ocr", rawText: chosen.segment.text, confidence: chosen.segment.confidence, segmentIds: [chosen.segment.id] };
    }
  }
  return { fields, diagnostics };
}
