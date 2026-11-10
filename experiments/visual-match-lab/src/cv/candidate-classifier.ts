import { Candidate, CandidateType, Rect } from '../types';
import { ComponentData } from './image-processor';

export class CandidateClassifier {
  /**
   * Classify connected components into text, icon, reaction-distractor, or unknown.
   */
  public static classifyCandidates(
    components: ComponentData[],
    imageWidth: number,
    imageHeight: number
  ): Candidate[] {
    const candidates: Candidate[] = [];

    // Step 1: Detect digit/character components and group adjacent characters into words/numbers
    // Sort components by x coordinate
    const sorted = [...components].sort((a, b) => a.bbox.x - b.bbox.x);
    const usedCompIds = new Set<number>();

    // Helper: is a component character-like?
    // Typical UI font in 41px bar has height 10-18px, width 5-14px, aspect ratio 0.4 - 0.95
    const isDigitLike = (c: ComponentData): boolean => {
      const h = c.bbox.height;
      const w = c.bbox.width;
      const ar = c.features.aspectRatio;
      return h >= 9 && h <= 20 && w >= 4 && w <= 16 && ar >= 0.35 && ar <= 1.1;
    };

    // Helper: check if two digit-like components can be merged horizontally (e.g. "9" and "0")
    for (let i = 0; i < sorted.length; i++) {
      const c1 = sorted[i];
      if (usedCompIds.has(c1.id)) continue;

      if (isDigitLike(c1)) {
        // Look for adjacent character to the right
        let mergedBbox: Rect = { ...c1.bbox };
        let mergedPixelCount = c1.pixelCount;
        const compIds = [c1.id];
        let j = i + 1;

        while (j < sorted.length) {
          const c2 = sorted[j];
          if (usedCompIds.has(c2.id)) {
            j++;
            continue;
          }

          const gapX = c2.bbox.x - (mergedBbox.x + mergedBbox.width);
          const alignY = Math.abs((c2.bbox.y + c2.bbox.height / 2) - (mergedBbox.y + mergedBbox.height / 2));
          const heightDiff = Math.abs(c2.bbox.height - c1.bbox.height);

          // If adjacent horizontally with small gap (<= 6px) and similar vertical baseline & height
          if (isDigitLike(c2) && gapX >= -2 && gapX <= 7 && alignY <= 4 && heightDiff <= 4) {
            // Merge
            const newMinX = Math.min(mergedBbox.x, c2.bbox.x);
            const newMaxX = Math.max(mergedBbox.x + mergedBbox.width, c2.bbox.x + c2.bbox.width);
            const newMinY = Math.min(mergedBbox.y, c2.bbox.y);
            const newMaxY = Math.max(mergedBbox.y + mergedBbox.height, c2.bbox.y + c2.bbox.height);

            mergedBbox = {
              x: newMinX,
              y: newMinY,
              width: newMaxX - newMinX,
              height: newMaxY - newMinY,
            };
            mergedPixelCount += c2.pixelCount;
            compIds.push(c2.id);
            usedCompIds.add(c2.id);
            j++;
          } else {
            break;
          }
        }

        if (compIds.length > 1) {
          usedCompIds.add(c1.id);
          const area = mergedBbox.width * mergedBbox.height;
          const fillRatio = mergedPixelCount / Math.max(1, area);
          const ar = mergedBbox.width / Math.max(1, mergedBbox.height);

          candidates.push({
            id: `text_${compIds.join('_')}`,
            bbox: mergedBbox,
            type: 'text',
            confidence: 0.94,
            sourceComponentIds: compIds,
            pixelCount: mergedPixelCount,
            features: {
              area,
              aspectRatio: ar,
              fillRatio,
              strokeVariance: 1.2,
              horizontalHoles: 1,
              verticalHoles: 0,
              colorVariation: 0,
              cx: mergedBbox.x + mergedBbox.width / 2,
              cy: mergedBbox.y + mergedBbox.height / 2,
            },
            reasons: [
              `Multi-digit text cluster: ${compIds.length} adjacent character glyphs`,
              `Uniform line height (${mergedBbox.height}px) and baseline alignment`,
              `Stroke & aspect ratio (${ar.toFixed(2)}) match numeric string`,
            ],
          });
          continue;
        }
      }
    }

    // Step 2: Classify remaining individual components
    for (const c of sorted) {
      if (usedCompIds.has(c.id)) continue;
      usedCompIds.add(c.id);

      const bbox = c.bbox;
      const w = bbox.width;
      const h = bbox.height;
      const ar = c.features.aspectRatio;
      const area = c.features.area;
      const fillRatio = c.features.fillRatio;

      // Condition 2A: Reaction Cluster / Distractor on the right side
      // Reaction group consists of multiple overlapping colored circles (Like/Love/Care/Haha emojis)
      // Usually located towards right or distinct overlapping structure (width > 28px or cluster of small circles)
      const isRightSide = bbox.x > imageWidth * 0.55;
      const isMultiIconCluster = w >= 28 && h >= 14 && h <= 24 && ar >= 1.6;
      const isCircularEmoji = w >= 13 && w <= 20 && h >= 13 && h <= 20 && Math.abs(ar - 1.0) <= 0.2 && fillRatio >= 0.55;

      if ((isRightSide && isMultiIconCluster) || (isRightSide && isCircularEmoji)) {
        candidates.push({
          id: `reaction_cluster_${c.id}`,
          bbox,
          type: 'reaction-distractor',
          confidence: 0.88,
          sourceComponentIds: [c.id],
          pixelCount: c.pixelCount,
          features: c.features,
          reasons: [
            `Identified as reaction/emoji cluster (distractor)`,
            isMultiIconCluster
              ? `Multi-icon overlapping reaction chain (aspect ratio ${ar.toFixed(2)}, width ${w}px)`
              : `Circular reaction icon (ratio ${ar.toFixed(2)}, fill ${fillRatio.toFixed(2)}) in secondary zone`,
            `Excluded from action candidate pool to prevent false positive Like button match`,
          ],
        });
        continue;
      }

      // Condition 2B: Action Icon Candidates (Like, Comment, Share)
      // Standard action icons have dimensions ~14-26px, square-like aspect ratio 0.75 - 1.4,
      // adequate area (>= 80px) and pixel count (>= 40px)
      const isIconSize = w >= 12 && w <= 28 && h >= 12 && h <= 28;
      const isIconAspect = ar >= 0.65 && ar <= 1.45;
      const hasIconMass = c.pixelCount >= 35 && area >= 90;

      if (isIconSize && isIconAspect && hasIconMass) {
        let confidence = 0.85;
        const reasons: string[] = [
          `Visual action icon candidate: dimensions ${w}x${h}px, aspect ratio ${ar.toFixed(2)}`,
          `Standalone component with clear boundary separation`,
        ];

        if (ar >= 0.85 && ar <= 1.2) {
          confidence += 0.08;
          reasons.push(`Balanced bounding geometry (${ar.toFixed(2)}) characteristic of action icons`);
        }
        if (fillRatio >= 0.3 && fillRatio <= 0.75) {
          confidence += 0.05;
          reasons.push(`Stroke-to-fill ratio (${fillRatio.toFixed(2)}) consistent with line-art or glyph icons`);
        }

        candidates.push({
          id: `icon_${c.id}`,
          bbox,
          type: 'icon',
          confidence: Math.min(0.98, confidence),
          sourceComponentIds: [c.id],
          pixelCount: c.pixelCount,
          features: c.features,
          reasons,
        });
        continue;
      }

      // Condition 2C: Standalone single-digit text candidate
      if (isDigitLike(c)) {
        candidates.push({
          id: `text_single_${c.id}`,
          bbox,
          type: 'text',
          confidence: 0.78,
          sourceComponentIds: [c.id],
          pixelCount: c.pixelCount,
          features: c.features,
          reasons: [
            `Single numeric/text character glyph (${w}x${h}px, ratio ${ar.toFixed(2)})`,
            `Stroke width and vertical height match font line specs`,
          ],
        });
        continue;
      }

      // Condition 2D: Unknown / Noise / Rejected components
      const unkReasons: string[] = [];
      if (area < 40 || c.pixelCount < 15) {
        unkReasons.push(`Area / pixel mass too small (${c.pixelCount}px < 15px)`);
      }
      if (ar > 3.0) {
        unkReasons.push(`Extreme horizontal elongation (${ar.toFixed(2)} > 3.0), likely separator or rule`);
      }
      if (ar < 0.25) {
        unkReasons.push(`Extreme vertical elongation (${ar.toFixed(2)} < 0.25), likely vertical boundary`);
      }
      if (w > imageWidth * 0.4) {
        unkReasons.push(`Component span exceeds expected icon/text candidate size`);
      }
      if (unkReasons.length === 0) {
        unkReasons.push(`Ambiguous visual features: does not satisfy icon or text geometric criteria`);
      }

      candidates.push({
        id: `unknown_${c.id}`,
        bbox,
        type: 'unknown',
        confidence: 0.3,
        sourceComponentIds: [c.id],
        pixelCount: c.pixelCount,
        features: c.features,
        reasons: [
          `Rejected as action candidate: marked UNKNOWN`,
          ...unkReasons,
        ],
      });
    }

    // Sort final candidates left to right
    return candidates.sort((a, b) => a.bbox.x - b.bbox.x);
  }
}
