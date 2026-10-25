import React, { useCallback, useEffect, useState } from "react";
import type { Command } from "../shared/contracts";
import { mapSeoOpsAuthError, mapSeoOpsAuthErrors } from "../shared/seo-ops-auth";
import { labelForStatus, type ScriptSyncRow } from "../shared/sync-status";
import type { ManualSyncResponse } from "../shared/sync-ipc";

type SessionState = {
  configured: boolean;
  baseUrl: string;
  authenticated: boolean;
  autoSyncEnabled: boolean;
  user?: { id: number; email: string; name: string; role: string };
  error?: string;
};

export function SeoOpsAuthPanel({
  locked,
  invoke,
}: {
  locked: boolean;
  invoke: <T>(command: Command) => Promise<T>;
}) {
  const [session, setSession] = useState<SessionState>();
  const [baseUrl, setBaseUrl] = useState("http://seo-ops.test");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const next = await invoke<SessionState>({ type: "seoOpsGetSession" });
    setSession(next);
    setBaseUrl(next.baseUrl);
    if (next.error) setError(next.error);
  }, [invoke]);

  useEffect(() => {
    void refresh().catch((e) => setError(mapSeoOpsAuthError(String((e as Error).message || e))));
  }, [refresh]);

  async function run(work: () => Promise<unknown>) {
    if (locked || busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
      setPassword("");
    } catch (e) {
      setError(mapSeoOpsAuthError(String((e as Error).message || e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="seo-ops-auth" aria-label="SEO-OPS Login">
      <h2>SEO-OPS Account</h2>
      <p>Đăng nhập bằng tài khoản SEO-OPS (`admin` / `owner`). Auto-sync hiện {session?.autoSyncEnabled ? "bật" : "tắt"}; manual Sync và Scenario local vẫn hoạt động.</p>
      <label>
        Endpoint
        <input
          disabled={locked || busy}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://seo-ops.test"
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
            });
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
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function SeoOpsSyncControls({
  locked,
  authenticated,
  autoSyncEnabled,
  flowId,
  invoke,
  onRows,
}: {
  locked: boolean;
  authenticated: boolean;
  autoSyncEnabled: boolean;
  flowId?: string;
  invoke: <T>(command: Command) => Promise<T>;
  onRows?: (rows: ScriptSyncRow[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rows, setRows] = useState<ScriptSyncRow[]>([]);
  const [backupLabel, setBackupLabel] = useState("");

  const applyRows = useCallback(
    (next: ScriptSyncRow[]) => {
      setRows(next);
      onRows?.(next);
    },
    [onRows],
  );

  const pullStatus = useCallback(async () => {
    const result = await invoke<{ rows: ScriptSyncRow[] }>({ type: "seoOpsSyncStatus" });
    applyRows(result.rows);
  }, [invoke, applyRows]);

  useEffect(() => {
    if (!authenticated || !autoSyncEnabled) return;
    void pullStatus().catch(() => undefined);
    const timer = setInterval(() => {
      void pullStatus().catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [authenticated, autoSyncEnabled, pullStatus]);
  useEffect(() => {
    if (!authenticated) return;
    const read = () => void invoke<{ backup?: unknown }>({ type: "seoOpsBackupInfo" })
      .then(value => setBackupLabel(value.backup ? "Backed up" : "Backup pending"))
      .catch(() => setBackupLabel("Backup failed"));
    read();
  }, [authenticated, invoke]);

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
        return;
      }
      applyRows(result.rows);
      const s = result.summary;
      setMessage(s ? `Sync xong: ${s.published} published, ${s.unchanged} unchanged, ${s.blocked} draft blocked, ${s.reports} reports, ${s.failed} failed`
        : `Sync xong: ${result.results.length} mục`);
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
        if (!window.confirm(`Backup ${info?.backed_up_at ?? ""}: ${counts.scenarios ?? 0} Scenario, ${counts.stepVersions ?? 0} Step versions. Dữ liệu local hiện tại sẽ được backup riêng trước khi restore. Tiếp tục?`)) {
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
      <button disabled={locked || busy || !authenticated} onClick={() => void runSync()}>
        Sync now
      </button>
      <button disabled={locked || busy || !authenticated} onClick={() => void restoreBackup()}>
        Restore from SEO-OPS
      </button>
      {message && <small>{message}</small>}
      {backupLabel && <small>{backupLabel}</small>}
      {rows.length > 0 && (
        <details className="seo-ops-sync-summary">
          <summary>Diagnostics sync ({rows.length})</summary>
          <ul>
            {rows.map((row) => (
              <li key={row.script_id}>
                <b>{row.name}</b> — {labelForStatus(row.status)}
                {row.message ? ` · ${row.message}` : ""}
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
  const demo = row.demo_status === "ready" ? "Demo ready"
    : row.demo_status === "outdated" ? "Demo outdated"
      : row.demo_status === "error" ? "Demo error" : "Missing demo";
  return `${demo} · ${labelForStatus(row.status)}`;
}
