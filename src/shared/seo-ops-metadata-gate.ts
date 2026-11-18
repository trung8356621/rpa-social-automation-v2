/**
 * Client-side request budget for SEO-OPS metadata GETs.
 * Prevents renderer effect loops from storming the VPS.
 */

export type MetadataEndpoint =
  | "action-tags"
  | "script-requests"
  | "scripts-catalog"
  | "scripts-plan"
  | "session";

export type MetadataGateOptions = {
  /** Soft TTL before a non-force call may hit the network again. */
  ttlMs?: Partial<Record<MetadataEndpoint, number>>;
  /** Max network attempts per endpoint in a rolling window. */
  maxPerWindow?: number;
  windowMs?: number;
  /** Minimum wait after 429/5xx before another network attempt (per endpoint). */
  defaultBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  onBlock?: (info: {
    endpoint: MetadataEndpoint;
    reason: "in_flight" | "ttl" | "budget" | "backoff";
    retryAfterMs?: number;
  }) => void;
};

export type MetadataGateAllow =
  | { allow: true }
  | { allow: false; reason: "in_flight" | "ttl" | "budget" | "backoff"; retryAfterMs?: number };

const DEFAULT_TTL: Record<MetadataEndpoint, number> = {
  "action-tags": 60_000,
  "script-requests": 60_000,
  "scripts-catalog": 60_000,
  "scripts-plan": 60_000,
  session: 120_000,
};

export function createSeoOpsMetadataGate(options: MetadataGateOptions = {}) {
  const ttl = { ...DEFAULT_TTL, ...options.ttlMs };
  const maxPerWindow = options.maxPerWindow ?? 8;
  const windowMs = options.windowMs ?? 60_000;
  const defaultBackoffMs = options.defaultBackoffMs ?? 15_000;
  const maxBackoffMs = options.maxBackoffMs ?? 120_000;
  const now = options.now ?? Date.now;

  const lastSuccessAt = new Map<MetadataEndpoint, number>();
  const backoffUntil = new Map<MetadataEndpoint, number>();
  const backoffMs = new Map<MetadataEndpoint, number>();
  const inFlight = new Map<MetadataEndpoint, Promise<unknown>>();
  const hits: number[] = [];
  const hitsByEndpoint = new Map<MetadataEndpoint, number[]>();
  const diagnostics: Array<{ at: string; endpoint: MetadataEndpoint; reason: string }> = [];

  function prune(list: number[], t: number) {
    while (list.length && t - list[0] > windowMs) list.shift();
  }

  function recordHit(endpoint: MetadataEndpoint) {
    const t = now();
    hits.push(t);
    prune(hits, t);
    const ep = hitsByEndpoint.get(endpoint) ?? [];
    ep.push(t);
    prune(ep, t);
    hitsByEndpoint.set(endpoint, ep);
  }

  function canNetwork(endpoint: MetadataEndpoint, force: boolean): MetadataGateAllow {
    if (inFlight.has(endpoint)) {
      options.onBlock?.({ endpoint, reason: "in_flight" });
      return { allow: false, reason: "in_flight" };
    }
    const t = now();
    const blockedUntil = backoffUntil.get(endpoint) ?? 0;
    if (blockedUntil > t) {
      const retryAfterMs = blockedUntil - t;
      options.onBlock?.({ endpoint, reason: "backoff", retryAfterMs });
      diagnostics.push({ at: new Date(t).toISOString(), endpoint, reason: "backoff" });
      return { allow: false, reason: "backoff", retryAfterMs };
    }
    if (!force) {
      const last = lastSuccessAt.get(endpoint) ?? 0;
      if (last && t - last < ttl[endpoint]) {
        options.onBlock?.({ endpoint, reason: "ttl", retryAfterMs: ttl[endpoint] - (t - last) });
        return { allow: false, reason: "ttl", retryAfterMs: ttl[endpoint] - (t - last) };
      }
    }
    const epHits = hitsByEndpoint.get(endpoint) ?? [];
    prune(epHits, t);
    if (epHits.length >= maxPerWindow) {
      // Force still cannot exceed hard budget — containment over convenience.
      const retryAfterMs = windowMs - (t - epHits[0]);
      options.onBlock?.({ endpoint, reason: "budget", retryAfterMs });
      diagnostics.push({ at: new Date(t).toISOString(), endpoint, reason: "budget" });
      return { allow: false, reason: "budget", retryAfterMs };
    }
    return { allow: true };
  }

  async function run<T>(
    endpoint: MetadataEndpoint,
    work: () => Promise<T>,
    opts?: { force?: boolean },
  ): Promise<{ value: T; fromNetwork: true } | { value?: undefined; fromNetwork: false; blocked: MetadataGateAllow & { allow: false } }> {
    const force = Boolean(opts?.force);
    if (inFlight.has(endpoint)) {
      const shared = inFlight.get(endpoint)! as Promise<T>;
      return { value: await shared, fromNetwork: true };
    }
    const decision = canNetwork(endpoint, force);
    if (!decision.allow) {
      return { fromNetwork: false, blocked: decision };
    }
    recordHit(endpoint);
    const pending = work();
    inFlight.set(endpoint, pending);
    try {
      const value = await pending;
      lastSuccessAt.set(endpoint, now());
      backoffMs.set(endpoint, defaultBackoffMs);
      backoffUntil.delete(endpoint);
      return { value, fromNetwork: true };
    } catch (error) {
      noteFailure(endpoint, error);
      throw error;
    } finally {
      inFlight.delete(endpoint);
    }
  }

  function noteFailure(endpoint: MetadataEndpoint, error: unknown) {
    const raw = String((error as Error)?.message || error || "");
    const is429 = /category=rate_limited|\b429\b/i.test(raw);
    const is5xx = /category=server_error|category=service_unavailable|\b5\d\d\b/i.test(raw);
    const isAuth = /unauthenticated|unauthorized|category=authentication|\b401\b|\b403\b/i.test(raw);
    if (isAuth) {
      // Stop retries until login — long backoff.
      backoffUntil.set(endpoint, now() + maxBackoffMs);
      backoffMs.set(endpoint, maxBackoffMs);
      return;
    }
    if (!is429 && !is5xx) return;
    const retryMatch = /retry-after=(\d+)/i.exec(raw);
    const retryMs = retryMatch ? Number(retryMatch[1]) * 1000 : 0;
    const prev = backoffMs.get(endpoint) ?? defaultBackoffMs;
    const next = Math.min(maxBackoffMs, Math.max(retryMs, prev * (is429 ? 2 : 2)));
    backoffMs.set(endpoint, next);
    backoffUntil.set(endpoint, now() + Math.max(retryMs, next));
  }

  function markSuccess(endpoint: MetadataEndpoint) {
    lastSuccessAt.set(endpoint, now());
    backoffUntil.delete(endpoint);
    backoffMs.set(endpoint, defaultBackoffMs);
  }

  function stats() {
    const t = now();
    prune(hits, t);
    const perEndpoint: Record<string, number> = {};
    for (const [ep, list] of hitsByEndpoint) {
      prune(list, t);
      perEndpoint[ep] = list.length;
    }
    return {
      windowMs,
      hitsInWindow: hits.length,
      perEndpoint,
      backoffUntil: Object.fromEntries(
        [...backoffUntil.entries()].map(([k, v]) => [k, new Date(v).toISOString()]),
      ),
      lastSuccessAt: Object.fromEntries(
        [...lastSuccessAt.entries()].map(([k, v]) => [k, new Date(v).toISOString()]),
      ),
      recentBlocks: diagnostics.slice(-20),
    };
  }

  function resetForTests() {
    lastSuccessAt.clear();
    backoffUntil.clear();
    backoffMs.clear();
    inFlight.clear();
    hits.length = 0;
    hitsByEndpoint.clear();
    diagnostics.length = 0;
  }

  return {
    canNetwork,
    run,
    noteFailure,
    markSuccess,
    stats,
    resetForTests,
    ttlMs: ttl,
  };
}

export type SeoOpsMetadataGate = ReturnType<typeof createSeoOpsMetadataGate>;
