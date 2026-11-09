import type { OcrResult, OcrSegment, Rect } from "../contracts.js";
import type {
  CaptureItem,
  CollectorDraft,
  CollectorVariable,
  CollectorVariableMapping,
} from "./types.js";
import { auditForCapture, captureItemById, markValidationOutdated } from "./ops.js";
import { proposeQuickFillForCapture } from "./regions.js";

/** Normalize text for robust comparison across Unicode/Vietnamese diacritics. */
export function normalizeVietnameseText(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("vi");
}

/** Check if text matches a Facebook post timestamp / date pattern. */
export function isTimestampText(text: string): boolean {
  const norm = normalizeVietnameseText(text);
  if (
    /(\d{1,2}\s+tháng\s+\d{1,2}|lúc\s+\d{1,2}:\d{2}|\d+\s*(giờ|ngày|phút|giây|h|m|d)\s*trước|hôm qua|hôm nay|vừa xong|yesterday|hours?\s+ago|minutes?\s+ago|just\s+now)/i.test(
      norm,
    )
  ) {
    return true;
  }
  if (/^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?(\s+(lúc\s+)?\d{1,2}:\d{2})?$/i.test(norm)) {
    return true;
  }
  return false;
}

/** Check if text matches reactions, comments, shares, or action buttons. */
export function isEngagementText(text: string): boolean {
  const norm = normalizeVietnameseText(text);
  if (
    /^\d+([.,]\d+)?[km]?\s*(bình luận|lượt thích|chia sẻ|shares?|comments?|reactions?|likes?)$/i.test(
      norm,
    )
  ) {
    return true;
  }
  if (/^(thích|bình luận|chia sẻ|gửi|like|comment|share)$/i.test(norm)) {
    return true;
  }
  if (/^\d+([.,]\d+)?[km]?$/i.test(norm) && norm.length <= 6) {
    return true;
  }
  // Counter / fraction patterns e.g. "33 / 52", "24 / 47"
  if (/^\d+\s*[/]\s*\d+$/i.test(norm)) {
    return true;
  }
  // Video playback timestamp e.g. "0:00 / 1:37", "1:37"
  if (/^\d+:\d{2}(\s*[/]\s*\d+:\d{2})?$/i.test(norm)) {
    return true;
  }
  // Comment expansion / controls
  if (
    /^(xem thêm|xem tất cả|xem các|view more|view all|view previous)\s+(bình luận|phản hồi|câu trả lời|comments?|replies)/i.test(
      norm,
    ) ||
    /^(xem thêm bình luận|view more comments)$/i.test(norm) ||
    /^(phù hợp nhất|tất cả bình luận|bình luận mới nhất|most relevant|all comments|newest comments)$/i.test(norm)
  ) {
    return true;
  }
  return false;
}

/** Check if text is a plausible author name. */
export function isAuthorCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (isTimestampText(trimmed) || isEngagementText(trimmed)) return false;
  if (/[.?!]$/.test(trimmed)) return false;
  // Specific author exclusions
  if (/^(xem thêm|view more|viết bình luận|write a comment|phù hợp nhất|tất cả bình luận)/i.test(trimmed)) return false;
  if (/^\d+\s*[/]\s*\d+$/.test(trimmed)) return false;
  if (/^\d+:\d{2}/.test(trimmed)) return false;
  return true;
}

export type OcrGroupingLevel = "block" | "line" | "word";

export type GroupedOcrSegments = {
  words: OcrSegment[];
  lines: OcrSegment[];
  blocks: OcrSegment[];
};

/**
 * Group OCR segments into Word, Line, and Block levels with boundary enforcement:
 * - Word: individual token level.
 * - Line: horizontal lines.
 * - Block: multiline paragraphs grouped using spatial proximity and alignment.
 * Boundary enforcement: NEVER merges author, timestamp, reactions, comments, or separate posts into post body.
 */
export function groupOcrSegments(
  ocrResult: OcrResult,
  _imageWidth?: number,
  _imageHeight?: number,
): GroupedOcrSegments {
  if (!ocrResult.segments || !ocrResult.segments.length) {
    return { words: [], lines: [], blocks: [] };
  }

  // 1. Separate raw words and lines
  const rawWords = ocrResult.segments.filter((s) => s.kind === "word");
  const rawLines = ocrResult.segments.filter((s) => s.kind === "line" || !s.kind);

  let lines: OcrSegment[] = [];
  if (rawLines.length > 0) {
    lines = [...rawLines];
  } else if (rawWords.length > 0) {
    // Group words into lines based on vertical overlap
    const sortedWords = [...rawWords].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const lineBuckets: OcrSegment[][] = [];
    for (const word of sortedWords) {
      let placed = false;
      for (const bucket of lineBuckets) {
        const last = bucket[bucket.length - 1]!;
        const yOverlap =
          Math.min(last.bbox.y + last.bbox.height, word.bbox.y + word.bbox.height) -
          Math.max(last.bbox.y, word.bbox.y);
        if (yOverlap > Math.min(last.bbox.height, word.bbox.height) * 0.5) {
          bucket.push(word);
          placed = true;
          break;
        }
      }
      if (!placed) lineBuckets.push([word]);
    }
    lines = lineBuckets.map((bucket, idx) => {
      bucket.sort((a, b) => a.bbox.x - b.bbox.x);
      const x = Math.min(...bucket.map((w) => w.bbox.x));
      const y = Math.min(...bucket.map((w) => w.bbox.y));
      const x2 = Math.max(...bucket.map((w) => w.bbox.x + w.bbox.width));
      const y2 = Math.max(...bucket.map((w) => w.bbox.y + w.bbox.height));
      const avgConf = bucket.reduce((sum, w) => sum + w.confidence, 0) / bucket.length;
      return {
        id: `line_${idx}`,
        text: bucket.map((w) => w.text).join(" "),
        confidence: Math.round(avgConf),
        bbox: { x, y, width: x2 - x, height: y2 - y },
        kind: "line" as const,
      };
    });
  }

  // Sort lines top-to-bottom: y, then x
  lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  // 2. Identify author lines and timestamps
  const isAuthorAtIdx = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    if (i < lines.length - 1) {
      const next = lines[i + 1]!;
      const gap = next.bbox.y - (cur.bbox.y + cur.bbox.height);
      if (gap < 45 && isTimestampText(next.text) && isAuthorCandidate(cur.text)) {
        isAuthorAtIdx.add(i);
      }
    }
    if (i === 0 && isAuthorCandidate(cur.text) && cur.bbox.y < 120) {
      isAuthorAtIdx.add(0);
    }
  }

  // Calculate median line height
  const heights = lines.map((l) => l.bbox.height).filter((h) => h > 5).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)]! : 22;

  // 3. Group lines into semantic blocks
  const blockBuckets: OcrSegment[][] = [];
  let currentBlock: OcrSegment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isAuthor = isAuthorAtIdx.has(i);
    const isTimestamp = isTimestampText(line.text);
    const isEngagement = isEngagementText(line.text);

    if (currentBlock.length === 0) {
      currentBlock.push(line);
      if (isAuthor || isTimestamp || isEngagement) {
        blockBuckets.push(currentBlock);
        currentBlock = [];
      }
      continue;
    }

    const prevLine = currentBlock[currentBlock.length - 1]!;
    const gap = line.bbox.y - (prevLine.bbox.y + prevLine.bbox.height);

    let shouldBreak = false;
    if (isAuthor || isTimestamp || isEngagement) {
      shouldBreak = true;
    } else if (gap > medianHeight * 1.6 || gap > 40) {
      shouldBreak = true;
    } else if (gap < -8) {
      shouldBreak = true;
    } else if (Math.abs(line.bbox.x - prevLine.bbox.x) > 75) {
      shouldBreak = true;
    }

    if (shouldBreak) {
      blockBuckets.push(currentBlock);
      currentBlock = [line];
      if (isAuthor || isTimestamp || isEngagement) {
        blockBuckets.push(currentBlock);
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blockBuckets.push(currentBlock);
  }

  // Format blocks into OcrSegment objects
  const blocks: OcrSegment[] = blockBuckets.map((bucket, idx) => {
    const x = Math.min(...bucket.map((l) => l.bbox.x));
    const y = Math.min(...bucket.map((l) => l.bbox.y));
    const x2 = Math.max(...bucket.map((l) => l.bbox.x + l.bbox.width));
    const y2 = Math.max(...bucket.map((l) => l.bbox.y + l.bbox.height));
    const avgConf = bucket.reduce((sum, l) => sum + l.confidence, 0) / bucket.length;

    return {
      id: `block_${idx}`,
      text: bucket.map((l) => l.text).join("\n"),
      confidence: Math.round(avgConf),
      bbox: { x, y, width: x2 - x, height: y2 - y },
      kind: "block" as const,
    };
  });

  // Ensure lines have kind "line"
  const formattedLines: OcrSegment[] = lines.map((l, idx) => ({
    ...l,
    id: l.id || `line_${idx}`,
    kind: "line" as const,
  }));

  // Ensure words have kind "word"
  let formattedWords: OcrSegment[] = rawWords.map((w, idx) => ({
    ...w,
    id: w.id || `word_${idx}`,
    kind: "word" as const,
  }));

  // If no raw words from OCR, split lines into words
  if (!formattedWords.length && lines.length) {
    let wordCount = 0;
    formattedWords = [];
    for (const line of lines) {
      const tokens = line.text.split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) {
        formattedWords.push({ ...line, id: `word_${wordCount++}`, kind: "word" as const });
      } else {
        const tokenWidth = line.bbox.width / tokens.length;
        tokens.forEach((token, tIdx) => {
          formattedWords.push({
            id: `word_${wordCount++}`,
            text: token,
            confidence: line.confidence,
            bbox: {
              x: Math.round(line.bbox.x + tIdx * tokenWidth),
              y: line.bbox.y,
              width: Math.round(tokenWidth),
              height: line.bbox.height,
            },
            kind: "word" as const,
          });
        });
      }
    }
  }

  return {
    words: formattedWords,
    lines: formattedLines,
    blocks,
  };
}

export function getSegmentsByLevel(
  ocrResult: OcrResult,
  level: OcrGroupingLevel,
  imageWidth?: number,
  imageHeight?: number,
): OcrSegment[] {
  const grouped = groupOcrSegments(ocrResult, imageWidth, imageHeight);
  if (level === "block") return grouped.blocks;
  if (level === "line") return grouped.lines;
  return grouped.words;
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

  const grouped = groupOcrSegments(targetOcr, imageWidth, imageHeight);
  const refIsMultiline = Boolean(ref.text?.includes("\n") || ref.segmentId?.startsWith("block_"));
  const pool = isCount
    ? [...grouped.blocks, ...grouped.lines, ...grouped.words]
    : refIsMultiline
      ? [...grouped.blocks, ...grouped.lines]
      : [...grouped.blocks, ...grouped.lines];

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
      if (isEngagementText(candText)) {
        contentScore += 20;
      } else if (/\d/.test(candText)) {
        contentScore += 10;
      }
    } else if (isDate) {
      if (isTimestampText(candText)) {
        contentScore += 20;
      } else if (/(\d{1,2}[:/.-]\d{1,2})/.test(candText)) {
        contentScore += 10;
      }
    } else if (isAuthor) {
      if (isAuthorCandidate(candText) && candRelY < 0.28) {
        contentScore += 20;
      }
    } else if (refIsMultiline) {
      if (cand.kind === "block" && candText.length >= 30) {
        contentScore += 20;
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
  if (!targetCapture) return draft;

  const isTeaching =
    draft.teachingCaptureId === targetCaptureId ||
    (!draft.teachingCaptureId && draft.captures[0]?.id === targetCaptureId);

  // In Image #1 (teaching reference), NEVER automatically guess variable assignments.
  if (isTeaching) return draft;

  // C2.11: Stage 2B region-scoped OCR learning path (independent of capture.ocr)
  const targetRegions = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ].filter((r) => r.captureItemId === targetCaptureId && r.ocr?.segments?.length);

  if (targetRegions.length > 0) {
    const withQuickFill = proposeQuickFillForCapture(draft, targetCaptureId, imageWidth, imageHeight);
    const hasNewProposals = withQuickFill.variables.some((v) =>
      v.mappings.some((m) => m.sampleId === targetCaptureId && m.simulatedProposal),
    );
    if (hasNewProposals) {
      const captureAudits = (withQuickFill.captureAudits ?? []).map((a) => {
        if (a.captureItemId === targetCaptureId && a.status === "unreviewed") {
          return {
            ...a,
            status: "proposed" as const,
            note: "Suggested values based on confirmed teaching reference.",
          };
        }
        return a;
      });
      return markValidationOutdated({
        ...withQuickFill,
        captureAudits,
        dirty: true,
      });
    }
    return withQuickFill;
  }

  // Fallback to legacy capture-level OCR for backward compatibility
  if (!targetCapture.ocr) return draft;

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
