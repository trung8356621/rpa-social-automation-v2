export type SyncStatusCode =
  | "local_only"
  | "synced"
  | "remote_only"
  | "local_changes"
  | "remote_changes"
  | "conflict"
  | "incomplete_assets"
  | "sync_error"
  | "unknown";

export const SYNC_STATUS_LABEL: Record<SyncStatusCode, string> = {
  local_only: "Local only",
  synced: "Synced",
  remote_only: "Remote only",
  local_changes: "Local changes",
  remote_changes: "Remote changes",
  conflict: "Conflict",
  incomplete_assets: "Incomplete assets",
  sync_error: "Sync error",
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
};

export function labelForStatus(code: SyncStatusCode): string {
  return SYNC_STATUS_LABEL[code] ?? code;
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
  error?: string;
}): SyncStatusCode {
  if (input.error) return "sync_error";
  if (input.incomplete) return "incomplete_assets";
  if (input.conflict) return "conflict";
  if (input.hasLocal && !input.hasRemote) return "local_only";
  if (!input.hasLocal && input.hasRemote) return "remote_only";
  if (input.sameDigest) return "synced";
  if (input.localAhead) return "local_changes";
  if (input.remoteAhead) return "remote_changes";
  return "unknown";
}
