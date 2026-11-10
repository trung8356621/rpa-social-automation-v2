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
    case "image_region":
      return "#ec4899"; // Pink
    case "primary_text":
      return "#0284c7"; // Sky blue
    case "secondary_text":
      return "#64748b"; // Slate gray
    case "action_menu":
      return "#f59e0b"; // Amber
    case "unknown":
      return "#94a3b8"; // Muted gray
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
  options?: {
    generateSegmentedOverlay?: boolean;
    generateIntermediateMasks?: boolean;
  },
): Promise<{
  blocks: BeginLayoutBlock[];
  rawWidth: number;
  rawHeight: number;
  aspectRatio: number;
  normWidth: number;
  normHeight: number;
  scaleX: number;
  scaleY: number;
  segmentedPngBuffer?: Buffer;
  maskOverlayPngBuffer?: Buffer;
  diagnostics?: {
    avatarFound: boolean;
    avatarConfidence?: number;
    primaryTextFound: boolean;
    menuFound: boolean;
    statusSummary?: string;
    edgePixelCount?: number;
    rawComponentCount?: number;
    filteredComponentCount?: number;
    intermediateBounds?: {
      avatar?: Rect;
      menu?: Rect;
      textZone?: Rect;
    };
  };
}> {
  const meta = await sharp(imageBuffer).metadata();
  const rawWidth = meta.width || 560;
  const rawHeight = meta.height || 60;
  const aspectRatio = rawWidth / Math.max(1, rawHeight);

  // Preserve aspect ratio with standardized working height
  const normHeight = NORM_H;
  const normWidth = Math.max(MIN_NORM_W, Math.min(MAX_NORM_W, Math.round(normHeight * aspectRatio)));
  const scaleX = Math.round((normWidth / Math.max(1, rawWidth)) * 10000) / 10000;
  const scaleY = Math.round((normHeight / Math.max(1, rawHeight)) * 10000) / 10000;

  // Extract grayscale raw pixels
  const { data: pixels } = await sharp(imageBuffer)
    .grayscale()
    .resize(normWidth, normHeight, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 1. Edge/Gradient thresholding
  const edgeMask = new Uint8Array(normWidth * normHeight);
  let edgePixelCount = 0;
  for (let y = 1; y < normHeight - 1; y++) {
    const rowOffset = y * normWidth;
    for (let x = 1; x < normWidth - 1; x++) {
      const idx = rowOffset + x;
      const dx = Math.abs(pixels[idx + 1]! - pixels[idx - 1]!);
      const dy = Math.abs(pixels[idx + normWidth]! - pixels[idx - normWidth]!);
      if (dx + dy >= 20) {
        edgeMask[idx] = 1;
        edgePixelCount++;
      }
    }
  }

  // 2. STAGE A: Avatar / Image-Region Detection (Left Zone: 0 .. 22% width)
  const leftZoneMaxX = Math.round(normWidth * 0.22);
  const leftEdgeMask = new Uint8Array(normWidth * normHeight);
  for (let y = 0; y < normHeight; y++) {
    for (let x = 0; x <= leftZoneMaxX; x++) {
      const idx = y * normWidth + x;
      if (edgeMask[idx] === 1) leftEdgeMask[idx] = 1;
    }
  }

  // Consolidate avatar shape with local morphological dilation
  const closedLeftMask = new Uint8Array(normWidth * normHeight);
  const avRad = 3;
  for (let y = 0; y < normHeight; y++) {
    const yMin = Math.max(0, y - avRad);
    const yMax = Math.min(normHeight - 1, y + avRad);
    for (let x = 0; x <= leftZoneMaxX; x++) {
      const xMin = Math.max(0, x - avRad);
      const xMax = Math.min(leftZoneMaxX, x + avRad);
      let found = false;
      for (let ny = yMin; ny <= yMax && !found; ny++) {
        const offset = ny * normWidth;
        for (let nx = xMin; nx <= xMax; nx++) {
          if (leftEdgeMask[offset + nx] === 1) {
            found = true;
            break;
          }
        }
      }
      if (found) closedLeftMask[y * normWidth + x] = 1;
    }
  }

  // Connected components in left zone
  const leftVisited = new Uint8Array(normWidth * normHeight);
  const leftComponents: RawComponent[] = [];
  for (let y = 0; y < normHeight; y++) {
    for (let x = 0; x <= leftZoneMaxX; x++) {
      const idx = y * normWidth + x;
      if (closedLeftMask[idx] === 1 && leftVisited[idx] === 0) {
        let cXmin = x;
        let cXmax = x;
        let cYmin = y;
        let cYmax = y;
        let pixelCount = 0;
        const queue = [idx];
        leftVisited[idx] = 1;
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

          const neighbors = [
            cy > 0 ? curr - normWidth : -1,
            cy < normHeight - 1 ? curr + normWidth : -1,
            cx > 0 ? curr - 1 : -1,
            cx < leftZoneMaxX ? curr + 1 : -1,
          ];
          for (const n of neighbors) {
            if (n >= 0 && closedLeftMask[n] === 1 && leftVisited[n] === 0) {
              leftVisited[n] = 1;
              queue.push(n);
            }
          }
        }
        const w = cXmax - cXmin + 1;
        const h = cYmax - cYmin + 1;
        if (w >= 10 && h >= 10) {
          leftComponents.push({ xMin: cXmin, yMin: cYmin, xMax: cXmax, yMax: cYmax, pixelCount });
        }
      }
    }
  }

  // Find best avatar candidate in left components (leftmost candidate first)
  leftComponents.sort((a, b) => a.xMin - b.xMin);
  let avatarBlock: BeginLayoutBlock | null = null;
  let avatarMaskBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null = null;

  for (const comp of leftComponents) {
    const compW = comp.xMax - comp.xMin + 1;
    const compH = comp.yMax - comp.yMin + 1;
    const relX = comp.xMin / normWidth;
    const relH = compH / normHeight;
    const aspect = compW / Math.max(1, compH);
    const cy = (comp.yMin + comp.yMax) / 2;

    // Avatar criteria:
    // - Starts near left edge (relX <= 0.09)
    // - Substantial vertical height for post header avatar (52% to 95% of container)
    // - Approximately square / circle aspect ratio (0.65 to 1.45)
    // - Vertically roughly centered (0.15 <= cy / normHeight <= 0.85)
    if (
      relX <= 0.09 &&
      relH >= 0.52 &&
      relH <= 0.98 &&
      aspect >= 0.65 &&
      aspect <= 1.45 &&
      cy >= normHeight * 0.15 &&
      cy <= normHeight * 0.85
    ) {
      let conf = 0.70;
      if (relX <= 0.08) conf += 0.15;
      if (aspect >= 0.85 && aspect <= 1.15) conf += 0.10;
      if (relH >= 0.50 && relH <= 0.90) conf += 0.05;

      avatarBlock = {
        id: "blk_avatar",
        type: "image_avatar",
        normalizedBounds: {
          x: Math.round((comp.xMin / normWidth) * 1000) / 1000,
          y: Math.round((comp.yMin / normHeight) * 1000) / 1000,
          width: Math.round((compW / normWidth) * 1000) / 1000,
          height: Math.round((compH / normHeight) * 1000) / 1000,
        },
        rawBounds: {
          x: Math.round((comp.xMin / normWidth) * rawWidth),
          y: Math.round((comp.yMin / normHeight) * rawHeight),
          width: Math.max(4, Math.round((compW / normWidth) * rawWidth)),
          height: Math.max(4, Math.round((compH / normHeight) * rawHeight)),
        },
        processingBounds: {
          x: comp.xMin,
          y: comp.yMin,
          width: compW,
          height: compH,
        },
        aspectRatio: Math.round(aspect * 100) / 100,
        density: Math.round((comp.pixelCount / Math.max(1, compW * compH)) * 100) / 100,
        confidence: Math.min(0.99, Math.round(conf * 100) / 100),
        required: true,
        label: "IMAGE AVATAR",
      };

      avatarMaskBounds = {
        xMin: Math.max(0, comp.xMin - 2),
        xMax: Math.min(normWidth - 1, comp.xMax + 4),
        yMin: Math.max(0, comp.yMin - 2),
        yMax: Math.min(normHeight - 1, comp.yMax + 2),
      };
      break;
    }
  }

  // 3. STAGE B: Action Menu Detection & Clustering (Right Zone: 70..100% width)
  const rightZoneMinX = Math.round(normWidth * 0.70);
  const rightComponents: RawComponent[] = [];
  const rightVisited = new Uint8Array(normWidth * normHeight);

  for (let y = 0; y < normHeight; y++) {
    for (let x = rightZoneMinX; x < normWidth; x++) {
      const idx = y * normWidth + x;
      if (edgeMask[idx] === 1 && rightVisited[idx] === 0) {
        let cXmin = x;
        let cXmax = x;
        let cYmin = y;
        let cYmax = y;
        let pixelCount = 0;
        const queue = [idx];
        rightVisited[idx] = 1;
        let head = 0;
        while (head < queue.length) {
          const curr = queue[head++]!;
          const cy = Math.floor(curr / normWidth);
          const cx = curr % normWidth;
          if (cx < cXmin) cXmin = cx;
          if (cx > cXmax) cXmax = cx;
          if (cy < cYmin) cYmin = cy;
          if (cy > cYmax) cYmax = cy;
          pixelCount++;

          const neighbors = [
            cy > 0 ? curr - normWidth : -1,
            cy < normHeight - 1 ? curr + normWidth : -1,
            cx > rightZoneMinX ? curr - 1 : -1,
            cx < normWidth - 1 ? curr + 1 : -1,
          ];
          for (const n of neighbors) {
            if (n >= 0 && edgeMask[n] === 1 && rightVisited[n] === 0) {
              rightVisited[n] = 1;
              queue.push(n);
            }
          }
        }
        const w = cXmax - cXmin + 1;
        const h = cYmax - cYmin + 1;
        if (w >= 2 && h >= 2) {
          rightComponents.push({ xMin: cXmin, yMin: cYmin, xMax: cXmax, yMax: cYmax, pixelCount });
        }
      }
    }
  }

  // Cluster nearby right-side components into a single menu cluster (prevents 2+ menu blocks from 3-dots)
  let menuBlock: BeginLayoutBlock | null = null;
  let menuMaskBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null = null;

  if (rightComponents.length > 0) {
    rightComponents.sort((a, b) => a.xMin - b.xMin);
    let mXmin = rightComponents[0]!.xMin;
    let mXmax = rightComponents[0]!.xMax;
    let mYmin = rightComponents[0]!.yMin;
    let mYmax = rightComponents[0]!.yMax;
    let mPixels = rightComponents[0]!.pixelCount;

    for (let i = 1; i < rightComponents.length; i++) {
      const c = rightComponents[i]!;
      const gapX = c.xMin - mXmax;
      const cyDiff = Math.abs((c.yMin + c.yMax) / 2 - (mYmin + mYmax) / 2);
      if (gapX <= 16 && cyDiff <= 12) {
        mXmin = Math.min(mXmin, c.xMin);
        mXmax = Math.max(mXmax, c.xMax);
        mYmin = Math.min(mYmin, c.yMin);
        mYmax = Math.max(mYmax, c.yMax);
        mPixels += c.pixelCount;
      }
    }

    const mW = mXmax - mXmin + 1;
    const mH = mYmax - mYmin + 1;
    const relX = mXmin / normWidth;
    const relW = mW / normWidth;
    const relH = mH / normHeight;
    const relY = mYmin / normHeight;

    if (relX >= 0.70 && relW <= 0.25 && relH <= 0.50 && relY <= 0.65) {
      menuBlock = {
        id: "blk_menu",
        type: "action_menu",
        normalizedBounds: {
          x: Math.round((mXmin / normWidth) * 1000) / 1000,
          y: Math.round((mYmin / normHeight) * 1000) / 1000,
          width: Math.round((mW / normWidth) * 1000) / 1000,
          height: Math.round((mH / normHeight) * 1000) / 1000,
        },
        rawBounds: {
          x: Math.round((mXmin / normWidth) * rawWidth),
          y: Math.round((mYmin / normHeight) * rawHeight),
          width: Math.max(4, Math.round((mW / normWidth) * rawWidth)),
          height: Math.max(4, Math.round((mH / normHeight) * rawHeight)),
        },
        processingBounds: {
          x: mXmin,
          y: mYmin,
          width: mW,
          height: mH,
        },
        aspectRatio: Math.round((mW / Math.max(1, mH)) * 100) / 100,
        density: Math.round((mPixels / Math.max(1, mW * mH)) * 100) / 100,
        confidence: 0.90,
        required: false,
        label: "ACTION MENU",
      };

      menuMaskBounds = {
        xMin: Math.max(0, mXmin - 3),
        xMax: Math.min(normWidth - 1, mXmax + 3),
        yMin: Math.max(0, mYmin - 2),
        yMax: Math.min(normHeight - 1, mYmax + 2),
      };
    }
  }

  // 4. STAGE C: Masking & Text / Layout Segmentation (Strictly Unmasked Area)
  const textEdgeMask = new Uint8Array(normWidth * normHeight);
  for (let y = 0; y < normHeight; y++) {
    for (let x = 0; x < normWidth; x++) {
      const idx = y * normWidth + x;
      if (edgeMask[idx] === 0) continue;

      // Mask out Avatar
      if (
        avatarMaskBounds &&
        x >= avatarMaskBounds.xMin &&
        x <= avatarMaskBounds.xMax &&
        y >= avatarMaskBounds.yMin &&
        y <= avatarMaskBounds.yMax
      ) {
        continue;
      }

      // Mask out Action Menu
      if (
        menuMaskBounds &&
        x >= menuMaskBounds.xMin &&
        x <= menuMaskBounds.xMax &&
        y >= menuMaskBounds.yMin &&
        y <= menuMaskBounds.yMax
      ) {
        continue;
      }

      textEdgeMask[idx] = 1;
    }
  }

  // Morphological horizontal dilation on unmasked text zone (hRad=5, vRad=1)
  const closedTextMask = new Uint8Array(normWidth * normHeight);
  const textHRad = 5;
  const textVRad = 1;

  for (let y = 0; y < normHeight; y++) {
    const yMin = Math.max(0, y - textVRad);
    const yMax = Math.min(normHeight - 1, y + textVRad);
    for (let x = 0; x < normWidth; x++) {
      const xMin = Math.max(0, x - textHRad);
      const xMax = Math.min(normWidth - 1, x + textHRad);
      let found = false;
      for (let ny = yMin; ny <= yMax && !found; ny++) {
        const offset = ny * normWidth;
        for (let nx = xMin; nx <= xMax; nx++) {
          if (textEdgeMask[offset + nx] === 1) {
            found = true;
            break;
          }
        }
      }
      if (found) closedTextMask[y * normWidth + x] = 1;
    }
  }

  // Extract connected components in unmasked text area
  const textVisited = new Uint8Array(normWidth * normHeight);
  const rawTextComps: RawComponent[] = [];

  for (let y = 0; y < normHeight; y++) {
    for (let x = 0; x < normWidth; x++) {
      const idx = y * normWidth + x;
      if (closedTextMask[idx] === 1 && textVisited[idx] === 0) {
        let cXmin = x;
        let cXmax = x;
        let cYmin = y;
        let cYmax = y;
        let pixelCount = 0;
        const queue = [idx];
        textVisited[idx] = 1;
        let head = 0;
        while (head < queue.length) {
          const curr = queue[head++]!;
          const cy = Math.floor(curr / normWidth);
          const cx = curr % normWidth;
          if (cx < cXmin) cXmin = cx;
          if (cx > cXmax) cXmax = cx;
          if (cy < cYmin) cYmin = cy;
          if (cy > cYmax) cYmax = cy;
          if (textEdgeMask[curr] === 1) pixelCount++;

          const neighbors = [
            cy > 0 ? curr - normWidth : -1,
            cy < normHeight - 1 ? curr + normWidth : -1,
            cx > 0 ? curr - 1 : -1,
            cx < normWidth - 1 ? curr + 1 : -1,
          ];
          for (const n of neighbors) {
            if (n >= 0 && closedTextMask[n] === 1 && textVisited[n] === 0) {
              textVisited[n] = 1;
              queue.push(n);
            }
          }
        }
        const w = cXmax - cXmin + 1;
        const h = cYmax - cYmin + 1;
        if (w >= 8 || h >= 6) {
          rawTextComps.push({ xMin: cXmin, yMin: cYmin, xMax: cXmax, yMax: cYmax, pixelCount });
        }
      }
    }
  }

  // Safe horizontal fragment merging on aligned lines
  rawTextComps.sort((a, b) => a.xMin - b.xMin);
  const mergedTextComps: RawComponent[] = [];

  for (const comp of rawTextComps) {
    let merged = false;
    for (const existing of mergedTextComps) {
      const cy1 = (comp.yMin + comp.yMax) / 2;
      const cy2 = (existing.yMin + existing.yMax) / 2;
      const sameLine = Math.abs(cy1 - cy2) <= 4;
      const horizontalGap = Math.max(0, comp.xMin - existing.xMax);

      // Do not merge across large gap (> 14px) or if resulting width exceeds 75% of normWidth
      if (sameLine && horizontalGap <= 14 && comp.xMax - existing.xMin < normWidth * 0.75) {
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
      mergedTextComps.push({ ...comp });
    }
  }

  // Sort text components vertically (top line first)
  mergedTextComps.sort((a, b) => a.yMin - b.yMin);

  const textBlocks: BeginLayoutBlock[] = [];
  let blockCounter = 1;

  for (let i = 0; i < mergedTextComps.length; i++) {
    const c = mergedTextComps[i]!;
    const w = c.xMax - c.xMin + 1;
    const h = c.yMax - c.yMin + 1;
    const rx = c.xMin / normWidth;
    const ry = c.yMin / normHeight;
    const rw = w / normWidth;
    const rh = h / normHeight;
    const aspect = w / Math.max(1, h);

    let type: BeginLayoutBlockType = "generic_block";
    let conf = 0.8;
    let required = false;

    // Normal text line criteria (requires genuine stroke density, not hollow box outlines)
    const density = Math.round((c.pixelCount / Math.max(1, w * h)) * 100) / 100;
    if (rh <= 0.48 && (aspect >= 1.5 || rw >= 0.08) && density >= 0.12) {
      if (i === 0 && ry <= 0.50) {
        type = "primary_text";
        conf = 0.92;
        required = true;
      } else {
        type = "secondary_text";
        conf = 0.86;
        required = false;
      }
    } else if (rw >= 0.45 && rh >= 0.45) {
      // Wide block covering multiple rows (composer input pill or media)
      type = "generic_block";
      conf = 0.75;
      required = false;
    }

    textBlocks.push({
      id: `blk_${blockCounter++}_${type}`,
      type,
      normalizedBounds: {
        x: Math.round(rx * 1000) / 1000,
        y: Math.round(ry * 1000) / 1000,
        width: Math.round(rw * 1000) / 1000,
        height: Math.round(rh * 1000) / 1000,
      },
      rawBounds: {
        x: Math.round(rx * rawWidth),
        y: Math.round(ry * rawHeight),
        width: Math.max(4, Math.round(rw * rawWidth)),
        height: Math.max(4, Math.round(rh * rawHeight)),
      },
      processingBounds: {
        x: c.xMin,
        y: c.yMin,
        width: w,
        height: h,
      },
      aspectRatio: Math.round(aspect * 100) / 100,
      density,
      confidence: conf,
      required,
      label: type.replace("_", " ").toUpperCase(),
    });
  }

  // 5. Assemble all detected blocks
  const finalBlocks: BeginLayoutBlock[] = [];
  if (avatarBlock) finalBlocks.push(avatarBlock);
  finalBlocks.push(...textBlocks);
  if (menuBlock) finalBlocks.push(menuBlock);

  // Sort blocks left-to-right, then top-to-bottom
  finalBlocks.sort((a, b) => a.normalizedBounds.x - b.normalizedBounds.x || a.normalizedBounds.y - b.normalizedBounds.y);

  // Diagnostics summary
  const avatarFound = Boolean(avatarBlock);
  const primaryTextFound = finalBlocks.some((b) => b.type === "primary_text");
  const menuFound = Boolean(menuBlock);

  const statusSummary =
    avatarFound && primaryTextFound && menuFound
      ? "STANDARD_HEADER_DETECTED"
      : avatarFound && primaryTextFound
        ? "HEADER_NO_MENU"
        : primaryTextFound
          ? "TEXT_ONLY_HEADER"
          : "NON_STANDARD_LAYOUT";

  const diagnostics = {
    avatarFound,
    avatarConfidence: avatarBlock?.confidence,
    primaryTextFound,
    menuFound,
    statusSummary,
    edgePixelCount,
    rawComponentCount: leftComponents.length + rightComponents.length + rawTextComps.length,
    filteredComponentCount: finalBlocks.length,
    intermediateBounds: {
      avatar: avatarBlock ? avatarBlock.rawBounds : undefined,
      menu: menuBlock ? menuBlock.rawBounds : undefined,
      textZone: {
        x: avatarBlock ? (avatarBlock.rawBounds?.x ?? 0) + (avatarBlock.rawBounds?.width ?? 0) : 0,
        y: 0,
        width: menuBlock
          ? (menuBlock.rawBounds?.x ?? rawWidth) -
            (avatarBlock ? (avatarBlock.rawBounds?.x ?? 0) + (avatarBlock.rawBounds?.width ?? 0) : 0)
          : rawWidth,
        height: rawHeight,
      },
    },
  };

  // 6. Optional: Generate segmented visual overlay on original reference crop
  let segmentedPngBuffer: Buffer | undefined;
  if (options?.generateSegmentedOverlay) {
    try {
      const svgElements = finalBlocks
        .map((b) => {
          const bx = b.rawBounds?.x ?? Math.round(b.normalizedBounds.x * rawWidth);
          const by = b.rawBounds?.y ?? Math.round(b.normalizedBounds.y * rawHeight);
          const bw = Math.max(4, b.rawBounds?.width ?? Math.round(b.normalizedBounds.width * rawWidth));
          const bh = Math.max(4, b.rawBounds?.height ?? Math.round(b.normalizedBounds.height * rawHeight));
          const color = getBlockColor(b.type);
          const label =
            b.type === "image_avatar"
              ? "AVATAR"
              : b.type === "primary_text"
                ? "AUTHOR"
                : b.type === "secondary_text"
                  ? "TIMESTAMP"
                  : b.type === "action_menu"
                    ? "MENU"
                    : "BLOCK";

          return `
            <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2" rx="2" />
            <rect x="${bx}" y="${Math.max(0, by - 12)}" width="${Math.min(bw, 54)}" height="12" fill="${color}" rx="1" />
            <text x="${bx + 2}" y="${Math.max(0, by - 12) + 9}" font-family="sans-serif" font-size="8" font-weight="bold" fill="#ffffff">${label}</text>
          `;
        })
        .join("");

      const svg = `<svg width="${rawWidth}" height="${rawHeight}" xmlns="http://www.w3.org/2000/svg">${svgElements}</svg>`;
      segmentedPngBuffer = await sharp(imageBuffer)
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer();
    } catch {
      segmentedPngBuffer = undefined;
    }
  }

  // 7. Optional: Generate intermediate mask visualization overlay
  let maskOverlayPngBuffer: Buffer | undefined;
  if (options?.generateIntermediateMasks) {
    try {
      const maskSvgParts: string[] = [];

      // Background dim
      maskSvgParts.push(`<rect width="${rawWidth}" height="${rawHeight}" fill="#0f172a" fill-opacity="0.25" />`);

      // Avatar Mask
      if (avatarMaskBounds) {
        const ax = Math.round((avatarMaskBounds.xMin / normWidth) * rawWidth);
        const ay = Math.round((avatarMaskBounds.yMin / normHeight) * rawHeight);
        const aw = Math.round(((avatarMaskBounds.xMax - avatarMaskBounds.xMin + 1) / normWidth) * rawWidth);
        const ah = Math.round(((avatarMaskBounds.yMax - avatarMaskBounds.yMin + 1) / normHeight) * rawHeight);
        maskSvgParts.push(`
          <rect x="${ax}" y="${ay}" width="${aw}" height="${ah}" fill="#8b5cf6" fill-opacity="0.35" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="3 3" rx="3" />
          <text x="${ax + 4}" y="${ay + 14}" font-family="sans-serif" font-size="9" font-weight="bold" fill="#ffffff">AVATAR MASK</text>
        `);
      }

      // Menu Mask
      if (menuMaskBounds) {
        const mx = Math.round((menuMaskBounds.xMin / normWidth) * rawWidth);
        const my = Math.round((menuMaskBounds.yMin / normHeight) * rawHeight);
        const mw = Math.round(((menuMaskBounds.xMax - menuMaskBounds.xMin + 1) / normWidth) * rawWidth);
        const mh = Math.round(((menuMaskBounds.yMax - menuMaskBounds.yMin + 1) / normHeight) * rawHeight);
        maskSvgParts.push(`
          <rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="#f59e0b" fill-opacity="0.35" stroke="#f59e0b" stroke-width="2" stroke-dasharray="3 3" rx="2" />
          <text x="${Math.max(0, mx - 50)}" y="${my + 14}" font-family="sans-serif" font-size="9" font-weight="bold" fill="#ffffff">MENU MASK</text>
        `);
      }

      // Text Search Zone
      const tzX = avatarMaskBounds ? Math.round(((avatarMaskBounds.xMax + 1) / normWidth) * rawWidth) : 0;
      const tzEndX = menuMaskBounds ? Math.round((menuMaskBounds.xMin / normWidth) * rawWidth) : rawWidth;
      const tzW = Math.max(10, tzEndX - tzX);
      maskSvgParts.push(`
        <rect x="${tzX}" y="2" width="${tzW}" height="${rawHeight - 4}" fill="#0284c7" fill-opacity="0.08" stroke="#0284c7" stroke-width="1.5" stroke-dasharray="4 4" rx="2" />
        <text x="${tzX + 8}" y="${Math.round(rawHeight / 2)}" font-family="sans-serif" font-size="10" font-weight="bold" fill="#38bdf8" opacity="0.8">UNMASKED TEXT ZONE</text>
      `);

      const maskSvg = `<svg width="${rawWidth}" height="${rawHeight}" xmlns="http://www.w3.org/2000/svg">${maskSvgParts.join("")}</svg>`;
      maskOverlayPngBuffer = await sharp(imageBuffer)
        .composite([{ input: Buffer.from(maskSvg) }])
        .png()
        .toBuffer();
    } catch {
      maskOverlayPngBuffer = undefined;
    }
  }

  return {
    blocks: finalBlocks,
    rawWidth,
    rawHeight,
    aspectRatio,
    normWidth,
    normHeight,
    scaleX,
    scaleY,
    segmentedPngBuffer,
    maskOverlayPngBuffer,
    diagnostics,
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
        const isCore = t === "image_avatar" || t === "primary_text" || t === "action_menu";
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
          rawBounds: {
            x: Math.round(meanX * avgW),
            y: Math.round(meanY * avgH),
            width: Math.max(1, Math.round(meanW * avgW)),
            height: Math.max(1, Math.round(meanH * avgH)),
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
  const inputReferenceCount = referenceCrops.length;
  const validRefs = referenceCrops.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);
  const skippedRefs = referenceCrops.filter((r) => !r.imageBuffer || r.imageBuffer.length === 0);
  const skipReasons = skippedRefs.map((r) => ({
    sampleId: r.sampleId,
    regionId: r.regionId,
    reason: r.error || "Reference image buffer empty or unreadable",
  }));

  console.info(
    `[B3 V2 Pipeline Stage 3] matchBeginBlockLayout: Input=${inputReferenceCount}, Valid=${validRefs.length}, Skipped=${skippedRefs.length}`,
  );

  if (validRefs.length === 0) {
    return {
      testedAt: new Date().toISOString(),
      technique: "B3_V2_BLOCK_LEVEL_MATCHING",
      referenceSampleIds: [],
      referenceBeginCount: 0,
      inputReferenceCount,
      validReferenceCount: 0,
      skippedReferenceCount: skippedRefs.length,
      skipReasons,
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
        pipelineSummary:
          inputReferenceCount === 0
            ? "No BEGIN references provided"
            : `All ${inputReferenceCount} reference(s) skipped: ${skipReasons.map((s) => s.reason).join("; ")}`,
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
      inputReferenceCount,
      validReferenceCount: validRefs.length,
      skippedReferenceCount: skippedRefs.length,
      skipReasons,
      variantCount: 0,
      status: "NO_REFERENCES",
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
        pipelineSummary: `References available (${validRefs.length}) but failed to extract any valid layout blocks`,
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
    inputReferenceCount,
    validReferenceCount: validRefs.length,
    skippedReferenceCount: skippedRefs.length,
    skipReasons,
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
        const seg = await extractBeginBlocks(ref.imageBuffer, {
          generateSegmentedOverlay: true,
          generateIntermediateMasks: true,
        });
        const originalCropDataUrl =
          ref.originalDataUrl ||
          `data:image/png;base64,${(await sharp(ref.imageBuffer).png().toBuffer()).toString("base64")}`;

        const segmentedCropDataUrl = seg.segmentedPngBuffer
          ? `data:image/png;base64,${seg.segmentedPngBuffer.toString("base64")}`
          : originalCropDataUrl;

        const maskOverlayDataUrl = seg.maskOverlayPngBuffer
          ? `data:image/png;base64,${seg.maskOverlayPngBuffer.toString("base64")}`
          : undefined;

        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: seg.rawWidth, height: seg.rawHeight },
          processingDimensions: { width: seg.normWidth, height: seg.normHeight },
          scaleFactors: { scaleX: seg.scaleX, scaleY: seg.scaleY },
          aspectRatio: Math.round(seg.aspectRatio * 100) / 100,
          processingAspectRatio: Math.round((seg.normWidth / Math.max(1, seg.normHeight)) * 100) / 100,
          originalCropDataUrl,
          segmentedCropDataUrl,
          maskOverlayDataUrl,
          blocks: seg.blocks,
          diagnostics: seg.diagnostics,
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
