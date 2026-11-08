import { SCROLL_CAPTURE_LIMITS } from "./scrolling-capture.js";

export type ExtendRunner<T> = (deltaCssPx: number, signal: AbortSignal) => Promise<T>;

export type GateRequestResult = "started" | "dropped_busy" | "debounced";

/** Fired after the gate has fully transitioned to idle (running === false). */
export type GateIdleEvent<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; cancelled?: boolean };

export type GateLifecycle<T> = {
  /** Called when an extend actually starts (running already true). */
  onBusy?: () => void;
  /** Called only after running is cleared — safe to unlock Confirm / clear progress. */
  onIdle?: (event: GateIdleEvent<T>) => void;
};

/**
 * Serializes scrolling-capture extend requests.
 *
 * C2.5.5: gate owns busy/idle lifecycle. UI must unlock from onIdle, never by
 * inspecting busy from inside the runner (busy is still true until run returns).
 */
export class ScrollExtendGate<T> {
  private running = false;
  private abort: AbortController | null = null;
  private generation = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelPendingDelta: number | null = null;
  private wheelDebounceMs: number;
  private lifecycle: GateLifecycle<T> = {};

  constructor(wheelDebounceMs: number = SCROLL_CAPTURE_LIMITS.wheelDebounceMs) {
    this.wheelDebounceMs = wheelDebounceMs;
  }

  get busy(): boolean {
    return this.running;
  }

  setLifecycle(lifecycle: GateLifecycle<T>): void {
    this.lifecycle = lifecycle ?? {};
  }

  setWheelDebounceMs(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.wheelDebounceMs = ms;
  }

  cancel(): void {
    this.clearWheelDebounce();
    const wasRunning = this.running;
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.running = false;
    if (wasRunning) {
      this.lifecycle.onIdle?.({ ok: false, error: new Error("Extend cancelled."), cancelled: true });
    }
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
  scheduleWheelExtend(deltaCssPx: number, run: ExtendRunner<T>): GateRequestResult {
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
    this.lifecycle.onBusy?.();
    let value: T | undefined;
    let error: unknown;
    let succeeded = false;
    try {
      value = await run(delta, signal);
      if (gen !== this.generation) return null;
      succeeded = true;
      return value;
    } catch (e) {
      error = e;
      if (gen !== this.generation) return null;
      throw e;
    } finally {
      if (gen === this.generation) {
        this.running = false;
        this.abort = null;
        // Notify AFTER idle so UI unlock never races with busy===true inside the runner.
        if (succeeded && value !== undefined) {
          this.lifecycle.onIdle?.({ ok: true, value });
        } else if (error !== undefined) {
          this.lifecycle.onIdle?.({ ok: false, error });
        } else {
          this.lifecycle.onIdle?.({ ok: false, error: new Error("Extend cancelled."), cancelled: true });
        }
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
  return raw.replace(/\s*\[[A-Z_]+\][\s\S]*$/, "").trim() || "Không mở rộng được vùng chụp. Thử lại.";
}
