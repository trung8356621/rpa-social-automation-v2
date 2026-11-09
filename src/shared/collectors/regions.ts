/**
 * C2.8 — Static / Dynamic Region Architecture & DOM Discovery Foundation
 *
 * Generic, reusable engine for:
 * - Defining and matching STATIC anchors (header, footer, actions, etc.)
 * - Locating corresponding live/snapshotted DOM elements
 * - Finding and verifying the common Post Container
 * - Rejecting cross-post mismatches and oversized feed ancestors
 * - Extracting DYNAMIC HTML subtrees
 * - HTML filtering into structured candidate values
 *
 * Zero platform-specific hardcoding: works uniformly for Facebook, Threads, Reddit, YouTube, forums.
 */
import type { OcrResult, Rect } from "../contracts.js";
import type {
  AnchorMatchDetail,
  CollectorDomElement,
  CollectorDomSnapshot,
  CollectorDraft,
  CollectorExtractionMethod,
  CollectorRegion,
  CollectorRegionRole,
  CollectorRegionType,
  CollectorVariable,
  CollectorVariableMapping,
  DomElementEvidence,
  DynamicHtmlExtractionResult,
  LayoutContextKind,
  MatchedPostItem,
  MatchTestResult,
  MatchTestStatus,
  NormalizedRegionGeometry,
  PostGroupMatch,
  RegionRelationship,
  VerifiedPostContainer,
  GroupTagSuggestion,
  GroupTagSuggestionKind,
  LearnedAnchorRule,
  LearnedAnchorGroup,
  AnchorReferenceExample,
  StableGeometryProfile,
  QuickFillProposal,
  QuickFillResult,
} from "./types.js";
import { cryptoRandomId } from "./fixtures.js";
import {
  isAuthorCandidate,
  isEngagementText,
  isTimestampText,
  normalizeVietnameseText,
} from "./ocr-learning.js";

// ---------------------------------------------------------------------------
// 1. GEOMETRY HELPERS
// ---------------------------------------------------------------------------

export function normalizeGeometry(
  box: Rect,
  imageWidth: number,
  imageHeight: number,
): NormalizedRegionGeometry {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  return {
    relX: Math.max(0, Math.min(1, box.x / w)),
    relY: Math.max(0, Math.min(1, box.y / h)),
    relW: Math.max(0, Math.min(1, box.width / w)),
    relH: Math.max(0, Math.min(1, box.height / h)),
  };
}

export function denormalizeGeometry(
  geom: NormalizedRegionGeometry,
  imageWidth: number,
  imageHeight: number,
): Rect {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  return {
    x: Math.round(geom.relX * w),
    y: Math.round(geom.relY * h),
    width: Math.round(geom.relW * w),
    height: Math.round(geom.relH * h),
  };
}

export function calculateIoU(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * Resolves a region's pixel crop box against source image dimensions.
 * Handles legacy regions lacking originalRoi by denormalizing normalized geometry.
 * Clamps coordinates to stay within image boundaries.
 */
export function resolveRegionCropBox(
  region: CollectorRegion,
  imageWidth: number,
  imageHeight: number,
): { box?: Rect; error?: string } {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { error: "Invalid image dimensions." };
  }
  let box = region.originalRoi;
  if (!box || box.width <= 0 || box.height <= 0) {
    if (region.geometry && region.geometry.relW > 0 && region.geometry.relH > 0) {
      box = denormalizeGeometry(region.geometry, imageWidth, imageHeight);
    }
  }
  if (!box || box.width <= 0 || box.height <= 0) {
    return { error: "Invalid region bounds." };
  }
  const clampedX = Math.max(0, Math.min(imageWidth - 1, box.x));
  const clampedY = Math.max(0, Math.min(imageHeight - 1, box.y));
  const clampedW = Math.max(1, Math.min(imageWidth - clampedX, box.width));
  const clampedH = Math.max(1, Math.min(imageHeight - clampedY, box.height));

  return {
    box: {
      x: Math.round(clampedX),
      y: Math.round(clampedY),
      width: Math.round(clampedW),
      height: Math.round(clampedH),
    },
  };
}

// ---------------------------------------------------------------------------
// 2. REGION CRUD & TEACHING MODEL
// ---------------------------------------------------------------------------

function defaultLabelForType(type: CollectorRegionType, groupTag?: string): string {
  switch (type) {
    case "BEGIN":
      return groupTag ? `${groupTag} Begin` : "Begin Anchor";
    case "END":
      return groupTag ? `${groupTag} End` : "End Anchor";
    case "FREE":
      return "Free Region";
    case "STATIC":
      return "Static Anchor";
    case "DYNAMIC":
      return "Dynamic Content";
    default:
      return "Region";
  }
}

function defaultRoleForType(type: CollectorRegionType): CollectorRegionRole {
  switch (type) {
    case "BEGIN":
      return "header";
    case "END":
      return "footer";
    case "FREE":
      return "custom";
    case "STATIC":
      return "header";
    case "DYNAMIC":
      return "content";
    default:
      return "custom";
  }
}

export function createCollectorRegion(opts: {
  id?: string;
  captureItemId: string;
  type: CollectorRegionType;
  label: string;
  groupTag?: string;
  role?: CollectorRegionRole;
  box: Rect;
  imageWidth: number;
  imageHeight: number;
  candidateVariableKeys?: string[];
  relationships?: RegionRelationship[];
  confirmed?: boolean;
  simulatedProposal?: boolean;
  domEvidence?: DomElementEvidence;
  ocr?: OcrResult;
  ocrText?: string;
  ocrConfidence?: number;
  referenceImage?: string;
  referenceImageAsset?: string;
}): CollectorRegion {
  const now = new Date().toISOString();
  const rawTag = opts.groupTag?.trim();
  const groupTag =
    opts.type === "BEGIN" || opts.type === "END"
      ? rawTag || "default"
      : opts.type === "FREE"
        ? undefined
        : rawTag || undefined;

  return {
    id: opts.id || cryptoRandomId(),
    captureItemId: opts.captureItemId,
    type: opts.type,
    label: opts.label.trim() || defaultLabelForType(opts.type, groupTag),
    role: opts.role ?? defaultRoleForType(opts.type),
    groupTag,
    geometry: normalizeGeometry(opts.box, opts.imageWidth, opts.imageHeight),
    originalRoi: opts.box,
    candidateVariableKeys: opts.candidateVariableKeys ?? [],
    confirmed: opts.confirmed ?? false,
    simulatedProposal: opts.simulatedProposal,
    domEvidence: opts.domEvidence,
    relationships: opts.relationships ?? [],
    ocr: opts.ocr,
    ocrEvidence: opts.ocrText
      ? {
          text: opts.ocrText,
          confidence: opts.ocrConfidence ?? 90,
        }
      : opts.ocr?.text
        ? {
            text: opts.ocr.text,
            confidence: opts.ocr.confidence ?? 90,
          }
        : undefined,
    referenceImage: opts.referenceImage,
    referenceImageAsset: opts.referenceImageAsset,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeCollectorRegion(r: CollectorRegion): CollectorRegion {
  if (r.type === "BEGIN" || r.type === "END") {
    return {
      ...r,
      groupTag: r.groupTag?.trim() || "default",
    };
  }
  if (r.type === "FREE") {
    return {
      ...r,
      groupTag: undefined,
    };
  }
  if (r.type === "STATIC") {
    if (r.role === "footer" || r.label.toLowerCase().includes("footer") || r.label.toLowerCase().includes("end")) {
      return {
        ...r,
        type: "END",
        groupTag: r.groupTag?.trim() || "default",
      };
    }
    if (r.role === "header" || r.label.toLowerCase().includes("header") || r.label.toLowerCase().includes("begin")) {
      return {
        ...r,
        type: "BEGIN",
        groupTag: r.groupTag?.trim() || "default",
      };
    }
    return {
      ...r,
      type: "FREE",
      groupTag: undefined,
    };
  }
  if (r.type === "DYNAMIC") {
    return {
      ...r,
      type: "FREE",
      groupTag: undefined,
    };
  }
  return r;
}

export function normalizeCollectorRegions(regions: CollectorRegion[]): CollectorRegion[] {
  return (regions ?? []).map(normalizeCollectorRegion);
}

export type AnchorGroupVerificationResult = {
  valid: boolean;
  errors: string[];
  groups: Map<
    string,
    {
      groupTag: string;
      begin?: CollectorRegion;
      end?: CollectorRegion;
      allRegions: CollectorRegion[];
      error?: string;
    }
  >;
  freeRegions: CollectorRegion[];
};

export function verifyAnchorGroups(
  rawRegions: CollectorRegion[],
): AnchorGroupVerificationResult {
  const groups = new Map<
    string,
    {
      groupTag: string;
      begin?: CollectorRegion;
      end?: CollectorRegion;
      allRegions: CollectorRegion[];
      error?: string;
    }
  >();
  const freeRegions: CollectorRegion[] = [];
  const errors: string[] = [];

  for (const r of rawRegions) {
    if (r.type === "FREE") {
      freeRegions.push(r);
      continue;
    }
    if (r.type === "DYNAMIC") {
      freeRegions.push(r);
      continue;
    }

    const tag = (r.groupTag ?? (r.type === "STATIC" ? "default" : "")).trim() || "default";

    let entry = groups.get(tag);
    if (!entry) {
      entry = { groupTag: tag, allRegions: [] };
      groups.set(tag, entry);
    }
    entry.allRegions.push(r);

    const isBegin =
      r.type === "BEGIN" ||
      (r.type === "STATIC" && (r.role === "header" || r.label.toLowerCase().includes("header")));
    const isEnd =
      r.type === "END" ||
      (r.type === "STATIC" && (r.role === "footer" || r.label.toLowerCase().includes("footer")));

    if (isBegin) {
      if (entry.begin) {
        const err = `Group "${tag}" is ambiguous: multiple BEGIN anchors defined.`;
        entry.error = err;
        if (!errors.includes(err)) errors.push(err);
      } else {
        entry.begin = r;
      }
    } else if (isEnd) {
      if (entry.end) {
        const err = `Group "${tag}" is ambiguous: multiple END anchors defined.`;
        entry.error = err;
        if (!errors.includes(err)) errors.push(err);
      } else {
        entry.end = r;
      }
    } else if (r.type === "STATIC") {
      if (!entry.begin) {
        entry.begin = r;
      } else if (!entry.end) {
        entry.end = r;
      }
    }
  }

  for (const [tag, g] of groups.entries()) {
    if (!g.begin) {
      const err = `Group "${tag}" is incomplete: missing BEGIN anchor.`;
      g.error = g.error ? `${g.error} ${err}` : err;
      if (!errors.includes(err)) errors.push(err);
    }
    if (!g.end) {
      const err = `Group "${tag}" is incomplete: missing END anchor.`;
      g.error = g.error ? `${g.error} ${err}` : err;
      if (!errors.includes(err)) errors.push(err);
    }
  }

  if (groups.size === 0 && rawRegions.length > 0) {
    errors.push(
      "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags to discover post containers.",
    );
  }

  return {
    valid: errors.length === 0 && groups.size > 0,
    errors,
    groups,
    freeRegions,
  };
}

/**
 * C2.11: Propose existing and contextual group tags for editable combobox.
 *
 * Requirements:
 * 1. Suggest existing group tags from across the Collector.
 * 2. When creating END, prioritize groups with BEGIN but missing END in the current sample.
 * 3. When creating BEGIN, suggest previously used group names from other samples.
 * 4. Distinct kinds for existing linked groups vs creating a new group.
 * 5. FREE must not require a group tag.
 * 6. Preserves existing tags and saved data.
 */
export function getGroupTagSuggestions(
  draft: CollectorDraft,
  currentCaptureId: string,
  regionType: CollectorRegionType,
  currentInput: string = "",
): GroupTagSuggestion[] {
  if (regionType === "FREE") return [];

  const allRegions: CollectorRegion[] = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ];

  const regionMap = new Map<string, CollectorRegion>();
  for (const r of allRegions) {
    if (!regionMap.has(r.id)) regionMap.set(r.id, r);
  }
  const uniqueRegions = Array.from(regionMap.values());

  const tagStats = new Map<
    string,
    {
      sampleIds: Set<string>;
      hasBeginInSample: boolean;
      hasEndInSample: boolean;
    }
  >();

  for (const r of uniqueRegions) {
    if (r.type === "FREE") continue;
    const tag = r.groupTag?.trim();
    if (!tag) continue;

    let stat = tagStats.get(tag);
    if (!stat) {
      stat = {
        sampleIds: new Set<string>(),
        hasBeginInSample: false,
        hasEndInSample: false,
      };
      tagStats.set(tag, stat);
    }
    stat.sampleIds.add(r.captureItemId);

    if (r.captureItemId === currentCaptureId) {
      if (
        r.type === "BEGIN" ||
        (r.type === "STATIC" &&
          (r.role === "header" ||
            r.label.toLowerCase().includes("begin") ||
            r.label.toLowerCase().includes("header")))
      ) {
        stat.hasBeginInSample = true;
      }
      if (
        r.type === "END" ||
        (r.type === "STATIC" &&
          (r.role === "footer" ||
            r.label.toLowerCase().includes("end") ||
            r.label.toLowerCase().includes("footer")))
      ) {
        stat.hasEndInSample = true;
      }
    }
  }

  const query = currentInput.trim().toLowerCase();
  const suggestions: GroupTagSuggestion[] = [];

  for (const [tag, stat] of tagStats.entries()) {
    if (query && !tag.toLowerCase().includes(query)) continue;

    let kind: GroupTagSuggestionKind = "existing_group";
    let label = tag;

    if (regionType === "END" && stat.hasBeginInSample && !stat.hasEndInSample) {
      kind = "unpaired_in_sample";
      label = `${tag} (Needs END anchor)`;
    } else if (regionType === "BEGIN" && stat.sampleIds.size > 0 && !stat.sampleIds.has(currentCaptureId)) {
      kind = "other_sample";
      const count = stat.sampleIds.size;
      label = `${tag} (Used in ${count} other sample${count > 1 ? "s" : ""})`;
    }

    suggestions.push({
      tag,
      kind,
      label,
      hasBeginInSample: stat.hasBeginInSample,
      hasEndInSample: stat.hasEndInSample,
      sampleCount: stat.sampleIds.size,
    });
  }

  suggestions.sort((a, b) => {
    if (regionType === "END") {
      if (a.kind === "unpaired_in_sample" && b.kind !== "unpaired_in_sample") return -1;
      if (b.kind === "unpaired_in_sample" && a.kind !== "unpaired_in_sample") return 1;
    }
    if (regionType === "BEGIN") {
      if (a.kind === "other_sample" && b.kind !== "other_sample") return -1;
      if (b.kind === "other_sample" && a.kind !== "other_sample") return 1;
    }
    return a.tag.localeCompare(b.tag);
  });

  const exactMatchExists = Array.from(tagStats.keys()).some((t) => t.toLowerCase() === query);
  if (query && !exactMatchExists) {
    suggestions.unshift({
      tag: currentInput.trim(),
      kind: "create_new",
      label: `Create new group "${currentInput.trim()}"`,
      sampleCount: 0,
    });
  }

  return suggestions;
}

/**
 * ARCHITECTURAL CONTRACT — FUTURE LIVE BROWSER MATCH TEST:
 * Not called during Step 2 Reference Teaching.
 *
 * For a vertically ordered BEGIN/END pair matched in the live browser:
 * dynamicStartY = matchedBegin.y + matchedBegin.height;
 * dynamicEndY = matchedEnd.y;
 *
 * These are coordinates of anchors matched in the live browser,
 * NOT automatically the coordinates of the teaching screenshot.
 */
export function computeMatchedDynamicBounds(
  matchedBegin: Rect,
  matchedEnd: Rect,
  containerWidth?: number,
): { dynamicStartY: number; dynamicEndY: number; height: number; bounds: Rect } {
  const dynamicStartY = matchedBegin.y + matchedBegin.height;
  const dynamicEndY = matchedEnd.y;
  const height = Math.max(0, dynamicEndY - dynamicStartY);
  const x = Math.min(matchedBegin.x, matchedEnd.x);
  const width = containerWidth
    ? Math.max(1, containerWidth - x)
    : Math.max(matchedBegin.width, matchedEnd.width);

  return {
    dynamicStartY,
    dynamicEndY,
    height,
    bounds: {
      x,
      y: dynamicStartY,
      width,
      height,
    },
  };
}

export type DerivedReferenceCrop = {
  crop: Rect;
  groupTag: string;
  source: "anchor_group" | "legacy_static";
};

/**
 * Derive screenshot crop bounds directly from configured visual anchors.
 * Completely decoupled from live DOM verification.
 */
export function deriveReferenceCropFromAnchors(
  rawRegions: CollectorRegion[],
  imageWidth: number,
  imageHeight: number,
  targetGroupTag?: string,
): DerivedReferenceCrop | null {
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  const analysis = verifyAnchorGroups(rawRegions);

  // 1. Complete anchor group matching
  const candidateGroups = targetGroupTag
    ? [analysis.groups.get(targetGroupTag)].filter(Boolean)
    : Array.from(analysis.groups.values());

  for (const group of candidateGroups) {
    if (group && group.begin && group.end) {
      const bBox = denormalizeGeometry(group.begin.geometry, w, h);
      const eBox = denormalizeGeometry(group.end.geometry, w, h);
      const minX = Math.max(0, Math.min(bBox.x, eBox.x));
      const minY = Math.max(0, Math.min(bBox.y, eBox.y));
      const maxX = Math.min(w, Math.max(bBox.x + bBox.width, eBox.x + eBox.width));
      const maxY = Math.min(h, Math.max(bBox.y + bBox.height, eBox.y + eBox.height));
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const isLegacy = group.begin.type === "STATIC" && group.end.type === "STATIC";
      return {
        crop: { x: minX, y: minY, width, height },
        groupTag: group.groupTag,
        source: isLegacy ? "legacy_static" : "anchor_group",
      };
    }
  }

  // 2. Fallback: Legacy STATIC regions
  const staticRegions = rawRegions.filter((r) => r.type === "STATIC");
  if (staticRegions.length > 0) {
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    for (const r of staticRegions) {
      const box = denormalizeGeometry(r.geometry, w, h);
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    const cropX = Math.max(0, Math.min(w - 1, minX));
    const cropY = Math.max(0, Math.min(h - 1, minY));
    const cropW = Math.max(1, Math.min(w - cropX, maxX - cropX));
    const cropH = Math.max(1, Math.min(h - cropY, maxY - cropY));
    return {
      crop: { x: cropX, y: cropY, width: cropW, height: cropH },
      groupTag: "legacy",
      source: "legacy_static",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. STATIC ANCHOR MATCHING (Image #1 Reference -> Image #2+ Proposals)
// ---------------------------------------------------------------------------

/**
 * Propose learned static anchors on target capture using confirmed reference examples.
 * Never guesses without confirmed references. Never automatically learns from unconfirmed guesses.
 */
export function matchLearnedRegions(
  targetCaptureId: string,
  referenceRegions: CollectorRegion[],
  targetOcrText: string = "",
  imageWidth: number = 800,
  imageHeight: number = 1000,
): CollectorRegion[] {
  // Filter confirmed anchors from teaching references (BEGIN, END, FREE, STATIC)
  const confirmedAnchors = referenceRegions.filter(
    (r) => (r.type === "BEGIN" || r.type === "END" || r.type === "FREE" || r.type === "STATIC") && r.confirmed,
  );
  if (!confirmedAnchors.length) return [];

  // Group confirmed references by tag+type or role or label
  const roleGroups = new Map<string, CollectorRegion[]>();
  for (const r of confirmedAnchors) {
    const key = `${r.type}_${r.groupTag || ""}_${r.role || r.label}`;
    const group = roleGroups.get(key) ?? [];
    group.push(r);
    roleGroups.set(key, group);
  }

  const proposedRegions: CollectorRegion[] = [];
  const normalizedTargetText = normalizeVietnameseText(targetOcrText);

  for (const [key, refs] of roleGroups.entries()) {
    const latestRef = refs[refs.length - 1]!;
    const geom = latestRef.geometry;

    // Check if target text contains any anchor tokens from reference
    let textScore = 0;
    let textEvidence = "";
    if (latestRef.ocrEvidence?.text) {
      const refTokens = normalizeVietnameseText(latestRef.ocrEvidence.text)
        .split(/\s+/)
        .filter((t) => t.length > 2);
      const matchCount = refTokens.filter((token) => normalizedTargetText.includes(token)).length;
      if (refTokens.length > 0 && matchCount > 0) {
        textScore = Math.min(30, Math.round((matchCount / refTokens.length) * 30));
        textEvidence = `matched ${matchCount}/${refTokens.length} anchor tokens`;
      }
    }

    // Geometry proximity score (starts high for normalized position)
    const posScore = 60;
    const confidence = Math.min(95, posScore + textScore);

    const now = new Date().toISOString();
    proposedRegions.push({
      id: cryptoRandomId(),
      captureItemId: targetCaptureId,
      type: latestRef.type,
      label: latestRef.label,
      role: latestRef.role,
      groupTag: latestRef.groupTag,
      geometry: { ...geom },
      originalRoi: denormalizeGeometry(geom, imageWidth, imageHeight),
      candidateVariableKeys: [...latestRef.candidateVariableKeys],
      confirmed: false,
      simulatedProposal: true,
      confidence,
      evidence: `Learned anchor (${latestRef.type}${latestRef.groupTag ? `:${latestRef.groupTag}` : ""}) matched with ${confidence}% confidence${
        textEvidence ? ` [${textEvidence}]` : ""
      }.`,
      relationships: latestRef.relationships ? [...latestRef.relationships] : [],
      createdAt: now,
      updatedAt: now,
    });
  }

  return proposedRegions;
}

// ---------------------------------------------------------------------------
// 4. DOM CORRESPONDENCE (Map visual region coordinates to DOM elements)
// ---------------------------------------------------------------------------

/**
 * Projects a visual region onto a DOM snapshot and finds the best corresponding DOM element.
 * Accounts for screenshot ROI, scroll position, and text correspondence.
 */
export function mapRegionToDomElement(
  region: CollectorRegion,
  snapshot: CollectorDomSnapshot,
  imageWidth: number,
  imageHeight: number,
  imageRoi?: Rect,
): {
  matchedElement: CollectorDomElement | null;
  confidence: number;
  evidence: string;
  rejectionReason?: string;
  stale?: boolean;
} {
  if (!snapshot || !snapshot.elements.length) {
    return {
      matchedElement: null,
      confidence: 0,
      evidence: "No DOM elements in snapshot.",
      rejectionReason: "DOM snapshot empty",
    };
  }

  if (snapshot.isStale) {
    return {
      matchedElement: null,
      confidence: 0,
      evidence: "DOM snapshot belongs to a different URL or outdated page state.",
      rejectionReason: "Stale page state",
      stale: true,
    };
  }

  // 1. Calculate region pixel coordinates on the image
  const visualBox = denormalizeGeometry(region.geometry, imageWidth, imageHeight);

  // 2. Project visual box to page/viewport DOM coordinates
  // If screenshot was cropped from ROI: visual coordinates are relative to ROI
  const offsetX = imageRoi ? imageRoi.x : 0;
  const offsetY = imageRoi ? imageRoi.y : 0;
  const projectedDomBox: Rect = {
    x: offsetX + visualBox.x,
    y: offsetY + visualBox.y,
    width: visualBox.width,
    height: visualBox.height,
  };

  // 3. Find candidate elements that overlap with projected box
  const candidates: Array<{
    el: CollectorDomElement;
    score: number;
    iou: number;
    textOverlap: number;
    reason: string;
  }> = [];

  const regionNormalizedText = region.ocrEvidence?.text
    ? normalizeVietnameseText(region.ocrEvidence.text)
    : "";

  for (const el of snapshot.elements) {
    if (el.rect.width <= 0 || el.rect.height <= 0) continue;

    // Reject enormous broad containers (e.g. body, html, large feed lists) from being anchor leaves
    if (el.tagName === "BODY" || el.tagName === "HTML" || el.isFeedContainer) continue;

    const iou = calculateIoU(projectedDomBox, el.rect);

    // Also check center point distance
    const projCenterX = projectedDomBox.x + projectedDomBox.width / 2;
    const projCenterY = projectedDomBox.y + projectedDomBox.height / 2;
    const elCenterX = el.rect.x + el.rect.width / 2;
    const elCenterY = el.rect.y + el.rect.height / 2;

    const dx = Math.abs(projCenterX - elCenterX);
    const dy = Math.abs(projCenterY - elCenterY);
    const maxDim = Math.max(projectedDomBox.width, projectedDomBox.height, 50);

    const isNearCenter = dx < maxDim && dy < maxDim;
    if (iou <= 0 && !isNearCenter) continue;

    // 4. Calculate Text Match Score
    let textOverlap = 0;
    if (regionNormalizedText && el.textSnippet) {
      const elNorm = normalizeVietnameseText(el.textSnippet);
      if (elNorm.includes(regionNormalizedText) || regionNormalizedText.includes(elNorm)) {
        textOverlap = 1.0;
      } else {
        const tokensA = regionNormalizedText.split(/\s+/).filter((t) => t.length > 2);
        const tokensB = elNorm.split(/\s+/).filter((t) => t.length > 2);
        if (tokensA.length > 0) {
          const matched = tokensA.filter((t) => tokensB.includes(t)).length;
          textOverlap = matched / tokensA.length;
        }
      }
    }

    // 5. Compute combined score (0..100)
    // - Spatial alignment: up to 50 pts
    // - Text correspondence: up to 40 pts
    // - Specificity (depth/leaf): up to 10 pts
    const spatialScore = Math.round(iou * 40 + (isNearCenter ? 10 : 0));
    const textScore = Math.round(textOverlap * 40);
    const depthScore = Math.min(10, el.depth * 2);

    const totalScore = spatialScore + textScore + depthScore;
    candidates.push({
      el,
      score: totalScore,
      iou,
      textOverlap,
      reason: `spatial: ${spatialScore}pts, text: ${textScore}pts, depth: ${depthScore}pts`,
    });
  }

  if (!candidates.length) {
    return {
      matchedElement: null,
      confidence: 0,
      evidence: "No overlapping DOM elements found for this visual region.",
      rejectionReason: "No spatial match",
    };
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  if (best.score < 25) {
    return {
      matchedElement: null,
      confidence: best.score,
      evidence: `Best candidate <${best.el.tagName}> scored ${best.score} (below 25 threshold).`,
      rejectionReason: "Low match confidence",
    };
  }

  const selector = best.el.className
    ? `${best.el.tagName.toLowerCase()}.${best.el.className.split(/\s+/).slice(0, 2).join(".")}`
    : best.el.tagName.toLowerCase();

  return {
    matchedElement: best.el,
    confidence: Math.min(98, best.score),
    evidence: `Mapped to DOM element <${selector}> with ${best.score}% confidence (${best.reason}).`,
  };
}

// ---------------------------------------------------------------------------
// 5. VERIFIED POST CONTAINER (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Finds the Lowest Common Ancestor (LCA) of two DOM elements in a DOM snapshot.
 */
export function findLowestCommonAncestor(
  elAId: string,
  elBId: string,
  elementMap: Map<string, CollectorDomElement>,
): CollectorDomElement | null {
  if (elAId === elBId) return elementMap.get(elAId) ?? null;

  const ancestorsA = new Set<string>();
  let cur: CollectorDomElement | undefined = elementMap.get(elAId);
  while (cur) {
    ancestorsA.add(cur.id);
    cur = cur.parentId ? elementMap.get(cur.parentId) : undefined;
  }

  let curB: CollectorDomElement | undefined = elementMap.get(elBId);
  while (curB) {
    if (ancestorsA.has(curB.id)) {
      return curB;
    }
    curB = curB.parentId ? elementMap.get(curB.parentId) : undefined;
  }

  return null;
}

/**
 * Verifies and returns the single Post Container corresponding to the item.
 * Strictly prevents selecting broad feed streams or pairing a header from Post A
 * with a footer from Post B.
 */
export function findVerifiedPostContainer(
  staticRegions: CollectorRegion[],
  snapshot: CollectorDomSnapshot,
  imageWidth: number = 800,
  imageHeight: number = 1000,
  layoutContext: LayoutContextKind = "FEED_ITEM",
  imageRoi?: Rect,
): VerifiedPostContainer {
  if (!snapshot || !snapshot.elements.length) {
    return {
      containerId: "",
      tagName: "",
      selector: "",
      layoutContext,
      confidence: 0,
      evidence: ["DOM snapshot is empty."],
      headerMatched: false,
      footerMatched: false,
      isNestedSharedPost: false,
      rejectionReason: "Empty DOM snapshot",
    };
  }

  const elementMap = new Map<string, CollectorDomElement>();
  for (const el of snapshot.elements) {
    elementMap.set(el.id, el);
  }

  const scaleX = snapshot.viewport?.width ? imageWidth / snapshot.viewport.width : 1;
  const scaleY = snapshot.viewport?.height ? imageHeight / snapshot.viewport.height : 1;
  const offsetX = imageRoi ? imageRoi.x : 0;
  const offsetY = imageRoi ? imageRoi.y : 0;

  let currentGroupTag: string | undefined;
  let headerRegion: CollectorRegion | undefined;
  let footerRegion: CollectorRegion | undefined;

  const hasModernOrGrouped = staticRegions.some(
    (r) => r.type === "BEGIN" || r.type === "END" || r.type === "FREE" || Boolean(r.groupTag),
  );

  if (hasModernOrGrouped) {
    const analysis = verifyAnchorGroups(staticRegions);
    if (analysis.errors.length > 0) {
      return {
        containerId: "",
        tagName: "",
        selector: "",
        layoutContext,
        confidence: 0,
        evidence: analysis.errors,
        headerMatched: false,
        footerMatched: false,
        isNestedSharedPost: false,
        rejectionReason: analysis.errors[0],
      };
    }
    if (analysis.groups.size === 0) {
      return {
        containerId: "",
        tagName: "",
        selector: "",
        layoutContext,
        confidence: 0,
        evidence: [
          "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags to discover post containers.",
        ],
        headerMatched: false,
        footerMatched: false,
        isNestedSharedPost: false,
        rejectionReason:
          "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags to discover post containers.",
      };
    }

    const [tag, entry] = Array.from(analysis.groups.entries())[0]!;
    currentGroupTag = tag;
    headerRegion = entry.begin;
    footerRegion = entry.end;
  } else {
    // Legacy STATIC anchors fallback (e.g. from existing test fixtures)
    const staticList = staticRegions.filter((r) => r.type === "STATIC");
    if (staticList.length === 0) {
      return {
        containerId: "",
        tagName: "",
        selector: "",
        layoutContext,
        confidence: 0,
        evidence: [
          "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags to discover post containers.",
        ],
        headerMatched: false,
        footerMatched: false,
        isNestedSharedPost: false,
        rejectionReason:
          "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags to discover post containers.",
      };
    }
    headerRegion =
      staticList.find(
        (r) => r.role === "header" || r.label.toLowerCase().includes("header"),
      ) ?? staticList[0];
    footerRegion =
      staticList.find(
        (r) =>
          r !== headerRegion &&
          (r.role === "footer" || r.label.toLowerCase().includes("footer")),
      ) ?? (staticList.length > 1 && staticList[1] !== headerRegion ? staticList[1] : undefined);
  }

  // 2. Map visual regions to DOM elements
  const headerMatch = headerRegion
    ? mapRegionToDomElement(headerRegion, snapshot, imageWidth, imageHeight, imageRoi)
    : null;
  const footerMatch = footerRegion
    ? mapRegionToDomElement(footerRegion, snapshot, imageWidth, imageHeight, imageRoi)
    : null;

  const headerEl = headerMatch?.matchedElement ?? null;
  const footerEl = footerMatch?.matchedElement ?? null;

  // CASE A: Both Header and Footer matched
  if (headerEl && footerEl) {
    // Structural sanity check: Footer must not be physically above Header
    if (footerEl.rect.y < headerEl.rect.y - 10) {
      return {
        containerId: "",
        tagName: "",
        selector: "",
        layoutContext,
        confidence: 0,
        evidence: [
          `Spatial ordering mismatch: Footer element <${footerEl.tagName}> (y:${footerEl.rect.y}) is above Header element <${headerEl.tagName}> (y:${headerEl.rect.y}).`,
        ],
        headerMatched: true,
        footerMatched: true,
        isNestedSharedPost: false,
        rejectionReason: "Inverted header/footer ordering",
        groupTag: currentGroupTag,
      };
    }

    // Find Lowest Common Ancestor (LCA)
    const lca = findLowestCommonAncestor(headerEl.id, footerEl.id, elementMap);
    if (!lca) {
      return {
        containerId: "",
        tagName: "",
        selector: "",
        layoutContext,
        confidence: 0,
        evidence: ["No common DOM ancestor exists between header and footer elements."],
        headerMatched: true,
        footerMatched: true,
        isNestedSharedPost: false,
        rejectionReason: "Disjoint DOM subtrees",
        groupTag: currentGroupTag,
      };
    }

    // CRITICAL SAFETY CHECK: Reject oversized feed ancestors (e.g. body, feed container, main)
    if (
      lca.tagName === "BODY" ||
      lca.tagName === "HTML" ||
      lca.isFeedContainer ||
      lca.role === "feed" ||
      (lca.className && /\b(feed|stream|wall|timeline)\b/i.test(lca.className))
    ) {
      return {
        containerId: "",
        tagName: lca.tagName,
        selector: lca.className || lca.tagName,
        layoutContext,
        confidence: 0,
        evidence: [
          `Cross-post mismatch rejected: Lowest common ancestor <${lca.tagName}.${
            lca.className || ""
          }> is an outer feed container. Header and footer belong to different posts.`,
        ],
        headerMatched: true,
        footerMatched: true,
        isNestedSharedPost: false,
        rejectionReason: "Cross-post mismatch (broad feed ancestor)",
        groupTag: currentGroupTag,
      };
    }

    // Check if the LCA encloses other sibling post cards (which also indicates too broad)
    const enclosedCards = snapshot.elements.filter(
      (el) =>
        el.id !== lca.id &&
        el.isArticleOrCard &&
        el.rect.x >= lca.rect.x &&
        el.rect.y >= lca.rect.y &&
        el.rect.x + el.rect.width <= lca.rect.x + lca.rect.width &&
        el.rect.y + el.rect.height <= lca.rect.y + lca.rect.height,
    );

    if (enclosedCards.length > 1) {
      return {
        containerId: "",
        tagName: lca.tagName,
        selector: lca.className || lca.tagName,
        layoutContext,
        confidence: 0,
        evidence: [
          `Container <${lca.tagName}> encloses ${enclosedCards.length} post cards. Rejected as cross-post container.`,
        ],
        headerMatched: true,
        footerMatched: true,
        isNestedSharedPost: false,
        rejectionReason: "Encloses multiple post cards",
        groupTag: currentGroupTag,
      };
    }

    // Check for nested / quoted post
    const isNestedSharedPost = Boolean(
      headerEl.depth > lca.depth + 3 ||
        (lca.outerHtmlSnippet && /shared_post|quoted|nested/i.test(lca.outerHtmlSnippet)),
    );

    const selector = lca.idAttr
      ? `#${lca.idAttr}`
      : lca.className
        ? `${lca.tagName.toLowerCase()}.${lca.className.split(/\s+/)[0]}`
        : lca.tagName.toLowerCase();

    const containerRect: Rect = {
      x: Math.max(0, Math.round((lca.rect.x - offsetX) * scaleX)),
      y: Math.max(0, Math.round((lca.rect.y - offsetY) * scaleY)),
      width: Math.max(1, Math.min(imageWidth, Math.round(lca.rect.width * scaleX))),
      height: Math.max(1, Math.min(imageHeight, Math.round(lca.rect.height * scaleY))),
    };

    return {
      containerId: lca.id,
      tagName: lca.tagName,
      selector,
      role: lca.role,
      layoutContext,
      confidence: 96,
      evidence: [
        `Header (<${headerEl.tagName}>) and Footer (<${footerEl.tagName}>) share post container <${selector}> at depth ${lca.depth}.`,
        isNestedSharedPost ? "Nested/shared post structure detected." : "Standard post item container.",
      ],
      headerMatched: true,
      footerMatched: true,
      isNestedSharedPost,
      outerHtmlSnippet: lca.outerHtmlSnippet,
      groupTag: currentGroupTag,
      rect: containerRect,
    };
  }

  // CASE B: Only Header matched (Footer outside viewport or omitted)
  if (headerEl) {
    // Traverse up ancestors from Header to find the enclosing post card/article
    let candidateCard: CollectorDomElement | null = null;
    let cur: CollectorDomElement | undefined = elementMap.get(headerEl.parentId ?? "");

    while (cur) {
      if (cur.tagName === "BODY" || cur.tagName === "HTML" || cur.isFeedContainer || cur.role === "feed") {
        break; // Stop before ascending into the broad feed
      }

      if (
        cur.isArticleOrCard ||
        cur.role === "article" ||
        (cur.className && /\b(card|post|item|unit|box)\b/i.test(cur.className)) ||
        (cur.rect.height > 80 && cur.rect.width >= 280)
      ) {
        candidateCard = cur;
        break;
      }
      cur = cur.parentId ? elementMap.get(cur.parentId) : undefined;
    }

    if (candidateCard) {
      const selector = candidateCard.idAttr
        ? `#${candidateCard.idAttr}`
        : candidateCard.className
          ? `${candidateCard.tagName.toLowerCase()}.${candidateCard.className.split(/\s+/)[0]}`
          : candidateCard.tagName.toLowerCase();

      const containerRect: Rect = {
        x: Math.max(0, Math.round((candidateCard.rect.x - offsetX) * scaleX)),
        y: Math.max(0, Math.round((candidateCard.rect.y - offsetY) * scaleY)),
        width: Math.max(1, Math.min(imageWidth, Math.round(candidateCard.rect.width * scaleX))),
        height: Math.max(1, Math.min(imageHeight, Math.round(candidateCard.rect.height * scaleY))),
      };

      return {
        containerId: candidateCard.id,
        tagName: candidateCard.tagName,
        selector,
        role: candidateCard.role,
        layoutContext,
        confidence: 85,
        evidence: [
          `Single Header (<${headerEl.tagName}>) verified inside enclosing post container <${selector}> (footer absent/outside viewport).`,
        ],
        headerMatched: true,
        footerMatched: false,
        isNestedSharedPost: false,
        outerHtmlSnippet: candidateCard.outerHtmlSnippet,
        groupTag: currentGroupTag,
        rect: containerRect,
      };
    }

    return {
      containerId: "",
      tagName: headerEl.tagName,
      selector: headerEl.className || headerEl.tagName,
      layoutContext,
      confidence: 40,
      evidence: [
        `Header anchor matched <${headerEl.tagName}>, but no distinct post card boundary was found. Needs attention.`,
      ],
      headerMatched: true,
      footerMatched: false,
      isNestedSharedPost: false,
      rejectionReason: "Ambiguous container boundary without footer",
      groupTag: currentGroupTag,
    };
  }

  // CASE C: Neither matched
  return {
    containerId: "",
    tagName: "",
    selector: "",
    layoutContext,
    confidence: 0,
    evidence: ["Neither header nor footer static anchors could be matched in DOM snapshot."],
    headerMatched: false,
    footerMatched: false,
    isNestedSharedPost: false,
    rejectionReason: "No static anchors matched",
    groupTag: currentGroupTag,
  };
}

// ---------------------------------------------------------------------------
// 6. DYNAMIC HTML EXTRACTION (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Extracts the dynamic content HTML subtree from the verified post container.
 * Collects raw HTML, text body, media URLs, link preview metadata, and completeness flags.
 */
export function extractDynamicHtmlFromContainer(
  container: VerifiedPostContainer,
  snapshot: CollectorDomSnapshot,
  staticRegions: CollectorRegion[] = [],
): DynamicHtmlExtractionResult {
  const now = new Date().toISOString();

  if (!container.containerId) {
    return {
      status: "empty",
      rawHtml: "",
      evidence: [`Cannot extract dynamic HTML: ${container.rejectionReason || "No verified container"}`],
      isComplete: false,
      hasCollapsedText: false,
      hasLazyMedia: false,
      extractedAt: now,
    };
  }

  const containerEl = snapshot.elements.find((el) => el.id === container.containerId);
  if (!containerEl) {
    return {
      status: "empty",
      rawHtml: "",
      evidence: [`Container element ${container.containerId} not found in snapshot elements.`],
      isComplete: false,
      hasCollapsedText: false,
      hasLazyMedia: false,
      extractedAt: now,
    };
  }

  // Find all elements descending from container
  const elementMap = new Map<string, CollectorDomElement>();
  for (const el of snapshot.elements) {
    elementMap.set(el.id, el);
  }

  const isDescendantOf = (childId: string, parentId: string): boolean => {
    let cur = elementMap.get(childId);
    while (cur) {
      if (cur.parentId === parentId) return true;
      cur = cur.parentId ? elementMap.get(cur.parentId) : undefined;
    }
    return false;
  };

  const descendants = snapshot.elements.filter((el) => isDescendantOf(el.id, containerEl.id));

  // Extract media URLs
  const mediaUrls: string[] = [];
  const linkPreviews: Array<{ title: string; url: string; domain?: string }> = [];

  for (const d of descendants) {
    if (d.tagName === "IMG" && d.attributes["src"]) {
      mediaUrls.push(d.attributes["src"]);
    }
    if (d.tagName === "VIDEO" && d.attributes["src"]) {
      mediaUrls.push(d.attributes["src"]);
    }
    if (d.tagName === "A" && d.attributes["href"]) {
      const href = d.attributes["href"];
      if (/^https?:\/\//i.test(href) && d.textSnippet) {
        linkPreviews.push({
          title: d.textSnippet.slice(0, 80),
          url: href,
        });
      }
    }
  }

  // Check completeness flags
  const containerText = (containerEl.textSnippet || "") + descendants.map((d) => d.textSnippet).join(" ");
  const hasCollapsedText = /xem thêm|see more|read more|continue reading/i.test(containerText);
  const hasLazyMedia = descendants.some(
    (d) => d.attributes["data-src"] || d.attributes["loading"] === "lazy",
  );

  const rawHtml = containerEl.outerHtmlSnippet || `<div class="post-container">${containerText}</div>`;

  return {
    status: "success",
    rawHtml,
    extractedText: containerEl.textSnippet || descendants.map((d) => d.textSnippet).filter(Boolean).join("\n"),
    mediaUrls: mediaUrls.slice(0, 10),
    linkPreviews: linkPreviews.slice(0, 5),
    isComplete: !hasCollapsedText,
    hasCollapsedText,
    hasLazyMedia,
    evidence: [
      `Extracted dynamic subtree from <${container.selector}> (${descendants.length} child nodes).`,
      `Found ${mediaUrls.length} media items and ${linkPreviews.length} links.`,
      hasCollapsedText ? "Notice: Post text contains collapsed 'See more' marker." : "Full text visible.",
    ],
    extractedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 7. HTML FILTER FOUNDATION (Phase 7)
// ---------------------------------------------------------------------------

export type GenericFilterRule = {
  id: string;
  targetVariableKey: string;
  attribute?: "textContent" | "href" | "src" | "mediaCount" | "linkCount";
  transform?: "text" | "number" | "url" | "array";
};

export type HtmlFilterResult = {
  values: Record<string, unknown>;
  evidence: string[];
  status: "success" | "partial" | "empty";
  rawHtml: string;
};

/**
 * Reusable HTML filter interface that transforms verified dynamic HTML extraction
 * into candidate variable values without hardcoded selectors.
 */
export function executeHtmlFilter(
  dynamicExtraction: DynamicHtmlExtractionResult,
  container: VerifiedPostContainer,
  rules: GenericFilterRule[],
  variables: CollectorVariable[] = [],
): HtmlFilterResult {
  if (dynamicExtraction.status !== "success" || !dynamicExtraction.rawHtml) {
    return {
      values: {},
      evidence: ["No valid dynamic HTML to filter."],
      status: "empty",
      rawHtml: dynamicExtraction.rawHtml || "",
    };
  }

  const values: Record<string, unknown> = {};
  const evidence: string[] = [];

  for (const rule of rules) {
    const key = rule.targetVariableKey;
    const v = variables.find((variable) => variable.key === key);

    switch (rule.attribute) {
      case "src": {
        const val = dynamicExtraction.mediaUrls?.[0] ?? null;
        values[key] = val;
        evidence.push(`Variable "${key}" extracted media URL: ${val || "none"}`);
        break;
      }
      case "mediaCount": {
        const count = dynamicExtraction.mediaUrls?.length ?? 0;
        values[key] = count;
        evidence.push(`Variable "${key}" counted ${count} media items.`);
        break;
      }
      case "href": {
        const link = dynamicExtraction.linkPreviews?.[0]?.url ?? null;
        values[key] = link;
        evidence.push(`Variable "${key}" extracted link: ${link || "none"}`);
        break;
      }
      case "linkCount": {
        const count = dynamicExtraction.linkPreviews?.length ?? 0;
        values[key] = count;
        evidence.push(`Variable "${key}" counted ${count} link previews.`);
        break;
      }
      case "textContent":
      default: {
        const text = dynamicExtraction.extractedText ?? "";
        values[key] = text;
        evidence.push(`Variable "${key}" extracted text content (${text.length} chars).`);
        break;
      }
    }
  }

  return {
    values,
    evidence,
    status: Object.keys(values).length > 0 ? "success" : "partial",
    rawHtml: dynamicExtraction.rawHtml,
  };
}

// ---------------------------------------------------------------------------
// 9. C2.10 LIVE BROWSER MATCH TEST ENGINE
// ---------------------------------------------------------------------------

export function findAnchorCandidates(
  region: CollectorRegion,
  elements: CollectorDomElement[],
  learnedRule?: LearnedAnchorRule,
): Array<{
  el: CollectorDomElement;
  score: number;
  method: "text_dom" | "visual_projection" | "none";
  reason: string;
}> {
  const candidates: Array<{
    el: CollectorDomElement;
    score: number;
    method: "text_dom" | "visual_projection" | "none";
    reason: string;
  }> = [];

  // Prefer region-scoped OCR text or explicit evidence text over fallback label
  const rawText = region.ocr?.text || region.ocrEvidence?.text || region.label;
  const normalizedText = normalizeVietnameseText(rawText);

  // When learned rule is available, use its stable tokens and ignore variable tokens (e.g. dynamic author/timestamp)
  let refTokens: string[];
  const variableTokenSet = new Set<string>(learnedRule?.variableTokens ?? []);
  if (learnedRule && learnedRule.stableTokens.length > 0) {
    refTokens = learnedRule.stableTokens;
  } else {
    refTokens = normalizedText.split(/\s+/).filter((t) => t.length > 1);
  }

  for (const el of elements) {
    let score = 0;
    let method: "text_dom" | "visual_projection" | "none" = "none";
    const reasons: string[] = [];

    // Text token matching against stable tokens
    if (refTokens.length > 0 && el.textSnippet) {
      const elText = normalizeVietnameseText(el.textSnippet);
      const matchCount = refTokens.filter((token) => !variableTokenSet.has(token) && elText.includes(token)).length;
      const effectiveRefCount = refTokens.filter((token) => !variableTokenSet.has(token)).length || refTokens.length;
      if (matchCount > 0) {
        const textScore = Math.min(60, Math.round((matchCount / effectiveRefCount) * 60));
        score += textScore;
        method = "text_dom";
        reasons.push(`matched ${matchCount}/${effectiveRefCount} tokens`);
      }
    }

    // Role or attribute match (learned profile or region evidence)
    if (learnedRule?.domProfile.roles.length && el.role && learnedRule.domProfile.roles.includes(el.role)) {
      score += 20;
      reasons.push(`learned role "${el.role}"`);
    } else if (region.domEvidence?.role && el.role === region.domEvidence.role) {
      score += 20;
      reasons.push(`role "${el.role}"`);
    } else if (region.role && (el.role === region.role || (el.className && el.className.includes(region.role)))) {
      score += 15;
      reasons.push(`role/class "${region.role}"`);
    } else if (region.type === "BEGIN" && (el.role === "heading" || el.tagName === "HEADER" || el.role === "banner")) {
      score += 20;
      reasons.push(`semantic header role`);
    } else if (region.type === "END" && (el.role === "footer" || el.tagName === "FOOTER" || el.role === "toolbar" || el.role === "group")) {
      score += 20;
      reasons.push(`semantic footer role`);
    }

    // Tag name match
    if (learnedRule?.domProfile.tagNames.length && learnedRule.domProfile.tagNames.includes(el.tagName)) {
      score += 10;
      reasons.push(`learned <${el.tagName}>`);
    } else if (region.domEvidence?.tagName && el.tagName === region.domEvidence.tagName) {
      score += 10;
      reasons.push(`<${el.tagName}>`);
    }

    // Spatial presence in viewport
    if (el.rect.width > 0 && el.rect.height > 0) {
      score += 10;
      if (method === "none") method = "visual_projection";
    }

    // Relative vertical alignment in viewport layout zone
    if (region.type === "BEGIN" && el.rect.y < 550) {
      score += 10;
      reasons.push("top layout zone");
    } else if (region.type === "END" && el.rect.y > 80) {
      score += 10;
      reasons.push("bottom layout zone");
    }

    // Social post header heuristics (author profile link, timestamp pattern)
    const isAuthorHeader =
      (el.tagName === "A" && Boolean(el.attributes?.href) && Boolean(el.textSnippet && el.textSnippet.length > 2)) ||
      (el.attributes?.role === "link" && Boolean(el.textSnippet && isAuthorCandidate(el.textSnippet))) ||
      Boolean(el.textSnippet && isTimestampText(el.textSnippet));

    if (region.type === "BEGIN" && isAuthorHeader) {
      score += 25;
      if (method === "none") method = "text_dom";
      reasons.push("header author/time structure");
    }

    // Social post footer/actions heuristics (like/comment/share actions, engagement toolbar)
    const isActionFooter =
      Boolean(el.textSnippet && isEngagementText(el.textSnippet)) ||
      Boolean(el.textSnippet && /\b(thích|bình luận|chia sẻ|like|comment|share|reply|gửi|send|upvote|retweet|repost)\b/i.test(el.textSnippet)) ||
      Boolean(el.attributes?.["aria-label"] && /\b(thích|bình luận|chia sẻ|like|comment|share)\b/i.test(el.attributes["aria-label"])) ||
      el.role === "toolbar" ||
      el.role === "group";

    if (region.type === "END" && isActionFooter) {
      score += 30;
      if (method === "none") method = "text_dom";
      reasons.push("social actions bar (like/comment/share)");
    }

    if (score >= 40) {
      candidates.push({
        el,
        score: Math.min(100, score),
        method,
        reason: reasons.join(", "),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * C2.10 — Live Browser Match Test Engine
 *
 * Requirements:
 * - Operates against actual live DOM snapshot (fails if snapshot is empty or stale).
 * - Matches BEGIN and END reference templates in the live browser.
 * - Computes dynamic bounds using live matched coordinates.
 * - Distinguishes NOT TESTED, MATCHED, PARTIAL, AMBIGUOUS, FAILED.
 * - Rejects cross-post pairings (e.g. broad feed ancestor / encloses multiple cards).
 * - Rejects inverted ordering (END above BEGIN).
 * - Respects multiple visible posts in a feed.
 * - Explicitly reports visual matching limitations.
 * - C2.11: Consumes multi-sample LearnedAnchorRules when available or derived from draft.
 */
export function executeLiveBrowserMatchTest(
  regions: CollectorRegion[],
  snapshot: CollectorDomSnapshot,
  draft?: CollectorDraft,
): MatchTestResult {
  const testedAt = new Date().toISOString();
  const visualLimitations = [
    "Visual matching uses DOM text tokens, attributes, and viewport layout projection.",
    "Pixel-level image template matching for icons/avatars is not yet implemented.",
  ];

  if (!snapshot || !snapshot.elements || snapshot.elements.length === 0) {
    return {
      testedAt,
      browserUrl: snapshot?.url || "",
      status: "FAILED",
      matchedPostCount: 0,
      groups: [],
      summary: "No DOM elements found in live browser page. Ensure page is loaded.",
      limitations: visualLimitations,
      error: "DOM snapshot empty or unavailable",
    };
  }

  if (snapshot.isStale) {
    return {
      testedAt,
      browserUrl: snapshot.url,
      status: "FAILED",
      matchedPostCount: 0,
      groups: [],
      summary: "DOM snapshot belongs to a different URL or outdated page state.",
      limitations: visualLimitations,
      error: "Stale page state",
    };
  }

  // Deduplicate multi-sample regions to one representative BEGIN and END per group tag
  const canonicalRegions: CollectorRegion[] = [];
  const seenBegin = new Set<string>();
  const seenEnd = new Set<string>();

  const sortedRegions = [...regions].sort((a, b) => {
    const aOcrScore = (a.ocr?.text || a.ocrEvidence?.text) ? 20 : 0;
    const aConfScore = a.confirmed ? 10 : 0;
    const aSampleScore = a.captureItemId === draft?.teachingCaptureId ? 2 : 0;
    const aTotal = aOcrScore + aConfScore + aSampleScore;

    const bOcrScore = (b.ocr?.text || b.ocrEvidence?.text) ? 20 : 0;
    const bConfScore = b.confirmed ? 10 : 0;
    const bSampleScore = b.captureItemId === draft?.teachingCaptureId ? 2 : 0;
    const bTotal = bOcrScore + bConfScore + bSampleScore;

    return bTotal - aTotal;
  });

  for (const r of sortedRegions) {
    if (r.type === "FREE") {
      canonicalRegions.push(r);
      continue;
    }
    const tag = (r.groupTag || "default").trim();
    if (r.type === "BEGIN") {
      if (!seenBegin.has(tag)) {
        seenBegin.add(tag);
        canonicalRegions.push(r);
      }
    } else if (r.type === "END") {
      if (!seenEnd.has(tag)) {
        seenEnd.add(tag);
        canonicalRegions.push(r);
      }
    } else {
      canonicalRegions.push(r);
    }
  }

  const analysis = verifyAnchorGroups(canonicalRegions);
  if (analysis.errors.length > 0) {
    return {
      testedAt,
      browserUrl: snapshot.url,
      status: "FAILED",
      matchedPostCount: 0,
      groups: [],
      summary: analysis.errors[0] || "Incomplete anchor group configuration.",
      limitations: visualLimitations,
      error: analysis.errors[0],
    };
  }

  if (analysis.groups.size === 0) {
    return {
      testedAt,
      browserUrl: snapshot.url,
      status: "FAILED",
      matchedPostCount: 0,
      groups: [],
      summary: "No anchor groups defined. Create paired BEGIN and END anchors with matching group tags in Step 2A.",
      limitations: visualLimitations,
      error: "No anchor groups defined",
    };
  }

  const elementMap = new Map<string, CollectorDomElement>();
  for (const el of snapshot.elements) {
    elementMap.set(el.id, el);
  }

  const groupResults: PostGroupMatch[] = [];
  const allMatchedItems: MatchedPostItem[] = [];
  let totalMatchedPosts = 0;

  const learnedRules = draft ? buildLearnedAnchorRules(draft) : undefined;

  for (const [tag, group] of analysis.groups.entries()) {
    const begin = group.begin;
    const end = group.end;
    if (!begin || !end) continue;

    const ruleGroup = learnedRules?.get(tag);

    // 1. Find candidates for BEGIN
    const beginCandidates = findAnchorCandidates(begin, snapshot.elements, ruleGroup?.beginRule);
    // 2. Find candidates for END
    const endCandidates = findAnchorCandidates(end, snapshot.elements, ruleGroup?.endRule);

    if (beginCandidates.length === 0 && endCandidates.length === 0) {
      allMatchedItems.push({
        index: allMatchedItems.length + 1,
        groupTag: tag,
        beginMatched: false,
        endMatched: false,
        paired: false,
        domResolved: false,
        confidence: 0,
        failureReason: `Neither BEGIN anchor (${begin.label}) nor END anchor (${end.label}) matched in live DOM.`,
      });
      groupResults.push({
        groupTag: tag,
        status: "FAILED",
        domAssociationStatus: "NOT_RESOLVED",
        visualConfidence: 0,
        limitations: visualLimitations,
        failureReason: `Neither BEGIN anchor (${begin.label}) nor END anchor (${end.label}) matched in live DOM.`,
      });
      continue;
    }

    if (beginCandidates.length > 0 && endCandidates.length === 0) {
      const topBegin = beginCandidates[0]!;
      allMatchedItems.push({
        index: allMatchedItems.length + 1,
        groupTag: tag,
        beginRect: topBegin.el.rect,
        beginMatched: true,
        endMatched: false,
        paired: false,
        domResolved: false,
        confidence: topBegin.score,
        failureReason: `BEGIN anchor matched <${topBegin.el.tagName}>, but END anchor (${end.label}) was not found in live DOM.`,
      });
      groupResults.push({
        groupTag: tag,
        status: "PARTIAL",
        beginMatch: {
          regionId: begin.id,
          role: "BEGIN",
          groupTag: tag,
          matched: true,
          matchedElementId: topBegin.el.id,
          matchedTagName: topBegin.el.tagName,
          matchedRect: topBegin.el.rect,
          confidence: topBegin.score,
          method: topBegin.method,
          evidence: topBegin.reason,
        },
        domAssociationStatus: "NOT_RESOLVED",
        visualConfidence: topBegin.score,
        limitations: visualLimitations,
        failureReason: `BEGIN anchor matched <${topBegin.el.tagName}>, but END anchor (${end.label}) was not found in live DOM.`,
      });
      continue;
    }

    if (beginCandidates.length === 0 && endCandidates.length > 0) {
      const topEnd = endCandidates[0]!;
      allMatchedItems.push({
        index: allMatchedItems.length + 1,
        groupTag: tag,
        endRect: topEnd.el.rect,
        beginMatched: false,
        endMatched: true,
        paired: false,
        domResolved: false,
        confidence: topEnd.score,
        failureReason: `END anchor matched <${topEnd.el.tagName}>, but BEGIN anchor (${begin.label}) was not found in live DOM.`,
      });
      groupResults.push({
        groupTag: tag,
        status: "PARTIAL",
        endMatch: {
          regionId: end.id,
          role: "END",
          groupTag: tag,
          matched: true,
          matchedElementId: topEnd.el.id,
          matchedTagName: topEnd.el.tagName,
          matchedRect: topEnd.el.rect,
          confidence: topEnd.score,
          method: topEnd.method,
          evidence: topEnd.reason,
        },
        domAssociationStatus: "NOT_RESOLVED",
        visualConfidence: topEnd.score,
        limitations: visualLimitations,
        failureReason: `END anchor matched <${topEnd.el.tagName}>, but BEGIN anchor (${begin.label}) was not found in live DOM.`,
      });
      continue;
    }

    // Both have candidates. Evaluate pairings.
    type PairCandidate = {
      beginCandidate: (typeof beginCandidates)[0];
      endCandidate: (typeof endCandidates)[0];
      lca: CollectorDomElement | null;
      isVerticallyOrdered: boolean;
      isBroadFeed: boolean;
      enclosesMultiple: boolean;
      score: number;
    };

    const validPairs: PairCandidate[] = [];
    const rejectedPairs: Array<{ pair: PairCandidate; reason: string }> = [];

    for (const bCand of beginCandidates) {
      for (const eCand of endCandidates) {
        // Vertical ordering check
        const isVerticallyOrdered = eCand.el.rect.y > bCand.el.rect.y + bCand.el.rect.height - 5;
        if (!isVerticallyOrdered) {
          rejectedPairs.push({
            pair: {
              beginCandidate: bCand,
              endCandidate: eCand,
              lca: null,
              isVerticallyOrdered: false,
              isBroadFeed: false,
              enclosesMultiple: false,
              score: 0,
            },
            reason: `Spatial ordering inverted: END (<${eCand.el.tagName}> at y:${eCand.el.rect.y}) is above BEGIN (<${bCand.el.tagName}> at y:${bCand.el.rect.y}).`,
          });
          continue;
        }

        const lca = findLowestCommonAncestor(bCand.el.id, eCand.el.id, elementMap);
        if (!lca) {
          rejectedPairs.push({
            pair: {
              beginCandidate: bCand,
              endCandidate: eCand,
              lca: null,
              isVerticallyOrdered: true,
              isBroadFeed: false,
              enclosesMultiple: false,
              score: 0,
            },
            reason: "Disjoint DOM subtrees: No common ancestor exists.",
          });
          continue;
        }

        const isBroadFeed =
          lca.tagName === "BODY" ||
          lca.tagName === "HTML" ||
          lca.isFeedContainer ||
          lca.role === "feed" ||
          Boolean(lca.className && /\b(feed|stream|wall|timeline)\b/i.test(lca.className));

        if (isBroadFeed) {
          rejectedPairs.push({
            pair: {
              beginCandidate: bCand,
              endCandidate: eCand,
              lca,
              isVerticallyOrdered: true,
              isBroadFeed: true,
              enclosesMultiple: false,
              score: 0,
            },
            reason: `Cross-post mismatch rejected: Lowest common ancestor <${lca.tagName}.${lca.className || ""}> is a broad feed container. BEGIN and END belong to different posts.`,
          });
          continue;
        }

        const enclosedCards = snapshot.elements.filter(
          (el) =>
            el.id !== lca.id &&
            el.isArticleOrCard &&
            el.rect.x >= lca.rect.x &&
            el.rect.y >= lca.rect.y &&
            el.rect.x + el.rect.width <= lca.rect.x + lca.rect.width &&
            el.rect.y + el.rect.height <= lca.rect.y + lca.rect.height,
        );

        if (enclosedCards.length > 1) {
          rejectedPairs.push({
            pair: {
              beginCandidate: bCand,
              endCandidate: eCand,
              lca,
              isVerticallyOrdered: true,
              isBroadFeed: false,
              enclosesMultiple: true,
              score: 0,
            },
            reason: `Cross-post container rejected: Ancestor <${lca.tagName}> encloses multiple post cards.`,
          });
          continue;
        }

        const pairScore = Math.round((bCand.score + eCand.score) / 2);
        validPairs.push({
          beginCandidate: bCand,
          endCandidate: eCand,
          lca,
          isVerticallyOrdered: true,
          isBroadFeed: false,
          enclosesMultiple: false,
          score: pairScore,
        });
      }
    }

    // Sort valid pairs: top-down by Y
    validPairs.sort((a, b) => a.beginCandidate.el.rect.y - b.beginCandidate.el.rect.y);

    if (validPairs.length === 0) {
      const primaryRejection =
        rejectedPairs[0]?.reason || "No valid pairing between BEGIN and END anchors.";
      allMatchedItems.push({
        index: allMatchedItems.length + 1,
        groupTag: tag,
        beginRect: beginCandidates[0]?.el.rect,
        endRect: endCandidates[0]?.el.rect,
        beginMatched: beginCandidates.length > 0,
        endMatched: endCandidates.length > 0,
        paired: false,
        domResolved: false,
        confidence: Math.round(
          ((beginCandidates[0]?.score ?? 0) + (endCandidates[0]?.score ?? 0)) / 2,
        ),
        failureReason: primaryRejection,
      });
      groupResults.push({
        groupTag: tag,
        status: "FAILED",
        beginMatch: {
          regionId: begin.id,
          role: "BEGIN",
          groupTag: tag,
          matched: true,
          matchedElementId: beginCandidates[0]?.el.id,
          matchedTagName: beginCandidates[0]?.el.tagName,
          matchedRect: beginCandidates[0]?.el.rect,
          confidence: beginCandidates[0]?.score ?? 0,
          method: beginCandidates[0]?.method ?? "none",
        },
        endMatch: {
          regionId: end.id,
          role: "END",
          groupTag: tag,
          matched: true,
          matchedElementId: endCandidates[0]?.el.id,
          matchedTagName: endCandidates[0]?.el.tagName,
          matchedRect: endCandidates[0]?.el.rect,
          confidence: endCandidates[0]?.score ?? 0,
          method: endCandidates[0]?.method ?? "none",
        },
        domAssociationStatus: "FAILED",
        visualConfidence: Math.round(
          ((beginCandidates[0]?.score ?? 0) + (endCandidates[0]?.score ?? 0)) / 2,
        ),
        limitations: visualLimitations,
        failureReason: primaryRejection,
      });
      continue;
    }

    // Filter non-overlapping distinct posts (each post has its own BEGIN and END)
    const distinctPosts: PairCandidate[] = [];
    const usedBegins = new Set<string>();
    const usedEnds = new Set<string>();

    for (const vp of validPairs) {
      if (!usedBegins.has(vp.beginCandidate.el.id) && !usedEnds.has(vp.endCandidate.el.id)) {
        distinctPosts.push(vp);
        usedBegins.add(vp.beginCandidate.el.id);
        usedEnds.add(vp.endCandidate.el.id);
      }
    }

    // Sort distinct posts top-to-bottom strictly by BEGIN anchor vertical position
    distinctPosts.sort((a, b) => a.beginCandidate.el.rect.y - b.beginCandidate.el.rect.y);

    for (const post of distinctPosts) {
      // Capped at 3 posts strictly
      if (allMatchedItems.filter((item) => item.domResolved).length >= 3) break;
      const dyn = computeMatchedDynamicBounds(
        post.beginCandidate.el.rect,
        post.endCandidate.el.rect,
        snapshot.viewport.width,
      );
      allMatchedItems.push({
        index: allMatchedItems.length + 1,
        groupTag: tag,
        beginRect: post.beginCandidate.el.rect,
        endRect: post.endCandidate.el.rect,
        containerRect: post.lca?.rect ?? dyn.bounds,
        containerId: post.lca?.id,
        containerTagName: post.lca?.tagName,
        beginMatched: true,
        endMatched: true,
        paired: true,
        domResolved: Boolean(post.lca),
        confidence: post.score,
      });
    }

    const primaryPair = distinctPosts[0]!;
    const dynamic = computeMatchedDynamicBounds(
      primaryPair.beginCandidate.el.rect,
      primaryPair.endCandidate.el.rect,
      snapshot.viewport.width,
    );

    totalMatchedPosts += distinctPosts.length;

    groupResults.push({
      groupTag: tag,
      status: "MATCHED",
      beginMatch: {
        regionId: begin.id,
        role: "BEGIN",
        groupTag: tag,
        matched: true,
        matchedElementId: primaryPair.beginCandidate.el.id,
        matchedTagName: primaryPair.beginCandidate.el.tagName,
        matchedRect: primaryPair.beginCandidate.el.rect,
        confidence: primaryPair.beginCandidate.score,
        method: primaryPair.beginCandidate.method,
        evidence: primaryPair.beginCandidate.reason,
      },
      endMatch: {
        regionId: end.id,
        role: "END",
        groupTag: tag,
        matched: true,
        matchedElementId: primaryPair.endCandidate.el.id,
        matchedTagName: primaryPair.endCandidate.el.tagName,
        matchedRect: primaryPair.endCandidate.el.rect,
        confidence: primaryPair.endCandidate.score,
        method: primaryPair.endCandidate.method,
        evidence: primaryPair.endCandidate.reason,
      },
      dynamicBounds: dynamic,
      domContainer: primaryPair.lca
        ? {
            containerId: primaryPair.lca.id,
            tagName: primaryPair.lca.tagName,
            role: primaryPair.lca.role,
            depth: primaryPair.lca.depth,
            isArticleOrCard: Boolean(primaryPair.lca.isArticleOrCard),
          }
        : undefined,
      domAssociationStatus: "CONFIRMED",
      visualConfidence: primaryPair.score,
      limitations: visualLimitations,
    });
  }

  const allMatched = groupResults.length > 0 && groupResults.every((g) => g.status === "MATCHED");
  const anyAmbiguous = groupResults.some((g) => g.status === "AMBIGUOUS");
  const anyPartial = groupResults.some((g) => g.status === "PARTIAL");
  const anyFailed = groupResults.some((g) => g.status === "FAILED");

  let overallStatus: MatchTestStatus = "FAILED";
  if (allMatched && totalMatchedPosts > 0) {
    overallStatus = "MATCHED";
  } else if (anyAmbiguous) {
    overallStatus = "AMBIGUOUS";
  } else if (anyPartial) {
    overallStatus = "PARTIAL";
  } else if (anyFailed) {
    overallStatus = "FAILED";
  }

  const summary =
    overallStatus === "MATCHED"
      ? `Successfully verified ${totalMatchedPosts} post(s) across ${groupResults.length} anchor group(s). Dynamic boundaries resolved.`
      : overallStatus === "PARTIAL"
        ? `Partial match: ${groupResults.filter((g) => g.status === "MATCHED").length}/${groupResults.length} groups verified.`
        : `Match Test failed: ${groupResults.find((g) => g.failureReason)?.failureReason || "Could not verify anchors in live DOM."}`;

  return {
    testedAt,
    browserUrl: snapshot.url,
    status: overallStatus,
    matchedPostCount: totalMatchedPosts,
    groups: groupResults,
    matchedItems: allMatchedItems,
    summary,
    limitations: visualLimitations,
    error: overallStatus === "FAILED" ? summary : undefined,
  };
}

// ---------------------------------------------------------------------------
// 8. MULTI-VARIABLE MAPPING HELPERS (C2.10.3)
// ---------------------------------------------------------------------------

/**
 * Returns all variables associated with a given OCR segment on a specific capture.
 */
export function getMappedVariablesForSegment(
  variables: CollectorVariable[],
  captureId: string,
  segmentId: string,
  regionId?: string,
  segmentText?: string,
): Array<{ variable: CollectorVariable; mapping: CollectorVariableMapping }> {
  const results: Array<{ variable: CollectorVariable; mapping: CollectorVariableMapping }> = [];
  for (const v of variables) {
    const m = v.mappings.find(
      (entry) =>
        entry.sampleId === captureId &&
        (!entry.regionId || !regionId || entry.regionId === regionId) &&
        entry.presence === "mapped",
    );
    if (!m) continue;
    if (m.segmentId === segmentId) {
      results.push({ variable: v, mapping: m });
    } else if (
      segmentText &&
      m.text &&
      m.text.trim() === segmentText.trim() &&
      (!m.method || m.method === "OCR_TEXT")
    ) {
      results.push({ variable: v, mapping: m });
    }
  }
  return results;
}

/**
 * Assigns or updates a variable mapping to an OCR segment with a specified extraction method.
 * Enforces deduplication of identical variable + method + attribute combinations.
 */
export function assignSegmentMapping(
  draft: CollectorDraft,
  captureItemId: string,
  variableId: string,
  segment: { id: string; text?: string; confidence?: number; bbox: Rect },
  regionId: string | undefined,
  method: CollectorExtractionMethod = "OCR_TEXT",
  attribute?: string,
  screenshotBbox?: Rect,
): CollectorDraft {
  const targetVar = draft.variables.find((v) => v.id === variableId);
  if (!targetVar) return draft;

  const cleanAttr = method === "DOM_ATTRIBUTE" ? (attribute?.trim() || "href") : undefined;
  const isOcr = method === "OCR_TEXT";

  // Prevent duplicate mapping of the same variable/method/attribute combination
  const existingExact = targetVar.mappings.find(
    (m) =>
      m.sampleId === captureItemId &&
      m.presence === "mapped" &&
      m.segmentId === segment.id &&
      (m.method || "OCR_TEXT") === method &&
      (m.attribute || undefined) === cleanAttr,
  );
  if (existingExact) {
    return draft;
  }

  const hostRegion = regionId
    ? (draft.regions ?? []).find((r) => r.id === regionId) ??
      (draft.captures ?? []).flatMap((c) => c.regions ?? []).find((r) => r.id === regionId)
    : undefined;

  const newMapping: CollectorVariableMapping = {
    sampleId: captureItemId,
    regionId,
    presence: "mapped",
    confirmed: true,
    method,
    attribute: cleanAttr,
    text: isOcr ? segment.text : undefined,
    confidence: isOcr ? segment.confidence : undefined,
    bbox: screenshotBbox || segment.bbox,
    normalizedBbox: hostRegion
      ? {
          relX: segment.bbox.x / Math.max(1, hostRegion.originalRoi?.width || 300),
          relY: segment.bbox.y / Math.max(1, hostRegion.originalRoi?.height || 60),
          relW: segment.bbox.width / Math.max(1, hostRegion.originalRoi?.width || 300),
          relH: segment.bbox.height / Math.max(1, hostRegion.originalRoi?.height || 60),
        }
      : undefined,
    segmentId: segment.id,
    evidence: isOcr
      ? (draft.teachingCaptureId === captureItemId ? "Manual teaching assignment (Reference)" : "Manual user correction")
      : "Configured / Awaiting DOM Match",
  };

  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const otherMappings = v.mappings.filter(
      (m) => !(m.sampleId === captureItemId && (m.regionId === regionId || !m.regionId)),
    );
    return {
      ...v,
      source: isOcr ? ("ocr_image" as const) : ("visual_dom" as const),
      expectedValue: isOcr ? segment.text : v.expectedValue,
      mappings: [...otherMappings, newMapping],
    };
  });

  let nextRegions = draft.regions;
  if (regionId && draft.regions) {
    nextRegions = draft.regions.map((r) =>
      r.id === regionId
        ? {
            ...r,
            candidateVariableKeys: Array.from(new Set([...r.candidateVariableKeys, targetVar.key])),
            updatedAt: new Date().toISOString(),
          }
        : r,
    );
  }

  return {
    ...draft,
    variables,
    regions: nextRegions,
    dirty: true,
  };
}

// ---------------------------------------------------------------------------
// 9. STAGE 2B CONFIGURATION VALIDATION (C2.10.4)
// ---------------------------------------------------------------------------

export type MappingConfigStatus =
  | "CONFIGURED"
  | "MATCHED"
  | "EXTRACTED"
  | "VALIDATED"
  | "UNMAPPED"
  | "INVALID";

export interface MappingConfigState {
  status: MappingConfigStatus;
  isConfigured: boolean;
  isValid: boolean;
  badgeLabel: string;
  badgeStyle: "neutral" | "info" | "success" | "warning" | "error";
  description: string;
}

/**
 * Validates mapping configuration for Stage 2B.
 * Separates CONFIGURED from MATCHED / EXTRACTED / VALIDATED.
 * Stage 2B only requires configuration completeness (region/segment, attribute name).
 * It does NOT demand that DOM matching has already succeeded.
 */
export function getMappingConfigState(
  mapping: CollectorVariableMapping | undefined,
): MappingConfigState {
  if (!mapping || mapping.presence === "unmapped") {
    return {
      status: "UNMAPPED",
      isConfigured: false,
      isValid: false,
      badgeLabel: "Unmapped",
      badgeStyle: "neutral",
      description: "No mapping assigned to this variable.",
    };
  }

  if (mapping.presence === "not_present") {
    return {
      status: "CONFIGURED",
      isConfigured: true,
      isValid: true,
      badgeLabel: "Not Present",
      badgeStyle: "neutral",
      description: "Explicitly marked not present in this reference.",
    };
  }

  const method = mapping.method || "OCR_TEXT";

  if (method === "OCR_TEXT") {
    const hasSegment = Boolean(
      mapping.segmentId ||
      mapping.observedValueId ||
      (mapping.text && mapping.text.trim().length > 0),
    );
    if (!hasSegment) {
      return {
        status: "INVALID",
        isConfigured: false,
        isValid: false,
        badgeLabel: "Invalid OCR Mapping",
        badgeStyle: "error",
        description: "OCR_TEXT mapping requires a valid OCR segment to be selected.",
      };
    }
    return {
      status: mapping.text ? "EXTRACTED" : "CONFIGURED",
      isConfigured: true,
      isValid: true,
      badgeLabel: mapping.text ? "Mapped (OCR)" : "Configured (OCR)",
      badgeStyle: "success",
      description: mapping.text ? `Extracted text: "${mapping.text}"` : "OCR segment selected.",
    };
  }

  if (method === "DOM_TEXT") {
    const hasRegionOrSegment = Boolean(
      mapping.regionId || mapping.segmentId,
    );
    if (!hasRegionOrSegment) {
      return {
        status: "INVALID",
        isConfigured: false,
        isValid: false,
        badgeLabel: "Missing Anchor Region",
        badgeStyle: "error",
        description: "DOM_TEXT mapping requires an anchor or region to be selected.",
      };
    }
    return {
      status: "CONFIGURED",
      isConfigured: true,
      isValid: true,
      badgeLabel: "Awaiting DOM Match",
      badgeStyle: "info",
      description: "Anchor configured. Live text will be extracted during browser match test.",
    };
  }

  if (method === "DOM_ATTRIBUTE") {
    const hasRegionOrSegment = Boolean(
      mapping.regionId || mapping.segmentId,
    );
    const hasAttribute = Boolean(mapping.attribute && mapping.attribute.trim().length > 0);

    if (!hasRegionOrSegment) {
      return {
        status: "INVALID",
        isConfigured: false,
        isValid: false,
        badgeLabel: "Missing Anchor Region",
        badgeStyle: "error",
        description: "DOM_ATTRIBUTE mapping requires an anchor or region to be selected.",
      };
    }

    if (!hasAttribute) {
      return {
        status: "INVALID",
        isConfigured: false,
        isValid: false,
        badgeLabel: "Missing Attribute Name",
        badgeStyle: "error",
        description: "DOM_ATTRIBUTE mapping requires an attribute name (e.g. href, src).",
      };
    }

    return {
      status: "CONFIGURED",
      isConfigured: true,
      isValid: true,
      badgeLabel: "Awaiting DOM Match",
      badgeStyle: "info",
      description: `Configured for attribute @${mapping.attribute}. Value will be extracted during browser match test.`,
    };
  }

  return {
    status: "CONFIGURED",
    isConfigured: true,
    isValid: true,
    badgeLabel: "Configured",
    badgeStyle: "info",
    description: "Mapping configured.",
  };
}

// ---------------------------------------------------------------------------
// 12. C2.11 MULTI-SAMPLE LEARNED ANCHOR RULE FOUNDATION
// ---------------------------------------------------------------------------

/**
 * C2.11: Multi-sample Learned Anchor Rule Foundation.
 *
 * Aggregates confirmed reference regions across multiple captures into reusable learned rules.
 * - Groups by groupTag + region type (BEGIN / END / FREE).
 * - Identifies stable text tokens vs variable content (author names, timestamps, dynamic numbers).
 * - Extracts stable geometry profile (min/max/average bounds).
 * - Learns common DOM tags, roles, and structural characteristics.
 */
export function buildLearnedAnchorRules(
  draft: CollectorDraft,
): Map<string, LearnedAnchorGroup> {
  const groups = new Map<string, LearnedAnchorGroup>();

  const allRegions: CollectorRegion[] = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ];

  const regionMap = new Map<string, CollectorRegion>();
  for (const r of allRegions) {
    if (!regionMap.has(r.id)) regionMap.set(r.id, r);
  }
  const confirmedRegions = Array.from(regionMap.values()).filter((r) => r.confirmed);

  const tagBuckets = new Map<string, CollectorRegion[]>();
  for (const r of confirmedRegions) {
    const tag = (r.groupTag || (r.type === "FREE" ? "free" : "default")).trim();
    const list = tagBuckets.get(tag) ?? [];
    list.push(r);
    tagBuckets.set(tag, list);
  }

  function tokenize(str: string): string[] {
    return normalizeVietnameseText(str)
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9_\u00C0-\u024F\u1EA0-\u1EF9]/gi, ""))
      .filter((t) => t.length > 1);
  }

  for (const [tag, tagRegions] of tagBuckets.entries()) {
    const beginExamples = tagRegions.filter((r) => r.type === "BEGIN" || (r.type === "STATIC" && r.role === "header"));
    const endExamples = tagRegions.filter((r) => r.type === "END" || (r.type === "STATIC" && r.role === "footer"));
    const freeExamples = tagRegions.filter((r) => r.type === "FREE" || r.type === "DYNAMIC");

    function buildRuleForType(
      type: CollectorRegionType,
      examples: CollectorRegion[],
      defaultRole: CollectorRegionRole,
    ): LearnedAnchorRule | undefined {
      if (examples.length === 0) return undefined;

      const refExamples: AnchorReferenceExample[] = examples.map((ex) => ({
        captureItemId: ex.captureItemId,
        regionId: ex.id,
        originalRoi: ex.originalRoi,
        geometry: { ...ex.geometry },
        role: ex.role,
        domEvidence: ex.domEvidence ? { ...ex.domEvidence } : undefined,
        ocrEvidenceText: ex.ocrEvidence?.text,
        ocrText: ex.ocr?.text,
        candidateVariableKeys: [...(ex.candidateVariableKeys ?? [])],
        referenceImageAsset: ex.referenceImageAsset,
        referenceImage: ex.referenceImage,
      }));

      let minRelX = Infinity, maxRelX = -Infinity, sumRelX = 0;
      let minRelY = Infinity, maxRelY = -Infinity, sumRelY = 0;
      let minRelW = Infinity, maxRelW = -Infinity, sumRelW = 0;
      let minRelH = Infinity, maxRelH = -Infinity, sumRelH = 0;

      for (const ex of examples) {
        const g = ex.geometry;
        minRelX = Math.min(minRelX, g.relX);
        maxRelX = Math.max(maxRelX, g.relX);
        sumRelX += g.relX;

        minRelY = Math.min(minRelY, g.relY);
        maxRelY = Math.max(maxRelY, g.relY);
        sumRelY += g.relY;

        minRelW = Math.min(minRelW, g.relW);
        maxRelW = Math.max(maxRelW, g.relW);
        sumRelW += g.relW;

        minRelH = Math.min(minRelH, g.relH);
        maxRelH = Math.max(maxRelH, g.relH);
        sumRelH += g.relH;
      }
      const n = examples.length;
      const geometryProfile: StableGeometryProfile = {
        minRelX,
        maxRelX,
        avgRelX: sumRelX / n,
        minRelY,
        maxRelY,
        avgRelY: sumRelY / n,
        minRelW,
        maxRelW,
        avgRelW: sumRelW / n,
        minRelH,
        maxRelH,
        avgRelH: sumRelH / n,
      };

      const associatedVars = Array.from(new Set(examples.flatMap((e) => e.candidateVariableKeys ?? [])));

      const sampleTokensMap = new Map<string, Set<string>>();
      const allTokensSet = new Set<string>();

      for (const ex of examples) {
        const sampleId = ex.captureItemId;
        const textToAnalyze = ex.ocr?.text || ex.ocrEvidence?.text || "";
        const tokens = tokenize(textToAnalyze);
        let sampleSet = sampleTokensMap.get(sampleId);
        if (!sampleSet) {
          sampleSet = new Set<string>();
          sampleTokensMap.set(sampleId, sampleSet);
        }
        for (const tok of tokens) {
          sampleSet.add(tok);
          allTokensSet.add(tok);
        }
      }

      const knownVariableValues = new Set<string>();
      for (const v of draft.variables) {
        for (const m of v.mappings) {
          if (m.confirmed && m.text && examples.some((e) => e.captureItemId === m.sampleId && e.id === m.regionId)) {
            for (const t of tokenize(m.text)) {
              knownVariableValues.add(t);
            }
          }
        }
      }

      const stableTokens: string[] = [];
      const variableTokens: string[] = [];

      const sampleCount = sampleTokensMap.size;
      for (const tok of allTokensSet) {
        if (knownVariableValues.has(tok)) {
          variableTokens.push(tok);
          continue;
        }

        if (sampleCount > 1) {
          let count = 0;
          for (const sSet of sampleTokensMap.values()) {
            if (sSet.has(tok)) count++;
          }
          if (count >= 2 || count === sampleCount) {
            stableTokens.push(tok);
          } else {
            variableTokens.push(tok);
          }
        } else {
          if (isAuthorCandidate(tok) && (tok.length > 3 || /^[A-Z]/.test(tok))) {
            variableTokens.push(tok);
          } else {
            stableTokens.push(tok);
          }
        }
      }

      const tagNames = Array.from(new Set(examples.map((e) => e.domEvidence?.tagName).filter(Boolean) as string[]));
      const roles = Array.from(new Set(examples.map((e) => e.domEvidence?.role || e.role).filter(Boolean) as string[]));
      const hasAttributes: string[] = [];
      for (const ex of examples) {
        if (ex.domEvidence?.attributes) {
          for (const attr of Object.keys(ex.domEvidence.attributes)) {
            if (!hasAttributes.includes(attr)) hasAttributes.push(attr);
          }
        }
      }

      return {
        groupTag: tag,
        type,
        role: examples[0]?.role || defaultRole,
        exampleCount: examples.length,
        referenceExamples: refExamples,
        geometryProfile,
        stableTokens,
        variableTokens,
        domProfile: {
          tagNames,
          roles,
          hasAttributes,
        },
        associatedVariableKeys: associatedVars,
      };
    }

    const beginRule = buildRuleForType("BEGIN", beginExamples, "header");
    const endRule = buildRuleForType("END", endExamples, "footer");
    const freeRules: LearnedAnchorRule[] = [];
    if (freeExamples.length > 0) {
      const freeRule = buildRuleForType("FREE", freeExamples, "custom");
      if (freeRule) freeRules.push(freeRule);
    }

    const sampleIds = Array.from(new Set(tagRegions.map((r) => r.captureItemId)));

    groups.set(tag, {
      groupTag: tag,
      beginRule,
      endRule,
      freeRules,
      sampleIds,
    });
  }

  return groups;
}

export interface LearnedVariablesResult {
  variableKeys: string[];
  sampleCount: number;
}

/**
 * C2.11.3: Look up confirmed reference anchors with matching groupTag and region type
 * to inherit candidate variables for new sample teaching.
 *
 * Rules:
 * - Only confirmed reference regions qualify.
 * - Strict type matching: BEGIN never inherits END variables, END never inherits BEGIN variables.
 * - Optional excludeCaptureId prevents inheriting unconfirmed/draft variables from the active capture.
 */
export function getLearnedCandidateVariablesForGroup(
  draft: CollectorDraft,
  groupTag: string | undefined,
  type: CollectorRegionType,
  excludeCaptureId?: string,
): LearnedVariablesResult {
  const normTag = (groupTag || (type === "FREE" ? "free" : "default")).trim().toLowerCase();

  const allRegions: CollectorRegion[] = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ];

  const regionMap = new Map<string, CollectorRegion>();
  for (const r of allRegions) {
    if (!regionMap.has(r.id)) regionMap.set(r.id, r);
  }

  // Filter confirmed reference regions with matching type and groupTag
  const matchingRefs = Array.from(regionMap.values()).filter((r) => {
    if (!r.confirmed) return false;
    if (excludeCaptureId && r.captureItemId === excludeCaptureId) return false;
    if (r.type !== type) return false;
    const rTag = (r.groupTag || (r.type === "FREE" ? "free" : "default")).trim().toLowerCase();
    return rTag === normTag;
  });

  const sampleIds = new Set(matchingRefs.map((r) => r.captureItemId));
  const variableKeySet = new Set<string>();
  const validDraftKeys = new Set((draft.variables ?? []).map((v) => v.key));

  for (const r of matchingRefs) {
    if (r.candidateVariableKeys) {
      for (const vk of r.candidateVariableKeys) {
        if (validDraftKeys.size === 0 || validDraftKeys.has(vk)) {
          variableKeySet.add(vk);
        }
      }
    }
  }

  return {
    variableKeys: Array.from(variableKeySet),
    sampleCount: sampleIds.size,
  };
}

// ---------------------------------------------------------------------------
// 13. C2.11 REGION-BASED QUICK FILL ENGINE
// ---------------------------------------------------------------------------

/**
 * C2.11: Propose variable mappings for a target region using confirmed reference regions.
 *
 * Matching scope: Region Type + Group Tag + Variable Configuration
 * Rules:
 * 1. Learn only from confirmed references.
 * 2. Use target Region's own OCR results (region.ocr).
 * 3. Do not depend on legacy capture-level OCR.
 * 4. Preserve extraction methods and attribute names.
 * 5. Do not copy old OCR segment IDs directly.
 * 6. Find corresponding target segment using OCR characteristics and relative layout.
 * 7. Mark automatic proposals as SUGGESTED (simulatedProposal: true, confirmed: false).
 * 8. Never overwrite existing confirmed manual mappings.
 */
export function proposeRegionQuickFill(
  draft: CollectorDraft,
  targetRegionId: string,
  imageWidth: number = 800,
  imageHeight: number = 600,
): QuickFillResult {
  const targetRegion =
    (draft.regions ?? []).find((r) => r.id === targetRegionId) ??
    (draft.captures ?? []).flatMap((c) => c.regions ?? []).find((r) => r.id === targetRegionId);

  if (!targetRegion || !targetRegion.ocr || !targetRegion.ocr.segments?.length) {
    return { draft, proposals: [], appliedCount: 0 };
  }

  const targetCaptureId = targetRegion.captureItemId;

  const allRegions = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ];
  const regionMap = new Map<string, CollectorRegion>();
  for (const r of allRegions) {
    if (!regionMap.has(r.id)) regionMap.set(r.id, r);
  }

  const confirmedReferences = Array.from(regionMap.values()).filter((r) => {
    if (!r.confirmed || r.captureItemId === targetCaptureId) return false;
    if (r.type !== targetRegion.type) return false;
    if (r.type === "FREE") {
      return (r.role && r.role === targetRegion.role) || r.label === targetRegion.label;
    }
    const refTag = (r.groupTag || "default").trim();
    const targetTag = (targetRegion.groupTag || "default").trim();
    return refTag === targetTag;
  });

  if (confirmedReferences.length === 0) {
    return { draft, proposals: [], appliedCount: 0 };
  }

  const targetCropBox = resolveRegionCropBox(targetRegion, imageWidth, imageHeight);
  const targetW = targetRegion.originalRoi?.width || targetCropBox.box?.width || 300;
  const targetH = targetRegion.originalRoi?.height || targetCropBox.box?.height || 60;
  const targetRoiX = targetRegion.originalRoi?.x ?? targetCropBox.box?.x ?? 0;
  const targetRoiY = targetRegion.originalRoi?.y ?? targetCropBox.box?.y ?? 0;

  const proposals: QuickFillProposal[] = [];
  const assignedSegmentIds = new Set<string>();

  for (const refRegion of confirmedReferences) {
    for (const v of draft.variables) {
      const refMapping = v.mappings.find(
        (m) =>
          m.sampleId === refRegion.captureItemId &&
          m.regionId === refRegion.id &&
          m.presence === "mapped" &&
          m.confirmed,
      );
      if (!refMapping) continue;

      const existingTarget = v.mappings.find(
        (m) => m.sampleId === targetCaptureId && (m.regionId === targetRegion.id || !m.regionId),
      );
      if (existingTarget && existingTarget.confirmed) {
        continue;
      }

      if (proposals.some((p) => p.variableId === v.id)) continue;

      let refRelX = refMapping.normalizedBbox?.relX;
      let refRelY = refMapping.normalizedBbox?.relY;
      if (refRelX == null || refRelY == null) {
        const refCropBox = resolveRegionCropBox(refRegion, imageWidth, imageHeight);
        const refW = refRegion.originalRoi?.width || refCropBox.box?.width || 300;
        const refH = refRegion.originalRoi?.height || refCropBox.box?.height || 60;
        const refX = refRegion.originalRoi?.x ?? refCropBox.box?.x ?? 0;
        const refY = refRegion.originalRoi?.y ?? refCropBox.box?.y ?? 0;
        const localX = refMapping.bbox?.x != null && refMapping.bbox.x >= refX ? refMapping.bbox.x - refX : (refMapping.bbox?.x ?? 0);
        const localY = refMapping.bbox?.y != null && refMapping.bbox.y >= refY ? refMapping.bbox.y - refY : (refMapping.bbox?.y ?? 0);
        refRelX = localX / refW;
        refRelY = localY / refH;
      }

      let bestSeg: (typeof targetRegion.ocr.segments)[0] | null = null;
      let bestScore = -1;
      const reasons: string[] = [];

      for (const cand of targetRegion.ocr.segments) {
        const candRelX = cand.bbox.x / targetW;
        const candRelY = cand.bbox.y / targetH;
        const dist = Math.hypot(candRelX - refRelX, candRelY - refRelY);
        let score = Math.max(0, 70 - Math.round(dist * 90));

        const candReasons: string[] = [`layout proximity (${Math.round((1 - Math.min(1, dist)) * 100)}%)`];

        const isVarAuthor = /author|creator|user|name|tac_gia/i.test(v.key);
        const isVarTime = /time|date|created|timestamp|ngay|gio/i.test(v.key);
        const isVarEngage = /reaction|like|comment|share|count|luot/i.test(v.key);

        if (isVarAuthor && isAuthorCandidate(cand.text)) {
          score += 20;
          candReasons.push("author pattern");
        } else if (isVarTime && isTimestampText(cand.text)) {
          score += 25;
          candReasons.push("timestamp pattern");
        } else if (isVarEngage && isEngagementText(cand.text)) {
          score += 20;
          candReasons.push("engagement pattern");
        }

        if (refMapping.method === "DOM_ATTRIBUTE") {
          score += 15;
          candReasons.push(`attribute @${refMapping.attribute}`);
        } else if (refMapping.method === "DOM_TEXT") {
          score += 10;
          candReasons.push("DOM text");
        }

        if (cand.confidence) {
          score += Math.round((cand.confidence / 100) * 10);
        }

        if (assignedSegmentIds.has(cand.id)) {
          score -= 15;
        }

        if (score > bestScore) {
          bestScore = score;
          bestSeg = cand;
          reasons.length = 0;
          reasons.push(...candReasons);
        }
      }

      if (bestSeg) {
        assignedSegmentIds.add(bestSeg.id);
        const finalConfidence = Math.min(95, Math.max(50, bestScore));

        const screenshotBbox: Rect = {
          x: targetRoiX + bestSeg.bbox.x,
          y: targetRoiY + bestSeg.bbox.y,
          width: bestSeg.bbox.width,
          height: bestSeg.bbox.height,
        };

        const refCapture = (draft.captures ?? []).find((c) => c.id === refRegion.captureItemId);
        const refTitle = refCapture?.captureUrl || `Sample #${refRegion.captureItemId.slice(0, 6)}`;

        proposals.push({
          variableId: v.id,
          variableKey: v.key,
          targetRegionId: targetRegion.id,
          targetSegmentId: bestSeg.id,
          targetSegmentText: bestSeg.text,
          method: refMapping.method || "OCR_TEXT",
          attribute: refMapping.attribute,
          confidence: finalConfidence,
          evidence: `Quick Fill from confirmed ${refRegion.type} [#${refRegion.groupTag || "default"}] (${refTitle}): ${reasons.join(", ")}`,
          bbox: screenshotBbox,
          normalizedBbox: {
            relX: bestSeg.bbox.x / targetW,
            relY: bestSeg.bbox.y / targetH,
            relW: bestSeg.bbox.width / targetW,
            relH: bestSeg.bbox.height / targetH,
          },
          refSampleId: refRegion.captureItemId,
          refRegionId: refRegion.id,
        });
      }
    }
  }

  if (proposals.length === 0) {
    return { draft, proposals: [], appliedCount: 0 };
  }

  let updatedDraft = draft;
  for (const proposal of proposals) {
    updatedDraft = applyQuickFillProposal(updatedDraft, proposal);
  }

  return {
    draft: updatedDraft,
    proposals,
    appliedCount: proposals.length,
  };
}

export function applyQuickFillProposal(
  draft: CollectorDraft,
  proposal: QuickFillProposal,
): CollectorDraft {
  const isOcr = proposal.method === "OCR_TEXT";
  const newMapping: CollectorVariableMapping = {
    sampleId:
      (draft.regions ?? []).find((r) => r.id === proposal.targetRegionId)?.captureItemId ||
      (draft.captures ?? []).flatMap((c) => c.regions ?? []).find((r) => r.id === proposal.targetRegionId)?.captureItemId || "",
    regionId: proposal.targetRegionId,
    presence: "mapped",
    confirmed: false,
    simulatedProposal: true,
    method: proposal.method,
    attribute: proposal.attribute,
    text: isOcr ? proposal.targetSegmentText : undefined,
    confidence: proposal.confidence,
    bbox: proposal.bbox,
    normalizedBbox: proposal.normalizedBbox,
    segmentId: proposal.targetSegmentId,
    evidence: proposal.evidence,
  };

  const variables = draft.variables.map((v) => {
    if (v.id !== proposal.variableId) return v;
    const existing = v.mappings.find(
      (m) => m.sampleId === newMapping.sampleId && (m.regionId === proposal.targetRegionId || !m.regionId),
    );
    if (existing && existing.confirmed) return v;

    const others = v.mappings.filter(
      (m) => !(m.sampleId === newMapping.sampleId && (m.regionId === proposal.targetRegionId || !m.regionId)),
    );
    return {
      ...v,
      source: isOcr ? ("ocr_image" as const) : ("visual_dom" as const),
      mappings: [...others, newMapping],
    };
  });

  const regions = (draft.regions ?? []).map((r) =>
    r.id === proposal.targetRegionId
      ? {
          ...r,
          candidateVariableKeys: Array.from(new Set([...r.candidateVariableKeys, proposal.variableKey])),
          updatedAt: new Date().toISOString(),
        }
      : r,
  );

  return {
    ...draft,
    variables,
    regions,
    dirty: true,
  };
}

export function confirmQuickFillMapping(
  draft: CollectorDraft,
  targetCaptureId: string,
  variableId: string,
  regionId?: string,
): CollectorDraft {
  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const mappings = v.mappings.map((m) => {
      if (m.sampleId === targetCaptureId && (!regionId || m.regionId === regionId)) {
        return {
          ...m,
          confirmed: true,
          simulatedProposal: false,
          evidence: "User accepted Quick Fill suggestion",
        };
      }
      return m;
    });
    return { ...v, mappings };
  });

  return { ...draft, variables, dirty: true };
}

export function rejectQuickFillMapping(
  draft: CollectorDraft,
  targetCaptureId: string,
  variableId: string,
  regionId?: string,
): CollectorDraft {
  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const mappings = v.mappings.filter(
      (m) => !(m.sampleId === targetCaptureId && (!regionId || m.regionId === regionId)),
    );
    return { ...v, mappings };
  });

  return { ...draft, variables, dirty: true };
}

export function proposeQuickFillForCapture(
  draft: CollectorDraft,
  targetCaptureId: string,
  imageWidth: number = 800,
  imageHeight: number = 600,
): CollectorDraft {
  const targetRegions = [
    ...(draft.regions ?? []),
    ...(draft.captures ?? []).flatMap((c) => c.regions ?? []),
  ].filter((r) => r.captureItemId === targetCaptureId && r.ocr?.segments?.length);

  let updatedDraft = draft;
  for (const reg of targetRegions) {
    const res = proposeRegionQuickFill(updatedDraft, reg.id, imageWidth, imageHeight);
    updatedDraft = res.draft;
  }
  return updatedDraft;
}
