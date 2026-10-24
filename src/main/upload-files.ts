import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ExecutionError, Flow, Payload, UploadFileCheck, UploadFileValidation, UploadInfo } from "../shared/contracts.js";
export const MAX_UPLOAD_FILES = 20;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
export class UploadError extends Error {
  constructor(
    message: string,
    readonly upload?: UploadInfo,
    readonly validation?: UploadFileValidation,
  ) {
    super(message);
  }
}
export async function validateUploadFiles(
  files: unknown,
  unresolved = false,
): Promise<UploadFileValidation> {
  if (unresolved) return { status: "UNRESOLVED", validCount: 0, invalidCount: 0, files: [] };
  try { validateUploadFileList(files); }
  catch (error) {
    return { status: "INVALID", validCount: 0, invalidCount: Array.isArray(files) ? files.length : 1,
      files: Array.isArray(files) ? files.map(value => ({ path: String(value), name: path.basename(String(value)), status: "INVALID" as const, reason: (error as Error).message })) : [] };
  }
  const results: UploadFileCheck[] = [];
  const canonicalPaths: string[] = [];
  for (const file of files) {
    try {
      const canonical = await realpath(file), metadata = await stat(canonical);
      if (!metadata.isFile() || !metadata.size) throw Error("không phải file ảnh có dữ liệu");
      await access(canonical, constants.R_OK);
      const image = await sharp(canonical).metadata();
      if (!image.format || !["png", "jpeg", "webp", "gif"].includes(image.format) || !image.width || !image.height)
        throw Error("nội dung không phải ảnh được hỗ trợ");
      if (canonicalPaths.some(existing => process.platform === "win32" ? existing.toLowerCase() === canonical.toLowerCase() : existing === canonical))
        throw Error("file bị chọn trùng");
      canonicalPaths.push(canonical);
      results.push({ path: canonical, name: path.basename(file), status: "VALID" });
    } catch (error) {
      results.push({ path: file, name: path.basename(file), status: "INVALID", reason: (error as Error).message });
    }
  }
  const invalidCount = results.filter(item => item.status === "INVALID").length;
  return { status: invalidCount ? "INVALID" : "VALID", validCount: results.length - invalidCount, invalidCount, files: results };
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
  const validation = await validateUploadFiles(files);
  if (validation.status !== "VALID") {
    const missing = validation.files.filter(item => item.status === "INVALID");
    throw new UploadError(`Không dùng được ${missing.length} ảnh: ${missing.map(item => `“${item.name}” (${item.reason ?? "không hợp lệ"})`).join(", ")}.`, undefined, validation);
  }
  return validation.files.map(item => item.path);
}
export async function uploadPreflightError(payload: Payload, flow: Flow, stepId: string, version: number): Promise<ExecutionError | undefined> {
  if (payload.action !== "UPLOAD_FILE") return;
  const validation = await validateUploadFiles(payload.files);
  if (validation.status === "VALID" || validation.status === "UNRESOLVED") return;
  const variable = flow.variables?.find(item => item.id === payload.variableId);
  const invalid = validation.files.filter(item => item.status === "INVALID");
  return {
    code: "UPLOAD_FILES_INVALID", category: "Dữ liệu upload", stepId, version,
    variableId: variable?.id, variableKey: variable?.key,
    field: variable ? "Default Pattern" : "files",
    message: variable
      ? `Không tìm thấy hoặc không đọc được ${invalid.length || 1} ảnh trong Variable \`${variable.key}\`.`
      : `Không tìm thấy hoặc không đọc được ${invalid.length || 1} ảnh của Step.`,
    suggestedAction: variable ? "Mở Variables để chọn lại file." : "Mở Step Editor để chọn lại file.",
    details: invalid.map(item => `${item.name}: ${item.reason ?? "không hợp lệ"}`),
  };
}
