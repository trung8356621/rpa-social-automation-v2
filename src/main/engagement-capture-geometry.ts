/**
 * Browser-side geometry for Step 3 Engagement capture.
 * Finds the smallest DOM wrapper that contains both the matched Action Row and the
 * count/summary region. Never uses a fixed pixel offset or the full Parent article.
 * Numeric DOM text is used only to locate the summary — never as the OCR result.
 */
export const ENGAGEMENT_CAPTURE_GEOMETRY_JS = `(() => {
  const parent = window.__rpaPdcSavedParent;
  const row = window.__rpaPdcSavedActionRow;
  if (!parent?.isConnected || !row?.isConnected || !parent.contains(row)) {
    return { ok: false, reason: "PARENT_RUNTIME_MISSING" };
  }
  const r = row.getBoundingClientRect();
  const vw = innerWidth;
  const vh = innerHeight;
  const absRow = { x: r.x, y: r.y, width: r.width, height: r.height };
  if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
    return {
      ok: false,
      reason: "ENGAGEMENT_OUTSIDE_VIEWPORT",
      rowRect: absRow,
      diagnostics: ["Action Row is outside the visible BrowserCore viewport."],
    };
  }

  const numberFrom = (raw) => {
    const m = String(raw || "").replace(/\\s+/g, " ").match(/(?:^|[^\\d])(\\d+(?:[.,]\\d+)?)\\s*(?:k|m|b|nghìn|ngàn|triệu|tỷ)?(?=$|[^\\p{L}\\d])/iu);
    return m?.[1] || null;
  };
  const looksLikeCount = (el) => {
    for (const attr of ["aria-label", "title", "data-count", "alt"]) {
      if (numberFrom(el.getAttribute(attr))) return true;
    }
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || "").join(" ");
    return Boolean(numberFrom(own));
  };
  const isSummaryIcon = (el) => {
    if (!(el instanceof Element)) return false;
    if (!el.matches("svg, [role='img'], img")) return false;
    const b = el.getBoundingClientRect();
    return b.width > 2 && b.width <= 48 && b.height > 2 && b.height <= 48;
  };
  const isLargeMedia = (el) => {
    if (!(el instanceof Element)) return false;
    if (!el.matches("img, video, canvas, [data-visualcompletion='media-vc-image']")) return false;
    const b = el.getBoundingClientRect();
    return b.height > 72 || b.width > 140;
  };

  // Structural search: preceding sibling subtrees under shared ancestors up to Parent.
  const summaryRoots = [];
  let cursor = row;
  while (cursor && parent.contains(cursor)) {
    let sib = cursor.previousElementSibling;
    while (sib) {
      summaryRoots.push(sib);
      sib = sib.previousElementSibling;
    }
    if (cursor === parent) break;
    cursor = cursor.parentElement;
  }

  const countEls = [];
  const iconEls = [];
  for (const root of summaryRoots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (!(el instanceof Element)) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2 || b.height > 80) continue;
      if (b.bottom > r.top + 8) continue;
      if (looksLikeCount(el)) countEls.push(el);
      else if (isSummaryIcon(el)) iconEls.push(el);
    }
  }
  // Counts can also live on Action Row labels (e.g. "12 Comments").
  for (const el of [row, ...row.querySelectorAll("[aria-label],[title],[data-count],span,a")]) {
    if (!(el instanceof Element)) continue;
    if (looksLikeCount(el)) countEls.push(el);
  }

  if (!countEls.length) {
    return {
      ok: false,
      reason: "NO_COUNT_REGION",
      rowRect: absRow,
      diagnostics: ["No Engagement count nodes found near Action Row in the matched Parent DOM."],
    };
  }

  const visibleCounts = countEls.filter((el) => {
    const b = el.getBoundingClientRect();
    return b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw;
  });
  if (!visibleCounts.length) {
    return {
      ok: false,
      reason: "ENGAGEMENT_OUTSIDE_VIEWPORT",
      rowRect: absRow,
      diagnostics: ["Engagement counts are outside the visible BrowserCore viewport."],
    };
  }

  // Smallest wrapper that contains Action Row + at least one count node, without post media.
  const maxBand = Math.max(120, r.height + 72);
  const candidates = [];
  let node = row.parentElement;
  while (node && parent.contains(node)) {
    const ownedCounts = visibleCounts.filter((el) => node.contains(el));
    if (ownedCounts.length) {
      const b = node.getBoundingClientRect();
      const countBoxes = ownedCounts.map((el) => el.getBoundingClientRect());
      const bandTop = Math.min(...countBoxes.map((c) => c.top), r.top);
      const junkAbove = bandTop - b.top;
      const bandHeight = Math.max(r.bottom, ...countBoxes.map((c) => c.bottom)) - bandTop;
      const media = Array.from(node.querySelectorAll("img,video,canvas")).some((el) => isLargeMedia(el));
      if (!media && junkAbove <= 28 && bandHeight <= maxBand && b.height <= maxBand + junkAbove + 12) {
        candidates.push({
          node,
          b,
          bandTop,
          bandBottom: Math.max(r.bottom, ...countBoxes.map((c) => c.bottom)),
          area: Math.max(1, b.width) * Math.max(1, bandHeight),
        });
      }
    }
    if (node === parent) break;
    node = node.parentElement;
  }

  if (!candidates.length) {
    return {
      ok: false,
      reason: "NO_COUNT_REGION",
      rowRect: absRow,
      diagnostics: ["No reliable Engagement wrapper containing Action Row + count summary without post media."],
    };
  }

  const best = candidates.sort((a, b) => a.area - b.area || a.b.height - b.b.height)[0];
  const ownedIcons = iconEls.filter((el) => best.node.contains(el));
  const ownedCounts = visibleCounts.filter((el) => best.node.contains(el));
  const boxes = [...ownedCounts, ...ownedIcons].map((el) => el.getBoundingClientRect());
  // Overall Engagement band: counts/icons + Action Row inside the trusted wrapper.
  const selected = {
    left: Math.min(best.b.left, r.left, ...boxes.map((c) => c.left)),
    right: Math.max(best.b.right, r.right, ...boxes.map((c) => c.right)),
    top: Math.min(best.bandTop, ...boxes.map((c) => c.top)),
    bottom: Math.max(best.bandBottom, r.bottom, ...boxes.map((c) => c.bottom)),
  };
  // Never expand above the trusted wrapper or into media territory.
  selected.left = Math.max(selected.left, best.b.left);
  selected.right = Math.min(selected.right, best.b.right);
  selected.top = Math.max(selected.top, best.b.top);
  selected.bottom = Math.min(selected.bottom, best.b.bottom);

  const pad = 4;
  const x = Math.max(0, Math.floor(selected.left - pad));
  const right = Math.min(vw, Math.ceil(selected.right + pad));
  const y = Math.max(0, Math.floor(selected.top - pad));
  const bottom = Math.min(vh, Math.ceil(selected.bottom + pad));
  if (right - x < 40 || bottom - y < 12) {
    return {
      ok: false,
      reason: "NO_COUNT_REGION",
      rowRect: absRow,
      diagnostics: ["Engagement count region collapsed after viewport clip."],
    };
  }
  if (bottom - y > maxBand + 24) {
    return {
      ok: false,
      reason: "NO_COUNT_REGION",
      rowRect: absRow,
      diagnostics: ["Engagement wrapper height still includes non-engagement content."],
    };
  }

  const clippedCounts = ownedCounts.filter((el) => {
    const b = el.getBoundingClientRect();
    return b.bottom > y && b.top < bottom && b.right > x && b.left < right;
  });
  if (!clippedCounts.length) {
    return {
      ok: false,
      reason: "ENGAGEMENT_OUTSIDE_VIEWPORT",
      rowRect: absRow,
      diagnostics: ["Engagement count region is outside the visible viewport after clip."],
    };
  }

  // Anti-icon zones: ONLY small decorative/action icons — never full buttons that wrap counts.
  const rejectNodes = [
    ...Array.from(row.querySelectorAll("svg,[role=img],img")),
    ...ownedIcons,
  ].filter((el, index, all) => all.indexOf(el) === index);
  const actionRects = rejectNodes
    .map((el) => el.getBoundingClientRect())
    .filter((b) => {
      if (b.width <= 2 || b.height <= 2 || b.width > 28 || b.height > 28) return false;
      return Math.max(b.width, b.height) / Math.min(b.width, b.height) <= 1.75;
    })
    .map((b) => ({ x: b.x - x, y: b.y - y, width: b.width, height: b.height }));

  return {
    ok: true,
    rect: { x, y, width: right - x, height: bottom - y },
    actionRects,
    rowRect: { x: r.x - x, y: r.y - y, width: r.width, height: r.height },
    diagnostics: [],
  };
})()`;
