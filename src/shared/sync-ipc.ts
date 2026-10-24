import type { SyncPlan } from "./script-sync.js";
import type { ScriptSyncRow } from "./sync-status.js";

export type SyncActionResult = { script_id: string; action: string; ok: boolean; message?: string };
export type SyncIpcDiagnostic = {
  code: "IPC_SERIALIZATION" | "NETWORK_FAILURE" | "AUTHENTICATION_FAILURE" | "SYNC_FAILURE";
  category: "ipc" | "network" | "authentication" | "sync";
  message: string;
  technicalMessage: string;
  path?: string;
};
export type ManualSyncResponse =
  | { ok: true; plan: SyncPlan; results: SyncActionResult[]; rows: ScriptSyncRow[]; summary?: { backed_up: number; published: number; unchanged: number; blocked: number; failed: number; reports: number } }
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
  if (/failed to fetch|networkerror|econnrefused|enotfound|timed?\s*out/i.test(technicalMessage))
    return { code: "NETWORK_FAILURE", category: "network", message: "Không kết nối được SEO-OPS.", technicalMessage };
  if (/unauthenticated|forbidden|unauthorized|\b401\b|\b403\b/i.test(technicalMessage))
    return { code: "AUTHENTICATION_FAILURE", category: "authentication", message: "Phiên đăng nhập SEO-OPS không hợp lệ hoặc không đủ quyền.", technicalMessage };
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
