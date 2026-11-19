/**
 * Collector Capture Session contracts (C2B.5).
 * Isolated from Script Creator / Part Library localStorage payloads.
 * Large bodies live on disk under scratch/collector-capture-sessions/.
 */

export const COLLECTOR_CAPTURE_SCHEMA_VERSION = 1;

export type CollectorCaptureStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "partial"
  | "failed";

export type NetworkBodyParseStatus =
  | "not_requested"
  | "skipped_filter"
  | "skipped_quota"
  | "unavailable"
  | "empty"
  | "raw"
  | "json_ok"
  | "ndjson_ok"
  | "ndjson_partial"
  | "json_invalid"
  | "oversize"
  | "failed";

export type CollectorNetworkCaptureFilters = {
  /** Empty/undefined = any method. */
  methods?: string[];
  /** Substring match against request URL (any match allows). Empty = all URLs for metadata. */
  urlIncludes?: string[];
  /** Content-Type substrings that may persist a body (default: json / ndjson / javascript). */
  bodyContentTypeIncludes?: string[];
  /** Max decoded body bytes to persist per response. */
  maxBodyBytes?: number;
};

export type CollectorNetworkCaptureLimits = {
  maxRequestsTracked: number;
  maxBodyBytes: number;
  maxTotalArtifactBytes: number;
  maxPendingBodyFetches: number;
};

export const DEFAULT_NETWORK_CAPTURE_LIMITS: CollectorNetworkCaptureLimits = {
  maxRequestsTracked: 2000,
  maxBodyBytes: 2_000_000,
  maxTotalArtifactBytes: 80_000_000,
  maxPendingBodyFetches: 8,
};

export const DEFAULT_NETWORK_CAPTURE_FILTERS: Required<
  Pick<CollectorNetworkCaptureFilters, "bodyContentTypeIncludes" | "maxBodyBytes">
> &
  CollectorNetworkCaptureFilters = {
  methods: undefined,
  urlIncludes: undefined,
  /**
   * Substring match on Content-Type / mimeType.
   * Intentionally excludes broad "javascript" — that pulled script assets into body
   * persistence and inflated bodiesSaved without JSON parse success.
   */
  bodyContentTypeIncludes: [
    "json",
    "ndjson",
    "text/plain",
  ],
  maxBodyBytes: DEFAULT_NETWORK_CAPTURE_LIMITS.maxBodyBytes,
};

export type CollectorCaptureStartInput = {
  captureSessionId?: string;
  browserSessionId?: string;
  sourceUrl?: string;
  cdpGeneration: number;
  scriptId?: string;
  networkPartId?: string;
  networkPartVersion?: number;
  filters?: CollectorNetworkCaptureFilters;
  limits?: Partial<CollectorNetworkCaptureLimits>;
};

export type CollectorCaptureSessionStats = {
  requestsTracked: number;
  /** Bodies written to disk (any parse outcome, including json_invalid .txt). */
  bodiesSaved: number;
  /** Body fetch skipped (filter/quota/empty/oversize) or CDP unavailable. */
  bodiesSkipped: number;
  /** CDP getResponseBody returned non-empty text (before persist/skip decision). */
  bodiesFetched: number;
  parseJsonOk: number;
  parseNdjsonOk: number;
  parseInvalid: number;
  loadFailed: number;
  redirects: number;
  totalArtifactBytes: number;
  diagnostics: number;
  /** Per-request final bodyStatus tallies (safe diagnostics). */
  bodyStatusCounts: Partial<Record<NetworkBodyParseStatus, number>>;
};

export function emptyCaptureStats(): CollectorCaptureSessionStats {
  return {
    requestsTracked: 0,
    bodiesSaved: 0,
    bodiesSkipped: 0,
    bodiesFetched: 0,
    parseJsonOk: 0,
    parseNdjsonOk: 0,
    parseInvalid: 0,
    loadFailed: 0,
    redirects: 0,
    totalArtifactBytes: 0,
    diagnostics: 0,
    bodyStatusCounts: {},
  };
}

export type CollectorCaptureSessionRecord = {
  schemaVersion: number;
  captureSessionId: string;
  browserSessionId?: string;
  sourceUrl?: string;
  cdpGeneration: number;
  scriptId?: string;
  networkPartId?: string;
  networkPartVersion?: number;
  status: CollectorCaptureStatus;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  filters: CollectorNetworkCaptureFilters;
  limits: CollectorNetworkCaptureLimits;
  stats: CollectorCaptureSessionStats;
  artifactRoot: string;
  diagnostics: string[];
};

export type NetworkRequestMetaRecord = {
  schemaVersion: number;
  captureSessionId: string;
  /** CDP request id (may be reused across redirects / later occurrences). */
  requestId: string;
  /** Stable unique id for this capture occurrence and body file. */
  artifactId: string;
  documentURL?: string;
  method: string;
  url: string;
  urlRedacted: string;
  timestamp: string;
  wallTime?: number;
  resourceType?: string;
  statusCode?: number;
  mimeType?: string;
  contentType?: string;
  fromRedirect?: boolean;
  redirectedFromRequestId?: string;
  requestHeadersRedacted?: Record<string, string>;
  responseHeadersRedacted?: Record<string, string>;
  bodyStatus: NetworkBodyParseStatus;
  bodyPath?: string;
  bodyBytes?: number;
  objectCount?: number;
  errorText?: string;
  completed: boolean;
};

export type NetworkDiagnosticRecord = {
  at: string;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  requestId?: string;
};
