import type { Rect } from "../../shared/contracts";

export async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Không thể tải ảnh screenshot."));
  });
  return img;
}

export async function cropDataUrl(sourceDataUrl: string, roi: Rect): Promise<{
  dataUrl: string;
  width: number;
  height: number;
}> {
  const img = await loadImage(sourceDataUrl);
  const x = Math.max(0, Math.round(roi.x));
  const y = Math.max(0, Math.round(roi.y));
  const width = Math.max(4, Math.round(roi.width));
  const height = Math.max(4, Math.round(roi.height));
  if (x + width > img.naturalWidth || y + height > img.naturalHeight) {
    throw new Error(
      `ROI ${width}×${height} at ${x},${y} does not fit capture ${img.naturalWidth}×${img.naturalHeight}.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context không khả dụng.");
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

export async function imageToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context không khả dụng.");
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/** Mask pixels outside ROI to black on a processing copy; original evidence stays untouched. */
export async function maskOutsideRoi(sourceDataUrl: string, roi: Rect): Promise<string> {
  const img = await loadImage(sourceDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context không khả dụng.");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const x = Math.max(0, Math.round(roi.x));
  const y = Math.max(0, Math.round(roi.y));
  const width = Math.max(4, Math.round(roi.width));
  const height = Math.max(4, Math.round(roi.height));
  ctx.drawImage(img, x, y, width, height, x, y, width, height);
  return canvas.toDataURL("image/png");
}
