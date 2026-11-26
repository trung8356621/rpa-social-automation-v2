import type { Rect } from "../shared/contracts.js";
import type { WebContents } from "electron";
import { TargetNotConfident } from "./target-resolver.js";
import {
  chooseOcrScrollCandidateIndex,
  computeOcrSearchRegion,
} from "./ocr-scroll-region.js";

// Private isolated JS world: keep one container reference without modifying Facebook DOM.
const WORLD = 1001;
export async function clearOcrSearch(contents: WebContents) {
  await contents.executeJavaScriptInIsolatedWorld(WORLD, [{
    code: "delete globalThis.__creatorOcrScroll",
  }]);
}
export async function advanceOcrSearch(
  contents: WebContents, matchTo: "top" | "middle" | "bottom", zoom: number, start = false, inspect = false, recenterY?: number,
): Promise<{
  moved: boolean;
  reached: boolean;
  reason?: string;
  searchRegion?: Rect;
  deltaYDip?: number;
  scrollTop?: number;
  scrollHeight?: number;
  goal?: number;
}> {
  const progress = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => {
    const chooseOcrScrollCandidateIndex = ${chooseOcrScrollCandidateIndex.toString()};
    const computeOcrSearchRegion = ${computeOcrSearchRegion.toString()};
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
      const elements = [scope, ...ancestors, ...scope.querySelectorAll('*')].filter(el =>
        visible(el) && el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(el).overflowY));
      const active = document.activeElement;
      const metrics = elements.map(el => {
        const r = el.getBoundingClientRect();
        return {
          isModal: el === modal,
          containsFocus: active !== document.body && el.contains(active),
          visibleArea: Math.max(0, Math.min(innerHeight,r.bottom)-Math.max(0,r.top)) *
            Math.max(0, Math.min(innerWidth,r.right)-Math.max(0,r.left)),
        };
      });
      const index = chooseOcrScrollCandidateIndex(metrics);
      // A modal with no scrollable content must never fall back to the page behind it.
      const el = index !== null ? elements[index] : (!modal ? root : null);
      if (!el) return { blocked: true };
      const fraction = ${JSON.stringify(matchTo)} === 'top' ? 1/3 : ${JSON.stringify(matchTo)} === 'middle' ? 2/3 : 1;
      state = globalThis.__creatorOcrScroll = { el, modal, fraction,
        traveled: 0 };
    }
    const el = state.el;
    if (state.modal !== modal || !el.isConnected || !visible(el)) return { blocked: true };
    const before = el.scrollTop;
    const goal = Math.max(0, el.scrollHeight * state.fraction - el.clientHeight);
    const region = () => {
      const scrollBox = el.getBoundingClientRect();
      // Modal OCR covers dialog chrome/footer (e.g. Publish) even when a nested
      // composer pane is the scroll element. Fraction only limits scroll distance.
      return computeOcrSearchRegion({
        zoom: ${zoom},
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        modalBox: state.modal ? (() => {
          const r = state.modal.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        })() : null,
        scrollBox: { left: scrollBox.left, top: scrollBox.top, right: scrollBox.right, bottom: scrollBox.bottom },
        scrollIsPageRoot: el === document.scrollingElement,
      });
    };
    if (${recenterY !== undefined}) {
      const viewport = region();
      const center = (viewport.y+viewport.height/2)/${zoom};
      const delta = Math.max(-400/${zoom},Math.min(400/${zoom},${recenterY ?? 0}/${zoom}-center));
      el.scrollTo({ top: Math.max(0,Math.min(el.scrollHeight-el.clientHeight,before+delta)), behavior: 'instant' });
      const moved = Math.abs(el.scrollTop-before);
      state.traveled += moved;
      return { moved: moved > 0.5, reached: state.traveled >= 8000/${zoom}, reason: 'EDGE_RECENTER',
        deltaYDip: (el.scrollTop-before)*${zoom}, searchRegion: region(), scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, goal };
    }
    if (${inspect}) return { moved: false, reached: false, reason: 'SCAN_REGION', searchRegion: region(),
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, goal };
    if (${start}) {
      el.scrollTo({ top: 0, behavior: 'instant' });
      return { moved: Math.abs(before-el.scrollTop)>0.5, reached: false,
        reason: el.scrollTop <= 1 ? 'SCAN_START' : 'RESET_FAILED', scrollTop: el.scrollTop, goal };
    }
    const remaining = goal-before;
    if (remaining <= 1) return { moved: false, reached: true, reason: "DESTINATION_REACHED",
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, goal, searchRegion: region() };
    // 200 DIP per capture, also capped by visible height to retain overlap.
    const distance = Math.min(200 / ${zoom}, el.clientHeight * 0.7, remaining);
    el.scrollTo({ top: before + distance, behavior: 'instant' });
    const moved = Math.abs(el.scrollTop-before);
    state.traveled += moved;
    return { moved: moved > 0.5, reached: state.traveled >= 8000 / ${zoom},
      reason: moved <= 0.5 ? 'SCROLL_STALLED' : 'SCROLLED',
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, goal };
  })()` }]);
  if (progress.reason === "RESET_FAILED")
    throw new TargetNotConfident("SCAN_RESET_FAILED: không thể về đầu vùng cuộn; chưa gửi action.");
  if (progress.blocked)
    throw new TargetNotConfident("SCROLL_CONTAINER_CHANGED: vùng cuộn/modal đã đổi hoặc không cuộn được; chưa gửi action.");
  return progress;
}
