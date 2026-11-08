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
import type { Rect } from "../contracts.js";
import type {
  CollectorDomElement,
  CollectorDomSnapshot,
  CollectorRegion,
  CollectorRegionRole,
  CollectorRegionType,
  CollectorVariable,
  DynamicHtmlExtractionResult,
  LayoutContextKind,
  NormalizedRegionGeometry,
  RegionRelationship,
  VerifiedPostContainer,
} from "./types.js";
import { cryptoRandomId } from "./fixtures.js";
import { normalizeVietnameseText } from "./ocr-learning.js";

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
  ocrText?: string;
  ocrConfidence?: number;
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
    id: cryptoRandomId(),
    captureItemId: opts.captureItemId,
    type: opts.type,
    label: opts.label.trim() || defaultLabelForType(opts.type, groupTag),
    role: opts.role ?? defaultRoleForType(opts.type),
    groupTag,
    geometry: normalizeGeometry(opts.box, opts.imageWidth, opts.imageHeight),
    originalRoi: opts.box,
    candidateVariableKeys: opts.candidateVariableKeys ?? [],
    confirmed: false,
    relationships: opts.relationships ?? [],
    ocrEvidence: opts.ocrText
      ? {
          text: opts.ocrText,
          confidence: opts.ocrConfidence ?? 90,
        }
      : undefined,
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
