import { Candidate, RecognizedGroup, RecognizedGroupItem, Rect } from '../types';

export class GroupRecognizer {
  /**
   * Recognize interaction clusters (e.g. Like-Comment-Share) based on spatial relationships.
   */
  public static recognizeGroups(
    candidates: Candidate[],
    imageWidth: number,
    imageHeight: number
  ): RecognizedGroup[] {
    const groups: RecognizedGroup[] = [];

    const iconCandidates = candidates.filter((c) => c.type === 'icon');
    const textCandidates = candidates.filter((c) => c.type === 'text');
    const reactionDistractors = candidates.filter((c) => c.type === 'reaction-distractor');

    // Step 1: Form [Icon, Text] pairs based on spatial proximity
    const pairedItems: RecognizedGroupItem[] = [];
    const usedTextIds = new Set<string>();

    for (const icon of iconCandidates) {
      // Find closest text candidate immediately to the right of this icon
      const iconRight = icon.bbox.x + icon.bbox.width;
      const iconCenterY = icon.bbox.y + icon.bbox.height / 2;

      let bestText: Candidate | undefined;
      let minGap = Infinity;

      for (const text of textCandidates) {
        if (usedTextIds.has(text.id)) continue;
        const textLeft = text.bbox.x;
        const textCenterY = text.bbox.y + text.bbox.height / 2;

        const gapX = textLeft - iconRight;
        const offsetCenterY = Math.abs(textCenterY - iconCenterY);

        // Text should be to the right of icon, within reasonable distance (3 to 28px)
        // and vertically aligned (offset <= 6px)
        if (gapX >= 2 && gapX <= 32 && offsetCenterY <= 6) {
          if (gapX < minGap) {
            minGap = gapX;
            bestText = text;
          }
        }
      }

      if (bestText) {
        usedTextIds.add(bestText.id);
        pairedItems.push({
          iconCandidate: icon,
          textCandidate: bestText,
          horizontalGap: minGap,
        });
      } else {
        pairedItems.push({
          iconCandidate: icon,
          textCandidate: undefined,
          horizontalGap: 0,
        });
      }
    }

    // Step 2: Cluster adjacent paired units into interaction action sequences
    if (pairedItems.length >= 2) {
      // Sort items by icon x position
      pairedItems.sort((a, b) => a.iconCandidate.bbox.x - b.iconCandidate.bbox.x);

      // Group consecutive items if their inter-item distances and baselines are consistent
      let currentCluster: RecognizedGroupItem[] = [pairedItems[0]];

      for (let i = 1; i < pairedItems.length; i++) {
        const prev = currentCluster[currentCluster.length - 1];
        const curr = pairedItems[i];

        const prevEnd = prev.textCandidate
          ? prev.textCandidate.bbox.x + prev.textCandidate.bbox.width
          : prev.iconCandidate.bbox.x + prev.iconCandidate.bbox.width;
        const currStart = curr.iconCandidate.bbox.x;

        const interUnitGap = currStart - prevEnd;
        const alignY = Math.abs(
          curr.iconCandidate.bbox.y + curr.iconCandidate.bbox.height / 2 -
            (prev.iconCandidate.bbox.y + prev.iconCandidate.bbox.height / 2)
        );

        // In action bars, units are distributed with gap typically between 8px and 120px
        // with strict vertical alignment (< 5px)
        if (interUnitGap >= 6 && interUnitGap <= 140 && alignY <= 5) {
          currentCluster.push(curr);
        } else {
          // Finish previous cluster if large enough
          if (currentCluster.length >= 2) {
            groups.push(this.createGroupFromItems(currentCluster, imageWidth));
          }
          currentCluster = [curr];
        }
      }

      if (currentCluster.length >= 2) {
        groups.push(this.createGroupFromItems(currentCluster, imageWidth));
      }
    }

    // Step 3: Analyze Distractor Group (Reaction cluster) and document rejection reason
    if (reactionDistractors.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const d of reactionDistractors) {
        minX = Math.min(minX, d.bbox.x);
        minY = Math.min(minY, d.bbox.y);
        maxX = Math.max(maxX, d.bbox.x + d.bbox.width);
        maxY = Math.max(maxY, d.bbox.y + d.bbox.height);
      }
      const distractorBbox: Rect = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };

      groups.push({
        id: 'distractor_reaction_cluster',
        bbox: distractorBbox,
        items: reactionDistractors.map((d) => ({
          iconCandidate: d,
          textCandidate: undefined,
          horizontalGap: 0,
        })),
        pattern: 'Distractor Reaction Cluster',
        isActionGroup: false,
        confidence: 0.1,
        reasons: [
          'REJECTED as Like-Comment-Share action group',
          'Geometry: tight multi-symbol cluster without alternating [Icon -> Number] unit separation',
          'Location: in post metadata/summary area rather than primary interaction bar',
          'Preserved as visual reference for negative distractor filtering',
        ],
      });
    }

    return groups;
  }

  private static createGroupFromItems(items: RecognizedGroupItem[], imageWidth: number): RecognizedGroup {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const item of items) {
      minX = Math.min(minX, item.iconCandidate.bbox.x);
      minY = Math.min(minY, item.iconCandidate.bbox.y);

      const rightX = item.textCandidate
        ? item.textCandidate.bbox.x + item.textCandidate.bbox.width
        : item.iconCandidate.bbox.x + item.iconCandidate.bbox.width;
      const bottomY = item.textCandidate
        ? Math.max(item.iconCandidate.bbox.y + item.iconCandidate.bbox.height, item.textCandidate.bbox.y + item.textCandidate.bbox.height)
        : item.iconCandidate.bbox.y + item.iconCandidate.bbox.height;

      maxX = Math.max(maxX, rightX);
      maxY = Math.max(maxY, bottomY);
    }

    const hasNumbers = items.filter((it) => it.textCandidate !== undefined).length;
    const isClassicTrio = items.length === 3;
    let confidence = 0.8;

    const reasons: string[] = [
      `Formed interaction chain of ${items.length} units with collinear horizontal alignment`,
    ];

    if (hasNumbers === items.length) {
      confidence += 0.12;
      reasons.push(`Strict alternating [Icon -> Count] pattern confirmed across all ${items.length} units`);
    } else if (hasNumbers > 0) {
      confidence += 0.06;
      reasons.push(`Partial [Icon -> Count] pattern (${hasNumbers}/${items.length} units have numeric counters)`);
    }

    if (isClassicTrio) {
      confidence += 0.06;
      reasons.push(`Matches standard 3-action cluster topology (Like, Comment, Share)`);
    }

    const patternDesc = items
      .map((it) => (it.textCandidate ? '[Icon + Num]' : '[Icon]'))
      .join(' ── ');

    return {
      id: `action_group_${Date.now()}_${items.length}`,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      items,
      pattern: patternDesc,
      isActionGroup: true,
      confidence: Math.min(0.99, confidence),
      reasons,
    };
  }
}
