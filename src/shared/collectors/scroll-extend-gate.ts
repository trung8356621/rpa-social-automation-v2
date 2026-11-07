import { SCROLL_CAPTURE_LIMITS } from "./scrolling-capture.js";

export type ExtendRunner<T> = (deltaCssPx: number, signal: AbortSignal) => Promise<T>;

/**
 * Serializes scrolling-capture extend requests.
 * Coalesces overlapping wheel/edge input into one follow-up extend.
 * Cancel aborts the in-flight work and drops the queue.
 */
export class ScrollExtendGate<T> {
  private running = false;
  private queuedDelta: number | null = null;
  private abort: AbortController | null = null;
  private generation = 0;

  get busy(): boolean {
    return this.running;
  }

  cancel(): void {
    this.queuedDelta = null;
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.running = false;
  }

  /**
   * @returns last successful result for this burst, or null if cancelled / coalesced into a later run
   */
  async request(deltaCssPx: number, run: ExtendRunner<T>): Promise<T | null> {
    const delta = Number.isFinite(deltaCssPx) ? deltaCssPx : SCROLL_CAPTURE_LIMITS.defaultScrollCssPx;
    if (this.running) {
      this.queuedDelta = (this.queuedDelta ?? 0) + delta;
      return null;
    }
    this.running = true;
    const gen = this.generation;
    let last: T | null = null;
    let nextDelta = delta;
    try {
      while (true) {
        if (gen !== this.generation) return null;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        last = await run(nextDelta, signal);
        if (gen !== this.generation) return null;
        const queued = this.queuedDelta;
        this.queuedDelta = null;
        if (queued == null || Math.abs(queued) < 1) {
          this.running = false;
          this.abort = null;
          return last;
        }
        nextDelta = queued;
      }
    } catch (error) {
      this.running = false;
      this.queuedDelta = null;
      this.abort = null;
      throw error;
    }
  }
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Extend cancelled.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  const onAbort = () => {
    if (timer) clearTimeout(timer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
