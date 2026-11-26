import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";

export type OcrButtonChip = Rect;

/**
 * Locate solid chromatic UI chips (primary buttons) whose white/light label text
 * is invisible to full-viewport Tesseract SPARSE_TEXT, but readable on a tight crop.
 *
 * Empirically, even 2px of surrounding white margin around Facebook-style
 * white-on-blue "Publish" makes LocalOcr return empty; the chip box must hug the fill.
 */
export async function findChromaticButtonChips(image: Buffer): Promise<OcrButtonChip[]> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (width < 160 || height < 120) return [];

  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    // Saturated mid/dark fills (blue/green/red primary buttons), not near-white UI chrome.
    if (chroma < 55 || max < 140 || min > 170) continue;
    // Prefer a dominant channel so gray panels stay excluded.
    if (max < min + 55) continue;
    mask[i] = 1;
  }

  const visited = new Uint8Array(mask.length);
  const chips: OcrButtonChip[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      const queue = [start];
      visited[start] = 1;
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi]!;
        count++;
        const cx = cur % width;
        const cy = (cur / width) | 0;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (!mask[nidx] || visited[nidx]) continue;
          visited[nidx] = 1;
          queue.push(nidx);
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const aspect = w / Math.max(1, h);
      if (count < 400 || w < 48 || h < 18 || w > 280 || h > 72) continue;
      if (aspect < 1.15 || aspect > 10) continue;
      // Require the component to fill most of its bbox (solid chip, not a ring/outline).
      if (count / (w * h) < 0.45) continue;
      chips.push({ x: minX, y: minY, width: w, height: h });
      if (chips.length >= 24) return chips;
    }
  }
  return chips;
}

/** True when a primary OCR segment already covers this chip's center. */
export function chipAlreadyCovered(
  chip: OcrButtonChip,
  segments: Array<{ bbox: Rect; confidence: number; text: string }>,
): boolean {
  const cx = chip.x + chip.width / 2;
  const cy = chip.y + chip.height / 2;
  return segments.some((segment) => {
    if (!(segment.confidence >= 70) || !segment.text.trim()) return false;
    const b = segment.bbox;
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
  });
}
