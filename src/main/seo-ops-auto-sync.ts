/**
 * Debounced / single-flight SEO-OPS Script sync.
 * Does not sync on every keystroke or render — callers must request explicitly after save/login/online.
 */

export type AutoSyncRequest = {
  flowId?: string;
  reason: string;
  immediate?: boolean;
};

export type AutoSyncDeps = {
  /** Fail-closed feature switch. Auto-sync is disabled unless explicitly enabled. */
  enabled?: boolean;
  isAuthenticated: () => boolean;
  /** Full sync (push/pull/skip/conflict). Must be safe to call with same digests (no-op). */
  sync: (opts?: { flowId?: string }) => Promise<unknown>;
  /** Soft status refresh when a full sync is not warranted. */
  refreshStatus?: () => Promise<unknown>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  debounceMs?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
};

export function isSeoOpsAutoSyncEnabled(
  value = process.env.SEO_OPS_AUTO_SYNC_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function createSeoOpsAutoSync(deps: AutoSyncDeps) {
  const enabled = deps.enabled ?? false;
  const debounceMs = deps.debounceMs ?? 1500;
  const pollIntervalMs = deps.pollIntervalMs ?? 120_000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60_000;
  const now = deps.now ?? (() => Date.now());

  let inFlight: Promise<void> | null = null;
  let queued: AutoSyncRequest | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let backoffMs = 1000;
  let offlinePending = false;
  let lastErrorKey = "";
  let lastErrorAt = 0;
  let syncGeneration = 0;
  /** Digests observed after last successful sync — used to avoid push/pull loops in tests/helpers. */
  let lastSuccessAt = 0;

  function log(level: "info" | "warn" | "error", message: string) {
    deps.log?.(level, message);
  }

  function logErrorOnce(message: string) {
    const t = now();
    if (message === lastErrorKey && t - lastErrorAt < 30_000) return;
    lastErrorKey = message;
    lastErrorAt = t;
    log("warn", message);
  }

  function isOfflineError(err: unknown): boolean {
    const msg = String((err as Error)?.message || err || "");
    return /failed to fetch|network_error|econnrefused|enotfound|etimedout|network/i.test(msg);
  }

  function request(req: AutoSyncRequest) {
    if (!enabled) return;
    if (!deps.isAuthenticated() && req.reason !== "online") {
      offlinePending = true;
      queued = { ...queued, ...req, reason: req.reason };
      return;
    }
    queued = {
      flowId: coalesceFlowId(queued?.flowId, req.flowId),
      reason: req.reason,
    };
    if (req.immediate) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      void flush();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, debounceMs);
  }

  function coalesceFlowId(a?: string, b?: string): string | undefined {
    if (!a) return b;
    if (!b) return a;
    if (a === b) return a;
    // Different scripts → full sync
    return undefined;
  }

  async function flush(): Promise<void> {
    if (!enabled) return;
    if (inFlight) return;
    if (!queued && !offlinePending) return;
    if (!deps.isAuthenticated()) {
      offlinePending = true;
      return;
    }
    const job = queued;
    queued = null;
    const gen = ++syncGeneration;
    inFlight = (async () => {
      try {
        await deps.sync(job?.flowId ? { flowId: job.flowId } : undefined);
        backoffMs = 1000;
        offlinePending = false;
        lastSuccessAt = now();
        lastErrorKey = "";
      } catch (err) {
        if (isOfflineError(err)) {
          offlinePending = true;
          logErrorOnce(`SEO-OPS sync offline (${job?.reason ?? "flush"}): giữ thay đổi local`);
        } else {
          logErrorOnce(`SEO-OPS sync failed (${job?.reason ?? "flush"}): ${String((err as Error).message || err)}`);
        }
        scheduleRetry();
      } finally {
        inFlight = null;
        if (gen === syncGeneration && queued) void flush();
      }
    })();
    await inFlight;
  }

  function scheduleRetry() {
    if (!enabled) return;
    if (retryTimer) return;
    const wait = backoffMs;
    backoffMs = Math.min(maxBackoffMs, Math.floor(backoffMs * 2));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!deps.isAuthenticated()) {
        offlinePending = true;
        return;
      }
      request({ reason: "retry", immediate: true, flowId: queued?.flowId });
    }, wait);
  }

  function notifyOnline() {
    if (!enabled) return;
    if (!deps.isAuthenticated()) return;
    if (offlinePending || queued) {
      request({ reason: "online", immediate: true });
    }
  }

  function start() {
    stop();
    if (!enabled) return;
    pollTimer = setInterval(() => {
      if (!deps.isAuthenticated()) return;
      request({ reason: "poll" });
    }, pollIntervalMs);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  return {
    request,
    notifyOnline,
    start,
    stop,
    flush,
    /** Test/introspection helpers */
    getState: () => ({
      enabled,
      offlinePending,
      inFlight: Boolean(inFlight),
      queued,
      polling: Boolean(pollTimer),
      retryScheduled: Boolean(retryTimer),
      backoffMs,
      lastSuccessAt,
      syncGeneration,
    }),
  };
}

export type SeoOpsAutoSync = ReturnType<typeof createSeoOpsAutoSync>;
