import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";
import type {
  BeginLayoutBlock,
  BeginLayoutBlockType,
  BeginBlockVariant,
  BeginBlockCandidate,
  BeginBlockMatchResult,
  BeginSampleBlockInspection,
  BeginGroupBlockInspection,
  BeginBlockInspectionReport,
} from "../shared/collectors/types.js";
import type { ReferenceBeginCrop } from "./begin-layout-matcher.js";

export type BeginBlockMatcherOptions = {
  scaleVariants?: number[];
  minConfidence?: number;
};

// Standardized processing resolution for block segmentation
const NORM_H = 64;
const MIN_NORM_W = 160;
const MAX_NORM_W = 640;

export function getBlockColor(type: BeginLayoutBlockType): string {
  switch (type) {
    case "image_avatar":
      return "#8b5cf6"; // Purple
    case "primary_text":
      return "#0284c7"; // Sky blue
    case "secondary_text":
      return "#64748b"; // Slate gray
    case "action_menu":
      return "#f59e0b"; // Amber
    case "generic_block":
    default:
      return "#10b981"; // Emerald
  }
}

/**
 * Connected component bounding box with stroke density.
 */
type RawComponent = {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pixelCount: number;
};

/**
 * Lightweight deterministic image segmentation.
 *
 * 1. Grayscale & normalized scaling (fixed height 64px, aspect-ratio preserved width).
 * 2. Gradient magnitude / stroke thresholding (gradient >= 24).
 * 3. Morphological horizontal closing (9x3 kernel) to fuse character strokes into text lines
 *    and texture into avatar/menu blocks.
 * 4. Connected components analysis & noise filtering.
 * 5. Horizontal fragment merging on aligned lines.
 * 6. Geometric classification into abstract layout blocks (avatar, primary text, secondary text, action menu).
 */
export async function extractBeginBlocks(
  imageBuffer: Buffer,
  options?: { generateSegmentedOverlay?: boolean },
): Promise<{
  blocks: BeginLayoutBlock[];
  rawWidth: number;
  rawHeight: number;
  aspectRatio: number;
  normWidth: number;
  normHeight: number;
  segmentedPngBuffer?: Buffer;
}> {
  const meta = await sharp(imageBuffer).metadata();
  const rawWidth = meta.width || 560;
  const rawHeight = meta.height || 60;
  const aspectRatio = rawWidth / Math.max(1, rawHeight);

  // Preserve aspect ratio with standardized working height
  const normHeight = NORM_H;
  const normWidth = Math.max(MIN_NORM_W, Math.min(MAX_NORM_W, Math.round(normHeight * aspectRatio)));

  // Extract grayscale raw pixels
  const { data: pixels } = await sharp(imageBuffer)
    .grayscale()
    .resize(normWidth, normHeight, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 1. Edge/Gradient thresholding
  const edgeMask = new Uint8Array(normWidth * normHeight);
  for (let y = 1; y < normHeight - 1; y++) {
    const rowOffset = y * normWidth;
    for (let x = 1; x < normWidth - 1; x++) {
      const idx = rowOffset + x;
      const dx = Math.abs(pixels[idx + 1]! - pixels[idx - 1]!);
      const dy = Math.abs(pixels[idx + normWidth]! - pixels[idx - normWidth]!);
      if (dx + dy >= 24) {
        edgeMask[idx] = 1;
      }
    }
  }

  // 2. Morphological horizontal dilation / closing (horizontal radius 4, vertical radius 1)
  // Fuses characters into text lines without blurring separate lines
  const closedMask = new Uint8Array(normWidth * normHeight);
  const hRad = 4;
  const vRad = 1;

  for (let y = 0; y < normHeight; y++) {
    const yMin = Math.max(0, y - vRad);
    const yMax = Math.min(normHeight - 1, y + vRad);
    for (let x = 0; x < normWidth; x++) {
      const xMin = Math.max(0, x - hRad);
      const xMax = Math.min(normWidth - 1, x + hRad);

      let found = false;
      for (let ny = yMin; ny <= yMax && !found; ny++) {
        const nOffset = ny * normWidth;
        for (let nx = xMin; nx <= xMax; nx++) {
          if (edgeMask[nOffset + nx] === 1) {
            found = true;
            break;
          }
        }
      }
      if (found) {
        closedMask[y * normWidth + x] = 1;
      }
    }
  }

  // 3. Connected-Component extraction
  const visited = new Uint8Array(normWidth * normHeight);
  const rawComponents: RawComponent[] = [];

  for (let y = 0; y < normHeight; y++) {
    for (let x = 0; x < normWidth; x++) {
      const idx = y * normWidth + x;
      if (closedMask[idx] === 1 && visited[idx] === 0) {
        // BFS flood fill
        let cXmin = x;
        let cXmax = x;
        let cYmin = y;
        let cYmax = y;
        let pixelCount = 0;

        const queue: number[] = [idx];
        visited[idx] = 1;

        let head = 0;
        while (head < queue.length) {
          const curr = queue[head++]!;
          const cy = Math.floor(curr / normWidth);
          const cx = curr % normWidth;

          if (cx < cXmin) cXmin = cx;
          if (cx > cXmax) cXmax = cx;
          if (cy < cYmin) cYmin = cy;
          if (cy > cYmax) cYmax = cy;
          if (edgeMask[curr] === 1) pixelCount++;

          // 4-way neighbors
          const neighbors = [
            cy > 0 ? curr - normWidth : -1,
            cy < normHeight - 1 ? curr + normWidth : -1,
            cx > 0 ? curr - 1 : -1,
            cx < normWidth - 1 ? curr + 1 : -1,
          ];

          for (const n of neighbors) {
            if (n >= 0 && closedMask[n] === 1 && visited[n] === 0) {
              visited[n] = 1;
              queue.push(n);
            }
          }
        }

        const compW = cXmax - cXmin + 1;
        const compH = cYmax - cYmin + 1;

        // Filter tiny noise speckles (< 6px in both directions)
        if (compW >= 6 || compH >= 6) {
          rawComponents.push({
            xMin: cXmin,
            yMin: cYmin,
            xMax: cXmax,
            yMax: cYmax,
            pixelCount,
          });
        }
      }
    }
  }

  // 4. Region Merging: Merge horizontally aligned components on the same line if gap is small
  const mergedComponents: RawComponent[] = [];
  rawComponents.sort((a, b) => a.xMin - b.xMin);

  for (const comp of rawComponents) {
    let merged = false;
    for (const existing of mergedComponents) {
      const cy1 = (comp.yMin + comp.yMax) / 2;
      const cy2 = (existing.yMin + existing.yMax) / 2;
      const h1 = comp.yMax - comp.yMin + 1;
      const h2 = existing.yMax - existing.yMin + 1;

      // Both are horizontal text-like fragments on the same line
      const sameLine = Math.abs(cy1 - cy2) <= 5 && Math.min(h1, h2) / Math.max(h1, h2) >= 0.5;
      const horizontalGap = Math.max(0, comp.xMin - existing.xMax);

      if (sameLine && horizontalGap <= 16 && (comp.xMax - comp.xMin > 10 || existing.xMax - existing.xMin > 10)) {
        existing.xMin = Math.min(existing.xMin, comp.xMin);
        existing.xMax = Math.max(existing.xMax, comp.xMax);
        existing.yMin = Math.min(existing.yMin, comp.yMin);
        existing.yMax = Math.max(existing.yMax, comp.yMax);
        existing.pixelCount += comp.pixelCount;
        merged = true;
        break;
      }
    }
    if (!merged) {
      mergedComponents.push({ ...comp });
    }
  }

  // 5. Geometric Classification into Abstract Layout Blocks
  const blocks: BeginLayoutBlock[] = [];
  let blockCounter = 1;

  for (const c of mergedComponents) {
    const w = c.xMax - c.xMin + 1;
    const h = c.yMax - c.yMin + 1;
    const area = w * h;

    const rx = c.xMin / normWidth;
    const ry = c.yMin / normHeight;
    const rw = w / normWidth;
    const rh = h / normHeight;
    const compAspect = w / Math.max(1, h);
    const density = Math.min(1, Math.round((c.pixelCount / Math.max(1, area)) * 100) / 100);

    let type: BeginLayoutBlockType = "generic_block";
    let confidence = 0.8;

    // Classification rules
    if (rx <= 0.22 && compAspect >= 0.55 && compAspect <= 1.65 && rh >= 0.32) {
      // Compact square / circle on the left with substantial height
      type = "image_avatar";
      confidence = 0.95;
    } else if (rx >= 0.70 && rw <= 0.25 && rh <= 0.45 && ry <= 0.65) {
      // Small compact action/menu cluster on the top-right
      type = "action_menu";
      confidence = 0.9;
    } else if (rh <= 0.45 && (compAspect >= 1.8 || rw >= 0.12)) {
      // Horizontal text-line structure
      if (ry <= 0.48) {
        type = "primary_text";
        confidence = 0.9;
      } else {
        type = "secondary_text";
        confidence = 0.85;
      }
    } else if (rw >= 0.45 && rh >= 0.45) {
      // Wide single element covering multiple rows (e.g. composer input pill or media)
      type = "generic_block";
      confidence = 0.7;
    }

    blocks.push({
      id: `blk_${blockCounter++}_${type}`,
      type,
      normalizedBounds: {
        x: Math.round(rx * 1000) / 1000,
        y: Math.round(ry * 1000) / 1000,
        width: Math.round(rw * 1000) / 1000,
        height: Math.round(rh * 1000) / 1000,
      },
      aspectRatio: Math.round(compAspect * 100) / 100,
      density,
      confidence,
      required: type === "image_avatar" || type === "primary_text",
      label: type.replace("_", " ").toUpperCase(),
    });
  }

  // Sort blocks from left to right, then top to bottom
  blocks.sort((a, b) => a.normalizedBounds.x - b.normalizedBounds.x || a.normalizedBounds.y - b.normalizedBounds.y);

  // 6. Optional: Generate segmented visual overlay
  let segmentedPngBuffer: Buffer | undefined;
  if (options?.generateSegmentedOverlay) {
    try {
      const svgElements = blocks
        .map((b) => {
          const bx = Math.round(b.normalizedBounds.x * normWidth);
          const by = Math.round(b.normalizedBounds.y * normHeight);
          const bw = Math.max(4, Math.round(b.normalizedBounds.width * normWidth));
          const bh = Math.max(4, Math.round(b.normalizedBounds.height * normHeight));
          const color = getBlockColor(b.type);
          const label = b.type === "image_avatar" ? "AVATAR" : b.type === "primary_text" ? "TITLE" : b.type === "secondary_text" ? "TIME" : b.type === "action_menu" ? "MENU" : "BLOCK";

          return `
            <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2" rx="2" />
            <rect x="${bx}" y="${Math.max(0, by - 12)}" width="${Math.min(bw, 44)}" height="12" fill="${color}" rx="1" />
            <text x="${bx + 2}" y="${Math.max(0, by - 12) + 9}" font-family="sans-serif" font-size="8" font-weight="bold" fill="#ffffff">${label}</text>
          `;
        })
        .join("");

      const svg = `<svg width="${normWidth}" height="${normHeight}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;
      segmentedPngBuffer = await sharp(imageBuffer)
        .resize(normWidth, normHeight, { fit: "fill" })
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer();
    } catch {
      segmentedPngBuffer = undefined;
    }
  }

  return {
    blocks,
    rawWidth,
    rawHeight,
    aspectRatio,
    normWidth,
    normHeight,
    segmentedPngBuffer,
  };
}

/**
 * Multi-sample learning: clusters samples into layout variants and derives required/optional blocks.
 */
export async function buildLearnedBlockVariants(
  referenceCrops: ReferenceBeginCrop[],
  groupTag = "default",
): Promise<BeginBlockVariant[]> {
  const validRefs = referenceCrops.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);
  if (validRefs.length === 0) {
    return [];
  }

  // Extract blocks for all samples
  const sampleData: Array<{
    sampleId: string;
    width: number;
    height: number;
    aspectRatio: number;
    blocks: BeginLayoutBlock[];
  }> = [];

  for (const ref of validRefs) {
    try {
      const extracted = await extractBeginBlocks(ref.imageBuffer);
      sampleData.push({
        sampleId: ref.sampleId || "unknown",
        width: extracted.rawWidth,
        height: extracted.rawHeight,
        aspectRatio: extracted.aspectRatio,
        blocks: extracted.blocks,
      });
    } catch {
      // Ignore unreadable crop in learning
    }
  }

  if (sampleData.length === 0) {
    return [];
  }

  // Structural clustering: group samples by core layout signature
  // (has avatar, count of text lines, has menu)
  const clusterMap = new Map<string, typeof sampleData>();

  for (const s of sampleData) {
    const hasAvatar = s.blocks.some((b) => b.type === "image_avatar");
    const primaryCount = s.blocks.filter((b) => b.type === "primary_text").length;
    const secondaryCount = s.blocks.filter((b) => b.type === "secondary_text").length;
    const hasMenu = s.blocks.some((b) => b.type === "action_menu");

    const sig = `av:${hasAvatar ? 1 : 0}_p:${Math.min(2, primaryCount)}_s:${Math.min(2, secondaryCount)}_m:${hasMenu ? 1 : 0}`;
    const list = clusterMap.get(sig) ?? [];
    list.push(s);
    clusterMap.set(sig, list);
  }

  const variants: BeginBlockVariant[] = [];
  let variantIndex = 1;

  for (const [_, cluster] of clusterMap.entries()) {
    const sampleCount = cluster.length;
    const sampleIds = cluster.map((c) => c.sampleId);

    // Average nominal dimensions
    const avgW = Math.round(cluster.reduce((acc, c) => acc + c.width, 0) / sampleCount);
    const avgH = Math.round(cluster.reduce((acc, c) => acc + c.height, 0) / sampleCount);
    const avgAR = Math.round((avgW / Math.max(1, avgH)) * 100) / 100;

    // Align blocks across samples in this variant
    // Collect all unique block categories present
    const blockTypes: BeginLayoutBlockType[] = [
      "image_avatar",
      "primary_text",
      "secondary_text",
      "action_menu",
      "generic_block",
    ];

    const aggregatedBlocks: BeginLayoutBlock[] = [];

    for (const t of blockTypes) {
      // Gather all blocks of this type across cluster samples
      const matchingBlocks = cluster.flatMap((c) => c.blocks.filter((b) => b.type === t));
      if (matchingBlocks.length === 0) continue;

      // Group matching blocks by spatial closeness
      const spatialGroups: BeginLayoutBlock[][] = [];
      for (const b of matchingBlocks) {
        let placed = false;
        for (const grp of spatialGroups) {
          const leader = grp[0]!;
          const dx = Math.abs(leader.normalizedBounds.x - b.normalizedBounds.x);
          const dy = Math.abs(leader.normalizedBounds.y - b.normalizedBounds.y);
          if (dx <= 0.18 && dy <= 0.20) {
            grp.push(b);
            placed = true;
            break;
          }
        }
        if (!placed) {
          spatialGroups.push([b]);
        }
      }

      for (let gIdx = 0; gIdx < spatialGroups.length; gIdx++) {
        const grp = spatialGroups[gIdx]!;
        const count = grp.length;
        const consistency = count / sampleCount;

        const meanX = grp.reduce((acc, b) => acc + b.normalizedBounds.x, 0) / count;
        const meanY = grp.reduce((acc, b) => acc + b.normalizedBounds.y, 0) / count;
        const meanW = grp.reduce((acc, b) => acc + b.normalizedBounds.width, 0) / count;
        const meanH = grp.reduce((acc, b) => acc + b.normalizedBounds.height, 0) / count;
        const meanDensity = grp.reduce((acc, b) => acc + b.density, 0) / count;
        const meanAspect = grp.reduce((acc, b) => acc + b.aspectRatio, 0) / count;

        // Block is required if consistency >= 0.70 or if single sample and core header element
        const isCore = t === "image_avatar" || t === "primary_text";
        const required = sampleCount === 1 ? isCore : consistency >= 0.7;

        aggregatedBlocks.push({
          id: `var_${variantIndex}_${t}_${gIdx + 1}`,
          type: t,
          normalizedBounds: {
            x: Math.round(meanX * 1000) / 1000,
            y: Math.round(meanY * 1000) / 1000,
            width: Math.round(meanW * 1000) / 1000,
            height: Math.round(meanH * 1000) / 1000,
          },
          aspectRatio: Math.round(meanAspect * 100) / 100,
          density: Math.round(meanDensity * 100) / 100,
          confidence: Math.round(consistency * 100) / 100,
          required,
          label: `${t.replace("_", " ").toUpperCase()}${required ? " (REQ)" : " (OPT)"}`,
        });
      }
    }

    aggregatedBlocks.sort(
      (a, b) => a.normalizedBounds.x - b.normalizedBounds.x || a.normalizedBounds.y - b.normalizedBounds.y,
    );

    variants.push({
      variantId: `variant_${variantIndex++}_${groupTag}`,
      sampleCount,
      sampleIds,
      nominalDimensions: { width: avgW, height: avgH },
      nominalAspectRatio: avgAR,
      blocks: aggregatedBlocks,
      consistencyScore: Math.round((aggregatedBlocks.filter((b) => b.required).length / Math.max(1, aggregatedBlocks.length)) * 100) / 100,
    });
  }

  return variants;
}

/**
 * Cache for reusable learned variants keyed by reference sample hashes.
 */
const variantCache = new Map<string, { timestamp: number; variants: BeginBlockVariant[] }>();

/**
 * Computes intersection over union (IoU) of two normalized rectangles.
 */
function computeNormalizedIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * B3 V2 Whole-Layout Block Matching.
 *
 * Compares live screenshot regions against learned block layout templates.
 */
export async function matchBeginBlockLayout(
  screenshotBuffer: Buffer,
  referenceCrops: ReferenceBeginCrop[],
  options?: BeginBlockMatcherOptions,
): Promise<BeginBlockMatchResult> {
  const startTime = performance.now();
  const validRefs = referenceCrops.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);

  if (validRefs.length === 0) {
    return {
      testedAt: new Date().toISOString(),
      technique: "B3_V2_BLOCK_LEVEL_MATCHING",
      referenceSampleIds: [],
      referenceBeginCount: 0,
      variantCount: 0,
      status: "NO_REFERENCES",
      screenshotDimensions: { width: 0, height: 0 },
      scale: 1.0,
      matchedCandidates: [],
      rejectedCandidates: [],
      diagnostics: {
        decodeTimeMs: 0,
        preprocessTimeMs: 0,
        candidateGenerationTimeMs: 0,
        candidateComparisonTimeMs: 0,
        totalDurationMs: 0,
        evaluatedWindowsCount: 0,
        variants: [],
      },
    };
  }

  // 1. Decode screenshot metadata
  const tDecodeStart = performance.now();
  const meta = await sharp(screenshotBuffer).metadata();
  const sW = meta.width || 1280;
  const sH = meta.height || 800;
  const decodeTimeMs = Math.round((performance.now() - tDecodeStart) * 100) / 100;

  // 2. Build or retrieve learned variants from cache
  const tPreprocessStart = performance.now();
  const cacheKey = validRefs.map((r) => `${r.sampleId || ""}_${r.imageBuffer.length}`).join("|");
  let variants: BeginBlockVariant[];

  const cached = variantCache.get(cacheKey);
  if (cached && performance.now() - cached.timestamp < 30000) {
    variants = cached.variants;
  } else {
    variants = await buildLearnedBlockVariants(validRefs);
    variantCache.set(cacheKey, { timestamp: performance.now(), variants });
  }
  const preprocessTimeMs = Math.round((performance.now() - tPreprocessStart) * 100) / 100;

  if (variants.length === 0) {
    return {
      testedAt: new Date().toISOString(),
      technique: "B3_V2_BLOCK_LEVEL_MATCHING",
      referenceSampleIds: validRefs.map((r) => r.sampleId || "").filter(Boolean),
      referenceBeginCount: validRefs.length,
      variantCount: 0,
      status: "NO_MATCH",
      screenshotDimensions: { width: sW, height: sH },
      scale: 1.0,
      matchedCandidates: [],
      rejectedCandidates: [],
      diagnostics: {
        decodeTimeMs,
        preprocessTimeMs,
        candidateGenerationTimeMs: 0,
        candidateComparisonTimeMs: 0,
        totalDurationMs: Math.round((performance.now() - startTime) * 100) / 100,
        evaluatedWindowsCount: 0,
        variants: [],
      },
    };
  }

  // 3. Fast candidate window generation & evaluation
  const tGenStart = performance.now();
  const scaleVariants = options?.scaleVariants ?? [1.0, 0.95, 1.05];
  const minConfidence = options?.minConfidence ?? 65;

  const rawCandidates: BeginBlockCandidate[] = [];
  let evaluatedWindowsCount = 0;

  // Pre-load raw grayscale screenshot for quick coarse filter
  const { data: screenPixels } = await sharp(screenshotBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const primaryVariant = variants[0]!;
  const nomW = primaryVariant.nominalDimensions.width || 560;
  const nomH = primaryVariant.nominalDimensions.height || 60;

  for (const scale of scaleVariants) {
    const winW = Math.round(nomW * scale);
    const winH = Math.round(nomH * scale);

    if (winW > sW || winH > sH) continue;

    // Adaptive search grid: slide along vertical stream
    const yStep = Math.max(14, Math.round(winH * 0.25));
    // Usually feed posts are centered or left-aligned within standard margins
    const candidateXPositions = [
      Math.max(0, Math.round((sW - winW) / 2)), // Centered feed
      Math.round(sW * 0.15), // Left sidebar margin
      Math.round(sW * 0.25),
      0, // Far left
    ].filter((x) => x >= 0 && x + winW <= sW);

    const uniqueX = Array.from(new Set(candidateXPositions));

    for (const winX of uniqueX) {
      for (let winY = 0; winY + winH <= sH; winY += yStep) {
        // Fast Coarse Filter: Check if window has both left-edge contrast and text-band edge contrast
        // Avoids expensive sharp extraction on blank or solid color windows
        let leftContrast = 0;
        let centerContrast = 0;

        const sampleStep = 4;
        const leftLimit = Math.round(winW * 0.22);
        const centerLeft = Math.round(winW * 0.25);
        const centerRight = Math.round(winW * 0.75);

        for (let dy = 6; dy < winH - 6; dy += sampleStep) {
          const row = (winY + dy) * sW;
          // Left zone (avatar)
          for (let dx = 4; dx < leftLimit; dx += sampleStep) {
            const idx = row + winX + dx;
            leftContrast += Math.abs(screenPixels[idx + 1]! - screenPixels[idx - 1]!);
          }
          // Center zone (text)
          for (let dx = centerLeft; dx < centerRight; dx += sampleStep) {
            const idx = row + winX + dx;
            centerContrast += Math.abs(screenPixels[idx + 1]! - screenPixels[idx - 1]!);
          }
        }

        // If region is completely flat or has near-zero edges, skip early
        if (leftContrast < 120 && centerContrast < 150) {
          continue;
        }

        evaluatedWindowsCount++;

        // Extract candidate window crop
        let windowCropBuf: Buffer;
        try {
          windowCropBuf = await sharp(screenshotBuffer)
            .extract({ left: winX, top: winY, width: winW, height: winH })
            .toBuffer();
        } catch {
          continue;
        }

        // Segment candidate window into abstract blocks
        const seg = await extractBeginBlocks(windowCropBuf);
        const candBlocks = seg.blocks;

        // Compare candidate against each learned variant
        for (const variant of variants) {
          const reqBlocks = variant.blocks.filter((b) => b.required);
          const optBlocks = variant.blocks.filter((b) => !b.required);

          let matchedBlockCount = 0;
          const missingRequired: string[] = [];
          let totalIoU = 0;
          let matchedPairsCount = 0;

          const matchedCandBlockIds = new Set<string>();

          // 1. Match Required Blocks
          for (const req of reqBlocks) {
            // Find best matching candidate block of compatible type
            let bestCand: BeginLayoutBlock | null = null;
            let bestIoU = -1;

            for (const cb of candBlocks) {
              if (matchedCandBlockIds.has(cb.id)) continue;
              // Check type compatibility
              const typeCompatible =
                cb.type === req.type ||
                (req.type === "primary_text" && cb.type === "secondary_text") ||
                (req.type === "secondary_text" && cb.type === "primary_text");

              if (typeCompatible) {
                const iou = computeNormalizedIoU(req.normalizedBounds, cb.normalizedBounds);
                const dx = Math.abs(req.normalizedBounds.x - cb.normalizedBounds.x);
                const dy = Math.abs(req.normalizedBounds.y - cb.normalizedBounds.y);

                // Either reasonable IoU or close spatial centers
                if (iou > bestIoU && (iou > 0.15 || (dx <= 0.16 && dy <= 0.20))) {
                  bestIoU = iou;
                  bestCand = cb;
                }
              }
            }

            if (bestCand) {
              matchedCandBlockIds.add(bestCand.id);
              matchedBlockCount++;
              matchedPairsCount++;
              totalIoU += Math.max(0.2, bestIoU);
            } else {
              missingRequired.push(req.type);
            }
          }

          // 2. Match Optional Blocks
          for (const opt of optBlocks) {
            let bestCand: BeginLayoutBlock | null = null;
            let bestIoU = -1;

            for (const cb of candBlocks) {
              if (matchedCandBlockIds.has(cb.id)) continue;
              if (cb.type === opt.type) {
                const iou = computeNormalizedIoU(opt.normalizedBounds, cb.normalizedBounds);
                const dx = Math.abs(opt.normalizedBounds.x - cb.normalizedBounds.x);
                const dy = Math.abs(opt.normalizedBounds.y - cb.normalizedBounds.y);

                if (iou > bestIoU && (iou > 0.15 || (dx <= 0.16 && dy <= 0.20))) {
                  bestIoU = iou;
                  bestCand = cb;
                }
              }
            }

            if (bestCand) {
              matchedCandBlockIds.add(bestCand.id);
              matchedBlockCount++;
              matchedPairsCount++;
              totalIoU += Math.max(0.2, bestIoU);
            }
          }

          const extraBlocksCount = candBlocks.length - matchedCandBlockIds.size;
          const geometryScore =
            matchedPairsCount > 0 ? Math.round((totalIoU / matchedPairsCount) * 100) / 100 : 0;

          // Composite layout scoring
          const totalTemplateBlocks = variant.blocks.length;
          const matchRatio = matchedBlockCount / Math.max(1, totalTemplateBlocks);
          const reqRatio =
            reqBlocks.length > 0
              ? (reqBlocks.length - missingRequired.length) / reqBlocks.length
              : 1.0;

          // Extra block penalty (e.g. body text or video filling whole container)
          const extraPenalty = Math.min(0.25, extraBlocksCount * 0.05);

          let compositeScore = 0.45 * matchRatio + 0.35 * reqRatio + 0.20 * geometryScore - extraPenalty;
          compositeScore = Math.max(0, Math.min(1, compositeScore));
          const confidence = Math.round(compositeScore * 100);

          let status: "MATCHED" | "REJECTED" | "PARTIAL" = "REJECTED";
          let rejectionReason: string | undefined;

          if (missingRequired.length > 0) {
            status = "REJECTED";
            rejectionReason = `Missing required layout block(s): ${missingRequired.join(", ")}`;
          } else if (confidence >= minConfidence && geometryScore >= 0.20) {
            status = "MATCHED";
          } else if (confidence >= 45) {
            status = "PARTIAL";
            rejectionReason = `Layout similarity (${confidence}%) below threshold (${minConfidence}%)`;
          } else {
            status = "REJECTED";
            rejectionReason = `Layout similarity (${confidence}%) below acceptance`;
          }

          // Refine vertical candidate window alignment if avatar block is aligned
          let refinedY = winY;
          if (status === "MATCHED") {
            const candAvatar = candBlocks.find((b) => b.type === "image_avatar");
            const tmplAvatar = variant.blocks.find((b) => b.type === "image_avatar");
            if (candAvatar && tmplAvatar) {
              const yOffset = Math.round((candAvatar.normalizedBounds.y - tmplAvatar.normalizedBounds.y) * winH);
              if (Math.abs(yOffset) <= Math.round(winH * 0.35) && winY + yOffset >= 0 && winY + yOffset + winH <= sH) {
                refinedY = winY + yOffset;
              }
            }
          }

          rawCandidates.push({
            id: `cand_blk_${Math.round(Math.random() * 100000)}`,
            rect: { x: winX, y: refinedY, width: winW, height: winH },
            confidence,
            score: compositeScore,
            status,
            rejectionReason,
            matchedBlocksCount: matchedBlockCount,
            totalTemplateBlocks,
            missingRequiredBlocks: missingRequired,
            extraBlocksCount,
            geometryScore,
            variantId: variant.variantId,
            cropDimensions: { width: winW, height: winH },
            scale,
            blocks: candBlocks,
          });
        }
      }
    }
  }

  const candidateGenerationTimeMs = Math.round((performance.now() - tGenStart) * 100) / 100;

  // 4. Non-maximum suppression along vertical axis
  const tCompStart = performance.now();
  rawCandidates.sort((a, b) => b.score - a.score);

  const matchedCandidates: BeginBlockCandidate[] = [];
  const rejectedCandidates: BeginBlockCandidate[] = [];

  for (const cand of rawCandidates) {
    if (cand.status === "MATCHED") {
      const isOverlap = matchedCandidates.some((existing) => {
        const yDist = Math.abs(existing.rect.y - cand.rect.y);
        const xDist = Math.abs(existing.rect.x - cand.rect.x);
        return yDist <= cand.rect.height * 0.65 && xDist <= cand.rect.width * 0.5;
      });

      if (!isOverlap) {
        matchedCandidates.push(cand);
      }
    } else {
      if (rejectedCandidates.length < 8) {
        rejectedCandidates.push(cand);
      }
    }
  }

  const candidateComparisonTimeMs = Math.round((performance.now() - tCompStart) * 100) / 100;
  const totalDurationMs = Math.round((performance.now() - startTime) * 100) / 100;

  const finalStatus: "MATCHED" | "NO_MATCH" | "PARTIAL" =
    matchedCandidates.length > 0
      ? "MATCHED"
      : rawCandidates.some((c) => c.status === "PARTIAL" && (c.rect.y <= 10 || c.rect.y + c.rect.height >= sH - 10))
        ? "PARTIAL"
        : "NO_MATCH";

  return {
    testedAt: new Date().toISOString(),
    technique: "B3_V2_BLOCK_LEVEL_MATCHING",
    referenceSampleIds: validRefs.map((r) => r.sampleId || "").filter(Boolean),
    referenceBeginCount: validRefs.length,
    variantCount: variants.length,
    status: finalStatus,
    screenshotDimensions: { width: sW, height: sH },
    scale: scaleVariants[0] ?? 1.0,
    matchedCandidates,
    rejectedCandidates,
    diagnostics: {
      decodeTimeMs,
      preprocessTimeMs,
      candidateGenerationTimeMs,
      candidateComparisonTimeMs,
      totalDurationMs,
      evaluatedWindowsCount,
      variants: variants.map((v) => ({
        variantId: v.variantId,
        blockCount: v.blocks.length,
        sampleCount: v.sampleCount,
      })),
    },
  };
}

/**
 * Inspection report for Review 2C (Block Layout view).
 */
export async function inspectBeginBlockTemplate(
  references: ReferenceBeginCrop[],
  targetGroupTag?: string,
): Promise<BeginBlockInspectionReport> {
  const groups: Record<string, BeginGroupBlockInspection> = {};
  const byGroup = new Map<string, ReferenceBeginCrop[]>();
  const allGroupTagsSet = new Set<string>();

  for (const ref of references) {
    const tag = (ref.groupTag || "default").trim();
    allGroupTagsSet.add(tag);
    const list = byGroup.get(tag) ?? [];
    list.push(ref);
    byGroup.set(tag, list);
  }

  if (targetGroupTag) {
    allGroupTagsSet.add(targetGroupTag);
    if (!byGroup.has(targetGroupTag)) {
      byGroup.set(targetGroupTag, []);
    }
  }

  const allGroupTags = Array.from(allGroupTagsSet);

  for (const [tag, groupRefs] of byGroup.entries()) {
    const validRefs = groupRefs.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);

    if (validRefs.length === 0) {
      groups[tag] = {
        groupTag: tag,
        sampleCount: 0,
        sampleIds: groupRefs.map((r) => r.sampleId || "").filter(Boolean),
        canonicalDimensions: { width: 320, height: NORM_H },
        nominalDimensions: { width: 320, height: NORM_H },
        nominalAspectRatio: Math.round((320 / NORM_H) * 100) / 100,
        variants: [],
        samples: groupRefs.map((r) => ({
          sampleId: r.sampleId || "unknown",
          regionId: r.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: r.originalDataUrl,
          blocks: [],
          error: r.error || "Reference crop image buffer is empty or unavailable.",
        })),
        status: "NO_CONFIRMED_SAMPLES",
        error: "No usable confirmed BEGIN reference crops in this Anchor Group.",
      };
      continue;
    }

    const sampleInspections: BeginSampleBlockInspection[] = [];

    for (const ref of groupRefs) {
      if (!ref.imageBuffer || ref.imageBuffer.length === 0) {
        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: ref.originalDataUrl,
          blocks: [],
          error: ref.error || "Reference crop image buffer is empty or unreadable.",
        });
        continue;
      }

      try {
        const seg = await extractBeginBlocks(ref.imageBuffer, { generateSegmentedOverlay: true });
        const originalCropDataUrl =
          ref.originalDataUrl ||
          `data:image/png;base64,${(await sharp(ref.imageBuffer).png().toBuffer()).toString("base64")}`;

        const segmentedCropDataUrl = seg.segmentedPngBuffer
          ? `data:image/png;base64,${seg.segmentedPngBuffer.toString("base64")}`
          : originalCropDataUrl;

        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: seg.rawWidth, height: seg.rawHeight },
          aspectRatio: Math.round(seg.aspectRatio * 100) / 100,
          originalCropDataUrl,
          segmentedCropDataUrl,
          blocks: seg.blocks,
        });
      } catch (err) {
        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: ref.originalDataUrl,
          blocks: [],
          error: `Block extraction error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const variants = await buildLearnedBlockVariants(validRefs, tag);
    const primaryNom = variants[0]?.nominalDimensions || { width: 320, height: NORM_H };
    const primaryAR = variants[0]?.nominalAspectRatio || 5.0;

    groups[tag] = {
      groupTag: tag,
      sampleCount: validRefs.length,
      sampleIds: validRefs.map((r) => r.sampleId || "").filter(Boolean),
      canonicalDimensions: { width: 320, height: NORM_H },
      nominalDimensions: primaryNom,
      nominalAspectRatio: primaryAR,
      variants,
      samples: sampleInspections,
      status: "READY",
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    canonicalDimensions: { width: 320, height: NORM_H },
    groups,
    allGroupTags,
  };
}
