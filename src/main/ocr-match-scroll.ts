import type { WebContents } from "electron";
import { TargetNotConfident } from "./target-resolver.js";

// Private isolated JS world: keep one container reference without modifying Facebook DOM.
const WORLD = 1001;
export async function clearOcrSearch(contents: WebContents) {
  await contents.executeJavaScriptInIsolatedWorld(WORLD, [{
    code: "delete globalThis.__creatorOcrScroll",
  }]);
}
export async function advanceOcrSearch(
  contents: WebContents, matchTo: "top" | "middle" | "bottom", zoom: number,
): Promise<{ moved: boolean; reached: boolean; reason?: string }> {
  const progress = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => {
    const visible = el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
        r.right > 0 && r.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(visible);
    const modal = dialogs.at(-1) || null;
    let state = globalThis.__creatorOcrScroll;
    if (!state) {
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
      pool.sort((a,b) => {
        const area = el => {
          const r = el.getBoundingClientRect();
          return Math.max(0, Math.min(innerHeight,r.bottom)-Math.max(0,r.top)) *
            Math.max(0, Math.min(innerWidth,r.right)-Math.max(0,r.left));
        };
        return area(b)-area(a);
      });
      // A modal with no scrollable content must never fall back to the page behind it.
      const el = pool[0] || (!modal ? root : null);
      if (!el) return { blocked: true };
      const fraction = ${JSON.stringify(matchTo)} === 'top' ? 0 : ${JSON.stringify(matchTo)} === 'middle' ? 0.5 : 1;
      const goal = Math.max(0, el.scrollHeight-el.clientHeight) * fraction;
      state = globalThis.__creatorOcrScroll = { el, modal, fraction,
        direction: Math.sign(goal-el.scrollTop), traveled: 0 };
    }
    const el = state.el;
    if (state.modal !== modal || !el.isConnected || !visible(el)) return { blocked: true };
    const before = el.scrollTop;
    const goal = Math.max(0, el.scrollHeight-el.clientHeight) * state.fraction;
    const remaining = (goal-before)*state.direction;
    if (!state.direction || remaining <= 1) return { moved: false, reached: true, reason: "DESTINATION_REACHED" };
    // 200 DIP per capture, also capped by visible height to retain overlap.
    const distance = Math.min(200 / ${zoom}, el.clientHeight * 0.7, remaining);
    el.scrollTo({ top: before + state.direction*distance, behavior: 'instant' });
    const moved = Math.abs(el.scrollTop-before);
    state.traveled += moved;
    return { moved: moved > 0.5, reached: state.traveled >= 8000 / ${zoom},
      reason: moved <= 0.5 ? 'SCROLL_STALLED' : 'SCROLLED',
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, goal };
  })()` }]);
  if (progress.blocked)
    throw new TargetNotConfident("SCROLL_CONTAINER_CHANGED: vùng cuộn/modal đã đổi hoặc không cuộn được; chưa gửi action.");
  return progress;
}
