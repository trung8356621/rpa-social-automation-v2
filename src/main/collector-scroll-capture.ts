import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BrowserCore } from "./browser-core.js";
import type { Rect } from "../shared/contracts.js";
import {
  SCROLL_CAPTURE_LIMITS,
  alignVerticalFrames,
  assertWithinScrollCaptureLimits,
  type AlignResult,
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
};

type InternalSession = {
  id: string;
  phase: ScrollCapturePhase;
  browserSessionId?: string;
  url: string;
  width: number;
  height: number;
  /** Accumulated PNG buffer (not cropped). */
  png: Buffer;
  /** Last viewport PNG — alignment always uses consecutive viewports, not the tall canvas. */
  lastViewportPng: Buffer;
  lastViewportHeight: number;
  frameCount: number;
  lastAlignScore?: number;
  error?: string;
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

  // Skip sticky + overlap from next; append only verified new rows.
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

/** Probe nested scroll container (Facebook feed) and scroll by CSS px — works while view is hidden. */
export async function scrollNestedContainer(
  browser: BrowserCore,
  deltaCssPx: number,
): Promise<{ moved: boolean; deltaCss: number; reason: string }> {
  const delta = Math.max(-2000, Math.min(2000, Math.round(deltaCssPx)));
  const wc = browser.view.webContents;
  const result = await wc.executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [
    {
      code: `(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
            r.right > 0 && r.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
        };
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
        const el = pool[0] || (!modal ? root : null);
        if (!el) return { moved: false, deltaCss: 0, reason: 'NO_SCROLL_CONTAINER' };
        const before = el.scrollTop;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const target = Math.max(0, Math.min(max, before + ${delta}));
        el.scrollTo({ top: target, behavior: 'instant' });
        const after = el.scrollTop;
        const moved = Math.abs(after - before) > 0.5;
        return {
          moved,
          deltaCss: after - before,
          reason: !moved ? (Math.abs(target - before) < 0.5 ? 'SCROLL_BOUNDARY' : 'SCROLL_STALLED') : 'SCROLLED',
          scrollTop: after,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      })()`,
    },
  ]);
  return {
    moved: Boolean(result?.moved),
    deltaCss: Number(result?.deltaCss) || 0,
    reason: String(result?.reason || "UNKNOWN"),
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
    };
  }

  /** Start from an existing BrowserCore capture buffer (first freeze frame). */
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.extendBody(s, scrollDelta),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `Scroll extend timed out after ${SCROLL_CAPTURE_LIMITS.extendTimeoutMs}ms. Last valid image kept.`,
            )),
            SCROLL_CAPTURE_LIMITS.extendTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (s.phase === "EXTENDING") {
        s.phase = "FAILED";
        s.error = error instanceof Error ? error.message : String(error);
      }
      return this.pub(s);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async extendBody(
    s: InternalSession,
    scrollDelta: number,
  ): Promise<ScrollCaptureSessionPublic> {
    const limitBefore = assertWithinScrollCaptureLimits({
      frameCount: s.frameCount + 1,
      width: s.width,
      height: s.height,
      bufferBytes: s.png.byteLength,
    });
    if (limitBefore) {
      s.phase = "FAILED";
      s.error = limitBefore.message;
      return this.pub(s);
    }

    const scroll = await scrollNestedContainer(this.browser, scrollDelta);
    if (!scroll.moved) {
      s.phase = "FAILED";
      s.error =
        scroll.reason === "SCROLL_BOUNDARY"
          ? "Reached scroll boundary — no new content."
          : `Scroll did not move (${scroll.reason}). Last valid image kept.`;
      return this.pub(s);
    }

    await sleep(SCROLL_CAPTURE_LIMITS.settleMs);

    // Capture next viewport while native view may still be hidden (CDP surface).
    const nextCapture = await this.browser.capture({ requireCanonical: false });
    const nextPng = this.browser.captureBuffer(nextCapture.id);
    if (nextCapture.width !== s.width) {
      s.phase = "FAILED";
      s.error = `Viewport width changed (${s.width}→${nextCapture.width}); abort extend.`;
      return this.pub(s);
    }

    const prevGray = await toGray(s.lastViewportPng);
    const nextGray = await toGray(nextPng);
    const align = alignVerticalFrames(prevGray, nextGray);
    if (!align.ok) {
      s.phase = "FAILED";
      s.error = align.message;
      s.lastAlignScore = align.score;
      return this.pub(s);
    }

    const stitched = await stitchAppend(s.png, nextPng, align);
    const memLimit = assertWithinScrollCaptureLimits({
      frameCount: s.frameCount + 1,
      width: stitched.width,
      height: stitched.height,
      bufferBytes: stitched.png.byteLength,
    });
    if (memLimit) {
      s.phase = "FAILED";
      s.error = memLimit.message;
      return this.pub(s);
    }

    s.png = stitched.png;
    s.width = stitched.width;
    s.height = stitched.height;
    s.lastViewportPng = nextPng;
    s.lastViewportHeight = nextCapture.height;
    s.frameCount += 1;
    s.lastAlignScore = align.score;
    s.phase = "READY";
    s.error = undefined;
    return this.pub(s);
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
