import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BrowserCore } from "./browser-core.js";
import type { Rect } from "../shared/contracts.js";
import {
  SCROLL_CAPTURE_LIMITS,
  alignExtendFrames,
  assertWithinScrollCaptureLimits,
  type AlignResult,
  type ExtendDiagnostics,
  type ExtendFailureKind,
  type ScrollCapturePhase,
} from "../shared/collectors/scrolling-capture.js";
import { validateRect } from "../shared/geometry.js";

const SCROLL_WORLD = 1002;

export type ScrollCaptureSessionPublic = {
  sessionId: string;
  phase: ScrollCapturePhase;
  width: number;
  height: number;
  frameCount: number;
  dataUrl: string;
  lastAlignScore?: number;
  error?: string;
  browserSessionId?: string;
  url: string;
  lastDiagnostics?: ExtendDiagnostics;
};

type InternalSession = {
  id: string;
  phase: ScrollCapturePhase;
  browserSessionId?: string;
  url: string;
  width: number;
  height: number;
  png: Buffer;
  lastViewportPng: Buffer;
  lastViewportHeight: number;
  frameCount: number;
  lastAlignScore?: number;
  error?: string;
  /** Bound scroll container token in the page isolated world. */
  containerId: string;
  /** Last verified scrollTop for this container (CSS px). */
  verifiedScrollTop: number;
  extendGeneration: number;
  lastDiagnostics?: ExtendDiagnostics;
};

type ScrollProbe = {
  moved: boolean;
  deltaCss: number;
  reason: string;
  scrollBefore: number;
  scrollAfter: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  containerId: string;
  containerOk: boolean;
  containerReplaced: boolean;
};

async function toGray(png: Buffer): Promise<{ width: number; height: number; gray: Uint8Array }> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, gray: new Uint8Array(data) };
}

async function stitchAppend(
  accumulatedPng: Buffer,
  nextPng: Buffer,
  align: Extract<AlignResult, { ok: true }>,
): Promise<{ png: Buffer; width: number; height: number }> {
  const prevMeta = await sharp(accumulatedPng).metadata();
  const nextMeta = await sharp(nextPng).metadata();
  const width = prevMeta.width ?? 0;
  const prevH = prevMeta.height ?? 0;
  const nextH = nextMeta.height ?? 0;
  if (!width || !prevH || !nextH) throw new Error("Invalid stitch dimensions.");

  const skipTop = align.stickyPx + align.overlapPx;
  const sliceH = nextH - skipTop;
  if (sliceH < 1) throw new Error("No new rows to append after overlap removal.");

  const slice = await sharp(nextPng)
    .extract({ left: 0, top: skipTop, width, height: sliceH })
    .png()
    .toBuffer();

  const height = prevH + sliceH;
  const png = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: accumulatedPng, top: 0, left: 0 },
      { input: slice, top: prevH, left: 0 },
    ])
    .png()
    .toBuffer();

  return { png, width, height };
}

function logDiag(d: ExtendDiagnostics) {
  // Structured, no screenshot bytes / credentials.
  console.info("[collector-scroll-capture]", JSON.stringify(d));
}

/** Bind or reuse the session scroll container; scroll by CSS px while view may be hidden. */
export async function scrollBoundContainer(
  browser: BrowserCore,
  opts: { containerId: string; deltaCssPx: number; mode: "scroll" | "restore"; targetScrollTop?: number },
): Promise<ScrollProbe> {
  const delta = Math.max(-2000, Math.min(2000, Math.round(opts.deltaCssPx)));
  const target = opts.targetScrollTop;
  const wc = browser.view.webContents;
  const result = await wc.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [
    {
      code: `(() => {
        const STORE = '__rpaCollectorScrollCapture';
        const visible = (el) => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
            r.right > 0 && r.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const pickContainer = () => {
          const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(visible);
          const modal = dialogs.at(-1) || null;
          const root = document.scrollingElement;
          const scope = modal || document.body;
          const ancestors = [];
          if (modal) {
            for (let el = modal.parentElement; el && el !== document.body && el !== root; el = el.parentElement)
              ancestors.push(el);
          }
          const candidates = [scope, ...ancestors, ...scope.querySelectorAll('*')].filter(el =>
            visible(el) && el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 1 &&
            /auto|scroll/.test(getComputedStyle(el).overflowY));
          const active = document.activeElement;
          const focused = candidates.filter(el => active !== document.body && el.contains(active));
          const pool = focused.length ? focused : candidates;
          pool.sort((a, b) => {
            const area = (el) => {
              const r = el.getBoundingClientRect();
              return Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) *
                Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
            };
            return area(b) - area(a);
          });
          return pool[0] || (!modal ? root : null);
        };
        let store = globalThis[STORE];
        if (!store || store.id !== ${JSON.stringify(opts.containerId)}) {
          const el = pickContainer();
          if (!el) {
            return {
              moved: false, deltaCss: 0, reason: 'NO_SCROLL_CONTAINER',
              scrollBefore: 0, scrollAfter: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
              containerId: ${JSON.stringify(opts.containerId)}, containerOk: false, containerReplaced: true,
            };
          }
          store = globalThis[STORE] = {
            id: ${JSON.stringify(opts.containerId)},
            el,
            tag: el.tagName,
            className: (el.className && String(el.className).slice(0, 80)) || '',
          };
        }
        const el = store.el;
        if (!el || !el.isConnected || !visible(el) || !(el.scrollHeight > el.clientHeight + 1)) {
          delete globalThis[STORE];
          return {
            moved: false, deltaCss: 0, reason: 'CONTAINER_REPLACED',
            scrollBefore: 0, scrollAfter: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
            containerId: ${JSON.stringify(opts.containerId)}, containerOk: false, containerReplaced: true,
          };
        }
        const before = el.scrollTop;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        let after = before;
        if (${JSON.stringify(opts.mode)} === 'restore') {
          const t = Math.max(0, Math.min(max, ${target == null ? "before" : Number(target)}));
          el.scrollTo({ top: t, behavior: 'instant' });
          after = el.scrollTop;
          return {
            moved: Math.abs(after - before) > 0.5,
            deltaCss: after - before,
            reason: Math.abs(after - t) <= 1.5 ? 'RESTORED' : 'RESTORE_IMPRECISE',
            scrollBefore: before,
            scrollAfter: after,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            clientWidth: el.clientWidth || innerWidth,
            containerId: store.id,
            containerOk: true,
            containerReplaced: false,
          };
        }
        const dest = Math.max(0, Math.min(max, before + ${delta}));
        el.scrollTo({ top: dest, behavior: 'instant' });
        after = el.scrollTop;
        const moved = Math.abs(after - before) > 0.5;
        return {
          moved,
          deltaCss: after - before,
          reason: !moved ? (Math.abs(dest - before) < 0.5 ? 'SCROLL_BOUNDARY' : 'SCROLL_STALLED') : 'SCROLLED',
          scrollBefore: before,
          scrollAfter: after,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          clientWidth: el.clientWidth || innerWidth,
          containerId: store.id,
          containerOk: true,
          containerReplaced: false,
        };
      })()`,
    },
  ]);
  return {
    moved: Boolean(result?.moved),
    deltaCss: Number(result?.deltaCss) || 0,
    reason: String(result?.reason || "UNKNOWN"),
    scrollBefore: Number(result?.scrollBefore) || 0,
    scrollAfter: Number(result?.scrollAfter) || 0,
    scrollHeight: Number(result?.scrollHeight) || 0,
    clientHeight: Number(result?.clientHeight) || 0,
    clientWidth: Number(result?.clientWidth) || 0,
    containerId: String(result?.containerId || opts.containerId),
    containerOk: Boolean(result?.containerOk),
    containerReplaced: Boolean(result?.containerReplaced),
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class CollectorScrollCaptureController {
  private sessions = new Map<string, InternalSession>();

  constructor(
    private readonly browser: BrowserCore,
    private readonly assetDir: string,
  ) {}

  private pub(s: InternalSession): ScrollCaptureSessionPublic {
    return {
      sessionId: s.id,
      phase: s.phase,
      width: s.width,
      height: s.height,
      frameCount: s.frameCount,
      dataUrl: `data:image/png;base64,${s.png.toString("base64")}`,
      lastAlignScore: s.lastAlignScore,
      error: s.error,
      browserSessionId: s.browserSessionId,
      url: s.url,
      lastDiagnostics: s.lastDiagnostics,
    };
  }

  private fail(
    s: InternalSession,
    kind: ExtendFailureKind,
    message: string,
    partial?: Partial<ExtendDiagnostics>,
  ): ScrollCaptureSessionPublic {
    s.phase = "FAILED";
    s.error = message;
    s.lastDiagnostics = {
      sessionId: s.id,
      containerId: s.containerId,
      scrollBefore: partial?.scrollBefore ?? s.verifiedScrollTop,
      scrollAfter: partial?.scrollAfter ?? s.verifiedScrollTop,
      scrollDeltaCss: partial?.scrollDeltaCss ?? 0,
      viewportCssWidth: partial?.viewportCssWidth ?? 0,
      viewportCssHeight: partial?.viewportCssHeight ?? 0,
      screenshotWidth: partial?.screenshotWidth ?? s.width,
      screenshotHeight: partial?.screenshotHeight ?? s.lastViewportHeight,
      strategy: partial?.strategy ?? "none",
      score: partial?.score,
      expectedShiftPx: partial?.expectedShiftPx,
      accepted: false,
      failureKind: kind,
      message,
    };
    logDiag(s.lastDiagnostics);
    return this.pub(s);
  }

  async begin(opts: {
    captureId: string;
    browserSessionId?: string;
    url: string;
  }): Promise<ScrollCaptureSessionPublic> {
    this.cancelAll();
    const png = this.browser.captureBuffer(opts.captureId);
    const meta = await sharp(png).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const limit = assertWithinScrollCaptureLimits({
      frameCount: 1,
      width,
      height,
      bufferBytes: png.byteLength,
    });
    if (limit) throw new Error(limit.message);
    const containerId = randomUUID();
    // Bind scroll container (delta 0) and record verified scrollTop without advancing content.
    const bind = await scrollBoundContainer(this.browser, {
      containerId,
      deltaCssPx: 0,
      mode: "scroll",
    });
    if (!bind.containerOk) {
      throw new Error("No scrollable container found for Capture extend. Open the feed and try again.");
    }

    const session: InternalSession = {
      id: randomUUID(),
      phase: "INITIAL_FRAME",
      browserSessionId: opts.browserSessionId,
      url: opts.url,
      width,
      height,
      png,
      lastViewportPng: png,
      lastViewportHeight: height,
      frameCount: 1,
      containerId,
      verifiedScrollTop: bind.scrollAfter,
      extendGeneration: 0,
    };
    this.sessions.set(session.id, session);
    return this.pub(session);
  }

  get(sessionId: string): ScrollCaptureSessionPublic | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.pub(s) : undefined;
  }

  markRoiSelected(sessionId: string) {
    const s = this.require(sessionId);
    if (s.phase === "INITIAL_FRAME" || s.phase === "READY" || s.phase === "ROI_SELECTED" || s.phase === "FAILED") {
      s.phase = "ROI_SELECTED";
      s.error = undefined;
    }
    return this.pub(s);
  }

  async extend(
    sessionId: string,
    deltaCssPx?: number,
  ): Promise<ScrollCaptureSessionPublic> {
    const scrollDelta = deltaCssPx ?? SCROLL_CAPTURE_LIMITS.defaultScrollCssPx;
    const s = this.require(sessionId);
    if (!["ROI_SELECTED", "READY", "FAILED", "EXTENDING"].includes(s.phase)) {
      throw new Error("Select an ROI before scrolling to extend the capture.");
    }
    s.phase = "EXTENDING";
    s.error = undefined;
    const gen = ++s.extendGeneration;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.extendBody(s, scrollDelta, gen),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `Scroll extend timed out after ${SCROLL_CAPTURE_LIMITS.extendTimeoutMs}ms. Last valid image kept.`,
            )),
            SCROLL_CAPTURE_LIMITS.extendTimeoutMs,
          );
        }),
      ]);
      return result;
    } catch (error) {
      // Invalidate late mutations from a timed-out body.
      s.extendGeneration++;
      if (this.sessions.get(sessionId) === s) {
        // Best-effort restore verified scroll after timeout.
        try {
          await scrollBoundContainer(this.browser, {
            containerId: s.containerId,
            deltaCssPx: 0,
            mode: "restore",
            targetScrollTop: s.verifiedScrollTop,
          });
        } catch {
          /* ignore */
        }
        return this.fail(
          s,
          "TIMEOUT",
          error instanceof Error ? error.message : String(error),
        );
      }
      return this.pub(s);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private stillCurrent(s: InternalSession, gen: number): boolean {
    return this.sessions.get(s.id) === s && s.extendGeneration === gen;
  }

  private async extendBody(
    s: InternalSession,
    scrollDelta: number,
    gen: number,
  ): Promise<ScrollCaptureSessionPublic> {
    const limitBefore = assertWithinScrollCaptureLimits({
      frameCount: s.frameCount + 1,
      width: s.width,
      height: s.height,
      bufferBytes: s.png.byteLength,
    });
    if (limitBefore) {
      return this.fail(s, "LIMIT", limitBefore.message);
    }

    const scroll = await scrollBoundContainer(this.browser, {
      containerId: s.containerId,
      deltaCssPx: scrollDelta,
      mode: "scroll",
    });
    if (!this.stillCurrent(s, gen)) return this.pub(s);

    if (scroll.containerReplaced || !scroll.containerOk) {
      return this.fail(s, "CONTAINER_REPLACED", "Scroll container was replaced or became invalid. Select ROI again after re-capture.", {
        scrollBefore: scroll.scrollBefore,
        scrollAfter: scroll.scrollAfter,
        scrollDeltaCss: scroll.deltaCss,
        viewportCssWidth: scroll.clientWidth,
        viewportCssHeight: scroll.clientHeight,
      });
    }

    if (!scroll.moved) {
      return this.fail(
        s,
        "BROWSER_SCROLL_FAILED",
        scroll.reason === "SCROLL_BOUNDARY"
          ? "Reached scroll boundary — no new content."
          : `Browser scroll failed (${scroll.reason}). Last valid image kept.`,
        {
          scrollBefore: scroll.scrollBefore,
          scrollAfter: scroll.scrollAfter,
          scrollDeltaCss: scroll.deltaCss,
          viewportCssWidth: scroll.clientWidth,
          viewportCssHeight: scroll.clientHeight,
        },
      );
    }

    await sleep(SCROLL_CAPTURE_LIMITS.settleMs);
    if (!this.stillCurrent(s, gen)) return this.pub(s);

    const nextCapture = await this.browser.capture({ requireCanonical: false });
    if (!this.stillCurrent(s, gen)) return this.pub(s);
    const nextPng = this.browser.captureBuffer(nextCapture.id);

    const diagBase = {
      scrollBefore: scroll.scrollBefore,
      scrollAfter: scroll.scrollAfter,
      scrollDeltaCss: scroll.deltaCss,
      viewportCssWidth: scroll.clientWidth,
      viewportCssHeight: scroll.clientHeight || s.lastViewportHeight,
      screenshotWidth: nextCapture.width,
      screenshotHeight: nextCapture.height,
    };

    if (nextCapture.width !== s.width) {
      await this.restoreVerified(s);
      return this.fail(s, "LAYOUT_SHIFT", `Viewport width changed (${s.width}→${nextCapture.width}); scroll restored.`, diagBase);
    }

    const prevGray = await toGray(s.lastViewportPng);
    const nextGray = await toGray(nextPng);
    const align = alignExtendFrames({
      prev: prevGray,
      next: nextGray,
      scrollDeltaCss: scroll.deltaCss,
      viewportCssHeight: scroll.clientHeight || prevGray.height,
    });

    if (!align.ok) {
      await this.restoreVerified(s);
      if (!this.stillCurrent(s, gen)) return this.pub(s);
      const kind: ExtendFailureKind =
        align.reason === "NO_NEW_CONTENT"
          ? "SCREENSHOT_UNCHANGED"
          : align.reason === "LAYOUT_SHIFT"
            ? "LAYOUT_SHIFT"
            : "ALIGN_FAILED";
      return this.fail(s, kind, align.message, {
        ...diagBase,
        score: align.score,
        expectedShiftPx: align.expectedShiftPx,
        strategy: "none",
      });
    }

    const stitched = await stitchAppend(s.png, nextPng, align);
    if (!this.stillCurrent(s, gen)) return this.pub(s);

    const memLimit = assertWithinScrollCaptureLimits({
      frameCount: s.frameCount + 1,
      width: stitched.width,
      height: stitched.height,
      bufferBytes: stitched.png.byteLength,
    });
    if (memLimit) {
      await this.restoreVerified(s);
      return this.fail(s, "LIMIT", memLimit.message, diagBase);
    }

    s.png = stitched.png;
    s.width = stitched.width;
    s.height = stitched.height;
    s.lastViewportPng = nextPng;
    s.lastViewportHeight = nextCapture.height;
    s.frameCount += 1;
    s.lastAlignScore = align.score;
    s.verifiedScrollTop = scroll.scrollAfter;
    s.phase = "READY";
    s.error = undefined;
    s.lastDiagnostics = {
      sessionId: s.id,
      containerId: s.containerId,
      ...diagBase,
      strategy: align.strategy,
      score: align.score,
      expectedShiftPx: align.expectedShiftPx,
      accepted: true,
      failureKind: "SUCCESS",
      message: `Appended ${align.newContentPx}px via ${align.strategy} (score ${align.score.toFixed(1)}).`,
    };
    logDiag(s.lastDiagnostics);
    return this.pub(s);
  }

  private async restoreVerified(s: InternalSession) {
    try {
      const restored = await scrollBoundContainer(this.browser, {
        containerId: s.containerId,
        deltaCssPx: 0,
        mode: "restore",
        targetScrollTop: s.verifiedScrollTop,
      });
      if (restored.containerOk && Math.abs(restored.scrollAfter - s.verifiedScrollTop) <= 2) {
        s.verifiedScrollTop = restored.scrollAfter;
      }
    } catch {
      /* keep prior verifiedScrollTop */
    }
  }

  async confirm(
    sessionId: string,
    roi: Rect,
  ): Promise<{ asset: string; roi: Rect; dataUrl: string; environment: { width: number; height: number; zoom: number } }> {
    const s = this.require(sessionId);
    if (!["ROI_SELECTED", "READY", "EXTENDING", "FAILED"].includes(s.phase)) {
      throw new Error("Nothing to confirm.");
    }
    const fitted = validateRect(roi, s.width, s.height);
    const cropped = await sharp(s.png)
      .extract({
        left: fitted.x,
        top: fitted.y,
        width: fitted.width,
        height: fitted.height,
      })
      .png()
      .toBuffer();
    const asset = `${randomUUID()}.png`;
    await writeFile(path.join(this.assetDir, asset), cropped);
    const environment = { width: s.width, height: s.height, zoom: this.browser.zoom };
    s.phase = "CONFIRMED";
    this.sessions.delete(sessionId);
    return {
      asset,
      roi: fitted,
      environment,
      dataUrl: `data:image/png;base64,${cropped.toString("base64")}`,
    };
  }

  cancel(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.extendGeneration++;
      s.phase = "CANCELLED";
      this.sessions.delete(sessionId);
    }
  }

  cancelAll() {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
  }

  cancelIfBrowserSessionChanged(activeBrowserSessionId?: string) {
    for (const [id, s] of this.sessions) {
      if (s.browserSessionId && activeBrowserSessionId && s.browserSessionId !== activeBrowserSessionId) {
        this.cancel(id);
      }
    }
  }

  private require(sessionId: string): InternalSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Scroll capture session expired — capture again.");
    return s;
  }
}

/** @deprecated use scrollBoundContainer — kept name for older imports in tests if any */
export const scrollNestedContainer = async (
  browser: BrowserCore,
  deltaCssPx: number,
) => {
  const id = randomUUID();
  return scrollBoundContainer(browser, { containerId: id, deltaCssPx, mode: "scroll" });
};
