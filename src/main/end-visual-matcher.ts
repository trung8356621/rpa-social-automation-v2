import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";
import type {
  EndVisualCandidate,
  EndVisualFeatureScores,
  EndVisualMatchResult,
} from "../shared/collectors/types.js";

export type ReferenceEndCrop = {
  sampleId?: string;
  imageBuffer: Buffer;
  roi?: Rect;
};

export type EndVisualMatcherOptions = {
  scaleVariants?: number[];
  minConfidence?: number;
};

export type VisualPatch = {
  data: Buffer;
  w: number;
  h: number;
  variance: number;
};

/** Compute grayscale pixel variance (contrast check). */
export function computeVariance(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i]!;
  }
  const mean = sum / buf.length;
  let varSum = 0;
  for (let i = 0; i < buf.length; i++) {
    const diff = buf[i]! - mean;
    varSum += diff * diff;
  }
  return varSum / buf.length;
}

/** Compute zero-mean normalized cross correlation (ZNCC) between a sub-patch and a screenshot window (0 to 1). */
export function computePatchSimilarity(
  screenData: Buffer,
  screenWidth: number,
  screenHeight: number,
  startX: number,
  startY: number,
  patch: VisualPatch,
): number {
  const { data: pData, w: pW, h: pH } = patch;
  if (
    startX < 0 ||
    startY < 0 ||
    startX >= screenWidth ||
    startY >= screenHeight
  ) {
    return 0;
  }

  const effW = Math.min(pW, screenWidth - startX);
  const effH = Math.min(pH, screenHeight - startY);
  if (effW < Math.round(pW * 0.4) || effH < Math.round(pH * 0.4)) {
    return 0;
  }

  let sSum = 0;
  let pSum = 0;
  let count = 0;
  const strideX = Math.max(1, Math.floor(effW / 28));
  const strideY = Math.max(1, Math.floor(effH / 16));

  for (let py = 0; py < effH; py += strideY) {
    const sRow = (startY + py) * screenWidth;
    const pRow = py * pW;
    for (let px = 0; px < effW; px += strideX) {
      sSum += screenData[sRow + (startX + px)]!;
      pSum += pData[pRow + px]!;
      count++;
    }
  }

  if (count === 0) return 0;
  const sMean = sSum / count;
  const pMean = pSum / count;

  let cov = 0;
  let sVar = 0;
  let pVar = 0;

  for (let py = 0; py < effH; py += strideY) {
    const sRow = (startY + py) * screenWidth;
    const pRow = py * pW;
    for (let px = 0; px < effW; px += strideX) {
      const sDiff = screenData[sRow + (startX + px)]! - sMean;
      const pDiff = pData[pRow + px]! - pMean;
      cov += sDiff * pDiff;
      sVar += sDiff * sDiff;
      pVar += pDiff * pDiff;
    }
  }

  // If flat region without feature contrast, reject
  if (sVar < 15 * count || pVar < 15 * count) {
    return 0;
  }

  const denom = Math.sqrt(sVar * pVar);
  if (denom <= 0) return 0;

  const zncc = cov / denom;
  return Math.max(0, Math.min(1, zncc));
}

/**
 * C2.11.12: Decomposes a confirmed END region crop into its 3 constituent visual action clusters:
 * - Like cluster (left ~0.06 to 0.32 of width)
 * - Comment cluster (center ~0.37 to 0.63 of width)
 * - Share cluster (right ~0.68 to 0.94 of width)
 */
export async function extractVisualSubPatches(cropBuffer: Buffer): Promise<{
  fullWidth: number;
  fullHeight: number;
  likePatch: VisualPatch;
  commentPatch: VisualPatch;
  sharePatch: VisualPatch;
}> {
  const meta = await sharp(cropBuffer).metadata();
  const fullWidth = meta.width || 500;
  const fullHeight = meta.height || 42;

  const extractZone = async (
    relX: number,
    relW: number,
  ): Promise<VisualPatch> => {
    const left = Math.max(0, Math.round(fullWidth * relX));
    const width = Math.min(fullWidth - left, Math.round(fullWidth * relW));
    const top = Math.max(0, Math.round(fullHeight * 0.12));
    const height = Math.min(fullHeight - top, Math.round(fullHeight * 0.76));

    const { data } = await sharp(cropBuffer)
      .extract({ left, top, width, height })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      w: width,
      h: height,
      variance: computeVariance(data),
    };
  };

  const likePatch = await extractZone(0.06, 0.26);
  const commentPatch = await extractZone(0.37, 0.26);
  const sharePatch = await extractZone(0.68, 0.26);

  return {
    fullWidth,
    fullHeight,
    likePatch,
    commentPatch,
    sharePatch,
  };
}

/**
 * C2.11.12: Isolated END-only Visual Matching Engine.
 *
 * Detects post engagement footers across the current browser screenshot using multi-cluster visual correlation:
 * - Matches the combination of Like + Comment + Share action clusters in tripartite horizontal layout.
 * - Rejects comment areas (which have Like/Reply but lack Share, and have narrow widths).
 * - Tolerates changing engagement counts row above the buttons.
 * - Tolerates reasonable scaling (multi-scale search).
 * - Identifies partial cut-off footers at viewport edges as PARTIAL / NO MATCH.
 */
export async function matchEndVisual(
  screenshotBuffer: Buffer,
  referenceCrops: ReferenceEndCrop[],
  options?: EndVisualMatcherOptions,
): Promise<EndVisualMatchResult> {
  const startTime = performance.now();
  const scaleVariants = options?.scaleVariants ?? [1.0, 0.95, 1.05];
  const minConfidence = options?.minConfidence ?? 60;

  const screenMeta = await sharp(screenshotBuffer).metadata();
  const screenWidth = screenMeta.width || 1280;
  const screenHeight = screenMeta.height || 800;

  const screenRaw = await sharp(screenshotBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const screenData = screenRaw.data;

  const validReferences = referenceCrops.filter(
    (r) => r.imageBuffer && r.imageBuffer.length > 0,
  );
  if (validReferences.length === 0) {
    return {
      testedAt: new Date().toISOString(),
      technique: "Tripartite Multi-Cluster Visual Template Correlation (Sharp)",
      screenshotDimensions: { width: screenWidth, height: screenHeight },
      scale: 1.0,
      referenceEndCount: 0,
      referenceSampleIds: [],
      status: "NO_MATCH",
      matchedFooters: [],
      rejectedCandidates: [],
      diagnostics: {
        referenceCropDimensions: [],
        totalEvaluated: 0,
        durationMs: Math.round(performance.now() - startTime),
        summary: "No valid confirmed END reference crops provided.",
      },
    };
  }

  const rawCandidates: EndVisualCandidate[] = [];
  const referenceSampleIds: string[] = [];
  const referenceCropDimensions: Array<{
    width: number;
    height: number;
    sampleId: string;
  }> = [];

  let totalEvaluated = 0;

  for (const ref of validReferences) {
    const sId = ref.sampleId || "sample_ref";
    if (!referenceSampleIds.includes(sId)) referenceSampleIds.push(sId);

    const {
      fullWidth: refW,
      fullHeight: refH,
      likePatch,
      commentPatch,
      sharePatch,
    } = await extractVisualSubPatches(ref.imageBuffer);

    referenceCropDimensions.push({
      width: refW,
      height: refH,
      sampleId: sId,
    });

    for (const scale of scaleVariants) {
      const scaledW = Math.round(refW * scale);
      const scaledH = Math.round(refH * scale);

      // Scale visual sub-patches
      const scalePatch = async (p: VisualPatch): Promise<VisualPatch> => {
        if (scale === 1.0) return p;
        const targetW = Math.max(8, Math.round(p.w * scale));
        const targetH = Math.max(8, Math.round(p.h * scale));
        const { data } = await sharp(p.data, {
          raw: { width: p.w, height: p.h, channels: 1 },
        })
          .resize(targetW, targetH, { fit: "fill" })
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, w: targetW, h: targetH, variance: p.variance };
      };

      const scaledLike = await scalePatch(likePatch);
      const scaledComment = await scalePatch(commentPatch);
      const scaledShare = await scalePatch(sharePatch);

      // Search across viewport
      // Post action bars are typically bounded to content column
      const xStartMin = 20;
      const xStartMax = Math.max(xStartMin + 20, screenWidth - scaledW - 20);
      const xStep = 16;
      const yStep = 4;

      for (let y = 30; y <= screenHeight - Math.round(scaledH * 0.35); y += yStep) {
        for (let x = xStartMin; x <= xStartMax; x += xStep) {
          totalEvaluated++;

          const likeOffset = Math.round(scaledW * 0.06);
          const commentOffset = Math.round(scaledW * 0.37);
          const shareOffset = Math.round(scaledW * 0.68);

          const sLike = computePatchSimilarity(
            screenData,
            screenWidth,
            screenHeight,
            x + likeOffset,
            y,
            scaledLike,
          );
          const sComment = computePatchSimilarity(
            screenData,
            screenWidth,
            screenHeight,
            x + commentOffset,
            y,
            scaledComment,
          );
          const sShare = computePatchSimilarity(
            screenData,
            screenWidth,
            screenHeight,
            x + shareOffset,
            y,
            scaledShare,
          );

          // Check if candidate is partially truncated at viewport bottom boundary
          const isTruncated = y + scaledH > screenHeight - 6;

          // Composite multi-cluster visual score
          const compositeScore =
            0.35 * sLike + 0.35 * sComment + 0.30 * sShare;
          const confidence = Math.round(compositeScore * 100);

          const isTripartite = sLike >= 0.50 && sComment >= 0.50 && sShare >= 0.45;

          const features: EndVisualFeatureScores = {
            likeFound: sLike >= 0.50,
            likeConfidence: Math.round(sLike * 100),
            commentFound: sComment >= 0.50,
            commentConfidence: Math.round(sComment * 100),
            shareFound: sShare >= 0.45,
            shareConfidence: Math.round(sShare * 100),
            tripartiteLayout: isTripartite,
          };

          const candRect: Rect = {
            x,
            y,
            width: scaledW,
            height: scaledH,
          };

          if (isTruncated && (sLike >= 0.45 || sComment >= 0.45 || compositeScore >= 0.35)) {
            rawCandidates.push({
              id: `end_cand_${rawCandidates.length + 1}`,
              rect: candRect,
              confidence,
              score: compositeScore,
              status: "PARTIAL",
              rejectionReason: `Partial footer truncated at viewport bottom boundary (${screenHeight - y}px visible < ${scaledH}px full height)`,
              features,
              referenceSampleIds: [sId],
              cropDimensions: { width: refW, height: refH },
              scale,
            });
          } else if (
            isTripartite &&
            scaledW >= 350 &&
            confidence >= minConfidence
          ) {
            rawCandidates.push({
              id: `end_cand_${rawCandidates.length + 1}`,
              rect: candRect,
              confidence,
              score: compositeScore,
              status: "MATCHED",
              features,
              referenceSampleIds: [sId],
              cropDimensions: { width: refW, height: refH },
              scale,
            });
          } else if (
            (sLike >= 0.40 || sComment >= 0.40) &&
            sShare < 0.30
          ) {
            rawCandidates.push({
              id: `end_cand_${rawCandidates.length + 1}`,
              rect: candRect,
              confidence,
              score: compositeScore,
              status: "REJECTED",
              rejectionReason: `Comment area detected: missing Share action cluster (score ${Math.round(sShare * 100)}% < 30%); comment action pattern`,
              features,
              referenceSampleIds: [sId],
              cropDimensions: { width: refW, height: refH },
              scale,
            });
          }
        }
      }
    }
  }

  // Non-Maximum Suppression (NMS) along the y-axis
  // Post footers are vertically separated by at least 60px
  const matchedPool = rawCandidates.filter((c) => c.status === "MATCHED");
  matchedPool.sort((a, b) => b.score - a.score);

  const matchedFooters: EndVisualCandidate[] = [];
  for (const cand of matchedPool) {
    const isNearby = matchedFooters.some(
      (m) =>
        Math.abs(m.rect.y - cand.rect.y) <= Math.max(28, cand.rect.height * 0.75) &&
        Math.abs(m.rect.x - cand.rect.x) <= Math.max(100, cand.rect.width * 0.4),
    );
    if (!isNearby) {
      matchedFooters.push(cand);
    }
  }

  // Sort matched footers from top to bottom
  matchedFooters.sort((a, b) => a.rect.y - b.rect.y);

  // Group rejected candidates with NMS as well
  const rejectedPool = rawCandidates.filter((c) => c.status !== "MATCHED");
  rejectedPool.sort((a, b) => b.score - a.score);

  const rejectedCandidates: EndVisualCandidate[] = [];
  for (const cand of rejectedPool) {
    const isNearMatch = matchedFooters.some(
      (m) => Math.abs(m.rect.y - cand.rect.y) <= Math.max(25, cand.rect.height * 0.7),
    );
    const isNearRejected = rejectedCandidates.some(
      (r) => Math.abs(r.rect.y - cand.rect.y) <= Math.max(25, cand.rect.height * 0.7),
    );
    if (!isNearMatch && !isNearRejected && rejectedCandidates.length < 15) {
      rejectedCandidates.push(cand);
    }
  }

  let overallStatus: "MATCHED" | "NO_MATCH" | "PARTIAL" = "NO_MATCH";
  if (matchedFooters.length > 0) {
    overallStatus = "MATCHED";
  } else if (rawCandidates.some((c) => c.status === "PARTIAL")) {
    overallStatus = "PARTIAL";
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    testedAt: new Date().toISOString(),
    technique: "Tripartite Multi-Cluster Visual Template Correlation (Sharp)",
    screenshotDimensions: { width: screenWidth, height: screenHeight },
    scale: 1.0,
    referenceEndCount: validReferences.length,
    referenceSampleIds,
    status: overallStatus,
    matchedFooters,
    rejectedCandidates,
    diagnostics: {
      referenceCropDimensions,
      totalEvaluated,
      durationMs,
      summary:
        overallStatus === "MATCHED"
          ? `Detected ${matchedFooters.length} post engagement footer(s) using visual tripartite action cluster correlation.`
          : overallStatus === "PARTIAL"
            ? "Detected partial footer truncated at viewport boundary; insufficient complete evidence."
            : "No post engagement footer matching reference visual clusters found in screenshot.",
    },
  };
}
