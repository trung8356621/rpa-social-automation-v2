import type { OcrResult, OcrSegment } from "../shared/contracts.js";

// Exact normalized tokens only: retain accents, digits, +, #, /, _ and hyphens.
export function normalizeOcrText(text: string) {
  return text.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .toLocaleLowerCase("vi").replace(/[“”‘’"'.,!?;:()[\]{}…]/gu, " ")
    .replace(/(^|\s)@(?=[\p{L}\p{N}\s]|$)/gu, "$1").trim().replace(/\s+/gu, " ");
}

/** Merge only geometrically adjacent, ordered segments; never skip a token. */
export function findOcrCandidates(result: OcrResult, selection: { text: string; kind: "line" | "word" }): OcrSegment[] {
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
    const candidate = { id: `candidate-${matches.length}`, text, kind: selection.kind,
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
  return matches;
}
