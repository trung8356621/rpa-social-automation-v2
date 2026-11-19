import type { OcrResult, OcrSegment, Rect } from "../shared/contracts.js";

// Exact normalized tokens only: retain accents, digits, +, #, /, _ and hyphens.
// Pipe/box-drawing edges are OCR chrome around buttons (e.g. "| Lưu nháp |"), not tokens.
export function normalizeOcrText(text: string) {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .toLocaleLowerCase("vi").replace(/[“”‘’"'.,!?;:()[\]{}…|│┃¦]/gu, " ")
    .replace(/(^|\s)@(?=[\p{L}\p{N}\s]|$)/gu, "$1").trim().replace(/\s+/gu, " ");
}

/**
 * When punctuation-normalized matching yields multiple hits (e.g. "Password" vs
 * "password?" in "Lost your password?"), prefer the rawer text form and — if
 * still tied — the bbox closest in size to the saved selection. Never invent a
 * click when two forms stay equally plausible.
 */
export function refineOcrCandidates(
  matches: OcrSegment[],
  selection: { text: string; kind?: "line" | "word" | "block"; bbox?: Rect },
): OcrSegment[] {
  if (matches.length <= 1) return matches;
  const expected = selection.text.normalize("NFKC").trim();
  const expectedFold = expected.toLocaleLowerCase("vi");
  const scored = matches.map((match) => {
    const raw = match.text.normalize("NFKC").trim();
    const fold = raw.toLocaleLowerCase("vi");
    let rank = 2;
    if (raw === expected) rank = 4;
    else if (fold === expectedFold) rank = 3;
    else if (fold.replace(/[?.!,;:]+$/gu, "") === expectedFold && fold !== expectedFold)
      rank = 1; // matched only after stripping trailing punctuation
    let geo = Number.POSITIVE_INFINITY;
    if (selection.bbox) {
      const dw =
        Math.abs(match.bbox.width - selection.bbox.width)
        / Math.max(1, selection.bbox.width);
      const dh =
        Math.abs(match.bbox.height - selection.bbox.height)
        / Math.max(1, selection.bbox.height);
      geo = dw + dh;
    }
    return { match, rank, geo };
  });
  const bestRank = Math.max(...scored.map((row) => row.rank));
  let kept = scored.filter((row) => row.rank === bestRank);
  if (kept.length > 1 && selection.bbox && kept.every((row) => Number.isFinite(row.geo))) {
    const bestGeo = Math.min(...kept.map((row) => row.geo));
    const winners = kept.filter((row) => Math.abs(row.geo - bestGeo) < 1e-9);
    if (winners.length === 1) {
      const second = Math.min(
        ...kept.filter((row) => row !== winners[0]).map((row) => row.geo),
      );
      // Require a clear size gap so two near-identical labels still BLOCK.
      if (second - bestGeo >= 0.12) kept = winners;
    }
  }
  return kept.map((row) => row.match);
}

/** Merge only geometrically adjacent, ordered segments; never skip a token. */
export function findOcrCandidates(result: OcrResult, selection: { text: string; kind?: "line" | "word" | "block"; bbox?: Rect }): OcrSegment[] {
  const expected = normalizeOcrText(selection.text);
  if (!expected) return [];
  const matches: OcrSegment[] = [];
  const evidencePriority = new Map<OcrSegment, number>();
  const add = (parts: OcrSegment[]) => {
    const text = parts.map(part => part.text).join(" ");
    if (normalizeOcrText(text) !== expected) return;
    const x = Math.min(...parts.map(p => p.bbox.x)), y = Math.min(...parts.map(p => p.bbox.y));
    const right = Math.max(...parts.map(p => p.bbox.x+p.bbox.width));
    const bottom = Math.max(...parts.map(p => p.bbox.y+p.bbox.height));
    const candidate = { id: `candidate-${matches.length}`, text, kind: selection.kind ?? "line",
      confidence: Math.min(...parts.map(p => Number.isFinite(p.confidence) ? p.confidence : 0)), bbox: { x, y, width: right-x, height: bottom-y } };
    const duplicate = matches.find(saved => {
      const a = saved.bbox, b = candidate.bbox;
      const overlap = Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)) *
        Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
      return overlap/Math.max(1,Math.min(a.width*a.height,b.width*b.height)) >= 0.8 &&
        Math.abs(a.x+a.width/2-b.x-b.width/2) <= Math.max(a.height,b.height);
    });
    // Confidence must describe the matched tokens, not a surrounding avatar/@ glyph.
    // Exact word evidence wins over a whole-line representation, even when the words
    // are weaker. Within the same evidence class, retain the conservative minimum.
    const priority = parts.every(part => part.kind === "word") ? 2 : 1;
    if (duplicate) {
      const previous = evidencePriority.get(duplicate)!;
      if (priority > previous) {
        candidate.id = duplicate.id;
        matches[matches.indexOf(duplicate)] = candidate;
        evidencePriority.set(candidate, priority);
        evidencePriority.delete(duplicate);
      } else if (priority === previous) duplicate.confidence = Math.min(duplicate.confidence,candidate.confidence);
    } else {
      matches.push(candidate);
      evidencePriority.set(candidate,priority);
    }
  };
  const valid = result.segments.filter(s => Object.values(s.bbox).every(Number.isFinite) && s.bbox.width > 0 && s.bbox.height > 0);
  for (const segment of valid) add([segment]);
  for (const kind of ["word", "line"] as const) {
    const rows: OcrSegment[][] = [];
    for (const segment of valid.filter(s => s.kind === kind && normalizeOcrText(s.text)).sort((a,b) => a.bbox.y-b.bbox.y || a.bbox.x-b.bbox.x)) {
      const row = rows.find(row => {
        const a = row[0].bbox, b = segment.bbox;
        return Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y) >= Math.min(a.height,b.height)*0.6 &&
          Math.max(a.height,b.height) <= Math.min(a.height,b.height)*1.8;
      });
      if (row) row.push(segment); else rows.push([segment]);
    }
    for (const row of rows) row.sort((a,b) => a.bbox.x-b.bbox.x);
    const sequences = [...rows];
    // At most three tightly adjacent, left-aligned rows, and only whole token order.
    if (expected.split(" ").length >= 3) for (let i=0; i<rows.length; i++) {
      let sequence = [...rows[i]];
      for (let j=i+1; j<Math.min(rows.length,i+3); j++) {
        const previous = rows[j-1], next = rows[j];
        const height = Math.max(...previous.map(p => p.bbox.height),...next.map(p => p.bbox.height));
        const bottom = Math.max(...previous.map(p => p.bbox.y+p.bbox.height));
        const top = Math.min(...next.map(p => p.bbox.y));
        if (Math.abs(next[0].bbox.x-rows[i][0].bbox.x) > height || top-bottom < -2 || top-bottom > height*1.2) break;
        sequence = [...sequence,...next];
        sequences.push(sequence);
      }
    }
    for (const row of sequences) {
      for (let start=0; start<row.length; start++) {
        const parts: OcrSegment[] = [];
        for (let end=start; end<Math.min(row.length,start+expected.split(" ").length+4); end++) {
          const current = row[end], previous = parts.at(-1);
          if (previous) {
            const gap = current.bbox.x-previous.bbox.x-previous.bbox.width;
            const wrapped = current.bbox.y >= previous.bbox.y+previous.bbox.height-2;
            if (!wrapped && (gap < -2 || gap > Math.max(24,Math.max(previous.bbox.height,current.bbox.height)*2))) break;
          }
          parts.push(current);
          const normalized = normalizeOcrText(parts.map(p => p.text).join(" "));
          if (normalized.split(" ").length > expected.split(" ").length) break;
          add(parts);
        }
      }
    }
  }
  return refineOcrCandidates(matches, selection);
}
