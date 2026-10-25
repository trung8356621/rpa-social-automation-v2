import React, { useEffect, useState } from "react";
import { UiPopover } from "./ui-popover";
import type { AppPage, Command, ScenarioOrganization, State } from "../shared/contracts";
import type { ScriptSyncRow } from "../shared/sync-status";
import { SeoOpsSyncControls, getScenarioSyncBadge, scriptVersionLabel, syncBadge, type SeoOpsSessionState } from "./seo-ops-panel";
import { ScriptHealthPanel } from "./script-health-panel";

/** Primary Admin nav only — Variations / Widget / Workflow / Builds remain routable legacy, not listed. */
const menus = [
  { page: "scenarios", label: "Scripts", color: "#68d6a6", path: "M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M10 7h7v7" },
  { page: "browser-sessions", label: "Browser Sessions", color: "#75b9ff", path: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" },
  { page: "test-lab", label: "Test Lab", color: "#f4ae67", path: "M9 3h6M10 3v7L4 19q-1 2 2 2h12q3 0 2-2l-6-9V3M7 15h10" },
  { page: "settings", label: "Settings", color: "#a8b2c2", path: "m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
] as const;

export function AppNavigation({ page, collapsed, locked, navigate, toggle }: {
  page: AppPage; collapsed: boolean; locked: boolean;
  navigate: (page: AppPage) => void; toggle: () => void;
}) {
  return <div className={`app-sidebar${collapsed ? " collapsed" : ""}`}>
    <div className="app-sidebar-heading">
      {!collapsed && <b>RPA Social <small>V2</small></b>}
      <button disabled={locked} aria-label={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}
        title={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"} onClick={toggle}>{collapsed ? "»" : "«"}</button>
    </div>
    <nav className="app-menu" aria-label="Điều hướng chính">
      {menus.map(item => <button key={item.page} disabled={locked} title={item.label}
        aria-label={item.label} aria-current={(page === "creator" ? "scenarios" : page) === item.page ? "page" : undefined}
        onClick={() => navigate(item.page)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={item.color}
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.path} /></svg>
        {!collapsed && <span>{item.label}</span>}
      </button>)}
    </nav>
  </div>;
}

function ScenarioDemo({ flowId, state, invoke }: { flowId: string; state?: State; invoke?: <T>(command: Command) => Promise<T> }) {
  const demo = state?.scenarioDemos?.[flowId];
  const [thumbnail, setThumbnail] = useState("");
  const [video, setVideo] = useState("");
  useEffect(() => {
    let active = true; setThumbnail(""); setVideo("");
    if (demo && invoke) void invoke<string>({ type: "scenarioDemoMedia", flowId, media: "thumbnail" })
      .then(value => { if (active) setThumbnail(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [flowId, demo?.runId, invoke]);
  if (!demo) return <div className="scenario-demo-placeholder" aria-label="Chưa có Script Demo">No demo</div>;
  return <>
    <button className="scenario-demo-thumb" disabled={!thumbnail || !invoke} title="Xem Script Demo" onClick={() => {
      if (!invoke) return;
      void invoke<string>({ type: "scenarioDemoMedia", flowId, media: "video" }).then(setVideo).catch(() => undefined);
    }}>{thumbnail ? <img src={thumbnail} alt="Script Demo thumbnail" /> : <span>Loading…</span>}</button>
    <span className={`demo-status ${demo.status}`}>{demo.status === "ready" ? "Ready" : "Outdated"}</span>
    {video && <UiPopover variant="modal" label="Script Demo" className="scenario-demo-preview" close={() => setVideo("")}>
      <div className="popover-heading"><b>Script Demo</b><button onClick={() => setVideo("")} aria-label="Đóng video">×</button></div>
      <video controls autoPlay={false} preload="metadata" src={video} />
    </UiPopover>}
  </>;
}

export function ScenariosPage({ state, name, setName, locked, open, create, quickAcceptance, sessionControl, update, invoke, seoOpsSession, autoSyncEnabled, onSeoOpsSession, reconnectSeoOps, onState }: {
  state?: State; name: string; setName: (name: string) => void; locked: boolean;
  open: (id: string, focus?: { stepId: string; version: number }) => void; create: () => void;
  quickAcceptance: (id: string) => void;
  sessionControl?: React.ReactNode; update: (command: Command) => Promise<void>;
  invoke?: <T>(command: Command) => Promise<T>;
  seoOpsSession?: SeoOpsSessionState;
  autoSyncEnabled?: boolean;
  onSeoOpsSession?: (session: SeoOpsSessionState) => void;
  reconnectSeoOps?: () => void;
  onState?: (state: State) => void;
}) {
  type BackupResult = { status: "working" | "verified" | "incomplete" | "cancelled" | "failed";
    message?: string; counts?: { scenarios: number; stepVersions: number; assets: number; missingFiles: number };
    missing?: Array<{ logicalReference: string; originalPath?: string; scenarioId?: string; variableKey?: string }> };
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "create" | "rename" | "delete" | "move" | "scenario-delete"; id?: string }>();
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [backupResult, setBackupResult] = useState<BackupResult>();
  const [importResult, setImportResult] = useState<{ status: string; token?: string; message?: string;
    counts?: BackupResult["counts"]; hasExistingData?: boolean; rollbackPath?: string }>();
  const [syncRows, setSyncRows] = useState<ScriptSyncRow[]>([]);
  const organization: ScenarioOrganization = state?.scenarioOrganization ?? { groups: [], membership: {}, ungroupedCollapsed: false };
  const disabled = locked || working;

  useEffect(() => {
    if (!invoke) return;
    void invoke<{ rows: ScriptSyncRow[] }>({ type: "seoOpsSyncStatus" })
      .then((r) => setSyncRows(r.rows))
      .catch(() => undefined);
  }, [invoke, seoOpsSession?.authenticated, state?.flows]);
  function show(kind: "create" | "rename" | "delete" | "move" | "scenario-delete", id?: string, initial = "") {
    setValue(initial); setError(""); setDialog({ kind, id });
  }
  async function apply(command: Command, close = false) {
    if (disabled) return;
    setWorking(true); setError("");
    try { await update(command); if (close) setDialog(undefined); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }
  function submit() {
    if (!dialog) return;
    const command: Command = dialog.kind === "create" ? { type: "createScenarioGroup", name: value }
      : dialog.kind === "rename" ? { type: "updateScenarioGroup", id: dialog.id!, name: value }
      : dialog.kind === "delete" ? { type: "deleteScenarioGroup", id: dialog.id!, confirmed: true }
      : dialog.kind === "scenario-delete" ? { type: "deleteScenario", id: dialog.id!, confirmed: true }
      : { type: "moveScenarioToGroup", flowId: dialog.id!, groupId: value || undefined };
    void apply(command, true);
  }
  const groups = [...organization.groups, { id: "", name: "Chưa phân nhóm", collapsed: organization.ungroupedCollapsed }];
  return <section className="app-page scenarios-page" aria-label="Scripts">
    <div className="page-heading"><small>RPA Social Automation V2</small><h1>Scripts</h1>
      <p>Mở nhiều Script bằng tab. Bản nháp Editor được giữ riêng trong mỗi tab.</p></div>
    <div className="scenario-toolbar">
      <button disabled={disabled} onClick={() => show("create")}>+ Group</button>
      <button className="primary" disabled={disabled} onClick={() => setCreating(v => !v)}>+ Script</button>
      <button className="primary" disabled={disabled || !invoke} onClick={() => {
        if (!invoke) return; setWorking(true); setBackupResult({ status: "working", message: "Đang đóng gói và xác minh Full Backup…" });
        void invoke<BackupResult>({ type: "exportFullBackup" })
          .then(setBackupResult)
          .catch(() => setBackupResult({ status: "failed", message: "Không thể tạo Full Backup. Xem application log để biết chi tiết." }))
          .finally(() => setWorking(false));
      }}>Export Full Backup (.zip)</button>
      <button disabled={disabled || !invoke} onClick={() => {
        if (!invoke) return; setWorking(true); setImportResult({ status: "working", message: "Đang kiểm tra backup…" });
        void invoke<{ status: string; token?: string; message?: string; counts?: BackupResult["counts"]; hasExistingData?: boolean }>({ type: "importFullBackup" })
          .then(setImportResult).catch(() => setImportResult({ status: "failed", message: "Không thể đọc Full Backup. Xem application log." }))
          .finally(() => setWorking(false));
      }}>Import Full Backup (.zip)</button>
      {sessionControl}
      {invoke && (
        <SeoOpsSyncControls
          locked={disabled}
          session={seoOpsSession}
          autoSyncEnabled={Boolean(autoSyncEnabled)}
          invoke={invoke}
          onRows={setSyncRows}
          onSession={onSeoOpsSession}
          reconnect={reconnectSeoOps}
        />
      )}
    </div>
    {backupResult && <section className={`backup-result ${backupResult.status}`} role={backupResult.status === "incomplete" || backupResult.status === "failed" ? "alert" : "status"}>
      <b>{backupResult.status === "working" ? "Đang export"
        : backupResult.status === "verified" ? "Full Backup đã được lưu và xác minh"
          : backupResult.status === "incomplete" ? "Backup chưa hoàn chỉnh — chưa tạo file ZIP"
            : backupResult.status === "cancelled" ? "Đã hủy export" : "Export thất bại"}</b>
      {backupResult.message && <p>{backupResult.message}</p>}
      {backupResult.counts && <p>{backupResult.counts.scenarios} Script · {backupResult.counts.stepVersions} Step versions · {backupResult.counts.assets} assets · {backupResult.counts.missingFiles} file thiếu</p>}
      {backupResult.missing && backupResult.missing.length > 0 && <ul>{Object.entries(backupResult.missing.reduce<Record<string, { paths: string[]; scenarioId?: string }>>((groups, item) => {
        const group = groups[item.logicalReference] ??= { paths: [], scenarioId: item.scenarioId };
        group.paths.push(item.originalPath ?? "Không rõ đường dẫn"); return groups;
      }, {})).map(([reference, group]) => <li key={reference}><strong>{reference} → {group.paths.length} file thiếu</strong>
        {group.scenarioId && <button type="button" onClick={() => open(group.scenarioId!)}>Mở Script để sửa</button>}
        <details><summary>Xem đường dẫn</summary>{group.paths.map(file => <code key={file}>{file}</code>)}</details></li>)}</ul>}
    </section>}
    {importResult && importResult.status !== "cancelled" && <section className={`backup-result ${importResult.status}`} role={importResult.status === "failed" ? "alert" : "status"}>
      <b>{importResult.status === "working" ? "Đang kiểm tra backup"
        : importResult.status === "preview" ? "Backup hợp lệ — sẵn sàng khôi phục"
          : importResult.status === "restored" ? "Đã khôi phục Full Backup" : "Import thất bại"}</b>
      {importResult.message && <p>{importResult.message}</p>}
      {importResult.counts && <p>{importResult.counts.scenarios} Script · {importResult.counts.stepVersions} Step versions · {importResult.counts.assets} assets</p>}
      {importResult.status === "preview" && importResult.token && <><p>{importResult.hasExistingData
        ? "Dữ liệu hiện tại sẽ được thay thế sau khi tạo rollback backup. Không merge dữ liệu."
        : "Profile hiện tại trống. Một rollback backup vẫn sẽ được tạo trước khi restore."}</p>
        <button className="primary" disabled={disabled} onClick={() => {
          if (!invoke || !window.confirm("Khôi phục backup này? Dữ liệu hiện tại sẽ được thay thế và lưu rollback riêng.")) return;
          setWorking(true); const token = importResult.token!; setImportResult({ ...importResult, status: "working", message: "Đang khôi phục…" });
          void invoke<{ status: string; message?: string; counts?: BackupResult["counts"]; rollbackPath?: string }>({ type: "importFullBackup", token, confirmed: true })
            .then(result => { setImportResult(result); if (result.status === "restored") window.location.reload(); })
            .catch(() => setImportResult({ status: "failed", message: "Khôi phục thất bại. Dữ liệu rollback đã được giữ lại." }))
            .finally(() => setWorking(false));
        }}>Xác nhận khôi phục</button></>}
    </section>}
    {creating && <form className="scenario-create" onSubmit={event => { event.preventDefault(); create(); }}>
      <label>Tên Script mới<input aria-label="Tên flow mới" value={name} disabled={disabled}
        onChange={event => setName(event.target.value)} /></label>
      <button className="primary" disabled={disabled || !state || !name.trim()} type="submit">Tạo Script</button>
    </form>}
    {!dialog && error && <p role="alert">{error}</p>}
    {state?.scriptRequests && state.scriptRequests.length > 0 && (
      <section className="script-requests-panel" aria-label="Script Requests" style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 8, border: "1px solid var(--border, #3a3f45)", background: "var(--card-bg, #202428)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <b style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>SEO-OPS Script Requests</span>
            <small style={{ fontWeight: "normal", color: "#8b949e" }}>({state.scriptRequests.filter(r => r.status !== "published").length} việc cần làm)</small>
          </b>
        </div>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {state.scriptRequests.map(req => (
            <div key={req.request_id} style={{ padding: 10, borderRadius: 6, border: "1px solid #333", background: "#181b1e", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <code style={{ fontSize: 12, color: "#68d6a6" }}>{req.action_tag_key}</code>
                <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: req.status === "needs_fix" ? "#5a1d1d" : req.status === "developing" ? "#1e3a5f" : "#283430", color: req.status === "needs_fix" ? "#f87171" : req.status === "developing" ? "#60a5fa" : "#34d399" }}>
                  {req.request_type === "fix" ? "Fix" : "Create"} · {req.status}
                </span>
              </div>
              {req.error_reason && <p style={{ fontSize: 11, color: "#f87171", margin: "2px 0" }}>{req.error_reason}</p>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <small style={{ fontSize: 10, color: "#888" }}>{req.request_id}</small>
                {req.status !== "published" && (
                  <button
                    className="primary"
                    disabled={disabled || !invoke}
                    onClick={() => {
                      void invoke({ type: "createScriptFromRequest", requestId: req.request_id });
                    }}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    Create Script
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    )}
    <div className="scenario-groups">
      {groups.map(group => {
        const flows = state?.flows.filter(f => {
          const assigned = organization.membership[f.id];
          return group.id ? assigned === group.id : !organization.groups.some(g => g.id === assigned);
        }) ?? [];
        return <section className="scenario-folder" key={group.id}>
          <div className="scenario-folder-heading">
            <button disabled={disabled} aria-expanded={!group.collapsed} onClick={() => void apply(group.id
              ? { type: "updateScenarioGroup", id: group.id, collapsed: !group.collapsed }
              : { type: "collapseUngroupedScenarios", collapsed: !group.collapsed })}>
              {group.collapsed ? "▸" : "▾"} {group.name} <small>({flows.length})</small>
            </button>
            {group.id && <details><summary aria-label={`Menu Group ${group.name}`}>...</summary><div className="scenario-menu">
              <button disabled={disabled} onClick={() => show("rename", group.id, group.name)}>Đổi tên</button>
              <button disabled={disabled} onClick={() => show("delete", group.id)}>Xóa Group</button>
            </div></details>}
          </div>
          {!group.collapsed && <div className="scenario-items">
            {flows.map(flow => {
              const invalidPinned = flow.steps.filter(ref =>
                (state?.invalidSteps ?? []).some(r => r.stepId === ref.id && r.version === ref.version));
              const syncInfo = getScenarioSyncBadge(syncRows, flow.id);
              return <div className="scenario-item" key={flow.id}>
              <div className="scenario-title-cell">
                <button className="scenario-title" disabled={disabled} onClick={() => open(flow.id)} title={flow.name}>
                  {flow.name}
                </button>
                <span className={`scenario-sync-badge sync-status-${syncInfo.statusKey}`} title={syncInfo.title} aria-label={`Sync: ${syncInfo.label}`}>
                  {syncInfo.label}
                </span>
              </div>
              <small>{flow.steps.length} Step</small>
              <ScenarioDemo flowId={flow.id} state={state} invoke={invoke} />
              {invalidPinned.length > 0 && (
                <small className="hint" title={`${invalidPinned.length} pinned version lỗi — mở Script Health Check`}>
                  {invalidPinned.length} Step cần sửa
                </small>
              )}
              <small className="script-version" aria-label={`Version ${flow.name}`}>{scriptVersionLabel(syncRows, flow.id)}</small>
              <button disabled={disabled} onClick={() => open(flow.id)}>Mở Creator</button>
              <button className="scenario-acceptance" disabled={disabled} onClick={() => quickAcceptance(flow.id)}>Nghiệm thu</button>
              <details><summary aria-label={`Menu Script ${flow.name}`}>...</summary><div className="scenario-menu">
                <button disabled={disabled} onClick={() => show("move", flow.id, organization.membership[flow.id] ?? "")}>Move to Group</button>
                <button disabled={disabled} onClick={() => show("scenario-delete", flow.id)}>Delete Script</button>
              </div></details>
            </div>;
            })}
            {!flows.length && <p className="page-empty">Chưa có Script trong nhóm.</p>}
          </div>}
        </section>;
      })}
    </div>
    {invoke && (
      <ScriptHealthPanel
        state={state}
        locked={disabled}
        invoke={invoke}
        open={open}
        onPinned={(next) => onState?.(next)}
      />
    )}
    {dialog && <UiPopover variant="modal" label={dialog.kind === "scenario-delete" ? "Delete Script" : "Scenario Group"} className="unsaved-confirm"
      close={() => { if (!working) setDialog(undefined); }}>
      <div className="popover-heading"><b>{dialog.kind === "scenario-delete" ? "Delete Script" : dialog.kind === "create" ? "Tạo Group" : dialog.kind === "rename" ? "Đổi tên Group" : dialog.kind === "delete" ? "Xóa Group" : "Move to Group"}</b>
        <button disabled={working} onClick={() => setDialog(undefined)}>×</button></div>
      {dialog.kind === "scenario-delete" ? <p>Xóa Script “{state?.flows.find(f => f.id === dialog.id)?.name}” cùng các Step/Version thuộc riêng Script này? Thao tác này không thể hoàn tác.</p>
        : dialog.kind === "delete" ? <p>Xóa Group này? Các Script sẽ chuyển về Chưa phân nhóm, toàn bộ dữ liệu được giữ nguyên.</p>
        : dialog.kind === "move" ? <label>Group<select value={value} disabled={working} onChange={e => setValue(e.target.value)}>
          <option value="">Chưa phân nhóm</option>{organization.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
        : <label>Tên Group<input value={value} maxLength={80} disabled={working} onChange={e => setValue(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}
      <div className="popover-footer"><button disabled={working} onClick={() => setDialog(undefined)}>Hủy</button>
        <button className="primary" disabled={disabled || (["create", "rename"].includes(dialog.kind) && !value.trim())} onClick={submit}>
          {dialog.kind === "scenario-delete" ? "Delete Script" : dialog.kind === "delete" ? "Xóa Group" : "Lưu"}</button></div>
    </UiPopover>}
  </section>;
}

export function PlaceholderPage({ page }: { page: "browser-sessions" | "test-lab" }) {
  return <section className="app-page" aria-label={page === "browser-sessions" ? "Browser Sessions" : "Test Lab"}>
    <div className="page-heading"><h1>{page === "browser-sessions" ? "Browser Sessions" : "Test Lab"}</h1>
      <p>{page === "browser-sessions"
        ? "Quản lý các phiên trình duyệt độc lập để test kịch bản trên những môi trường đăng nhập khác nhau."
        : "Không gian chạy thử kịch bản với Session và dữ liệu đầu vào khác nhau."}</p>
    </div><p className="page-empty">Chức năng này sẽ được thiết kế trong giai đoạn sau.</p>
  </section>;
}
