import {
  resolveBoundaryFromAncestors,
  type BoundaryProbeResult,
  type BoundaryStatus,
  type AncestorStep,
  type ContainerElementInfo,
} from "../../shared/boundary-probe.js";
import {
  FacebookPermalinkAdapter,
  type PostIdentity,
} from "../../shared/permalink-adapter.js";
import {
  PermalinkRuleRegistry,
  type UserPermalinkRule,
} from "../../shared/permalink-rules.js";
import { resolveFullUrl } from "../experiments/visual-match-lab/PermalinkInspector.js";
import {
  extractCandidatePostIdentity,
  deriveFrameBoundaryStatus,
} from "./scroll-sampling.js";
import type {
  LiveCandidate,
  CandidateEvaluationRevision,
  VerificationType,
  CandidateDisplayStatus,
  FrameReport,
} from "./types.js";

export interface UrlConfirmationValidation {
  valid: boolean;
  classification:
    | "POST"
    | "GROUP_MEMBER"
    | "PROFILE"
    | "GROUP_HOME"
    | "TRACKING_ONLY"
    | "UNRECOGNIZED";
  reason?: string;
  postIdentity?: PostIdentity;
}

export function formatContainerSummary(
  container?: ContainerElementInfo | { tag: string; role?: string | null; level: number; rect?: { width: number; height: number } } | null,
): string {
  if (!container) return "Không tìm thấy container";
  const roleStr = container.role ? ` role="${container.role}"` : "";
  const dimStr = container.rect
    ? ` (${Math.round(container.rect.width)}×${Math.round(container.rect.height)})`
    : "";
  return `<${container.tag}${roleStr}> L${container.level}${dimStr}`;
}

/**
 * Validates whether a URL candidate can be accepted as a confirmed Post URL.
 * Strictly distinguishes post URLs from Group Member, Profile, Group Homepage, or tracking-only URLs.
 */
export function validatePostUrlForConfirmation(
  rawUrl: string,
  rules: UserPermalinkRule[] = [],
  basePageUrl = "https://www.facebook.com/",
): UrlConfirmationValidation {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return {
      valid: false,
      classification: "UNRECOGNIZED",
      reason: "URL không được để trống.",
    };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    const full = resolveFullUrl(trimmed, basePageUrl);
    parsed = new URL(full);
  } catch {
    return {
      valid: false,
      classification: "UNRECOGNIZED",
      reason: "URL không hợp lệ hoặc không thể phân tích cú pháp.",
    };
  }

  const pathname = parsed.pathname;

  // 1. Group Member: /groups/{group}/user/{id}/ or /groups/{group}/members
  if (/\/groups\/[^/]+\/(?:user|members)\b/i.test(pathname)) {
    return {
      valid: false,
      classification: "GROUP_MEMBER",
      reason: "URL là trang thành viên nhóm (Group Member), không phải bài viết.",
    };
  }

  // 2. Profile: /profile.php?id=... (without story_fbid) or /{username} (without /posts/ or /permalink/)
  if (/^\/profile\.php\/?$/i.test(pathname) && !parsed.searchParams.has("story_fbid")) {
    return {
      valid: false,
      classification: "PROFILE",
      reason: "URL là trang cá nhân (Profile), không phải bài viết.",
    };
  }

  // Non-post Facebook root sections
  if (
    /^\/(?:notifications|messages|friends|marketplace|watch|gaming|bookmarks|settings|saved)\b/i.test(
      pathname,
    )
  ) {
    return {
      valid: false,
      classification: "PROFILE",
      reason: "URL là trang tiện ích/cá nhân của nền tảng, không phải bài viết.",
    };
  }

  // 3. Tracking-only on root or group feed
  const hasTrackingParam = Array.from(parsed.searchParams.keys()).some(
    (k) => k.startsWith("__cft") || k.startsWith("__tn") || k === "sk" || k === "ref",
  );

  const isGroupHome = /^\/groups\/([^/]+)\/?$/i.test(pathname);

  if ((pathname === "/" || pathname === "") && hasTrackingParam) {
    return {
      valid: false,
      classification: "TRACKING_ONLY",
      reason: "URL chỉ chứa tham số theo dõi (tracking query), không xác định được Post ID.",
    };
  }
  if (isGroupHome && hasTrackingParam && !parsed.searchParams.has("set")) {
    return {
      valid: false,
      classification: "TRACKING_ONLY",
      reason: "URL là trang chủ nhóm chứa tham số tracking (__cft__), không chứa Post ID.",
    };
  }

  // 4. Group Homepage: /groups/{groupId}/ or /groups/{groupId}
  if (isGroupHome) {
    const setParam = parsed.searchParams.get("set");
    const isPhotoPcbOrGm = setParam && /^(?:gm|pcb)\./.test(setParam);
    if (!isPhotoPcbOrGm) {
      return {
        valid: false,
        classification: "GROUP_HOME",
        reason: "URL là trang chủ nhóm (Group Home), không phải bài viết.",
      };
    }
  }

  // 5. Try custom user rules first
  if (rules.length > 0) {
    const registry = new PermalinkRuleRegistry(rules);
    const match = registry.match(parsed.href) ?? registry.match(trimmed);
    if (match && match.identity?.postId) {
      return {
        valid: true,
        classification: "POST",
        postIdentity: match.identity,
      };
    }
  }

  // 6. Try standard platform adapter (Facebook)
  const fbAdapter = new FacebookPermalinkAdapter();
  const identity = fbAdapter.extractPostIdentity(parsed.href, basePageUrl);
  if (identity && identity.postId) {
    return {
      valid: true,
      classification: "POST",
      postIdentity: identity,
    };
  }

  return {
    valid: false,
    classification: "UNRECOGNIZED",
    reason: "URL chưa có Post ID hợp lệ. Hãy kiểm tra hoặc tạo Permalink Rule mới cho mẫu URL này.",
  };
}

export interface ReevaluateCandidateParams {
  candidate: LiveCandidate;
  rules: UserPermalinkRule[];
  confirmedUrl?: string;
  source: "USER_CONFIRMATION" | "RULE_SAVED" | "OFFLINE_REEVALUATION";
  ruleId?: string;
  basePageUrl?: string;
}

export type ReevaluateResult =
  | {
      success: true;
      updatedCandidate: LiveCandidate;
      revision: CandidateEvaluationRevision;
      beforeStatus: BoundaryStatus;
      afterStatus: BoundaryStatus;
      beforeDisplayStatus: CandidateDisplayStatus;
      afterDisplayStatus: CandidateDisplayStatus;
      beforeContainerSummary: string;
      afterContainerSummary: string;
    }
  | {
      success: false;
      error: "INSUFFICIENT_EVIDENCE" | "VALIDATION_FAILED";
      reason: string;
    };

/**
 * Offline Boundary Re-evaluation on ancestor trajectory.
 * Pure logic re-evaluating candidate boundary from evidence without re-probing DOM of the currently open page.
 */
export function reevaluateCandidateBoundaryOffline(
  params: ReevaluateCandidateParams,
): ReevaluateResult {
  const { candidate, rules, confirmedUrl, source, ruleId, basePageUrl = "https://www.facebook.com/" } = params;

  // 1. Evidence availability check
  const rawAncestors =
    candidate.rawEvidence?.ancestorSteps ?? candidate.boundary?.ancestorSteps;
  if (!rawAncestors || rawAncestors.length === 0) {
    return {
      success: false,
      error: "INSUFFICIENT_EVIDENCE",
      reason: "Thiếu dữ liệu ancestor trajectory trong evidence để re-evaluate offline.",
    };
  }

  // Keep raw evidence immutable
  const rawEvidence = candidate.rawEvidence ?? {
    ancestorSteps: rawAncestors,
    initialBoundary: candidate.boundary!,
  };

  // 2. Validate confirmed URL if provided
  let urlValidation: UrlConfirmationValidation | undefined;
  if (confirmedUrl) {
    urlValidation = validatePostUrlForConfirmation(confirmedUrl, rules, basePageUrl);
    if (!urlValidation.valid) {
      return {
        success: false,
        error: "VALIDATION_FAILED",
        reason: urlValidation.reason || "URL không thể xác nhận làm Post URL.",
      };
    }
  }

  const registry = new PermalinkRuleRegistry(rules);
  const fbAdapter = new FacebookPermalinkAdapter();

  // 3. Re-parse raw URLs across ancestors and dedupe post identities
  const updatedSteps: AncestorStep[] = rawAncestors.map((step) => {
    const rawUrls =
      step.rawUrls ?? (step.postIdentities ? step.postIdentities.map((p) => p.rawUrl) : []);
    const posts: PostIdentity[] = [];
    const keys = new Set<string>();

    for (const u of rawUrls) {
      const fullUrl = resolveFullUrl(u, basePageUrl);
      const match = registry.match(fullUrl) ?? registry.match(u);
      let identity: PostIdentity | null = null;
      if (match && match.identity?.postId) {
        identity = match.identity;
      } else {
        identity = fbAdapter.extractPostIdentity(fullUrl, basePageUrl);
      }
      if (identity && identity.postId) {
        const k = `${identity.platform}:${identity.postId}`;
        if (!keys.has(k)) {
          keys.add(k);
          posts.push(identity);
        }
      }
    }

    // If confirmed URL is verified and present in this step (or matches raw URLs), inject confirmed post identity
    if (confirmedUrl && urlValidation?.postIdentity) {
      const confirmedFull = resolveFullUrl(confirmedUrl, basePageUrl);
      const isUrlInStep = rawUrls.some((u) => {
        const full = resolveFullUrl(u, basePageUrl);
        return full === confirmedFull || u === confirmedUrl;
      });
      if (isUrlInStep) {
        const k = `${urlValidation.postIdentity.platform}:${urlValidation.postIdentity.postId}`;
        if (!keys.has(k)) {
          keys.add(k);
          posts.push(urlValidation.postIdentity);
        }
      }
    }

    return {
      ...step,
      postIdentities: posts,
      uniqueKeys: Array.from(keys),
    };
  });

  // 4. Run Boundary Resolver on ancestor trajectory
  const actionPoint = candidate.boundary?.actionPoint ?? {
    x: candidate.bbox.x + 20,
    y: candidate.bbox.y + 10,
  };
  const actionRowRect = {
    x: candidate.bbox.x,
    y: candidate.bbox.y,
    width: candidate.bbox.width,
    height: candidate.bbox.height,
  };

  const newBoundary = resolveBoundaryFromAncestors(
    updatedSteps,
    actionPoint,
    actionRowRect,
  );

  // 5. Compute Before / After statuses
  const beforeStatus: BoundaryStatus = candidate.boundary?.status ?? "BOUNDARY_NOT_FOUND";
  const beforeDisplayStatus: CandidateDisplayStatus =
    candidate.dedupeStatus === "DUPLICATE" || candidate.status === "DUPLICATE"
      ? "DUPLICATE"
      : beforeStatus === "BOUNDARY_FOUND"
        ? "FOUND"
        : "NEEDS_ATTENTION";

  let afterDisplayStatus: CandidateDisplayStatus;
  let nextCandidateStatus: LiveCandidate["status"];

  // Important: DO NOT lose DUPLICATE status
  if (candidate.dedupeStatus === "DUPLICATE" || candidate.status === "DUPLICATE") {
    afterDisplayStatus = "DUPLICATE";
    nextCandidateStatus = "DUPLICATE";
  } else if (newBoundary.status === "BOUNDARY_FOUND") {
    afterDisplayStatus = "FOUND";
    nextCandidateStatus = "NEW_ITEM";
  } else {
    afterDisplayStatus = "NEEDS_ATTENTION";
    nextCandidateStatus = "NEEDS_ATTENTION";
  }

  // 6. Verification types tracking
  const verificationTypes = new Set<VerificationType>(candidate.verificationTypes ?? []);
  if (confirmedUrl && urlValidation?.valid) {
    verificationTypes.add("URL_VERIFIED");
  }
  if (newBoundary.status === "BOUNDARY_FOUND") {
    verificationTypes.add("BOUNDARY_CONFIRMED");
  }

  const matchedPostIdentity =
    extractCandidatePostIdentity(newBoundary) ??
    (urlValidation?.postIdentity
      ? {
          platform: urlValidation.postIdentity.platform,
          postId: urlValidation.postIdentity.postId,
          scope: urlValidation.postIdentity.scope,
          canonicalUrl: urlValidation.postIdentity.canonicalUrl,
          rawUrl: urlValidation.postIdentity.rawUrl,
        }
      : candidate.postIdentity);

  // 7. Record evaluation revision
  const beforeContainerSummary = formatContainerSummary(candidate.boundary?.candidateContainer);
  const afterContainerSummary = formatContainerSummary(newBoundary.candidateContainer);

  const revision: CandidateEvaluationRevision = {
    revisionId: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    source,
    confirmedUrl,
    ruleId,
    beforeStatus,
    afterStatus: newBoundary.status,
    beforeCandidateStatus: beforeDisplayStatus,
    afterCandidateStatus: afterDisplayStatus,
    beforeRiskReason: candidate.boundary?.riskReason ?? null,
    afterRiskReason: newBoundary.riskReason ?? null,
    beforeContainerSummary,
    afterContainerSummary,
    matchedPostIdentity,
    notes: newBoundary.ownershipEvidence?.notes ?? [],
  };

  const updatedCandidate: LiveCandidate = {
    ...candidate,
    rawEvidence,
    boundary: newBoundary,
    boundaryStatus: newBoundary.status,
    status: nextCandidateStatus,
    postIdentity: matchedPostIdentity,
    verificationTypes: Array.from(verificationTypes),
    confirmedUrl: confirmedUrl ?? candidate.confirmedUrl,
    latestRevision: revision,
    evaluationRevisions: [revision, ...(candidate.evaluationRevisions ?? [])],
  };

  return {
    success: true,
    updatedCandidate,
    revision,
    beforeStatus,
    afterStatus: newBoundary.status,
    beforeDisplayStatus,
    afterDisplayStatus,
    beforeContainerSummary,
    afterContainerSummary,
  };
}

/**
 * Updates a single candidate in reports immutably, preserving other candidates and duplicate status,
 * and recalculating the sample's frame boundary status.
 */
export function updateCandidateInReports(
  reports: FrameReport[],
  frameIndex: number,
  candidateIndex: number,
  updatedCandidate: LiveCandidate,
): FrameReport[] {
  return reports.map((frame, fIdx) => {
    if (fIdx !== frameIndex) return frame;
    const nextCandidates = frame.candidates.map((c, cIdx) => {
      if (cIdx !== candidateIndex) return c;
      return updatedCandidate;
    });
    return {
      ...frame,
      candidates: nextCandidates,
      boundaryStatus: deriveFrameBoundaryStatus(nextCandidates),
    };
  });
}
