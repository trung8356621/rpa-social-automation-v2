import { randomUUID } from "node:crypto";
import type { CdpDebuggerSession, CdpLease } from "./cdp-debugger-session.js";
import { CollectorCaptureSessionStorage } from "./collector-capture-session-storage.js";
import {
  COLLECTOR_CAPTURE_SCHEMA_VERSION,
  DEFAULT_NETWORK_CAPTURE_FILTERS,
  DEFAULT_NETWORK_CAPTURE_LIMITS,
  emptyCaptureStats,
  type CollectorCaptureSessionRecord,
  type CollectorCaptureStartInput,
  type CollectorCaptureStatus,
  type CollectorNetworkCaptureFilters,
  type CollectorNetworkCaptureLimits,
  type NetworkBodyParseStatus,
  type NetworkRequestMetaRecord,
} from "../shared/collectors/capture-session-types.js";
import { parseNetworkResponseText } from "../shared/collectors/network-body-parse.js";
import { redactHeaders, redactUrl } from "../shared/collectors/network-capture-redaction.js";

type PendingRequest = {
  requestId: string;
  /** Unique per capture occurrence — used for body filenames (survives CDP requestId reuse). */
  artifactId: string;
  method: string;
  url: string;
  /** First-seen request URL (may include query); preferred for redaction evidence. */
  requestUrl: string;
  documentURL?: string;
  timestamp: string;
  wallTime?: number;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  statusCode?: number;
  mimeType?: string;
  contentType?: string;
  responseHeaders: Record<string, string>;
  fromRedirect: boolean;
  redirectedFromRequestId?: string;
  completed: boolean;
  bodyStatus: NetworkBodyParseStatus;
  bodyPath?: string;
  bodyBytes?: number;
  objectCount?: number;
  errorText?: string;
  flushed: boolean;
};

export type CollectorNetworkCaptureOptions = {
  cdp: CdpDebuggerSession;
  storage?: CollectorCaptureSessionStorage;
  projectDir?: string;
};

/**
 * Collector-owned Network Capture engine (C2B.5).
 * Uses the shared CdpDebuggerSession — never attaches a second debugger.
 * Not wired to IPC/BrowserCore in this milestone.
 */
export class CollectorNetworkCapture {
  private readonly cdp: CdpDebuggerSession;
  private readonly storage: CollectorCaptureSessionStorage;
  private status: CollectorCaptureStatus = "idle";
  private lease: CdpLease | undefined;
  private offMessage: (() => void) | undefined;
  private offInvalidation: (() => void) | undefined;
  private session: CollectorCaptureSessionRecord | undefined;
  private pending = new Map<string, PendingRequest>();
  private pendingBodyFetches = 0;
  private bodyFetchQueue: Array<() => void> = [];
  private writeChain: Promise<unknown> = Promise.resolve();
  private quotaExhausted = false;

  constructor(options: CollectorNetworkCaptureOptions) {
    this.cdp = options.cdp;
    this.storage =
      options.storage ??
      new CollectorCaptureSessionStorage(options.projectDir ?? process.cwd());
  }

  getStatus(): {
    status: CollectorCaptureStatus;
    session: CollectorCaptureSessionRecord | undefined;
  } {
    return { status: this.status, session: this.session };
  }

  async start(input: CollectorCaptureStartInput): Promise<CollectorCaptureSessionRecord> {
    if (this.status === "running" || this.status === "stopping") {
      throw new Error("CollectorNetworkCapture: capture already active");
    }
    const captureSessionId = input.captureSessionId ?? randomUUID().replace(/-/g, "");
    const filters: CollectorNetworkCaptureFilters = {
      ...DEFAULT_NETWORK_CAPTURE_FILTERS,
      ...input.filters,
      maxBodyBytes:
        input.filters?.maxBodyBytes ??
        input.limits?.maxBodyBytes ??
        DEFAULT_NETWORK_CAPTURE_FILTERS.maxBodyBytes,
    };
    const limits: CollectorNetworkCaptureLimits = {
      ...DEFAULT_NETWORK_CAPTURE_LIMITS,
      ...input.limits,
      maxBodyBytes: filters.maxBodyBytes ?? DEFAULT_NETWORK_CAPTURE_LIMITS.maxBodyBytes,
    };

    const artifactRoot = this.storage.getSessionDir(captureSessionId);
    const record: CollectorCaptureSessionRecord = {
      schemaVersion: COLLECTOR_CAPTURE_SCHEMA_VERSION,
      captureSessionId,
      browserSessionId: input.browserSessionId,
      sourceUrl: input.sourceUrl,
      cdpGeneration: input.cdpGeneration,
      scriptId: input.scriptId,
      networkPartId: input.networkPartId,
      networkPartVersion: input.networkPartVersion,
      status: "running",
      startedAt: new Date().toISOString(),
      filters,
      limits,
      stats: emptyCaptureStats(),
      artifactRoot,
      diagnostics: [],
    };

    this.pending.clear();
    this.quotaExhausted = false;
    this.session = record;
    this.status = "running";
    await this.storage.ensureSessionLayout(captureSessionId);
    await this.storage.writeSession(record);
    await this.diag("info", "capture_started", "Network capture started");

    try {
      this.offInvalidation = this.cdp.onUnexpectedDetach((info) => {
        void this.handleInvalidation(info.reason ?? "unexpected-detach");
      });
      this.lease = await this.cdp.acquire("collectorNetwork");
      if (this.lease.generation !== input.cdpGeneration) {
        throw new Error(
          `CollectorNetworkCapture: CDP generation mismatch (expected ${input.cdpGeneration}, got ${this.lease.generation})`,
        );
      }
      await this.cdp.enableDomain(this.lease, "Network", {
        maxTotalBufferSize: 50_000_000,
        maxResourceBufferSize: Math.min(limits.maxBodyBytes * 2, 20_000_000),
      });
      this.offMessage = this.cdp.onMessage(this.lease, (_e, method, params) => {
        void this.onCdpEvent(method, params);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failStart(message);
      throw error;
    }

    return structuredClone(record);
  }

  async stop(reason = "stopped"): Promise<CollectorCaptureSessionRecord> {
    if (!this.session) {
      return {
        schemaVersion: COLLECTOR_CAPTURE_SCHEMA_VERSION,
        captureSessionId: "none",
        cdpGeneration: -1,
        status: "idle",
        startedAt: new Date().toISOString(),
        filters: DEFAULT_NETWORK_CAPTURE_FILTERS,
        limits: DEFAULT_NETWORK_CAPTURE_LIMITS,
        stats: emptyCaptureStats(),
        artifactRoot: "",
        diagnostics: [],
      };
    }
    if (this.status !== "running" && this.status !== "stopping") {
      return structuredClone(this.session);
    }
    this.status = "stopping";
    await this.diag("info", "capture_stopping", reason);

    // Flush any completed-but-unflushed metadata without new body fetches.
    for (const pending of this.pending.values()) {
      if (pending.completed && !pending.flushed) {
        await this.flushPending(pending, false);
      }
    }

    this.offMessage?.();
    this.offMessage = undefined;
    this.offInvalidation?.();
    this.offInvalidation = undefined;

    if (this.lease) {
      try {
        if (this.lease.alive) await this.cdp.disableDomain(this.lease, "Network");
      } catch {
        /* ignore */
      }
      await this.lease.release().catch(() => undefined);
      this.lease = undefined;
    }

    const finalStatus: CollectorCaptureStatus =
      this.quotaExhausted || this.session.diagnostics.some((d) => /partial|quota|detach|replaced|destroy/i.test(d))
        ? this.session.status === "failed"
          ? "failed"
          : "partial"
        : reason === "failed"
          ? "failed"
          : "stopped";

    this.session.status = finalStatus;
    this.session.endedAt = new Date().toISOString();
    this.session.stopReason = reason;
    await this.storage.writeSession(this.session);
    this.status = finalStatus;
    const out = structuredClone(this.session);
    this.pending.clear();
    return out;
  }

  private async failStart(message: string): Promise<void> {
    this.offMessage?.();
    this.offMessage = undefined;
    this.offInvalidation?.();
    this.offInvalidation = undefined;
    if (this.lease) {
      await this.lease.release().catch(() => undefined);
      this.lease = undefined;
    }
    if (this.session) {
      this.session.status = "failed";
      this.session.endedAt = new Date().toISOString();
      this.session.stopReason = message;
      this.session.diagnostics.push(message);
      await this.storage.writeSession(this.session).catch(() => undefined);
    }
    this.status = "failed";
  }

  private async handleInvalidation(reason: string): Promise<void> {
    if (this.status !== "running") return;
    await this.diag("error", "session_invalidated", reason);
    if (this.session) {
      this.session.diagnostics.push(`invalidated:${reason}`);
      this.session.status = /destroy/i.test(reason) ? "failed" : "partial";
    }
    await this.stop(reason);
  }

  private async onCdpEvent(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.status !== "running" || !this.session) return;
    if (this.lease && !this.lease.alive) return;

    try {
      if (method === "Network.requestWillBeSent") {
        await this.onRequestWillBeSent(params);
        return;
      }
      if (method === "Network.responseReceived") {
        this.onResponseReceived(params);
        return;
      }
      if (method === "Network.loadingFinished") {
        await this.onLoadingFinished(params);
        return;
      }
      if (method === "Network.loadingFailed") {
        await this.onLoadingFailed(params);
      }
    } catch (error) {
      await this.diag(
        "error",
        "event_handler_failed",
        error instanceof Error ? error.message : String(error),
        typeof params.requestId === "string" ? params.requestId : undefined,
      );
    }
  }

  private async onRequestWillBeSent(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? "");
    if (!requestId || !this.session) return;
    const request = (params.request ?? {}) as Record<string, unknown>;
    const method = String(request.method ?? "GET").toUpperCase();
    const url = String(request.url ?? "");
    const headers = redactHeaders(
      (request.headers ?? {}) as Record<string, unknown>,
    );

    let existing = this.pending.get(requestId);
    const redirectResponse = params.redirectResponse as Record<string, unknown> | undefined;
    // CDP may reuse requestId after a prior request finished — start a new occurrence.
    if (existing && !redirectResponse && (existing.completed || existing.flushed)) {
      this.pending.delete(requestId);
      existing = undefined;
    }
    if (existing && redirectResponse) {
      this.session.stats.redirects += 1;
      existing.fromRedirect = true;
      existing.statusCode = Number(redirectResponse.status) || existing.statusCode;
      existing.mimeType = String(redirectResponse.mimeType ?? existing.mimeType ?? "");
      const rh = redactHeaders(
        (redirectResponse.headers ?? {}) as Record<string, unknown>,
      );
      existing.responseHeaders = { ...existing.responseHeaders, ...rh };
      existing.url = url;
      existing.method = method;
      existing.requestHeaders = headers;
      return;
    }

    if (this.pending.size >= this.session.limits.maxRequestsTracked && !existing) {
      if (!this.quotaExhausted) {
        this.quotaExhausted = true;
        await this.diag(
          "warn",
          "quota_requests",
          `maxRequestsTracked=${this.session.limits.maxRequestsTracked}`,
        );
        this.session.diagnostics.push("quota:maxRequestsTracked");
      }
      return;
    }

    // Optional method/URL filters gate tracking (metadata + body). Empty = track all.
    if (!this.methodAllowed(method) || !this.urlAllowed(url)) return;

    const pending: PendingRequest = {
      requestId,
      artifactId: randomUUID().replace(/-/g, "").slice(0, 16),
      method,
      url,
      requestUrl: url,
      documentURL:
        typeof params.documentURL === "string" ? params.documentURL : undefined,
      timestamp: new Date().toISOString(),
      wallTime: typeof params.wallTime === "number" ? params.wallTime : undefined,
      resourceType:
        typeof params.type === "string" ? params.type : undefined,
      requestHeaders: headers,
      responseHeaders: {},
      fromRedirect: Boolean(redirectResponse),
      completed: false,
      bodyStatus: "not_requested",
      flushed: false,
    };
    this.pending.set(requestId, pending);
    this.session.stats.requestsTracked = Math.max(
      this.session.stats.requestsTracked,
      this.pending.size,
    );
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending || !this.session) return;
    const response = (params.response ?? {}) as Record<string, unknown>;
    pending.statusCode = Number(response.status) || undefined;
    pending.mimeType =
      typeof response.mimeType === "string" ? response.mimeType : undefined;
    const headers = redactHeaders(
      (response.headers ?? {}) as Record<string, unknown>,
    );
    pending.responseHeaders = headers;
    const contentType =
      headers["content-type"] ||
      headers["Content-Type"] ||
      pending.mimeType ||
      "";
    pending.contentType = contentType;
    if (typeof response.url === "string" && response.url) pending.url = response.url;
  }

  private async onLoadingFinished(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending || !this.session) return;
    pending.completed = true;
    const wantBody = this.shouldFetchBody(pending);
    if (!wantBody) {
      pending.bodyStatus =
        pending.bodyStatus === "not_requested" ? "skipped_filter" : pending.bodyStatus;
      this.session.stats.bodiesSkipped += 1;
      await this.flushPending(pending, false);
      return;
    }
    if (this.quotaExhausted) {
      pending.bodyStatus = "skipped_quota";
      this.session.stats.bodiesSkipped += 1;
      await this.flushPending(pending, false);
      return;
    }
    await this.enqueueBodyFetch(async () => {
      if (this.status !== "running" || !this.lease?.alive || !this.session) return;
      await this.fetchAndStoreBody(pending);
    });
  }

  private async onLoadingFailed(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending || !this.session) return;
    pending.completed = true;
    pending.bodyStatus = "failed";
    pending.errorText =
      typeof params.errorText === "string" ? params.errorText : "loadingFailed";
    this.session.stats.loadFailed += 1;
    await this.flushPending(pending, false);
  }

  private shouldFetchBody(pending: PendingRequest): boolean {
    if (!this.session) return false;
    if (!this.methodAllowed(pending.method)) return false;
    if (!this.urlAllowed(pending.url)) return false;
    const contentType = pending.contentType ?? pending.mimeType ?? "";
    const list =
      this.session.filters.bodyContentTypeIncludes ??
      DEFAULT_NETWORK_CAPTURE_FILTERS.bodyContentTypeIncludes ??
      [];
    if (!list.length) return true;
    const lower = contentType.toLowerCase();
    return list.some((part) => lower.includes(part.toLowerCase()));
  }

  private methodAllowed(method: string): boolean {
    const methods = this.session?.filters.methods;
    if (!methods?.length) return true;
    return methods.map((m) => m.toUpperCase()).includes(method.toUpperCase());
  }

  private urlAllowed(url: string): boolean {
    const patterns = this.session?.filters.urlIncludes;
    if (!patterns?.length) return true;
    return patterns.some((p) => url.includes(p));
  }

  private enqueueBodyFetch(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = async () => {
        this.pendingBodyFetches += 1;
        try {
          await task();
        } finally {
          this.pendingBodyFetches -= 1;
          const next = this.bodyFetchQueue.shift();
          if (next) next();
          resolve();
        }
      };
      if (
        this.session &&
        this.pendingBodyFetches >= this.session.limits.maxPendingBodyFetches
      ) {
        this.bodyFetchQueue.push(() => {
          void run();
        });
      } else {
        void run();
      }
    });
  }

  private async fetchAndStoreBody(pending: PendingRequest): Promise<void> {
    if (!this.session || !this.lease?.alive) return;
    try {
      const result = (await this.cdp.sendCommand(this.lease, "Network.getResponseBody", {
        requestId: pending.requestId,
      })) as { body?: string; base64Encoded?: boolean };

      let text = "";
      if (result?.base64Encoded) {
        text = Buffer.from(String(result.body ?? ""), "base64").toString("utf8");
      } else {
        text = String(result?.body ?? "");
      }

      if (!text) {
        pending.bodyStatus = "empty";
        this.session.stats.bodiesSkipped += 1;
        await this.flushPending(pending, false);
        return;
      }

      this.session.stats.bodiesFetched += 1;

      const maxBody = this.session.limits.maxBodyBytes;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBody) {
        pending.bodyStatus = "oversize";
        pending.bodyBytes = bytes;
        this.session.stats.bodiesSkipped += 1;
        await this.diag(
          "warn",
          "body_oversize",
          `requestId=${pending.requestId} bytes=${bytes} max=${maxBody}`,
          pending.requestId,
        );
        await this.flushPending(pending, false);
        return;
      }

      if (
        this.session.stats.totalArtifactBytes + bytes >
        this.session.limits.maxTotalArtifactBytes
      ) {
        this.quotaExhausted = true;
        pending.bodyStatus = "skipped_quota";
        this.session.stats.bodiesSkipped += 1;
        this.session.diagnostics.push("quota:maxTotalArtifactBytes");
        await this.diag(
          "warn",
          "quota_total_bytes",
          `maxTotalArtifactBytes=${this.session.limits.maxTotalArtifactBytes}`,
          pending.requestId,
        );
        await this.flushPending(pending, false);
        return;
      }

      const parsed = parseNetworkResponseText(text);
      pending.bodyStatus = parsed.status === "empty" ? "empty" : parsed.status;
      pending.objectCount = parsed.objectCount;
      if (parsed.status === "json_ok") this.session.stats.parseJsonOk += 1;
      if (parsed.status === "ndjson_ok" || parsed.status === "ndjson_partial") {
        this.session.stats.parseNdjsonOk += 1;
      }
      if (parsed.status === "json_invalid") this.session.stats.parseInvalid += 1;

      const extension =
        parsed.status === "json_ok" ||
        parsed.status === "ndjson_ok" ||
        parsed.status === "ndjson_partial"
          ? "json"
          : "txt";
      const saved = await this.storage.writeResponseBody(
        this.session.captureSessionId,
        pending.artifactId,
        text,
        extension,
      );
      pending.bodyPath = saved.relativePath;
      pending.bodyBytes = saved.bytes;
      this.session.stats.bodiesSaved += 1;
      this.session.stats.totalArtifactBytes += saved.bytes;
      await this.flushPending(pending, false);
    } catch (error) {
      pending.bodyStatus = "unavailable";
      pending.errorText = error instanceof Error ? error.message : String(error);
      this.session.stats.bodiesSkipped += 1;
      await this.diag(
        "warn",
        "body_unavailable",
        pending.errorText,
        pending.requestId,
      );
      await this.flushPending(pending, false);
    }
  }

  private flushPending(pending: PendingRequest, force: boolean): Promise<void> {
    if (pending.flushed && !force) return Promise.resolve();
    pending.flushed = true;
    const session = this.session;
    if (!session) return Promise.resolve();
    const counts = session.stats.bodyStatusCounts ?? (session.stats.bodyStatusCounts = {});
    counts[pending.bodyStatus] = (counts[pending.bodyStatus] ?? 0) + 1;
    const record = this.toMetaRecord(session.captureSessionId, pending);
    return this.enqueueWrite(async () => {
      await this.storage.appendRequestMeta(record);
      // Periodic session.json checkpoint (not every event).
      if (session.stats.bodiesSaved % 10 === 0 || pending.bodyStatus === "failed") {
        await this.storage.writeSession(session);
      }
    });
  }

  private toMetaRecord(
    captureSessionId: string,
    pending: PendingRequest,
  ): NetworkRequestMetaRecord {
    return {
      schemaVersion: COLLECTOR_CAPTURE_SCHEMA_VERSION,
      captureSessionId,
      requestId: pending.requestId,
      artifactId: pending.artifactId,
      documentURL: pending.documentURL,
      method: pending.method,
      url: pending.url,
      urlRedacted: redactUrl(pending.requestUrl || pending.url),
      timestamp: pending.timestamp,
      wallTime: pending.wallTime,
      resourceType: pending.resourceType,
      statusCode: pending.statusCode,
      mimeType: pending.mimeType,
      contentType: pending.contentType,
      fromRedirect: pending.fromRedirect || undefined,
      redirectedFromRequestId: pending.redirectedFromRequestId,
      requestHeadersRedacted: pending.requestHeaders,
      responseHeadersRedacted: pending.responseHeaders,
      bodyStatus: pending.bodyStatus,
      bodyPath: pending.bodyPath,
      bodyBytes: pending.bodyBytes,
      objectCount: pending.objectCount,
      errorText: pending.errorText,
      completed: pending.completed,
    };
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch(async (error) => {
      await this.diag(
        "error",
        "write_failed",
        error instanceof Error ? error.message : String(error),
      );
      if (this.session) {
        this.session.diagnostics.push("write_failed");
        this.session.status = "partial";
      }
    });
  }

  private async diag(
    level: "info" | "warn" | "error",
    code: string,
    message: string,
    requestId?: string,
  ): Promise<void> {
    if (!this.session) return;
    this.session.stats.diagnostics += 1;
    if (level !== "info") this.session.diagnostics.push(`${code}:${message}`);
    await this.enqueueWrite(async () => {
      await this.storage.appendDiagnostic(this.session!.captureSessionId, {
        at: new Date().toISOString(),
        level,
        code,
        message,
        requestId,
      });
    });
  }
}
