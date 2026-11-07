import { SCROLL_CAPTURE_LIMITS } from "./scrolling-capture.js";

export type ExtendRunner<T> = (deltaCssPx: number, signal: AbortSignal) => Promise<T>;

export type GateRequestResult = "started" | "dropped_busy" | "debounced";

/**
 * Serializes scrolling-capture extend requests.
 *
 * C2.5.3: while an extend is running, additional requests are DROPPED
 * (not queued). Wheel bursts are debounced so one gesture → one extend.
 */
export class ScrollExtendGate<T> {
  private running = false;
  private abort: AbortController | null = null;
  private generation = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelPendingDelta: number | null = null;
  private wheelDebounceMs: number;

  constructor(wheelDebounceMs: number = SCROLL_CAPTURE_LIMITS.wheelDebounceMs) {
    this.wheelDebounceMs = wheelDebounceMs;
  }

  get busy(): boolean {
    return this.running;
  }

  setWheelDebounceMs(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.wheelDebounceMs = ms;
  }

  cancel(): void {
    this.clearWheelDebounce();
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.running = false;
  }

  private clearWheelDebounce() {
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.wheelPendingDelta = null;
  }

  /**
   * Immediate extend (ROI edge hold / explicit). Drops if already busy — no follow-up queue.
   */
  async request(deltaCssPx: number, run: ExtendRunner<T>): Promise<T | null> {
    if (this.running) return null;
    return this.runOnce(deltaCssPx, run);
  }

  /**
   * Wheel-at-end: debounce gesture burst, then at most one extend.
   * Wheels during an active extend are ignored (no post-align chain).
   */
  scheduleWheelExtend(
    deltaCssPx: number,
    run: ExtendRunner<T>,
    onStarted?: () => void,
  ): GateRequestResult {
    if (this.running) {
      this.clearWheelDebounce();
      return "dropped_busy";
    }
    const delta = Number.isFinite(deltaCssPx) ? deltaCssPx : SCROLL_CAPTURE_LIMITS.defaultScrollCssPx;
    this.wheelPendingDelta = delta;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      const pending = this.wheelPendingDelta;
      this.wheelPendingDelta = null;
      if (pending == null || this.running) return;
      onStarted?.();
      void this.runOnce(pending, run).catch(() => undefined);
    }, this.wheelDebounceMs);
    return "debounced";
  }

  private async runOnce(deltaCssPx: number, run: ExtendRunner<T>): Promise<T | null> {
    const delta = Number.isFinite(deltaCssPx) ? deltaCssPx : SCROLL_CAPTURE_LIMITS.defaultScrollCssPx;
    if (this.running) return null;
    this.running = true;
    const gen = this.generation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const last = await run(delta, signal);
      if (gen !== this.generation) return null;
      return last;
    } finally {
      if (gen === this.generation) {
        this.running = false;
        this.abort = null;
      }
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

/** Map extend failures to short user-facing copy (no MAD/IPC/geometry jargon). */
export function userFacingExtendError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("boundary") || s.includes("no new content") || s.includes("unchanged")) {
    return "Đã tới cuối trang hoặc không có nội dung mới.";
  }
  if (s.includes("container")) {
    return "Vùng cuộn trang đã đổi. Hủy và Chụp vùng lại.";
  }
  if (s.includes("timeout") || s.includes("timed out")) {
    return "Mở rộng quá lâu — ảnh hiện tại được giữ. Thử cuộn lại.";
  }
  if (s.includes("align") || s.includes("verify") || s.includes("mad") || s.includes("geometry")) {
    return "Không xác minh được vùng mới. Ảnh hiện tại được giữ — thử cuộn lại.";
  }
  if (s.includes("cancelled")) return "";
  // Strip diagnostic suffixes like [ALIGN_FAILED] scroll …
  return raw.replace(/\s*\[[A-Z_]+\][\s\S]*$/, "").trim() || "Không mở rộng được vùng chụp. Thử lại.";
}
