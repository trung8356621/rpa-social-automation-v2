import React, { useCallback, useEffect, useState } from "react";
import type { ActionTag, AppPage, Command, State } from "../shared/contracts";
import { mapSeoOpsAuthError, mapSeoOpsAuthErrors } from "../shared/seo-ops-auth";
import { SEO_OPS_DEFAULT_BASE_URL, SEO_OPS_PRODUCTION_BASE_URL, mapSeoOpsApiError } from "../shared/seo-ops-http";
import { labelForStatus, type ScriptSyncRow } from "../shared/sync-status";
import type { ManualSyncResponse } from "../shared/sync-ipc";

export type SeoOpsSessionState = {
  configured: boolean;
  baseUrl: string;
  authenticated: boolean;
  autoSyncEnabled: boolean;
  user?: { id: number; email: string; name: string; role: string };
  error?: string;
};

export type SeoOpsAuthGateState = {
  validating: boolean;
  authenticated: boolean;
  locked: boolean;
  redirectPage: "settings" | null;
  requiresLoginMessage: string | null;
};

export function resolveSeoOpsAuthGate(
  session: SeoOpsSessionState | undefined,
  currentPage: AppPage,
): SeoOpsAuthGateState {
  if (!session) {
    return {
      validating: true,
      authenticated: false,
      locked: true,
      redirectPage: null,
      requiresLoginMessage: null,
    };
  }
  if (!session.authenticated) {
    return {
      validating: false,
      authenticated: false,
      locked: true,
      redirectPage: currentPage === "settings" ? null : "settings",
      requiresLoginMessage: "Please log in to SEO-OPS to continue",
    };
  }
  return {
    validating: false,
    authenticated: true,
    locked: false,
    redirectPage: null,
    requiresLoginMessage: null,
  };
}

export function canAccessAppPage(
  session: SeoOpsSessionState | undefined,
  targetPage: AppPage,
): boolean {
  if (targetPage === "settings") return Boolean(session);
  return Boolean(session?.authenticated);
}

export function seoOpsSyncAvailability(session: SeoOpsSessionState | undefined, locked = false, busy = false) {
  if (locked) return { enabled: false, message: "Đợi tác vụ hiện tại kết thúc." };
  if (busy) return { enabled: false, message: "Đang xử lý SEO-OPS…" };
  if (!session) return { enabled: false, message: "Đang kiểm tra kết nối SEO-OPS…" };
  if (!session.configured) return { enabled: false, message: "Chưa cấu hình SEO-OPS. Mở Settings để nhập endpoint." };
  if (!session.authenticated) return { enabled: false, message: session.error
    ? mapSeoOpsAuthError(session.error)
    : "Chưa đăng nhập SEO-OPS. Mở Settings để kết nối." };
  // Soft warnings (429 etc.) must not disable Sync / Làm mới Tags.
  if (session.error && /giới hạn|rate.?limit|429|timeout|không kết nối/i.test(session.error)) {
    return { enabled: true, message: session.error };
  }
  return { enabled: true, message: "Đã kết nối SEO-OPS." };
}

export function SeoOpsAuthPanel({
  locked,
  initialSession,
  onLoginSuccess,
  invoke,
}: {
  locked: boolean;
  initialSession?: SeoOpsSessionState;
  onLoginSuccess?: () => void;
  invoke: <T>(command: Command) => Promise<T>;
}) {
  const [session, setSession] = useState<SeoOpsSessionState | undefined>(initialSession);
  const [baseUrl, setBaseUrl] = useState(initialSession?.baseUrl || SEO_OPS_DEFAULT_BASE_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialSession?.error || "");

  const refresh = useCallback(async (): Promise<SeoOpsSessionState> => {
    const next = await invoke<SeoOpsSessionState>({ type: "seoOpsGetSession" });
    setSession(next);
    setBaseUrl(next.baseUrl);
    if (next.error) setError(next.error);
    return next;
  }, [invoke]);

  useEffect(() => {
    if (!initialSession) return;
    setSession(initialSession);
    if (initialSession.baseUrl) setBaseUrl(initialSession.baseUrl);
    if (initialSession.error) setError(initialSession.error);
  }, [initialSession]);

  useEffect(() => {
    void refresh().catch((e) => setError(mapSeoOpsAuthError(String((e as Error).message || e))));
  }, [refresh]);

  async function run(work: () => Promise<unknown>, isLogin = false) {
    if (locked || busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      const next = await refresh();
      setPassword("");
      if (isLogin && next.authenticated) {
        onLoginSuccess?.();
      }
    } catch (e) {
      setError(mapSeoOpsAuthError(String((e as Error).message || e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="seo-ops-auth" aria-label="SEO-OPS Login">
      <h2>SEO-OPS Account</h2>
      <p>Đăng nhập bằng tài khoản SEO-OPS (`admin` / `owner`). Production: <code>{SEO_OPS_PRODUCTION_BASE_URL}</code>. Auto-sync hiện {session?.autoSyncEnabled ? "bật" : "tắt"}; manual Sync Scripts / Tags và Script local vẫn hoạt động.</p>
      <label>
        Endpoint
        <input
          disabled={locked || busy}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={SEO_OPS_PRODUCTION_BASE_URL}
        />
      </label>
      <button
        disabled={locked || busy}
        onClick={() => void run(() => invoke({ type: "seoOpsSetEndpoint", baseUrl }))}
      >
        Lưu endpoint
      </button>
      {session?.authenticated && session.user ? (
        <div className="seo-ops-user">
          <b>{session.user.name}</b>
          <span>{session.user.email}</span>
          <small>role: {session.user.role}</small>
          <button disabled={locked || busy} onClick={() => void run(() => invoke({ type: "seoOpsLogout" }))}>
            Logout
          </button>
        </div>
      ) : (
        <>
          <p className="seo-ops-auth-required" role="status">
            Please log in to SEO-OPS to continue
          </p>
          <form
            className="seo-ops-login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await invoke({ type: "seoOpsSetEndpoint", baseUrl });
                const result = await invoke<{ ok: boolean; errors?: string[] }>({
                  type: "seoOpsLogin",
                  email,
                  password,
                });
                if (!result.ok) throw new Error(mapSeoOpsAuthErrors(result.errors));
              }, true);
            }}
          >
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                disabled={locked || busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                disabled={locked || busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={locked || busy} type="submit">
              Đăng nhập SEO-OPS
            </button>
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function SeoOpsSyncControls({
  locked,
  session,
  autoSyncEnabled,
  flowId,
  invoke,
  onRows,
  onSession,
  reconnect,
  onSyncComplete,
}: {
  locked: boolean;
  session?: SeoOpsSessionState;
  autoSyncEnabled: boolean;
  flowId?: string;
  invoke: <T>(command: Command) => Promise<T>;
  onRows?: (rows: ScriptSyncRow[]) => void;
  onSession?: (session: SeoOpsSessionState) => void;
  reconnect?: () => void;
  onSyncComplete?: (tags: ActionTag[], nextState?: State) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rows, setRows] = useState<ScriptSyncRow[]>([]);
  const [currentSession, setCurrentSession] = useState(session);
  const authenticated = Boolean(currentSession?.authenticated);
  const availability = seoOpsSyncAvailability(currentSession, locked, busy);

  useEffect(() => { setCurrentSession(session); }, [session]);

  async function refreshSession() {
    const next = await invoke<SeoOpsSessionState>({ type: "seoOpsGetSession" });
    setCurrentSession(next); onSession?.(next);
    return next;
  }

  const applyRows = useCallback(
    (next: ScriptSyncRow[]) => {
      setRows(next);
      onRows?.(next);
    },
    [onRows],
  );

  async function runTagSync() {
    if (!authenticated) {
      setMessage("Cần đăng nhập SEO-OPS tại Settings trước khi đồng bộ.");
      return;
    }
    if (locked || busy) return;
    setBusy(true);
    setMessage("");
    try {
      // Tag metadata only — never runs Script sync / active-script package download.
      const res = await invoke<{
        ok: boolean;
        count?: number;
        tags?: ActionTag[];
        source?: string;
        error?: string;
        authRequired?: boolean;
        state?: State;
      }>({ type: "seoOpsRefreshActionTags", force: true });

      if (res.ok) {
        const count = res.count ?? res.tags?.length ?? 0;
        setMessage(`Đã làm mới ${count} Action Tag từ SEO-OPS (chỉ metadata, không sync Script).`);
        if (res.tags && onSyncComplete) {
          onSyncComplete(res.tags, res.state);
        }
      } else {
        const viaRequests = (res.tags?.length ?? 0) > 0
          ? ` — vẫn có ${res.tags!.length} Tag từ cache/Script Requests.`
          : "";
        setMessage(`Làm mới Tag thất bại: ${res.error || "Không thể lấy Action Tags"}${viaRequests}`);
        // Always push enriched tags so Creator/Scripts update even under 429.
        if (res.tags && onSyncComplete) {
          onSyncComplete(res.tags, res.state);
        }
        if (res.authRequired) {
          await refreshSession().catch(() => undefined);
        }
      }
    } catch (e) {
      setMessage(`Làm mới Tag thất bại: ${mapSeoOpsAuthError(String((e as Error).message || e))}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSync() {
    if (!authenticated) {
      setMessage("Cần đăng nhập SEO-OPS trước khi sync.");
      return;
    }
    if (locked || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await invoke<ManualSyncResponse>(
        { type: "seoOpsSyncAll" },
      );
      if (!result.ok) {
        setMessage(result.error.message);
        if (result.error.category === "authentication") await refreshSession().catch(() => undefined);
        return;
      }
      applyRows(result.rows);
      const s = result.summary;
      const prefix = s && (s.blocked > 0 || s.failed > 0) ? "Sync Scripts hoàn tất một phần" : "Sync Scripts hoàn tất";
      setMessage(s ? `${prefix}: ${s.published} published, ${s.downloaded} pulled, ${s.unchanged} unchanged, ${s.blocked} blocked, ${s.failed} failed`
        : `Sync Scripts xong: ${result.results.length} mục`);
      // syncAll already warmed tags; force:false avoids a second /action-tags hit (429).
      if (onSyncComplete) {
        const tagRefresh = await invoke<{ tags?: ActionTag[]; state?: State }>({
          type: "seoOpsRefreshActionTags",
          force: false,
        }).catch(() => undefined);
        if (Array.isArray(tagRefresh?.tags)) onSyncComplete(tagRefresh.tags, tagRefresh.state);
      }
    } catch (e) {
      setMessage(mapSeoOpsAuthError(String((e as Error).message || e)));
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    if (!authenticated || locked || busy) return;
    setBusy(true); setMessage("Đang kiểm tra backup…");
    try {
      const preview = await invoke<{ requiresConfirmation?: boolean; restored?: boolean; backup?: { backed_up_at?: string; summary?: Record<string, number> } }>({ type: "seoOpsRestore", confirmed: false });
      if (preview.requiresConfirmation) {
        const info = preview.backup; const counts = info?.summary ?? {};
        if (!window.confirm(`Backup ${info?.backed_up_at ?? ""}: ${counts.scenarios ?? 0} Script, ${counts.stepVersions ?? 0} Step versions. Dữ liệu local hiện tại sẽ được backup riêng trước khi restore. Tiếp tục?`)) {
          setMessage("Đã hủy Restore."); return;
        }
        await invoke({ type: "seoOpsRestore", confirmed: true });
      }
      setMessage("Restore hoàn tất. Dữ liệu local cũ đã được lưu trong restore-backups.");
    } catch (error) { setMessage(`Restore thất bại: ${String((error as Error).message || error)}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="seo-ops-sync-controls">
      <button
        className="primary"
        disabled={!availability.enabled || busy}
        title={availability.enabled ? "Publish/Sync Script catalog với SEO-OPS (plan + push/pull)" : availability.message}
        onClick={() => void runSync()}
      >
        {busy ? "Đang Sync Scripts…" : "Sync Scripts"}
      </button>
      <button
        disabled={!availability.enabled || busy}
        title={availability.enabled ? "Làm mới danh sách Action Tags từ SEO-OPS (không sync Script)" : availability.message}
        onClick={() => void runTagSync()}
      >
        {busy ? "Đang làm mới Tags…" : "Làm mới Tags"}
      </button>
      {!availability.enabled && <small role="status">{availability.message} {reconnect && !locked && !busy &&
        <button type="button" onClick={currentSession?.error && !/expired|hết hạn|unauthenticated/i.test(currentSession.error)
          ? () => void refreshSession() : reconnect}>{currentSession?.error ? "Kết nối lại" : "Mở Settings"}</button>}</small>}
      {availability.enabled && currentSession?.error && /giới hạn|rate.?limit|429/i.test(currentSession.error) && (
        <small role="status">{currentSession.error}</small>
      )}
      {message && <small role="status">{message}</small>}
      {rows.length > 0 && (
        <details className="seo-ops-sync-summary">
          <summary>Diagnostics sync ({rows.length})</summary>
          <ul>
            {rows.map((row) => (
              <li key={row.script_id}>
                <b>{row.name}</b> — {labelForStatus(row.status)}
                {row.message ? ` · ${mapSeoOpsApiError(row.message)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function syncBadge(rows: ScriptSyncRow[], flowId: string): string {
  const row = rows.find((r) => r.flow_id === flowId || r.script_id === flowId);
  if (!row) return "—";
  return labelForStatus(row.status);
}

export type ScenarioSyncBadgeInfo = {
  label: "Synced" | "Not synced" | "Sync error" | "Incomplete" | "Conflict" | "Missing demo";
  statusKey: "synced" | "not-synced" | "error" | "incomplete" | "conflict" | "blocked";
  title: string;
};

export function getScenarioSyncBadge(rows: ScriptSyncRow[], flowId: string): ScenarioSyncBadgeInfo {
  const row = rows.find((r) => r.flow_id === flowId || r.script_id === flowId);
  if (!row) {
    return { label: "Not synced", statusKey: "not-synced", title: "Chưa đồng bộ với SEO-OPS" };
  }
  const message = row.message || row.demo_reason || "";
  if (row.status === "synced") {
    return { label: "Synced", statusKey: "synced", title: message || "Release hiện tại đã xác nhận đồng bộ" };
  }
  if (row.status === "sync_error") {
    return { label: "Sync error", statusKey: "error", title: message || "Lần đồng bộ gần nhất thất bại" };
  }
  if (row.status === "incomplete_assets") {
    return { label: "Incomplete", statusKey: "incomplete", title: message || "Thiếu assets cần thiết để đồng bộ" };
  }
  if (row.status === "conflict") {
    return { label: "Conflict", statusKey: "conflict", title: message || "Xung đột phiên bản release giữa Local và SEO-OPS" };
  }
  if (row.status === "missing_demo") {
    return { label: "Missing demo", statusKey: "blocked", title: message || "Chưa có Script Demo hợp lệ để đồng bộ" };
  }
  return { label: "Not synced", statusKey: "not-synced", title: message || "Chưa đồng bộ hoặc có thay đổi chưa publish" };
}

export function scriptVersionLabel(rows: ScriptSyncRow[], flowId: string): string {
  const row = rows.find((r) => r.flow_id === flowId || r.script_id === flowId);
  if (!row) return "v1";
  if (row.draft_status === "changed" && row.draft_version) return `v${row.draft_version}`;
  return `v${row.published_version || "1"}`;
}
