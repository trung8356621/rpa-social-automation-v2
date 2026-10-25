export type SyncStatusCode =
  | "local_only"
  | "synced"
  | "remote_only"
  | "local_changes"
  | "remote_changes"
  | "conflict"
  | "incomplete_assets"
  | "missing_demo"
  | "sync_error"
  | "pending"
  | "unknown";

/** Compact UI labels required by Scenario list. */
export const SYNC_STATUS_LABEL: Record<SyncStatusCode, string> = {
  synced: "Synced",
  pending: "Pending",
  local_only: "Pending",
  local_changes: "Pending",
  remote_only: "Pending",
  remote_changes: "Pending",
  incomplete_assets: "Incomplete",
  missing_demo: "Missing demo",
  conflict: "Conflict",
  sync_error: "Error",
  unknown: "—",
};

export type ScriptSyncRow = {
  script_id: string;
  flow_id?: string;
  package_key: string;
  name: string;
  local_version?: string;
  remote_version?: string;
  local_digest?: string;
  remote_digest?: string;
  status: SyncStatusCode;
  last_sync_at?: string;
  last_result?: string;
  message?: string;
  incomplete?: boolean;
  demo_status?: "ready" | "missing" | "outdated" | "error";
  demo_reason?: string;
  published_version?: string;
  draft_status?: "new" | "unchanged" | "changed" | "blocked";
  draft_version?: string;
};

export function labelForStatus(code: SyncStatusCode): string {
  return SYNC_STATUS_LABEL[code] ?? code;
}

export function publishBlockerMessage(reasons: string[]): string {
  return [...new Set(reasons)].map(reason => {
    if (reason === "missing_demo") return "Missing demo — mở Test Lab, Run, rồi Use as Script Demo";
    if (reason === "steps_required") return "No Steps — thêm ít nhất một Step hợp lệ";
    if (reason === "SCRIPT_VERSION_METADATA_INCOMPLETE")
      return "Legacy release metadata incomplete — cần khôi phục digest/version metadata đã xác minh";
    if (reason === "SCRIPT_VERSION_CONFLICT") return "Version conflict — local và SEO-OPS không cùng release history";
    if (reason === "invalid_variable_ref") return "Invalid Script — sửa Variable reference trong Step";
    if (reason.startsWith("missing_asset:")) return `Missing OCR asset — ${reason.slice("missing_asset:".length)}`;
    if (/execution changed|Step versions changed/i.test(reason)) return `${reason} — chạy Test Lab lại cho Draft hiện tại`;
    if (/VIDEO_DEMO/i.test(reason)) return `${reason} — kiểm tra lại Script Demo`;
    return reason;
  }).join("; ");
}

/** Derive UI status from a plan entry for one script id. */
export function statusFromPlanSides(input: {
  hasLocal: boolean;
  hasRemote: boolean;
  sameDigest: boolean;
  conflict: boolean;
  localAhead: boolean;
  remoteAhead: boolean;
  incomplete: boolean;
  missingDemo?: boolean;
  error?: string;
  offlinePending?: boolean;
}): SyncStatusCode {
  if (input.error) return "sync_error";
  if (input.missingDemo) return "missing_demo";
  if (input.incomplete) return "incomplete_assets";
  if (input.conflict) return "conflict";
  if (input.offlinePending) return "pending";
  if (input.hasLocal && !input.hasRemote) return "local_only";
  if (!input.hasLocal && input.hasRemote) return "remote_only";
  if (input.sameDigest) return "synced";
  if (input.localAhead) return "local_changes";
  if (input.remoteAhead) return "remote_changes";
  return "unknown";
}
