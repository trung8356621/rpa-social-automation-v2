import sharp from "sharp";
import type { OcrResult, OcrSegment, Rect } from "../shared/contracts.js";
import type { EngagementFieldName } from "../shared/post-detail-collector/types.js";

const ROLE_ORDER: EngagementFieldName[] = ["like_count", "comment_count", "share_count"];

export type EngagementSlotDigit = {
  field: EngagementFieldName;
  value: number;
  rawText: string;
  confidence: number;
  window: { x0: number; x1: number };
};

export type EngagementSlotOcrResult = {
  digits: EngagementSlotDigit[];
  icons: Array<{ x0: number; x1: number }>;
  ocr: OcrResult;
  diagnostics: string[];
};

const compactCount = (text: string): number | null => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*([kmb])?\s*$/iu.exec(text.trim());
  if (!match) return null;
  const base = Number(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
  const factor = match[3]?.toLowerCase() === "k" ? 1_000 : match[3]?.toLowerCase() === "m" ? 1_000_000 : match[3]?.toLowerCase() === "b" ? 1_000_000_000 : 1;
  return Number.isFinite(base) ? Math.round(base * factor) : null;
};

/** Accept pure counts and short Latin-prefixed OCR noise ("c3"); reject Unicode junk. */
const countFromWord = (text: string): number | null => {
  const direct = compactCount(text);
  if (direct !== null) return direct;
  const match = /^\s*[A-Za-z@()]{0,2}(\d{1,9}(?:[.,]\d{1,2})?[kmb]?)\s*$/u.exec(text.trim());
  return match ? compactCount(match[1]) : null;
};

function findIconClusters(dens: number[], maxX: number): Array<{ x0: number; x1: number }> {
  const runs: Array<{ x0: number; x1: number }> = [];
  let inRun = false;
  for (let x = 0; x < Math.min(maxX, dens.length); x += 1) {
    if (dens[x] > 0.1) {
      if (!inRun) {
        runs.push({ x0: x, x1: x });
        inRun = true;
      } else {
        runs[runs.length - 1].x1 = x;
      }
    } else {
      inRun = false;
    }
  }
  const merged: Array<{ x0: number; x1: number }> = [];
  for (const run of runs) {
    if (!merged.length || run.x0 - merged[merged.length - 1].x1 > 12) {
      merged.push({ ...run });
    } else {
      merged[merged.length - 1].x1 = run.x1;
    }
  }
  // Skip left-edge divider ink; keep up to three Action icons.
  return merged
    .filter(run => {
      const width = run.x1 - run.x0 + 1;
      return width >= 5 && width <= 50 && run.x0 > 8;
    })
    .slice(0, 3);
}

async function columnDensity(crop: Buffer): Promise<{ dens: number[]; width: number; height: number }> {
  const { data, info } = await sharp(crop).grayscale().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const top = Math.max(0, height - 42);
  const dens = new Array(width).fill(0);
  for (let x = 0; x < width; x += 1) {
    let ink = 0;
    let n = 0;
    for (let y = top; y < height; y += 1) {
      if (data[y * width + x] < 200) ink += 1;
      n += 1;
    }
    dens[x] = n ? ink / n : 0;
  }
  return { dens, width, height };
}

/**
 * Per-role Engagement OCR: locate Like/Comment/Share icon columns, OCR each
 * icon→next window (upscaled). Supports partial rows (icon-only slots stay empty).
 */
export async function recognizeEngagementSlots(input: {
  crop: Buffer;
  localOcr: { recognize: (image: Buffer) => Promise<OcrResult> };
}): Promise<EngagementSlotOcrResult> {
  const diagnostics: string[] = [];
  const { dens, width, height } = await columnDensity(input.crop);
  const icons = findIconClusters(dens, Math.min(width, 320));
  diagnostics.push(`icon_slots:${icons.map(icon => `${icon.x0}-${icon.x1}`).join("|") || "none"}`);

  if (icons.length < 3) {
    diagnostics.push(`icon_slots_incomplete:${icons.length}`);
    return {
      digits: [],
      icons,
      ocr: { text: "", confidence: 0, language: "vie+eng", segments: [] },
      diagnostics,
    };
  }

  const top = Math.max(0, Math.floor(height * 0.18));
  const bandHeight = Math.max(12, height - top);
  const digits: EngagementSlotDigit[] = [];
  const segments: OcrSegment[] = [];

  for (let index = 0; index < 3; index += 1) {
    const field = ROLE_ORDER[index];
    const icon = icons[index];
    const x0 = icon.x0;
    const x1 = icons[index + 1] ? icons[index + 1].x0 - 1 : Math.min(width, icon.x1 + 42);
    const left = Math.max(0, Math.floor(x0));
    const winWidth = Math.max(16, Math.min(Math.ceil(x1 - x0), width - left));
    const prepared = await sharp(input.crop)
      .extract({ left, top, width: winWidth, height: bandHeight })
      .resize({
        width: Math.max(72, winWidth * 3),
        height: bandHeight * 3,
        kernel: "lanczos3",
      })
      .extend({ top: 18, bottom: 18, left: 18, right: 18, background: "#ffffff" })
      .grayscale()
      .linear(1.55, -36)
      .png()
      .toBuffer();
    const raw = await input.localOcr.recognize(prepared);
    const words = raw.segments.filter(segment => segment.kind === "word");
    let best: { value: number; text: string; confidence: number } | null = null;
    for (const word of words) {
      const value = countFromWord(word.text);
      if (value === null || word.confidence < 35) continue;
      if (!best || word.confidence > best.confidence || (word.confidence === best.confidence && compactCount(word.text) !== null)) {
        best = { value, text: word.text, confidence: word.confidence };
      }
    }
    if (!best) {
      diagnostics.push(`${field}:ICON_ONLY_NO_COUNT@${x0}-${x1}`);
      continue;
    }
    const bbox: Rect = {
      x: left + Math.max(0, icon.x1 - left),
      y: top + Math.round(bandHeight * 0.25),
      width: Math.max(8, Math.min(28, winWidth - (icon.x1 - left))),
      height: Math.max(10, Math.round(bandHeight * 0.45)),
    };
    const segmentId = `slot-${field}`;
    segments.push({
      id: segmentId,
      text: String(best.value),
      confidence: best.confidence,
      kind: "word",
      bbox,
    });
    digits.push({
      field,
      value: best.value,
      rawText: best.text,
      confidence: best.confidence,
      window: { x0, x1 },
    });
    diagnostics.push(`${field}:${best.value} from "${best.text}"@${x0}-${x1} c${Math.round(best.confidence)}`);
  }

  const confidence = segments.length
    ? segments.reduce((sum, segment) => sum + segment.confidence, 0) / segments.length
    : 0;
  return {
    digits,
    icons,
    ocr: {
      text: segments.map(segment => segment.text).join(" "),
      confidence,
      language: "vie+eng",
      segments,
    },
    diagnostics,
  };
}
