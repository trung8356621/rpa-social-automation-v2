import sharp from "sharp";
import type { OcrResult, Payload, Rect, Result, ResolutionTrace } from "../shared/contracts.js";
import type { OcrEngine } from "./ocr.js";
import { findOcrCandidates, normalizeOcrText as normalize } from "./ocr-candidates.js";

const savedOcr = new WeakMap<Buffer, Promise<OcrResult>>();
const generic = new Set(["thích", "bình luận", "chia sẻ", "like", "comment", "share", "viết bình luận", "xem thêm", "see more"]);

/** Text-only safety gate. Saved geometry is a loose neighborhood hint, never a crop or click coordinate. */
export async function confirmOcrContext(frame: Buffer, template: Buffer, payload: Payload,
  ocr: OcrEngine, found: NonNullable<Result["match"]>, viewportOcr: OcrResult, currentBox?: Rect, visibleRegion?: Rect,
): Promise<NonNullable<ResolutionTrace["context"]>[number]> {
  const selected = payload.target!.ocr!;
  const context: NonNullable<ResolutionTrace["context"]>[number] = {
    x: found.x, y: found.y, confirmed: false, reason: "CONTEXT_INSUFFICIENT",
  };
  const box = currentBox ?? findOcrCandidates(viewportOcr, selected).find(candidate =>
    Math.abs(candidate.bbox.x+candidate.bbox.width/2-found.x) <= 1 &&
    Math.abs(candidate.bbox.y+candidate.bbox.height/2-found.y) <= 1)?.bbox;
  const size = await sharp(frame).metadata();
  if (!box || !Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0 ||
      box.x < 0 || box.y < 0 || box.x+box.width > size.width! || box.y+box.height > size.height!) {
    context.reason = "CONTEXT_INVALID_TARGET_BBOX: bbox OCR hiện tại không hợp lệ.";
    return context;
  }
  let pending = savedOcr.get(template);
  if (!pending) {
    pending = ocr.recognize(template);
    savedOcr.set(template, pending);
    void pending.catch(() => savedOcr.delete(template));
  }
  const viewport = visibleRegion ?? { x: 0, y: 0, width: size.width!, height: size.height! };
  const edgeMargin = Math.max(48,Math.min(128,box.height*3));
  const nearEdge = box.y < viewport.y+edgeMargin || box.y+box.height > viewport.y+viewport.height-edgeMargin;
  const saved = await pending;
  const selectedText = normalize(selected.text);
  const rawAnchors = saved.segments.filter(segment => {
    const text = normalize(segment.text), b = segment.bbox, a = selected.bbox;
    const outside = b.x+b.width <= a.x || b.x >= a.x+a.width || b.y+b.height <= a.y || b.y >= a.y+a.height;
    return outside && Object.values(b).every(Number.isFinite) && b.width > 0 && b.height > 0 &&
      segment.confidence >= 80 && text.length >= (segment.kind === "line" ? 6 : 4) && /\p{L}/u.test(text) &&
      !generic.has(text) && !selectedText.includes(text) && !text.includes(selectedText);
  });
  // Keep constituent words until after live matching. A saved line can contain one
  // OCR typo while its stable words still provide valid relative context.
  const anchors = rawAnchors;
  if (!anchors.length) {
    context.reason = "CONTEXT_INSUFFICIENT: ảnh lưu không có chữ ngữ cảnh độc lập đáng tin cậy.";
    return context;
  }
  const scale = Math.max(0.5, Math.min(2, box.height/selected.bbox.height));
  const matched: typeof anchors = [];
  let visible = 0, ambiguous = false, clippedContext = false;
  for (const anchor of anchors) {
    const a = anchor.bbox, original = selected.bbox;
    const dx = (a.x+a.width/2-original.x-original.width/2)*scale;
    const dy = (a.y+a.height/2-original.y-original.height/2)*scale;
    const expectedX = found.x+dx, expectedY = found.y+dy;
    if (expectedY-a.height*scale/2 < viewport.y || expectedY+a.height*scale/2 > viewport.y+viewport.height)
      clippedContext = true;
    // Off-screen saved anchors are optional. Never require the old ROI to fit.
    const expectedVisible = expectedX+a.width*scale/2 > viewport.x && expectedX-a.width*scale/2 < viewport.x+viewport.width &&
      expectedY+a.height*scale/2 > viewport.y && expectedY-a.height*scale/2 < viewport.y+viewport.height;
    if (expectedVisible) visible++;
    // Still look for a visible anchor shifted by reflow even when its old projection is off-screen.
    const savedDistance = Math.hypot(dx, dy);
    const maxDistance = Math.max(160, savedDistance * 2.5, box.width * 2, box.height * 6);
    const candidates = findOcrCandidates(viewportOcr, anchor).filter(candidate => {
      const b = candidate.bbox;
      if (candidate.confidence < 80 || b.x < 0 || b.y < 0 || b.x+b.width > size.width! || b.y+b.height > size.height!) return false;
      const cx = b.x+b.width/2, cy = b.y+b.height/2;
      if (cx < viewport.x || cx > viewport.x+viewport.width || cy < viewport.y || cy > viewport.y+viewport.height) return false;
      // Keep the same side of the target and a bounded local neighborhood despite reflow.
      const slack = Math.max(6,Math.min(16,box.height/2));
      if (a.y+a.height <= original.y && b.y+b.height > box.y+slack) return false;
      if (a.y >= original.y+original.height && b.y < box.y+box.height-slack) return false;
      if (a.x+a.width <= original.x && b.x+b.width > box.x+slack) return false;
      if (a.x >= original.x+original.width && b.x < box.x+box.width-slack) return false;
      // Layout may reflow spacing while retaining semantic direction. Keep the
      // anchor in a bounded neighborhood instead of requiring its old projection.
      return Math.hypot(cx-found.x, cy-found.y) <= maxDistance;
    });
    if (candidates.length > 1) { ambiguous = true; continue; }
    if (candidates.length === 1) matched.push(anchor);
  }
  // Line/word alternatives from the same saved label are one piece of evidence.
  const evidence = matched.filter((anchor,index) => !matched.some((other,otherIndex) => {
    if (index === otherIndex) return false;
    const a = anchor.bbox, b = other.bbox;
    const contained = a.x >= b.x && a.y >= b.y && a.x+a.width <= b.x+b.width && a.y+a.height <= b.y+b.height;
    return contained && (normalize(other.text).length > normalize(anchor.text).length || otherIndex < index);
  }));
  context.anchor = evidence.map(anchor => anchor.text).join(" | ");
  if (ambiguous) {
    context.reason = "CONTEXT_AMBIGUOUS: nhiều anchor cùng chữ trong vùng lân cận mục tiêu.";
    return context;
  }
  const strong = evidence.some(anchor => {
    const text = normalize(anchor.text);
    return text.length >= 10 || (text.length >= 8 && text.split(" ").length >= 2);
  });
  context.confirmed = strong || evidence.length >= 2;
  context.reason = context.confirmed
    ? `CONTEXT_CONFIRMED: bbox OCR hiện tại + ${evidence.length} anchor chữ lân cận; không kiểm tra pixel/ROI đầy đủ.`
    : `${nearEdge || clippedContext ? "CONTEXT_EDGE_PENDING" : "CONTEXT_NOT_CONFIRMED"}: chưa đủ anchor chữ nhìn thấy (${matched.length}/${visible}).`;
  return context;
}
