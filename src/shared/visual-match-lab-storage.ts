import type {
  BoundaryDebugRecord,
  BoundaryDebugReport,
  BoundaryStatus,
  ContainerElementInfo,
} from "./boundary-probe.js";
import type { PostIdentity } from "./permalink-adapter.js";
import { PermalinkRuleRegistry, BUILTIN_PERMALINK_RULES, type UserPermalinkRule } from "./permalink-rules.js";

export const STORAGE_SCHEMA_VERSION = "2.0.0";

export function formatFrameFolderName(frameIndex: number): string {
  const safe = Math.max(1, Math.floor(Number(frameIndex) || 1));
  return `frame-${String(safe).padStart(3, "0")}`;
}

export function formatRowFileName(rowIndex: number): string {
  const safe = Math.max(0, Math.floor(Number(rowIndex) || 0));
  return `row-${String(safe).padStart(3, "0")}.png`;
}

export function formatAttemptId(attemptNumber: number): string {
  const safe = Math.max(1, Math.floor(Number(attemptNumber) || 1));
  return `attempt-${String(safe).padStart(3, "0")}`;
}

export function getRelativeFrameDir(frameIndex: number): string {
  return `frames/${formatFrameFolderName(frameIndex)}`;
}

export function getRelativeScreenshotPath(frameIndex: number): string {
  return `${getRelativeFrameDir(frameIndex)}/screenshot.png`;
}

export function getRelativeHighlightedPath(frameIndex: number): string {
  return `${getRelativeFrameDir(frameIndex)}/highlighted.png`;
}

export function getRelativeRowPath(frameIndex: number, rowIndex: number): string {
  return `${getRelativeFrameDir(frameIndex)}/${formatRowFileName(rowIndex)}`;
}

export function getRelativeAttemptDir(frameIndex: number, attemptId: string): string {
  return `${getRelativeFrameDir(frameIndex)}/attempts/${attemptId}`;
}

export function getExpectedFrameEvidenceDisplayPath(
  runId: string,
  frameIndex: number,
  rowIndex = 0,
): string {
  return `scratch/runs/${runId}/${getRelativeRowPath(frameIndex, rowIndex)}`;
}

export interface VisualMatchClassifiedUrl {
  url: string;
  rawUrl?: string;
  canonicalUrl?: string;
  level: number;
  tag: string;
  role: string | null;
  matchedRuleId?: string;
  postId?: string;
  platform?: string;
  scope: "CURRENT_ITEM" | "FEED_NEIGHBOR";
  status: "MATCHED" | "UNRECOGNIZED";
}

export interface VisualMatchStoredAttempt {
  attemptId: string;
  timestamp: string;
  reason: string;
  ruleTested?: { id: string; name: string; template: string };
  boundaryStatus: BoundaryStatus | "NO_ACTION_ROW";
  screenshotPath?: string;
  highlightedPath?: string;
  rowPaths: Record<string, string>;
  rows: VisualMatchStoredRow[];
}

export interface VisualMatchStoredRow {
  rowIndex: number;
  candidateId: string;
  actionRowBbox: { x: number; y: number; width: number; height: number };
  actionRowCssBbox: { x: number; y: number; width: number; height: number };
  matchingScore: number;
  iconCount: number;
  candidateStatus: "NEW_ITEM" | "DUPLICATE" | "NEEDS_ATTENTION" | "COMMENT_ACTION";
  fingerprint: string;
  docY: number;
  hitPoint: { x: number; y: number };
  hitElement?: BoundaryDebugRecord["hitElement"];
  boundaryStatus: BoundaryStatus;
  candidateContainer: ContainerElementInfo | null;
  crossedContainer: ContainerElementInfo | null;
  transitions: BoundaryDebugRecord["transitions"];
  postIdentities: PostIdentity[];
  urls: {
    rawUrls: string[];
    currentItemUrls: VisualMatchClassifiedUrl[];
    feedNeighborUrls: VisualMatchClassifiedUrl[];
  };
  ancestors: BoundaryDebugRecord["ancestors"];
  ownershipEvidence: BoundaryDebugRecord["ownershipEvidence"];
  riskReason: string | null;
  evidencePaths: {
    screenshot?: string;
    highlighted?: string;
    rowEvidence?: string;
  };
  diagnostics: {
    errors: string[];
    warnings: string[];
    notes: string[];
  };
}

export interface VisualMatchStoredFrame {
  frameIndex: number;
  scrollY: number;
  viewportUrl: string;
  captureId?: string;
  browserWebContentsId: number;
  captureStatus: "CAPTURE_PASS" | "CAPTURE_FAIL";
  pipelineStatus: string;
  templateStatus: string;
  detectionStatus: "DETECTION_PASS" | "DETECTION_FAIL" | "DETECTION_BLOCKED";
  boundaryStatus: BoundaryStatus | "NO_ACTION_ROW";
  rawIconMatches: number;
  actionClusters: number;
  rows: VisualMatchStoredRow[];
  evidencePaths: {
    screenshot?: string;
    highlighted?: string;
    rows: Record<string, string>;
  };
  diagnostics: {
    errors: string[];
    warnings: string[];
  };
  attempts?: VisualMatchStoredAttempt[];
  /** Transient base64 inputs during save or hydrated outputs during loadRun */
  screenshotBase64?: string;
  highlightedBase64?: string;
  rowBase64Map?: Record<number, string>;
}

export interface VisualMatchManifestFrameEntry {
  frameIndex: number;
  frameFolder: string;
  scrollY: number;
  boundaryStatus: BoundaryStatus | "NO_ACTION_ROW";
  rowCount: number;
  attemptCount: number;
  evidencePaths: {
    screenshot?: string;
    highlighted?: string;
    rows: string[];
    attempts: string[];
  };
}

export interface VisualMatchRunManifest {
  storageSchemaVersion: string;
  runId: string;
  createdAt: string;
  completedAt: string;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  platform: "facebook" | "threads" | "generic";
  sessionRef: {
    webContentsId: number;
    pageUrl: string;
  };
  viewport: {
    width: number;
    height: number;
    zoom: number;
    dpr: number;
  };
  scrollSettings: {
    overlapRatio: number;
    deltaY: number;
    settleWaitMs: number;
  };
  frameLimit: number;
  configVersion: {
    storageSchemaVersion: string;
    opencvPipelineVersion: string;
    boundaryResolverVersion: string;
    matchMethod: string;
    threshold: number;
    templateStatus: string;
    templatesCalibrated: {
      like: boolean;
      comment: boolean;
      share: boolean;
    };
    rulesCount: number;
    rules: Array<{
      id: string;
      name: string;
      platform: string;
      template: string;
      enabled: boolean;
    }>;
  };
  summary: {
    totalFrames: number;
    totalProbed: number;
    boundaryFoundCount: number;
    boundaryAmbiguousCount: number;
    boundaryNotFoundCount: number;
    noActionRowCount: number;
    jumpedZeroToTwoPlusCount: number;
    jumpedFrames: number[];
  };
  frames: VisualMatchManifestFrameEntry[];
  files: {
    manifest: string;
    result: string;
    pipelineLog: string;
    errorLog: string;
  };
}

export interface VisualMatchRunResult {
  storageSchemaVersion: string;
  runId: string;
  createdAt: string;
  completedAt: string;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  environment: BoundaryDebugReport["environment"];
  totalFrames: number;
  summary: VisualMatchRunManifest["summary"];
  frames: VisualMatchStoredFrame[];
  records: BoundaryDebugRecord[];
}

export interface VisualMatchLogEntry {
  timestamp: string;
  runId: string;
  level: "INFO" | "WARN" | "ERROR";
  stage: "RUN" | "CAPTURE" | "OPENCV" | "BOUNDARY_PROBE" | "STORAGE" | "ATTEMPT";
  frameIndex?: number;
  rowIndex?: number;
  attemptId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface VisualMatchSaveFrameAttemptInput {
  runId: string;
  frameIndex: number;
  rowIndex: number;
  reason: string;
  ruleTested?: { id: string; name: string; template: string };
  record: BoundaryDebugRecord;
  screenshotBase64?: string;
  highlightedBase64?: string;
  customRules?: UserPermalinkRule[];
}

function resolveRelativeFbUrl(rawUrl: string, baseOrigin = "https://www.facebook.com/"): string {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/") || trimmed.startsWith("?")) {
    try {
      return new URL(trimmed, baseOrigin).href;
    } catch {
      return `${baseOrigin.replace(/\/$/, "")}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
    }
  }
  return trimmed;
}

export function classifyAncestorsUrls(
  ancestors: BoundaryDebugRecord["ancestors"],
  boundaryCrossedLevel: number | null,
  rules: UserPermalinkRule[] = BUILTIN_PERMALINK_RULES,
): {
  rawUrls: string[];
  currentItemUrls: VisualMatchClassifiedUrl[];
  feedNeighborUrls: VisualMatchClassifiedUrl[];
} {
  const registry = new PermalinkRuleRegistry(rules);
  const crossed = boundaryCrossedLevel ?? Infinity;

  let inferredBase = "https://www.facebook.com/";
  for (const step of ancestors ?? []) {
    for (const u of step.rawUrls ?? []) {
      const m = /\/groups\/([^/?#]+)\//i.exec(u);
      if (m?.[1]) {
        inferredBase = `https://www.facebook.com/groups/${m[1]}/`;
        break;
      }
    }
    if (inferredBase !== "https://www.facebook.com/") break;
  }

  const allRaw: string[] = [];
  const currentItemUrls: VisualMatchClassifiedUrl[] = [];
  const feedNeighborUrls: VisualMatchClassifiedUrl[] = [];
  const seen = new Set<string>();

  for (const step of ancestors ?? []) {
    const isFeed = step.level >= crossed || step.role === "feed";
    for (const u of step.rawUrls ?? []) {
      if (!u || u.trim() === "#") continue;
      if (!allRaw.includes(u)) allRaw.push(u);
      const fullUrl = resolveRelativeFbUrl(u, inferredBase);
      const match = registry.match(fullUrl) ?? registry.match(u);
      const isMatched = Boolean(match?.ruleId);
      const scope: VisualMatchClassifiedUrl["scope"] = isFeed ? "FEED_NEIGHBOR" : "CURRENT_ITEM";
      const dedupKey = `${scope}:${fullUrl}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const entry: VisualMatchClassifiedUrl = {
        url: fullUrl,
        rawUrl: u !== fullUrl ? u : undefined,
        canonicalUrl: match?.identity?.canonicalUrl,
        level: step.level,
        tag: step.tag,
        role: step.role,
        matchedRuleId: match?.ruleId,
        postId: match?.identity?.postId,
        platform: match?.identity?.platform,
        scope,
        status: isMatched ? "MATCHED" : "UNRECOGNIZED",
      };

      if (isFeed) {
        feedNeighborUrls.push(entry);
      } else {
        currentItemUrls.push(entry);
      }
    }
  }

  return { rawUrls: allRaw, currentItemUrls, feedNeighborUrls };
}
