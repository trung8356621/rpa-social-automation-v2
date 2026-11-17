import type { OcrResult, OcrSegment, Rect } from "../contracts.js";
import type { EngagementFieldName, EngagementOcrField } from "./types.js";

const FIELDS: EngagementFieldName[] = ["like_count", "comment_count", "share_count"];
const LABEL_ONLY: Record<EngagementFieldName, RegExp> = {
  like_count: /^(?:likes?|thích|lượt thích|reactions?|cảm xúc)$/iu,
  comment_count: /^(?:comments?|bình luận|lượt bình luận)$/iu,
  share_count: /^(?:shares?|chia sẻ|lượt chia sẻ)$/iu,
};
const COMBINED: Record<EngagementFieldName, RegExp> = {
  like_count: /^(?:(\d+(?:[.,]\d+)?)\s*(?:k|m|b)?)\s*(?:likes?|thích|lượt thích|reactions?|cảm xúc)$|^(?:likes?|thích|lượt thích|reactions?|cảm xúc)\s*:?\s*(\d+(?:[.,]\d+)?\s*[kmb]?)$/iu,
  comment_count: /^(?:(\d+(?:[.,]\d+)?)\s*(?:k|m|b)?)\s*(?:comments?|bình luận|lượt bình luận)$|^(?:comments?|bình luận|lượt bình luận)\s*:?\s*(\d+(?:[.,]\d+)?\s*[kmb]?)$/iu,
  share_count: /^(?:(\d+(?:[.,]\d+)?)\s*(?:k|m|b)?)\s*(?:shares?|chia sẻ|lượt chia sẻ)$|^(?:shares?|chia sẻ|lượt chia sẻ)\s*:?\s*(\d+(?:[.,]\d+)?\s*[kmb]?)$/iu,
};

const centerX = (box: Rect) => box.x + box.width / 2;
const centerY = (box: Rect) => box.y + box.height / 2;
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const pointInRect = (x: number, y: number, rect: Rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
const compactCount = (text: string): number | null => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*([kmb])?\s*$/iu.exec(text);
  if (!match) return null;
  const base = Number(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
  const factor = match[3]?.toLowerCase() === "k" ? 1_000 : match[3]?.toLowerCase() === "m" ? 1_000_000 : match[3]?.toLowerCase() === "b" ? 1_000_000_000 : 1;
  return Number.isFinite(base) ? Math.round(base * factor) : null;
};
/** OCR sometimes prefixes a Latin glyph to a real digit ("c3", "Q7"); never accept Unicode junk like "ứ5". */
const compactCountLoose = (text: string): number | null => {
  const direct = compactCount(text);
  if (direct !== null) return direct;
  const match = /^\s*[A-Za-z@]{1,2}(\d{1,9}(?:[.,]\d{1,2})?[kmb]?)\s*$/u.exec(text.trim());
  return match ? compactCount(match[1]) : null;
};
const countFromCapture = (raw: string): number | null => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*([kmb])?\s*$/iu.exec(raw.trim());
  if (!match) return null;
  return compactCount(match[0]);
};

/** Compact near-square icons only — never full buttons or tall/wide strips that cover counts. */
const smallIconRects = (rects: Rect[]) => rects.filter(rect => {
  if (rect.width < 2 || rect.height < 2 || rect.width > 28 || rect.height > 28) return false;
  return Math.max(rect.width, rect.height) / Math.min(rect.width, rect.height) <= 1.75;
});

export function classifyEngagementOcr(input: { ocr: OcrResult; actionRects: Rect[]; cropHeight: number }): { fields: Record<EngagementFieldName, EngagementOcrField>; diagnostics: string[] } {
  const used = new Set<string>();
  const diagnostics: string[] = [];
  const normalized = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
  const empty = (field: EngagementFieldName, failureReason = "UNRESOLVED_ROLE"): EngagementOcrField => ({
    field, value: null, status: "needs_attention", sourceMethod: "visual_ocr", rawText: "", confidence: null, segmentIds: [], failureReason,
  });
  const fields = Object.fromEntries(FIELDS.map(field => [field, empty(field)])) as Record<EngagementFieldName, EngagementOcrField>;
  // Left-side Action/summary icons sit beside legitimate counts; only far-right decorative
  // reaction chips (e.g. blue 👍) should suppress OCR digit noise.
  const maxX = Math.max(
    0,
    ...input.actionRects.map(rect => rect.x + rect.width),
    ...input.ocr.segments.map(segment => segment.bbox.x + segment.bbox.width),
  );
  const rightBand = maxX * 0.62;
  const icons = smallIconRects(input.actionRects).filter(rect => rect.x >= rightBand);

  const rejectedByIcon = (bbox: Rect, id: string, text: string) => {
    const hit = icons.find(rect => overlapArea(bbox, rect) / Math.max(1, bbox.width * bbox.height) >= 0.55 || pointInRect(centerX(bbox), centerY(bbox), rect));
    if (!hit) return false;
    diagnostics.push(`Rejected numeric-like segment ${id} ("${text}"): overlaps far-right decorative icon ${Math.round(hit.x)},${Math.round(hit.y)} ${Math.round(hit.width)}×${Math.round(hit.height)}.`);
    return true;
  };

  const sourceSegments = input.ocr.segments.filter(segment => segment.kind === "word").length
    ? input.ocr.segments.filter(segment => segment.kind === "word")
    : input.ocr.segments;

  // 1) Combined tokens: "12 comments", "3 chia sẻ", etc.
  for (const segment of sourceSegments) {
    if (used.has(segment.id) || segment.confidence < 35) continue;
    const text = normalized(segment.text);
    for (const field of FIELDS) {
      if (fields[field].value !== null) continue;
      const match = COMBINED[field].exec(text);
      if (!match) continue;
      const value = countFromCapture(match[1] || match[2] || "");
      if (value === null) continue;
      if (rejectedByIcon(segment.bbox, segment.id, text)) continue;
      used.add(segment.id);
      fields[field] = { field, value, status: "verified", sourceMethod: "visual_ocr", rawText: text, confidence: segment.confidence, segmentIds: [segment.id] };
    }
  }

  const maxDigitHeight = Math.max(28, Math.round(input.cropHeight * 0.55));
  const numbers = sourceSegments.flatMap(segment => {
    if (used.has(segment.id)) return [];
    const value = compactCountLoose(segment.text);
    // Reject tall icon/blob misreads (live Share "1" was read as a full-height "2").
    if (value === null || segment.confidence < 35 || segment.bbox.width < 2 || segment.bbox.height < 4 || segment.bbox.height > maxDigitHeight) return [];
    if (rejectedByIcon(segment.bbox, segment.id, segment.text)) return [];
    return [{ segment, value, pure: compactCount(segment.text) !== null }];
  });
  const labels = sourceSegments.flatMap(segment => {
    if (used.has(segment.id) || segment.confidence < 35) return [];
    return FIELDS.flatMap(field => LABEL_ONLY[field].test(normalized(segment.text)) ? [{ field, segment }] : []);
  });

  // 2) Label ↔ adjacent number pairing
  for (const { field, segment: label } of labels) {
    if (fields[field].value !== null) continue;
    const candidates = numbers
      .filter(({ segment }) => !used.has(segment.id) && Math.abs(centerY(segment.bbox) - centerY(label.bbox)) <= Math.max(22, label.bbox.height * 1.6) && (segment.bbox.x + segment.bbox.width <= label.bbox.x + 28 || segment.bbox.x >= label.bbox.x - 28))
      .sort((a, b) => Math.abs(a.segment.bbox.x - label.bbox.x) - Math.abs(b.segment.bbox.x - label.bbox.x));
    if (!candidates.length) {
      fields[field] = empty(field, "LABEL_WITHOUT_NUMBER");
      continue;
    }
    if (candidates.length > 1 && Math.abs(candidates[0].segment.bbox.x - label.bbox.x) + 12 >= Math.abs(candidates[1].segment.bbox.x - label.bbox.x)) {
      fields[field] = empty(field, "AMBIGUOUS_NUMBER_FOR_LABEL");
      diagnostics.push(`Ambiguous numbers for ${field} near label "${label.text}".`);
      continue;
    }
    const chosen = candidates[0];
    used.add(chosen.segment.id);
    used.add(label.id);
    fields[field] = {
      field, value: chosen.value, status: "verified", sourceMethod: "visual_ocr",
      rawText: `${chosen.segment.text} ${label.text}`.trim(),
      confidence: Math.min(chosen.segment.confidence, label.confidence),
      segmentIds: [chosen.segment.id, label.id],
    };
  }

  // 3) Like without label once comment+share are labelled.
  if (fields.like_count.value === null && fields.comment_count.value !== null && fields.share_count.value !== null) {
    const labelledBoxes = [...fields.comment_count.segmentIds, ...fields.share_count.segmentIds]
      .map(id => input.ocr.segments.find(s => s.id === id))
      .filter((s): s is OcrSegment => Boolean(s));
    if (labelledBoxes.length) {
      const bandY = labelledBoxes.reduce((sum, s) => sum + centerY(s.bbox), 0) / labelledBoxes.length;
      const minLabelX = Math.min(...labelledBoxes.map(s => s.bbox.x));
      const candidates = numbers.filter(({ segment }) => !used.has(segment.id) && Math.abs(centerY(segment.bbox) - bandY) <= 24 && segment.bbox.x < minLabelX);
      if (candidates.length === 1) {
        const chosen = candidates[0];
        used.add(chosen.segment.id);
        fields.like_count = { field: "like_count", value: chosen.value, status: "verified", sourceMethod: "visual_ocr", rawText: chosen.segment.text, confidence: chosen.segment.confidence, segmentIds: [chosen.segment.id] };
      } else if (candidates.length > 1) {
        fields.like_count = empty("like_count", "AMBIGUOUS_LEFT_NUMBER");
        diagnostics.push("Multiple left-side numbers candidates for like_count.");
      } else {
        fields.like_count = empty("like_count", "NO_LEFT_NUMBER_FOR_LIKES");
      }
    }
  }

  // 4) Unlabeled icon+number engagement row (FB Like / Comment / Share order).
  // Values come from OCR evidence only — role order is structural, not hardcoded counts.
  // Partial rows (1/3 or 2/3) are valid when digits map to Action icon columns.
  if (FIELDS.every(field => fields[field].value === null)) {
    const available = numbers.filter(({ segment }) => !used.has(segment.id));
    const pureOrdered = available.filter(entry => entry.pure).sort((a, b) => a.segment.bbox.x - b.segment.bbox.x || a.segment.bbox.y - b.segment.bbox.y);
    const ordered = (pureOrdered.length >= 3 ? pureOrdered : available)
      .sort((a, b) => a.segment.bbox.x - b.segment.bbox.x || a.segment.bbox.y - b.segment.bbox.y);
    if (ordered.length >= 3) {
      const trio = ordered.slice(0, 3);
      const ys = trio.map(entry => centerY(entry.segment.bbox));
      const xs = trio.map(entry => centerX(entry.segment.bbox));
      const bandOk = Math.max(...ys) - Math.min(...ys) <= Math.max(30, input.cropHeight * 0.55);
      const spaced = xs[1] - xs[0] > 8 && xs[2] - xs[1] > 8;
      if (bandOk && spaced) {
        FIELDS.forEach((field, index) => {
          const chosen = trio[index];
          used.add(chosen.segment.id);
          fields[field] = {
            field, value: chosen.value, status: "verified", sourceMethod: "visual_ocr",
            rawText: chosen.segment.text, confidence: chosen.segment.confidence, segmentIds: [chosen.segment.id],
          };
        });
        diagnostics.push("Assigned unlabeled LTR engagement counts by Action Row structure (like/comment/share).");
        if (ordered.length > 3) diagnostics.push(`Ignored ${ordered.length - 3} extra numeric segment(s) after the primary trio.`);
      } else {
        diagnostics.push("Unlabeled numeric segments present but not a stable horizontal Action Row trio.");
      }
    } else if (ordered.length > 0) {
      // Map 1–2 digits onto Like/Comment/Share columns when Action icons are known.
      // Take the leftmost three small icons (decorative far-right chips come after).
      const roleIcons = smallIconRects(input.actionRects)
        .sort((a, b) => a.x - b.x)
        .slice(0, 3);
      if (roleIcons.length >= 3) {
        const columns = roleIcons.map((icon, index) => {
          const next = roleIcons[index + 1];
          return {
            field: FIELDS[index],
            x0: icon.x,
            x1: next ? next.x : icon.x + icon.width + 42,
          };
        });
        let assigned = 0;
        for (const entry of ordered) {
          if (used.has(entry.segment.id)) continue;
          const cx = centerX(entry.segment.bbox);
          const column = columns.find(col => cx >= col.x0 - 4 && cx <= col.x1 + 4);
          if (!column || fields[column.field].value !== null) continue;
          used.add(entry.segment.id);
          fields[column.field] = {
            field: column.field, value: entry.value, status: "verified", sourceMethod: "visual_ocr",
            rawText: entry.segment.text, confidence: entry.segment.confidence, segmentIds: [entry.segment.id],
          };
          assigned += 1;
        }
        if (assigned > 0) {
          diagnostics.push(`Assigned ${assigned}/3 unlabeled count(s) by Action icon columns (partial row allowed).`);
          for (const field of FIELDS) {
            if (fields[field].value === null) fields[field] = empty(field, "ICON_ONLY_NO_COUNT");
          }
        } else {
          diagnostics.push(`Found ${ordered.length} unlabeled numeric segment(s); none landed in Action icon columns.`);
        }
      } else {
        diagnostics.push(`Found ${ordered.length} unlabeled numeric segment(s); need Action icon columns or 3 evidence counts for LTR assignment.`);
      }
    }
  }

  for (const field of FIELDS) {
    if (fields[field].value !== null) continue;
    if (!fields[field].failureReason || fields[field].failureReason === "UNRESOLVED_ROLE") {
      const hasNumbers = numbers.length > 0 || sourceSegments.some(segment => COMBINED[field].test(normalized(segment.text)));
      fields[field] = empty(field, hasNumbers ? "ROLE_NOT_LINKED" : "NO_NUMERIC_OCR");
    }
  }

  if (!sourceSegments.length) diagnostics.push("OCR returned no segments for Engagement crop.");
  return { fields, diagnostics };
}
