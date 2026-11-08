import type { OcrResult, OcrSegment, Rect } from "../contracts.js";
import type {
  CaptureItem,
  CollectorDraft,
  CollectorVariable,
  CollectorVariableMapping,
} from "./types.js";
import { auditForCapture, captureItemById, markValidationOutdated } from "./ops.js";

/** Normalize text for robust comparison across Unicode/Vietnamese diacritics. */
export function normalizeVietnameseText(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("vi");
}

/**
 * Extract normalized coordinates and surrounding layout/anchor context for a segment.
 * Saved as teaching evidence on Image #1 or any confirmed capture.
 */
export function extractTeachingContext(
  segment: OcrSegment,
  allSegments: OcrSegment[],
  imageWidth: number,
  imageHeight: number,
): {
  normalizedBbox: { relX: number; relY: number; relW: number; relH: number };
  nearbyAnchors: { prevLineText?: string; nextLineText?: string };
} {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  const normalizedBbox = {
    relX: segment.bbox.x / w,
    relY: segment.bbox.y / h,
    relW: segment.bbox.width / w,
    relH: segment.bbox.height / h,
  };

  // Find line segments ordered vertically to find immediate neighbor lines
  const lines = allSegments
    .filter((s) => s.kind === "line" || !s.kind)
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  const idx = lines.findIndex((s) => s.id === segment.id);
  let prevLineText: string | undefined;
  let nextLineText: string | undefined;

  if (idx > 0) {
    const prev = lines[idx - 1]!;
    if (Math.abs(segment.bbox.y - (prev.bbox.y + prev.bbox.height)) < 120) {
      prevLineText = prev.text.trim();
    }
  }
  if (idx >= 0 && idx < lines.length - 1) {
    const next = lines[idx + 1]!;
    if (Math.abs(next.bbox.y - (segment.bbox.y + segment.bbox.height)) < 120) {
      nextLineText = next.text.trim();
    }
  }

  return {
    normalizedBbox,
    nearbyAnchors: { prevLineText, nextLineText },
  };
}

export type MatchCandidate = {
  segment: OcrSegment;
  confidence: number;
  evidence: string;
};

/**
 * Deterministic candidate matcher for a variable based on confirmed reference examples.
 * Uses:
 * 1. Normalized vertical position (relY) and horizontal position (relX)
 * 2. Preceding/succeeding text line anchors
 * 3. Type compatibility / name heuristics (counts, dates, header authors)
 */
export function matchLearnedVariable(
  variable: CollectorVariable,
  targetOcr: OcrResult,
  imageWidth: number,
  imageHeight: number,
  referenceCaptures: CaptureItem[],
): MatchCandidate | null {
  if (!targetOcr.segments.length) return null;

  // Gather confirmed mappings for this variable from reference captures
  const confirmedMappings: Array<{
    mapping: CollectorVariableMapping;
    capture: CaptureItem;
  }> = [];

  for (const cap of referenceCaptures) {
    const m = variable.mappings.find(
      (entry) => entry.sampleId === cap.id && entry.confirmed && entry.presence === "mapped" && entry.text,
    );
    if (m) confirmedMappings.push({ mapping: m, capture: cap });
  }

  // If no confirmed reference example exists for this variable, do NOT guess.
  if (!confirmedMappings.length) return null;

  const ref = confirmedMappings[confirmedMappings.length - 1]!.mapping;
  const refBbox = ref.normalizedBbox ?? (ref.bbox ? {
    relX: ref.bbox.x / Math.max(1, imageWidth),
    relY: ref.bbox.y / Math.max(1, imageHeight),
    relW: ref.bbox.width / Math.max(1, imageWidth),
    relH: ref.bbox.height / Math.max(1, imageHeight),
  } : null);

  if (!refBbox) return null;

  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  const keyLower = variable.key.toLowerCase();
  const isCount = keyLower.includes("count") || keyLower.includes("reaction") || keyLower.includes("comment") || keyLower.includes("share");
  const isDate = keyLower.includes("time") || keyLower.includes("date") || keyLower.includes("timestamp");
  const isAuthor = keyLower.includes("author") || keyLower.includes("user") || keyLower.includes("name");

  let bestCandidate: OcrSegment | null = null;
  let bestScore = -1;
  let bestEvidence = "";

  const lines = targetOcr.segments.filter((s) => s.kind === "line" || !s.kind);
  const pool = isCount ? targetOcr.segments : lines.length ? lines : targetOcr.segments;

  for (let i = 0; i < pool.length; i++) {
    const cand = pool[i]!;
    const candRelX = cand.bbox.x / w;
    const candRelY = cand.bbox.y / h;

    // 1. Position score (0..50 pts)
    const dy = Math.abs(candRelY - refBbox.relY);
    const dx = Math.abs(candRelX - refBbox.relX);
    if (dy > 0.45) continue; // too far vertically to be the same semantic slot

    const posScore = Math.max(0, 50 * (1 - dy * 2.2) * (1 - dx * 0.8));

    // 2. Neighboring anchor score (0..30 pts)
    let anchorScore = 0;
    let anchorNote = "";
    if (ref.nearbyAnchors?.prevLineText) {
      const prevCand = i > 0 ? pool[i - 1] : undefined;
      if (prevCand && normalizeVietnameseText(prevCand.text).includes(normalizeVietnameseText(ref.nearbyAnchors.prevLineText))) {
        anchorScore += 20;
        anchorNote = `preceding line "${ref.nearbyAnchors.prevLineText.slice(0, 16)}"`;
      }
    }
    if (ref.nearbyAnchors?.nextLineText) {
      const nextCand = i < pool.length - 1 ? pool[i + 1] : undefined;
      if (nextCand && normalizeVietnameseText(nextCand.text).includes(normalizeVietnameseText(ref.nearbyAnchors.nextLineText))) {
        anchorScore += 10;
        anchorNote = anchorNote ? `${anchorNote} + next line` : `next line "${ref.nearbyAnchors.nextLineText.slice(0, 16)}"`;
      }
    }

    // 3. Content heuristic score (0..20 pts)
    let contentScore = 0;
    const candText = cand.text.trim();
    if (isCount) {
      if (/^\d+([.,]\d+)?[kKmM]?$/.test(candText) || /^\d+\s*(bình luận|lượt thích|chia sẻ|shares?|comments?|reactions?)$/i.test(candText)) {
        contentScore += 20;
      } else if (/\d/.test(candText)) {
        contentScore += 10;
      }
    } else if (isDate) {
      if (/(\d{1,2}\s+tháng\s+\d{1,2}|lúc\s+\d{1,2}:\d{2}|\d+\s*(giờ|ngày|phút|giây|h|m|d)\s*trước|hôm qua|hôm nay)/i.test(candText)) {
        contentScore += 20;
      } else if (/(\d{1,2}[:/.-]\d{1,2})/.test(candText)) {
        contentScore += 10;
      }
    } else if (isAuthor) {
      if (candRelY < 0.28 && candText.length >= 2 && candText.length <= 60) {
        contentScore += 15;
      }
    }

    const totalScore = posScore + anchorScore + contentScore;

    if (totalScore > bestScore && totalScore >= 38) {
      bestScore = totalScore;
      bestCandidate = cand;
      const confidence = Math.min(99, Math.max(40, Math.round(totalScore)));
      const reasonParts: string[] = [];
      reasonParts.push(`position (Y ~ ${Math.round(candRelY * 100)}%)`);
      if (anchorNote) reasonParts.push(`anchor: ${anchorNote}`);
      if (contentScore > 0) reasonParts.push(`pattern match (${variable.key})`);
      bestEvidence = `Match score ${confidence}% based on ${reasonParts.join(" + ")}`;
    }
  }

  if (!bestCandidate) return null;

  return {
    segment: bestCandidate,
    confidence: Math.min(99, Math.max(40, Math.round(bestScore))),
    evidence: bestEvidence,
  };
}

/**
 * Apply learned rules to an image (Image #2 or later).
 * Skips the teaching reference image (Image #1).
 */
export function proposeLearnedMappings(
  draft: CollectorDraft,
  targetCaptureId: string,
  imageWidth?: number,
  imageHeight?: number,
): CollectorDraft {
  const targetCapture = captureItemById(draft, targetCaptureId);
  if (!targetCapture || !targetCapture.ocr) return draft;

  const isTeaching =
    draft.teachingCaptureId === targetCaptureId ||
    (!draft.teachingCaptureId && draft.captures[0]?.id === targetCaptureId);

  // In Image #1 (teaching reference), NEVER automatically guess variable assignments.
  if (isTeaching) return draft;

  // Gather confirmed reference captures
  const confirmedIds = new Set(
    (draft.captureAudits ?? [])
      .filter((a) => a.status === "confirmed")
      .map((a) => a.captureItemId),
  );
  const referenceCaptures = (draft.captures ?? []).filter((c) => confirmedIds.has(c.id));

  // If no confirmed reference captures exist yet, nothing to learn from.
  if (!referenceCaptures.length) return draft;

  // Derive width/height
  const w = imageWidth || targetCapture.roi?.width || 800;
  const h = imageHeight || targetCapture.roi?.height || 600;

  let anyProposed = false;
  const variables = draft.variables.map((variable) => {
    // Preserve existing user-confirmed or manual mappings
    const existing = variable.mappings.find((m) => m.sampleId === targetCaptureId);
    if (existing && existing.confirmed) return variable;

    const match = matchLearnedVariable(variable, targetCapture.ocr!, w, h, referenceCaptures);
    if (!match) return variable;

    anyProposed = true;
    const others = variable.mappings.filter((m) => m.sampleId !== targetCaptureId);
    const teachingContext = extractTeachingContext(match.segment, targetCapture.ocr!.segments, w, h);

    const mapping: CollectorVariableMapping = {
      sampleId: targetCaptureId,
      presence: "mapped",
      confirmed: false,
      simulatedProposal: true,
      segmentId: match.segment.id,
      text: match.segment.text,
      bbox: match.segment.bbox,
      confidence: match.confidence,
      evidence: match.evidence,
      normalizedBbox: teachingContext.normalizedBbox,
      nearbyAnchors: teachingContext.nearbyAnchors,
    };

    return {
      ...variable,
      mappings: [...others, mapping],
    };
  });

  if (!anyProposed) return draft;

  // Update audit status to "proposed" if currently unreviewed
  const captureAudits = (draft.captureAudits ?? []).map((a) => {
    if (a.captureItemId === targetCaptureId && a.status === "unreviewed") {
      return { ...a, status: "proposed" as const, note: "Suggested values based on confirmed teaching reference." };
    }
    return a;
  });

  return markValidationOutdated({
    ...draft,
    variables,
    captureAudits,
    dirty: true,
  });
}

/**
 * Manually assign an OCR segment to a variable (Manual Teaching or correction).
 */
export function assignOcrSegmentToVariable(
  draft: CollectorDraft,
  captureItemId: string,
  variableId: string,
  segment: OcrSegment,
  imageWidth: number,
  imageHeight: number,
): CollectorDraft {
  const capture = captureItemById(draft, captureItemId);
  if (!capture || !capture.ocr) return draft;

  const isTeaching =
    draft.teachingCaptureId === captureItemId ||
    (!draft.teachingCaptureId && draft.captures[0]?.id === captureItemId);

  const teachingContext = extractTeachingContext(segment, capture.ocr.segments, imageWidth, imageHeight);

  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const others = v.mappings.filter((m) => m.sampleId !== captureItemId);
    const mapping: CollectorVariableMapping = {
      sampleId: captureItemId,
      presence: "mapped",
      confirmed: false,
      simulatedProposal: false,
      segmentId: segment.id,
      text: segment.text,
      bbox: segment.bbox,
      confidence: Math.round(segment.confidence),
      normalizedBbox: teachingContext.normalizedBbox,
      nearbyAnchors: teachingContext.nearbyAnchors,
      evidence: isTeaching ? "Manual teaching assignment (Reference)" : "Manual user correction",
    };

    return {
      ...v,
      source: "ocr_image" as const,
      expectedValue: isTeaching ? segment.text : v.expectedValue,
      mappings: [...others, mapping],
    };
  });

  return markValidationOutdated({
    ...draft,
    variables,
    dirty: true,
  });
}

/**
 * Unmap a variable from a capture item.
 */
export function unmapVariableForCapture(
  draft: CollectorDraft,
  captureItemId: string,
  variableId: string,
): CollectorDraft {
  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const others = v.mappings.filter((m) => m.sampleId !== captureItemId);
    return {
      ...v,
      mappings: [
        ...others,
        {
          sampleId: captureItemId,
          presence: "unmapped" as const,
          confirmed: false,
          simulatedProposal: false,
        },
      ],
    };
  });

  return markValidationOutdated({
    ...draft,
    variables,
    dirty: true,
  });
}
