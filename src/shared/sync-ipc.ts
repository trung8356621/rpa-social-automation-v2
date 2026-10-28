import type { SyncPlan } from "./script-sync.js";
import type { ScriptSyncRow } from "./sync-status.js";

export type SyncActionResult = { script_id: string; action: string; ok: boolean; message?: string };
export type SyncIpcDiagnostic = {
  code: "IPC_SERIALIZATION" | "NETWORK_FAILURE" | "AUTHENTICATION_FAILURE" | "AUTHORIZATION_FAILURE" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "TIMEOUT" | "RATE_LIMITED" | "SERVER_ERROR" | "SERVICE_UNAVAILABLE" | "API_UNEXPECTED_RESPONSE" | "SYNC_FAILURE";
  category: "ipc" | "network" | "authentication" | "authorization" | "not_found" | "conflict" | "validation" | "timeout" | "rate_limited" | "server" | "service_unavailable" | "sync";
  message: string;
  technicalMessage: string;
  path?: string;
};
export type ManualSyncResponse =
  | { ok: true; plan: SyncPlan; results: SyncActionResult[]; rows: ScriptSyncRow[]; summary?: { published: number; downloaded: number; unchanged: number; blocked: number; failed: number; reports_downloaded: number } }
  | { ok: false; error: SyncIpcDiagnostic };

export class IpcSerializationError extends Error {
  constructor(readonly path: string, readonly valueType: string) {
    super(`IPC_SERIALIZATION: unsupported ${valueType} at ${path}`);
  }
}

function unsupportedPath(value: unknown, path = "$", seen = new WeakSet<object>()): { path: string; type: string } | undefined {
  const type = typeof value;
  if (type === "function" || type === "symbol") return { path, type };
  if (!value || type !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet)
    return { path, type: value.constructor.name };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = unsupportedPath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const found = unsupportedPath(item, `${path}.${key}`, seen);
    if (found) return found;
  }
}

export function assertIpcSerializable(value: unknown): void {
  const unsupported = unsupportedPath(value);
  if (unsupported) throw new IpcSerializationError(unsupported.path, unsupported.type);
  try { structuredClone(value); }
  catch (error) {
    throw new IpcSerializationError("$", error instanceof Error ? error.name : "unknown value");
  }
}

export function syncIpcDiagnostic(error: unknown): SyncIpcDiagnostic {
  const technicalMessage = error instanceof Error ? error.message : String(error);
  if (error instanceof IpcSerializationError || /could not be cloned|IPC_SERIALIZATION/i.test(technicalMessage))
    return { code: "IPC_SERIALIZATION", category: "ipc", message: "Dữ liệu Sync không thể chuyển về giao diện.", technicalMessage, path: error instanceof IpcSerializationError ? error.path : undefined };
  if (/category=timeout|SEO_OPS_HTTP:.*category=timeout/i.test(technicalMessage))
    return { code: "TIMEOUT", category: "timeout", message: "SEO-OPS không phản hồi kịp (timeout). Thử lại thủ công.", technicalMessage };
  if (/failed to fetch|networkerror|econnrefused|enotfound|timed?\s*out/i.test(technicalMessage))
    return { code: "NETWORK_FAILURE", category: "network", message: "Không kết nối được SEO-OPS.", technicalMessage };
  if (/forbidden|\b403\b|category=authorization/i.test(technicalMessage))
    return { code: "AUTHORIZATION_FAILURE", category: "authorization", message: "Tài khoản không có quyền sử dụng Social Automation.", technicalMessage };
  if (/unauthenticated|unauthorized|\b401\b|category=authentication/i.test(technicalMessage))
    return { code: "AUTHENTICATION_FAILURE", category: "authentication", message: "Phiên đăng nhập SEO-OPS không hợp lệ hoặc không đủ quyền.", technicalMessage };
  if (/category=not_found|\b404\b|not_found|package_not_found|script_not_found/i.test(technicalMessage))
    return { code: "NOT_FOUND", category: "not_found", message: "Không tìm thấy Script/release trên SEO-OPS.", technicalMessage };
  if (/category=conflict|\b409\b|version_digest_conflict|script_version_sequence_conflict|package_kind_conflict/i.test(technicalMessage))
    return { code: "CONFLICT", category: "conflict", message: "Xung đột version/digest với SEO-OPS.", technicalMessage };
  if (/category=validation|\b422\b/i.test(technicalMessage))
    return { code: "VALIDATION", category: "validation", message: "Dữ liệu Script không hợp lệ (validation). Kiểm tra Steps/Variables/Demo.", technicalMessage };
  if (/category=rate_limited|\b429\b/i.test(technicalMessage)) {
    const retry = /retry-after=(\d+)/i.exec(technicalMessage)?.[1];
    return { code: "RATE_LIMITED", category: "rate_limited",
      message: `SEO-OPS đang giới hạn yêu cầu.${retry ? ` Thử lại sau ${retry} giây.` : " Vui lòng thử lại sau."}`, technicalMessage };
  }
  if (/category=service_unavailable|\b503\b/i.test(technicalMessage))
    return { code: "SERVICE_UNAVAILABLE", category: "service_unavailable", message: "SEO-OPS tạm thời không khả dụng. Vui lòng thử lại sau.", technicalMessage };
  if (/category=server_error|\b5\d\d\b/i.test(technicalMessage))
    return { code: "SERVER_ERROR", category: "server", message: "SEO-OPS gặp lỗi máy chủ. Vui lòng thử lại sau.", technicalMessage };
  if (/SEO_OPS_HTTP:.*(?:content-type|redirect|unexpected_response)/i.test(technicalMessage))
    return { code: "API_UNEXPECTED_RESPONSE", category: "sync", message: "SEO-OPS trả về trang HTML/redirect thay vì dữ liệu API JSON.", technicalMessage };
  return { code: "SYNC_FAILURE", category: "sync", message: "Đồng bộ SEO-OPS thất bại.", technicalMessage };
}

export async function executeManualSync(
  work: () => Promise<Omit<Extract<ManualSyncResponse, { ok: true }>, "ok">>,
  diagnostic?: (error: unknown, detail: SyncIpcDiagnostic) => void,
): Promise<ManualSyncResponse> {
  try {
    const result = await work();
    assertIpcSerializable(result);
    return { ok: true, ...result };
  } catch (error) {
    const detail = syncIpcDiagnostic(error);
    diagnostic?.(error, detail);
    return { ok: false, error: detail };
  }
}
