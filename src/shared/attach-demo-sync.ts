import type { ManualSyncResponse } from "./sync-ipc.js";

export type AttachDemoSyncOutcome =
  | { kind: "published"; version: string; healthWarning?: boolean }
  | { kind: "already_synced"; healthWarning?: boolean }
  | { kind: "blocked"; reason: string }
  | { kind: "connection_failed"; reason: string }
  | { kind: "failed"; reason: string };

const HEALTH_NOTE = "Script đã đồng bộ, nhưng có Step cần cấu hình trước khi thực thi.";

/** User-facing one-liner after Demo save + targeted Sync. */
export function formatAttachDemoSyncMessage(outcome: AttachDemoSyncOutcome): string {
  switch (outcome.kind) {
    case "published":
      return outcome.healthWarning
        ? `Demo saved → Published v${outcome.version}. ${HEALTH_NOTE}`
        : `Demo saved → Published v${outcome.version}`;
    case "already_synced":
      return outcome.healthWarning
        ? `Demo saved → Already synchronized. ${HEALTH_NOTE}`
        : "Demo saved → Already synchronized";
    case "blocked":
      return `Demo saved → Sync blocked: ${outcome.reason}`;
    case "connection_failed":
      return "Demo saved → Connection failed: Retry Sync";
    case "failed":
      return `Demo saved → Sync blocked: ${outcome.reason}`;
  }
}

export function interpretSyncForFlow(
  flowId: string,
  sync: ManualSyncResponse,
): AttachDemoSyncOutcome {
  const row = sync.ok
    ? sync.rows.find((entry) => entry.flow_id === flowId || entry.script_id === flowId)
    : undefined;
  const healthWarning = Boolean(row?.health_warnings?.length || row?.health_status === "invalid_steps");

  if (!sync.ok) {
    if (
      sync.error.category === "network" ||
      sync.error.category === "timeout" ||
      sync.error.category === "service_unavailable"
    ) {
      return { kind: "connection_failed", reason: sync.error.message };
    }
    return { kind: "failed", reason: sync.error.technicalMessage || sync.error.message };
  }
  const result = sync.results.find((entry) => entry.script_id === flowId);
  if (!result) return { kind: "failed", reason: "No sync result for Script" };
  if (result.action === "publish_blocked") {
    return { kind: "blocked", reason: result.message || "incomplete" };
  }
  if (
    result.action === "unchanged" ||
    (/same_digest|idempotent/i.test(result.message || "") && result.ok)
  ) {
    return { kind: "already_synced", healthWarning };
  }
  if (result.ok && (result.action === "push" || /pushed/i.test(result.message || ""))) {
    const version =
      row?.published_version ||
      row?.local_version ||
      "?";
    return { kind: "published", version: String(version), healthWarning };
  }
  if (!result.ok) {
    // Remote/server rejection — never fabricate Published.
    return { kind: "failed", reason: result.message || "sync failed" };
  }
  return { kind: "blocked", reason: result.message || result.action };
}
