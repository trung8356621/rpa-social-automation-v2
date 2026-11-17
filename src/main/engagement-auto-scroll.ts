/**
 * Browser-side Engagement auto-scroll for Step 3.
 * Uses saved scroll hint as an initial restore, then live Action Row / Parent geometry
 * to settle Engagement comfortably inside the BrowserCore viewport.
 * Never clicks Like/Comment/Share and never scrolls Admin UI.
 */

export type EngagementScrollHint = {
  frameIndex?: number;
  deltaY?: number;
  observedScrollPx?: number;
  requestedScrollPx?: number;
  scrollTop?: number;
  maxScroll?: number;
  tag?: string;
  role?: string | null;
  wheelPoint?: { x: number; y: number };
};

export function buildEngagementAutoScrollJs(hint?: EngagementScrollHint | null): string {
  const payload = JSON.stringify(hint || null);
  return `(() => {
  const hint = ${payload};
  const parent = window.__rpaPdcSavedParent;
  const row = window.__rpaPdcSavedActionRow;
  const diagnostics = [];
  const maxAdjustments = 10;
  const settleMs = 90;
  const margin = 56;
  if (!parent?.isConnected || !row?.isConnected || !parent.contains(row)) {
    return { ok: false, reason: "PARENT_RUNTIME_MISSING", adjustments: 0, diagnostics: ["Saved Parent/Action Row runtime missing before Engagement auto-scroll."] };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const findScrollAncestor = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const max = node.scrollHeight - node.clientHeight;
      if (max > 1 && /(auto|scroll)/.test(style.overflowY || "")) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const visibility = (rect) => {
    const vw = innerWidth;
    const vh = innerHeight;
    const fullyOutside = rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw;
    const comfortable = rect.top >= margin && rect.bottom <= vh - margin && rect.left < vw && rect.right > 0;
    const partially = !fullyOutside;
    return { fullyOutside, comfortable, partially };
  };
  const matchHintContainer = (preferred) => {
    if (!hint || !hint.tag) return preferred;
    const expectedRole = hint.role || null;
    const candidates = Array.from(document.querySelectorAll("*")).filter((el) => {
      if (el.tagName !== hint.tag) return false;
      if ((el.getAttribute("role") || null) !== expectedRole) return false;
      return el.scrollHeight > el.clientHeight + 1;
    });
    if (!candidates.length) return preferred;
    if (typeof hint.maxScroll === "number") {
      candidates.sort((a, b) => Math.abs((a.scrollHeight - a.clientHeight) - hint.maxScroll) - Math.abs((b.scrollHeight - b.clientHeight) - hint.maxScroll));
    }
    return candidates[0] || preferred;
  };

  const wait = async () => {
    await sleep(settleMs);
    if (document.fonts?.ready) {
      try { await Promise.race([document.fonts.ready, sleep(120)]); } catch (_) {}
    }
  };

  return (async () => {
    let scroller = matchHintContainer(findScrollAncestor(row));
    const beforeRect = rectOf(row);
    const beforeScroll = { tag: scroller.tagName, role: scroller.getAttribute?.("role") || null, scrollTop: scroller.scrollTop, maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight) };
    diagnostics.push("post_identity_runtime_ready");
    if (hint) {
      diagnostics.push("saved_scroll_hint:" + JSON.stringify({
        frameIndex: hint.frameIndex ?? null,
        deltaY: hint.deltaY ?? null,
        observedScrollPx: hint.observedScrollPx ?? null,
        scrollTop: hint.scrollTop ?? null,
        tag: hint.tag ?? null,
        role: hint.role ?? null,
      }));
    } else {
      diagnostics.push("saved_scroll_hint:none");
    }
    diagnostics.push("scrollable_ancestor:" + beforeScroll.tag + (beforeScroll.role ? "[role=" + beforeScroll.role + "]" : "") + " scrollTop=" + Math.round(beforeScroll.scrollTop) + "/" + Math.round(beforeScroll.maxScroll));
    diagnostics.push("action_row_rect_before:" + [Math.round(beforeRect.x), Math.round(beforeRect.y), Math.round(beforeRect.width), Math.round(beforeRect.height)].join(","));

    let adjustments = 0;
    const initial = visibility(beforeRect);
    if (initial.comfortable) {
      return {
        ok: true,
        reason: "ALREADY_VISIBLE",
        adjustments: 0,
        skipped: true,
        scrollable: beforeScroll,
        rowRectBefore: beforeRect,
        rowRectAfter: beforeRect,
        scrollBefore: beforeScroll,
        scrollAfter: beforeScroll,
        visibility: initial,
        diagnostics,
      };
    }

    if (hint && typeof hint.scrollTop === "number" && Number.isFinite(hint.scrollTop)) {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.max(0, Math.min(max, hint.scrollTop));
      if (Math.abs(scroller.scrollTop - nextTop) > 2) {
        scroller.scrollTop = nextTop;
        adjustments += 1;
        diagnostics.push("applied_hint_scrollTop:" + Math.round(nextTop));
        await wait();
        scroller = matchHintContainer(findScrollAncestor(row));
      }
    } else if (hint && typeof hint.observedScrollPx === "number" && hint.observedScrollPx > 0) {
      // Initial hint only: approximate restore when absolute scrollTop is missing.
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const approx = Math.max(0, Math.min(max, hint.observedScrollPx));
      if (Math.abs(scroller.scrollTop - approx) > 8) {
        scroller.scrollTop = approx;
        adjustments += 1;
        diagnostics.push("applied_hint_observedScrollPx:" + Math.round(approx));
        await wait();
        scroller = matchHintContainer(findScrollAncestor(row));
      }
    }

    while (adjustments < maxAdjustments) {
      if (!row.isConnected || !parent.contains(row)) {
        return { ok: false, reason: "PARENT_RUNTIME_MISSING", adjustments, diagnostics: [...diagnostics, "Action Row disconnected during Engagement auto-scroll."] };
      }
      scroller = matchHintContainer(findScrollAncestor(row));
      const rect = rectOf(row);
      const vis = visibility(rect);
      if (vis.comfortable) break;
      const targetY = innerHeight * 0.42;
      const centerY = rect.y + rect.height / 2;
      let delta = centerY - targetY;
      if (Math.abs(delta) < 8) {
        // Nudge slightly when partially clipped near edges.
        if (rect.top < margin) delta = rect.top - margin - 12;
        else if (rect.bottom > innerHeight - margin) delta = rect.bottom - (innerHeight - margin) + 12;
        else break;
      }
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const beforeTop = scroller.scrollTop;
      const nextTop = Math.max(0, Math.min(max, beforeTop + delta));
      if (Math.abs(nextTop - beforeTop) < 1) {
        diagnostics.push("scroll_boundary_reached");
        break;
      }
      scroller.scrollTop = nextTop;
      adjustments += 1;
      diagnostics.push("adjust:" + adjustments + " delta=" + Math.round(delta) + " scrollTop=" + Math.round(beforeTop) + "→" + Math.round(scroller.scrollTop));
      await wait();
    }

    const afterRect = rectOf(row);
    const afterScroll = { tag: scroller.tagName, role: scroller.getAttribute?.("role") || null, scrollTop: scroller.scrollTop, maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight) };
    const finalVis = visibility(afterRect);
    diagnostics.push("action_row_rect_after:" + [Math.round(afterRect.x), Math.round(afterRect.y), Math.round(afterRect.width), Math.round(afterRect.height)].join(","));
    diagnostics.push("scroll_after:" + Math.round(afterScroll.scrollTop) + "/" + Math.round(afterScroll.maxScroll));
    diagnostics.push("visibility:" + (finalVis.comfortable ? "comfortable" : finalVis.partially ? "partial" : "outside"));
    diagnostics.push("adjustments:" + adjustments);

    if (finalVis.fullyOutside) {
      return {
        ok: false,
        reason: "ENGAGEMENT_OUTSIDE_VIEWPORT",
        adjustments,
        skipped: false,
        scrollable: afterScroll,
        rowRectBefore: beforeRect,
        rowRectAfter: afterRect,
        scrollBefore: beforeScroll,
        scrollAfter: afterScroll,
        visibility: finalVis,
        diagnostics: [...diagnostics, "Engagement Action Row still outside viewport after auto-scroll."],
      };
    }

    return {
      ok: true,
      reason: finalVis.comfortable ? "VISIBLE_COMFORTABLE" : "VISIBLE_PARTIAL",
      adjustments,
      skipped: false,
      scrollable: afterScroll,
      rowRectBefore: beforeRect,
      rowRectAfter: afterRect,
      scrollBefore: beforeScroll,
      scrollAfter: afterScroll,
      visibility: finalVis,
      diagnostics,
    };
  })();
})()`;
}
