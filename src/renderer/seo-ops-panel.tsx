import React, { useCallback, useEffect, useState } from "react";
import type { Command } from "../shared/contracts";
import { mapSeoOpsAuthError, mapSeoOpsAuthErrors } from "../shared/seo-ops-auth";
import { labelForStatus, type ScriptSyncRow } from "../shared/sync-status";
import { UiPopover } from "./ui-popover";

type SessionState = {
  configured: boolean;
  baseUrl: string;
  authenticated: boolean;
  user?: { id: number; email: string; name: string; role: string };
  error?: string;
};

function VersionDialog({
  open,
  defaultVersion,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  defaultVersion: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (version: string) => void;
}) {
  const [version, setVersion] = useState(defaultVersion);
  useEffect(() => {
    if (open) setVersion(defaultVersion);
  }, [open, defaultVersion]);
  if (!open) return null;
  return (
    <UiPopover variant="modal" label="Script version" className="unsaved-confirm" close={() => { if (!busy) onCancel(); }}>
      <div className="popover-heading">
        <b>Phiên bản Script (semver)</b>
        <button disabled={busy} onClick={onCancel}>×</button>
      </div>
      <p>Dùng khi push Script lên SEO-OPS. Để trống sẽ giữ phiên bản hiện tại.</p>
      <label>
        Version
        <input
          value={version}
          disabled={busy}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="1.0.0"
          autoFocus
        />
      </label>
      <div className="popover-actions">
        <button disabled={busy} onClick={onCancel}>Hủy</button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => onConfirm(version.trim() || defaultVersion)}
        >
          Sync now
        </button>
      </div>
    </UiPopover>
  );
}

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
      <p>Đăng nhập bằng tài khoản SEO-OPS (`admin` / `owner`). Sync Script tự chạy sau login; tạo/sửa/test Scenario local vẫn dùng được khi chưa login.</p>
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
  flowId,
  invoke,
  onRows,
}: {
  locked: boolean;
  authenticated: boolean;
  flowId?: string;
  invoke: <T>(command: Command) => Promise<T>;
  onRows?: (rows: ScriptSyncRow[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rows, setRows] = useState<ScriptSyncRow[]>([]);
  const [versionDialog, setVersionDialog] = useState<"all" | "one" | null>(null);

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
    if (!authenticated) return;
    void pullStatus().catch(() => undefined);
    const timer = setInterval(() => {
      void pullStatus().catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [authenticated, pullStatus]);

  async function runSync(all: boolean, version?: string) {
    if (!authenticated) {
      setMessage("Cần đăng nhập SEO-OPS trước khi sync.");
      return;
    }
    if (locked || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await invoke<{
        results: Array<{ script_id: string; action: string; ok: boolean; message?: string }>;
        rows: ScriptSyncRow[];
      }>(
        all
          ? { type: "seoOpsSyncAll", version }
          : { type: "seoOpsSyncFlow", flowId: flowId!, version },
      );
      applyRows(result.rows);
      const conflicts = result.results.filter((r) => r.action === "conflict").length;
      const failed = result.results.filter((r) => !r.ok && r.action !== "conflict").length;
      setMessage(
        `Sync xong: ${result.results.length} mục` +
          (conflicts ? `, ${conflicts} conflict (không overwrite)` : "") +
          (failed ? `, ${failed} lỗi` : ""),
      );
    } catch (e) {
      setMessage(mapSeoOpsAuthError(String((e as Error).message || e)));
    } finally {
      setBusy(false);
      setVersionDialog(null);
    }
  }

  return (
    <div className="seo-ops-sync-controls">
      <button disabled={locked || busy || !authenticated} onClick={() => setVersionDialog("all")}>
        Sync now
      </button>
      {flowId && (
        <button disabled={locked || busy || !authenticated} onClick={() => setVersionDialog("one")}>
          Sync Scenario này
        </button>
      )}
      {message && <small>{message}</small>}
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
      <VersionDialog
        open={versionDialog !== null}
        defaultVersion="1.0.0"
        busy={busy}
        onCancel={() => setVersionDialog(null)}
        onConfirm={(version) => void runSync(versionDialog === "all", version)}
      />
    </div>
  );
}

export function syncBadge(rows: ScriptSyncRow[], flowId: string): string {
  const row = rows.find((r) => r.flow_id === flowId || r.script_id === flowId);
  return row ? labelForStatus(row.status) : "—";
}
