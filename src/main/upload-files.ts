import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { UploadInfo } from "../shared/contracts.js";
export const MAX_UPLOAD_FILES = 20;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
export class UploadError extends Error {
  constructor(
    message: string,
    readonly upload?: UploadInfo,
  ) {
    super(message);
  }
}
export function validateUploadFileList(
  files: unknown,
): asserts files is string[] {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > MAX_UPLOAD_FILES ||
    files.some(
      (p) =>
        typeof p !== "string" ||
        p.length > 32768 ||
        !path.isAbsolute(p) ||
        !IMAGE_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase()),
    )
  )
    throw new UploadError(
      `UPLOAD_FILE cần 1–${MAX_UPLOAD_FILES} đường dẫn ảnh local tuyệt đối (PNG/JPEG/WebP/GIF).`,
    );
}
export async function inspectUploadFiles(files: unknown): Promise<string[]> {
  validateUploadFileList(files);
  const checked: string[] = [];
  for (const file of files) {
    try {
      const canonical = await realpath(file),
        metadata = await stat(canonical);
      if (!metadata.isFile() || !metadata.size)
        throw Error("không phải file ảnh có dữ liệu");
      await access(canonical, constants.R_OK);
      const image = await sharp(canonical).metadata();
      if (
        !image.format ||
        !["png", "jpeg", "webp", "gif"].includes(image.format) ||
        !image.width ||
        !image.height
      )
        throw Error("nội dung không phải ảnh được hỗ trợ");
      if (
        checked.some((p) =>
          process.platform === "win32"
            ? p.toLowerCase() === canonical.toLowerCase()
            : p === canonical,
        )
      )
        throw Error("file bị chọn trùng");
      checked.push(canonical);
    } catch (error) {
      throw new UploadError(
        `Không dùng được ảnh “${path.basename(file)}”: ${(error as Error).message}`,
      );
    }
  }
  return checked;
}
