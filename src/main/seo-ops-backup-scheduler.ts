import { retryAfterSeconds } from "../shared/seo-ops-http.js";

export function createSeoOpsBackupScheduler(options: {
  backup: () => Promise<unknown>;
  failed: (error: unknown) => void;
  debounceMs?: number;
  maxBackoffMs?: number;
  initialBackoffMs?: number;
  random?: () => number;
}) {
  const debounceMs = options.debounceMs ?? 750;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const random = options.random ?? Math.random;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  let backoffMs = initialBackoffMs;

  function schedule(delay = debounceMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  }

  function request() {
    dirty = true;
    if (!inFlight) schedule();
  }

  async function flush() {
    if (inFlight || !dirty) return inFlight;
    dirty = false;
    let retryDelay: number | undefined;
    inFlight = (async () => {
      try {
        await options.backup();
        backoffMs = initialBackoffMs;
      } catch (error) {
        dirty = true;
        options.failed(error);
        const serverDelay = (retryAfterSeconds(error) ?? 0) * 1000;
        retryDelay = Math.max(serverDelay, backoffMs + Math.floor(backoffMs * 0.2 * random()));
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      } finally {
        inFlight = undefined;
        if (dirty) schedule(retryDelay ?? debounceMs);
      }
    })();
    return inFlight;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { request, flush, stop, getState: () => ({ dirty, inFlight: Boolean(inFlight), scheduled: Boolean(timer), backoffMs }) };
}
