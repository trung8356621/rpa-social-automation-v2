import type { BrowserCore } from "./browser-core.js";
import {
  buildBoundaryProbeScript,
  buildRemoveBoundaryHighlightsScript,
  type BoundaryProbeResult,
} from "../shared/boundary-probe.js";

type Point = { x: number; y: number };
type Snapshot = { webContentsId: number; url: string; scrollX: number; scrollY: number };

function inspectScript(point: Point, parent: boolean) {
  return `(() => {
    let el = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    if (${parent} && el) el = el.parentElement;
    if (!el) return null;
    const clickable = el.closest('button,a,[role="button"],[role="link"],input,[tabindex]');
    const article = el.closest('[role="article"],article');
    const nestedArticle = article?.parentElement?.closest('[role="article"],article');
    const comment = el.closest('[aria-label*="comment" i],[aria-label*="bình luận" i],[data-ad-rendering-role="comment"]');
    const rect = el.getBoundingClientRect(); const cr = clickable?.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), ariaLabel: el.getAttribute('aria-label') || '',
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clickable: clickable ? { tag: clickable.tagName.toLowerCase(), role: clickable.getAttribute('role'), ariaLabel: (clickable.getAttribute('aria-label') || clickable.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240), rect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height } } : null,
      context: comment || nestedArticle ? 'comment' : article ? 'post' : 'unknown'
    };
  })()`;
}

export class VisualMatchLabRuntime {
  private captures = new Map<string, Snapshot>();
  constructor(
    private readonly browser: BrowserCore,
    private readonly withVisibleBrowser: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  private async facebook() {
    const wc = this.browser.view.webContents;
    const url = wc.getURL();
    const isFb = /^https:\/\/(?:www\.)?facebook\.com\//i.test(url);
    const isThreads = /^https:\/\/(?:www\.)?threads\.(?:net|com)\//i.test(url);
    if (!isFb && !isThreads) throw new Error("BROWSER_NOT_FACEBOOK: Mở Facebook hoặc Threads trong BrowserCore của Creator V2 trước.");
    const loggedIn = await wc.executeJavaScript(`(() => {
      if (/(?:threads\\.net|threads\\.com)/i.test(location.hostname)) return true;
      return Boolean(
        document.querySelector('[role="navigation"],[role="feed"],[aria-label*="Account" i],[aria-label*="Tài khoản" i]') &&
        !document.querySelector('input[type="password"],form[action*="login"],input[name="email"]')
      );
    })()`);
    if (!loggedIn) throw new Error("FACEBOOK_NOT_LOGGED_IN: Đăng nhập thủ công trong BrowserCore của Creator V2 trước.");
    return wc;
  }
  async state() {
    const wc = await this.facebook();
    return { connected: true, loggedIn: true, webContentsId: wc.id, url: wc.getURL() };
  }
  async capture() {
    const wc = await this.facebook(); const webContentsId = wc.id;
    const capture = await this.withVisibleBrowser(() => this.browser.capture({ requireCanonical: false }));
    if (this.browser.view.webContents.id !== webContentsId) throw new Error("BROWSER_INSTANCE_CHANGED");
    const viewport = await wc.executeJavaScript(`({width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio,url:location.href})`);
    this.captures.clear();
    this.captures.set(capture.id, { webContentsId, url: viewport.url, scrollX: viewport.scrollX, scrollY: viewport.scrollY });
    return { ...capture, webContentsId, viewport };
  }
  private async fresh(captureId: string, webContentsId: number) {
    const expected = this.captures.get(captureId); const wc = await this.facebook();
    if (!expected || expected.webContentsId !== webContentsId || wc.id !== webContentsId) throw new Error("STALE_OR_WRONG_BROWSER_INSTANCE");
    const current = await wc.executeJavaScript(`({url:location.href,scrollX,scrollY})`);
    if (current.url !== expected.url || current.scrollX !== expected.scrollX || current.scrollY !== expected.scrollY) { this.captures.clear(); throw new Error("STALE_VIEWPORT: Capture BrowserCore lại sau navigate/scroll."); }
    return wc;
  }
  async inspect(captureId: string, webContentsId: number, point: Point, parent = false) {
    const wc = await this.fresh(captureId, webContentsId);
    return { webContentsId, element: await wc.executeJavaScript(inspectScript(point, parent)) };
  }
  async highlight(captureId: string, webContentsId: number, point: Point) {
    const wc = await this.fresh(captureId, webContentsId);
    const highlighted = await wc.executeJavaScript(`(() => {
      document.querySelectorAll('[data-visual-match-lab-highlight]').forEach(n => n.remove());
      const el = document.elementFromPoint(${Number(point.x)},${Number(point.y)}); if (!el) return false;
      const r=el.getBoundingClientRect(), box=document.createElement('div'); box.dataset.visualMatchLabHighlight='true';
      Object.assign(box.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',border:'3px solid #ef4444',background:'rgba(239,68,68,.12)',zIndex:'2147483647',pointerEvents:'none'});
      document.documentElement.appendChild(box); return true;
    })()`);
    return { webContentsId, highlighted };
  }
  async probeBoundary(
    captureId: string,
    webContentsId: number,
    point: Point,
    actionRowBbox?: { x: number; y: number; width: number; height: number },
    options?: { highlight?: boolean; captureEvidence?: boolean },
  ): Promise<BoundaryProbeResult & { webContentsId: number; evidenceDataUrl?: string }> {
    const wc = await this.fresh(captureId, webContentsId);
    const shouldHighlight = options?.highlight !== false;
    const script = buildBoundaryProbeScript(point, actionRowBbox, { highlight: shouldHighlight });
    const result = (await wc.executeJavaScript(script)) as BoundaryProbeResult;
    let evidenceDataUrl: string | undefined;

    try {
      if (shouldHighlight && options?.captureEvidence !== false) {
        const evidence = await this.withVisibleBrowser(() => this.browser.capture({ requireCanonical: false }));
        evidenceDataUrl = evidence.dataUrl;
      }
    } finally {
      if (shouldHighlight) {
        await wc.executeJavaScript(buildRemoveBoundaryHighlightsScript());
      }
    }

    return { ...result, webContentsId, evidenceDataUrl };
  }
  async scroll(webContentsId: number, deltaY: number) {
    const wc = await this.facebook();
    if (wc.id !== webContentsId) throw new Error("WRONG_BROWSER_INSTANCE");
    await wc.executeJavaScript(`scrollBy({top:${Number(deltaY) || 0},behavior:'instant'})`);
    this.captures.clear();
    return { webContentsId, scrolled: true };
  }
}
