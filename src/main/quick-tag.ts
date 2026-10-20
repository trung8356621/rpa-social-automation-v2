import sharp from "sharp";
import type { Capture, Payload, Rect } from "../shared/contracts.js";
import { assertVisualEnvironment } from "../shared/visual-environment.js";
import type { BrowserCore } from "./browser-core.js";

export class QuickTagBlocked extends Error {}

// Compare pixels only. This does not read names or establish identity.
async function pixels(buffer: Buffer, roi: Rect) {
  return sharp(buffer).extract({ left: roi.x, top: roi.y, width: roi.width, height: roi.height }).resize(96, 48, { fit: "fill" })
    .toColourspace("srgb").removeAlpha().raw().toBuffer();
}
function difference(a: Buffer, b: Buffer) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 3)
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 24) changed++;
  return changed / (a.length / 3);
}

export async function quickTag(
  browser: BrowserCore,
  payload: Payload,
  before: Capture,
  template: Buffer,
  click: (x: number, y: number) => void,
  log: (details: Record<string, unknown>) => void,
) {
  const roi = payload.target!.roi;
  const rows = payload.quickTagRows!;
  const count = payload.quickTagCount!;
  if (!Number.isInteger(count) || count < 1 || count > 10 || count > rows)
    throw new QuickTagBlocked("QUICK_TAG: số lượng Integer phải từ 1–10 và không vượt số hàng ROI.");
  const rowHeight = roi.height / rows;
  if (rowHeight < 16 || roi.width < 40)
    throw new QuickTagBlocked("QUICK_TAG: ROI quá nhỏ; cần mỗi hàng ít nhất 16px, rộng ít nhất 40px.");
  const x = roi.x + roi.width / 2;
  const y = roi.y + rowHeight / 2;
  // Ignore checkbox at the right edge and avatar at the left. A checkbox or
  // click marker changing alone must not permit a second click on the same row.
  const content: Rect = { x: Math.round(roi.x + roi.width * 0.2), y: Math.round(roi.y),
    width: Math.floor(roi.width * 0.55), height: Math.floor(rowHeight) };
  const initial = await pixels(browser.captureBuffer(before.id), roi);
  const reference = await pixels(template, { x: 0, y: 0, width: roi.width, height: roi.height });
  const initialChange = difference(initial, reference);
  log({ phase: "roi-preflight", rows, count, x, y, initialChange });
  if (initialChange > 0.05)
    throw new QuickTagBlocked("QUICK_TAG: danh sách tại ROI không khớp ảnh đã crop. Mở đúng modal và crop lại; chưa click.");
  let current = before;
  for (let index = 0; index < count; index++) {
    assertVisualEnvironment(payload, before.zoom, { ...browser.bounds, zoom: browser.zoom });
    if (current.url !== before.url) throw new QuickTagBlocked("QUICK_TAG: trang đã thay đổi; dừng.");
    const baseline = await pixels(browser.captureBuffer(current.id), content);
    click(x, y);
    log({ phase: "click-sent", index: index + 1, count, x, y });
    let previous: Buffer | undefined;
    let changed = false;
    // Bounded wait, never retry a click. Require both replacement of the first
    // row and a stable frame before allowing another positional selection.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      current = await browser.capture();
      assertVisualEnvironment(payload, before.zoom, { ...browser.bounds, zoom: current.zoom });
      if (current.url !== before.url) throw new QuickTagBlocked("QUICK_TAG: trang đã thay đổi sau click; dừng, không retry.");
      const frame = await pixels(browser.captureBuffer(current.id), content);
      const change = difference(baseline, frame);
      const stable = previous !== undefined && difference(previous, frame) < 0.01;
      log({ phase: "wait-list-update", index: index + 1, attempt: attempt + 1, change, stable });
      if (change >= 0.04 && stable) { changed = true; break; }
      previous = frame;
    }
    if (!changed)
      throw new QuickTagBlocked(`QUICK_TAG: đã gửi ${index + 1}/${count} click; nội dung hàng đầu không đổi hoặc chưa ổn định sau 6 lần quan sát, cách nhau 500ms. Dừng để tránh chọn lại; kiểm tra thủ công, không tự retry.`);
  }
  return current;
}
