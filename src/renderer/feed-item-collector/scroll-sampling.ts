import type { BoundaryProbeResult } from "../../shared/boundary-probe";
import { distance } from "../experiments/visual-match-lab/LiveScrollTest";
import type {
  LiveCandidate,
  FrameCandidateCounts,
  CandidatePostIdentity,
  FrameReport,
} from "./types";

/** Total scroll distance per Step: 400 px */
export const TOTAL_STEP_SCROLL_PX = 400;

/** Base scroll unit: 100 px */
export const BASE_SCROLL_UNIT_PX = 100;

/** Split ratios: 1/3 (100+300), 2/2 (200+200), 3/1 (300+100) */
export type ScrollSplitRatio = "1/3" | "2/2" | "3/1";

export const SCROLL_SPLIT_MAP: Record<ScrollSplitRatio, [number, number]> = {
  "1/3": [100, 300],
  "2/2": [200, 200],
  "3/1": [300, 100],
};

export interface ScrollSamplingSplit {
  ratio: ScrollSplitRatio;
  firstDelta: number;
  secondDelta: number;
  totalDelta: number;
}

export function calculateSplitDeltas(ratio: ScrollSplitRatio): ScrollSamplingSplit {
  const [firstDelta, secondDelta] = SCROLL_SPLIT_MAP[ratio];
  return {
    ratio,
    firstDelta,
    secondDelta,
    totalDelta: firstDelta + secondDelta,
  };
}

export function pickScrollSplit(rng: () => number = Math.random): ScrollSamplingSplit {
  const ratios: ScrollSplitRatio[] = ["1/3", "2/2", "3/1"];
  const ratio = ratios[Math.floor(rng() * ratios.length)] ?? "2/2";
  return calculateSplitDeltas(ratio);
}

export interface ScrollProgressCheck {
  intendedDelta: number;
  actualDelta: number;
  priorScrollY: number;
  currentScrollY: number;
  moved: boolean;
  stoppedReason?: "SCROLL_DID_NOT_MOVE" | "REACHED_PAGE_END";
}

export function evaluateScrollProgress(
  priorScrollY: number | null,
  currentScrollY: number,
  intendedDelta: number,
): ScrollProgressCheck {
  if (priorScrollY === null) {
    return {
      intendedDelta,
      actualDelta: intendedDelta,
      priorScrollY: currentScrollY,
      currentScrollY,
      moved: true,
    };
  }

  const actualDelta = currentScrollY - priorScrollY;
  const moved = actualDelta > 0;
  return {
    intendedDelta,
    actualDelta,
    priorScrollY,
    currentScrollY,
    moved,
    stoppedReason: moved ? undefined : "SCROLL_DID_NOT_MOVE",
  };
}

/**
 * Extracts verified post identity strictly from the candidate container level (below boundaryCrossedLevel).
 * Never takes feed/neighbor URLs, and rejects non-post URLs like /groups/{groupId}/?__cft__...
 */
export function extractCandidatePostIdentity(
  boundary: BoundaryProbeResult | undefined,
): CandidatePostIdentity | undefined {
  if (!boundary) return undefined;

  const crossedLevel = boundary.boundaryCrossedLevel ?? Infinity;

  // 1. Check ancestorSteps strictly below boundaryCrossedLevel
  for (const step of boundary.ancestorSteps ?? []) {
    if (step.level >= crossedLevel) continue; // Exclude feed/neighbor levels
    if (step.postIdentities && step.postIdentities.length > 0) {
      for (const p of step.postIdentities) {
        if (p.postId && p.postId.trim()) {
          return {
            platform: p.platform,
            postId: p.postId,
            scope: p.scope,
            canonicalUrl: p.canonicalUrl,
            rawUrl: p.rawUrl,
          };
        }
      }
    }
  }

  // 2. If single post identity in boundary and boundary status is FOUND
  if (
    boundary.status === "BOUNDARY_FOUND" &&
    boundary.postIdentities &&
    boundary.postIdentities.length === 1
  ) {
    const p = boundary.postIdentities[0]!;
    if (p.postId && p.postId.trim()) {
      return {
        platform: p.platform,
        postId: p.postId,
        scope: p.scope,
        canonicalUrl: p.canonicalUrl,
        rawUrl: p.rawUrl,
      };
    }
  }

  return undefined;
}

/**
 * Computes counts of candidates per sample: FOUND, NEEDS_ATTENTION, DUPLICATE.
 */
export function computeFrameCandidateCounts(candidates: LiveCandidate[]): FrameCandidateCounts {
  let found = 0;
  let needsAttention = 0;
  let duplicate = 0;

  for (const c of candidates) {
    if (c.dedupeStatus === "DUPLICATE" || c.status === "DUPLICATE") {
      duplicate++;
    } else if (c.boundaryStatus === "BOUNDARY_FOUND" || c.status === "NEW_ITEM") {
      found++;
    } else {
      needsAttention++;
    }
  }

  return { found, needsAttention, duplicate, total: candidates.length };
}

/**
 * Derives the overall frame boundary status based on all candidate outcomes.
 * A frame cannot be BOUNDARY_FOUND if all active candidates are NEEDS_ATTENTION.
 */
export function deriveFrameBoundaryStatus(
  candidates: LiveCandidate[],
): FrameReport["boundaryStatus"] {
  if (candidates.length === 0) return "NO_ACTION_ROW";
  const counts = computeFrameCandidateCounts(candidates);
  if (counts.found > 0 && counts.needsAttention === 0) return "BOUNDARY_FOUND";
  if (counts.found > 0 && counts.needsAttention > 0) return "BOUNDARY_AMBIGUOUS";
  if (counts.found === 0 && counts.needsAttention > 0) return "BOUNDARY_NOT_FOUND";
  // If all candidates are duplicates
  return candidates.some((c) => c.boundaryStatus === "BOUNDARY_FOUND")
    ? "BOUNDARY_FOUND"
    : "BOUNDARY_NOT_FOUND";
}

/**
 * Evaluates a single candidate against seen candidates using the 3-tier priority:
 * 1. Same verified post identity -> DUPLICATE
 * 2. Overlapping action row (docY diff <= 70, fp distance <= 18) -> DUPLICATE
 * 3. Suspicious overlap without post ID (docY diff <= 120, fp distance <= 24) -> POSSIBLE_DUPLICATE (kept as NEEDS_ATTENTION)
 * 4. Otherwise -> NEW_ITEM (FOUND or NEEDS_ATTENTION)
 */
export function dedupeSingleCandidate(
  cand: LiveCandidate,
  allSeen: LiveCandidate[],
  docYThreshold = 70,
  distanceThreshold = 18,
): LiveCandidate {
  for (const seen of allSeen) {
    // Tier 1: Verified Post ID match
    if (
      cand.postIdentity?.postId &&
      seen.postIdentity?.postId &&
      cand.postIdentity.postId === seen.postIdentity.postId
    ) {
      return {
        ...cand,
        dedupeStatus: "DUPLICATE",
        status: "DUPLICATE",
        duplicateOfCandidateId: seen.candidateId,
        dedupeReason: `POST_IDENTITY_MATCH: postId=${cand.postIdentity.postId} trùng với candidate #${seen.candidateId}`,
      };
    }

    // Tier 2: Action row visual and positional overlap across frames
    const isDocYNear = Math.abs(seen.docY - cand.docY) <= docYThreshold;
    const isFpNear = distance(seen.fingerprint, cand.fingerprint) <= distanceThreshold;
    if (isDocYNear && isFpNear) {
      return {
        ...cand,
        dedupeStatus: "DUPLICATE",
        status: "DUPLICATE",
        duplicateOfCandidateId: seen.candidateId,
        dedupeReason: `OVERLAPPING_ACTION_ROW: docY diff ${Math.abs(seen.docY - cand.docY)}px <= ${docYThreshold}px, fp dist ${distance(seen.fingerprint, cand.fingerprint)} <= ${distanceThreshold}`,
      };
    }

    // Tier 3: Suspicious overlap without verified post ID
    // If visual distance is close and vertical distance in plausible overlap, flag as POSSIBLE_DUPLICATE
    // but keep as a separate candidate with status NEEDS_ATTENTION
    if (
      !cand.postIdentity?.postId &&
      !seen.postIdentity?.postId &&
      Math.abs(seen.docY - cand.docY) <= 120 &&
      distance(seen.fingerprint, cand.fingerprint) <= 24
    ) {
      return {
        ...cand,
        dedupeStatus: "POSSIBLE_DUPLICATE",
        status: "NEEDS_ATTENTION",
        duplicateOfCandidateId: seen.candidateId,
        dedupeReason: "POSSIBLE_DUPLICATE: nghi trùng nhưng chưa đủ bằng chứng permalink (giữ riêng NEEDS_ATTENTION)",
      };
    }
  }

  // Tier 4: New unique candidate
  return {
    ...cand,
    dedupeStatus: "NEW_ITEM",
    status: cand.boundaryStatus === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION",
  };
}

export interface DedupeResult {
  merged: LiveCandidate[];
  duplicateCount: number;
  possibleDuplicateCount: number;
}

/**
 * Deduplicate candidates from two captures in the same step against each other and against seen items.
 */
export function dedupeCandidates(
  firstCandidates: LiveCandidate[],
  secondCandidates: LiveCandidate[],
  seenCandidates: LiveCandidate[] = [],
  docYThreshold = 70,
  distanceThreshold = 18,
): DedupeResult {
  const merged: LiveCandidate[] = [];
  const allSeen: LiveCandidate[] = [...seenCandidates];
  let duplicateCount = 0;
  let possibleDuplicateCount = 0;

  for (const rawCand of firstCandidates) {
    const cand = dedupeSingleCandidate(rawCand, allSeen, docYThreshold, distanceThreshold);
    if (cand.dedupeStatus === "DUPLICATE") {
      duplicateCount++;
    } else if (cand.dedupeStatus === "POSSIBLE_DUPLICATE") {
      possibleDuplicateCount++;
      allSeen.push(cand);
    } else {
      allSeen.push(cand);
    }
    merged.push(cand);
  }

  for (const rawCand of secondCandidates) {
    const cand = dedupeSingleCandidate(rawCand, allSeen, docYThreshold, distanceThreshold);
    if (cand.dedupeStatus === "DUPLICATE") {
      duplicateCount++;
    } else if (cand.dedupeStatus === "POSSIBLE_DUPLICATE") {
      possibleDuplicateCount++;
      allSeen.push(cand);
    } else {
      allSeen.push(cand);
    }
    merged.push(cand);
  }

  return { merged, duplicateCount, possibleDuplicateCount };
}
