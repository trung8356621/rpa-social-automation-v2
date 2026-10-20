import sharp from "sharp";
import type { OcrResult, Payload, Result, ResolutionTrace } from "../shared/contracts.js";
import type { OcrEngine } from "./ocr.js";

import { findOcrCandidates, normalizeOcrText as normalize } from "./ocr-candidates.js";

const savedOcr = new WeakMap<Buffer, Promise<OcrResult>>();
const generic = new Set(["thích", "bình luận", "chia sẻ", "like", "comment", "share", "viết bình luận", "xem thêm", "see more"]);

/** Safety gate only: never replaces OCR click coordinates or searches via the DOM. */
export async function confirmOcrContext(frame: Buffer, template: Buffer, payload: Payload,
  ocr: OcrEngine, found: NonNullable<Result["match"]>, viewportOcr: OcrResult,
): Promise<NonNullable<ResolutionTrace["context"]>[number]> {
  const target = payload.target!, selected = target.ocr!;
  const context: NonNullable<ResolutionTrace["context"]>[number] = {
    x: found.x, y: found.y, confirmed: false, reason: "CONTEXT_INSUFFICIENT",
  };
  let pending = savedOcr.get(template);
  if (!pending) {
    pending = ocr.recognize(template);
    savedOcr.set(template, pending);
    void pending.catch(() => savedOcr.delete(template));
  }
  const saved = await pending;
  const selectedText = normalize(selected.text);
  // Require independent saved text, not another copy/word of the clicked label.
  const anchors = saved.segments.filter(segment => {
    const text = normalize(segment.text), b = segment.bbox, a = selected.bbox;
    const outside = b.x+b.width <= a.x || b.x >= a.x+a.width || b.y+b.height <= a.y || b.y >= a.y+a.height;
    return outside && segment.kind === "line" && segment.confidence >= 80 && text.length >= 10 && /\p{L}/u.test(text) &&
      !generic.has(text) && !selectedText.includes(text) && !text.includes(selectedText);
  });
  if (!anchors.length) {
    context.reason = "CONTEXT_INSUFFICIENT: ROI thiếu chữ ngữ cảnh độc lập; cần crop rộng hơn (tác giả/tiêu đề).";
    return context;
  }
  const left = Math.round(found.x - selected.bbox.x - selected.bbox.width/2);
  const top = Math.round(found.y - selected.bbox.y - selected.bbox.height/2);
  const size = await sharp(frame).metadata();
  if (left < 0 || top < 0 || left+target.roi.width > size.width! || top+target.roi.height > size.height!) {
    context.reason = "CONTEXT_CLIPPED: ngữ cảnh ROI chưa hiển thị đầy đủ.";
    return context;
  }
  const anchorsConfirmed = anchors.every(anchor => findOcrCandidates(viewportOcr, anchor).filter(segment =>
    segment.confidence >= 80 &&
    Math.abs(segment.bbox.x+segment.bbox.width/2-(left+anchor.bbox.x+anchor.bbox.width/2)) <= 12 &&
    Math.abs(segment.bbox.y+segment.bbox.height/2-(top+anchor.bbox.y+anchor.bbox.height/2)) <= 12).length === 1);
  if (!anchorsConfirmed) { context.reason = "CONTEXT_ANCHOR_MISMATCH: chữ trùng nhưng ngữ cảnh không khớp vị trí."; return context; }
  context.anchor = anchors.map(anchor => anchor.text).join(" | ");
  const reference = await sharp(template).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const candidate = await sharp(frame).extract({ left, top, width: target.roi.width, height: target.roi.height })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (reference.info.width !== target.roi.width || reference.info.height !== target.roi.height ||
      reference.info.channels !== candidate.info.channels) throw new Error("CONTEXT_IMAGE_SIZE: ảnh target không khớp ROI.");
  let difference = 0, count = 0, min = 255, max = 0;
  const box = selected.bbox, channels = reference.info.channels;
  for (let y=0; y<target.roi.height; y++) for (let x=0; x<target.roi.width; x++) {
    if (x >= box.x-3 && x < box.x+box.width+3 && y >= box.y-3 && y < box.y+box.height+3) continue;
    for (let ch=0; ch<channels; ch++) {
      const i = (y*target.roi.width+x)*channels+ch, value = reference.data[i];
      difference += Math.abs(value-candidate.data[i]); count++;
      min = Math.min(min,value); max = Math.max(max,value);
    }
  }
  context.imageScore = count ? 1-difference/(count*255) : 0;
  context.confirmed = count >= 192 && max-min >= 25 && context.imageScore >= Math.max(0.96,payload.threshold ?? 0.96);
  context.reason = context.confirmed ? "CONTEXT_CONFIRMED: anchor độc lập + ảnh ngoài chữ khớp."
    : "CONTEXT_IMAGE_MISMATCH: ảnh quanh chữ không đủ tin cậy.";
  return context;
}
