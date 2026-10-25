import React, { useEffect, useState } from "react";
import { UiPopover } from "./ui-popover";
import type { AppPage, Command, ScenarioOrganization, State } from "../shared/contracts";
import type { ScriptSyncRow } from "../shared/sync-status";
import { SeoOpsSyncControls, syncBadge } from "./seo-ops-panel";
import { ScriptHealthPanel } from "./script-health-panel";

/** Primary Admin nav only — Variations / Widget / Workflow / Builds remain routable legacy, not listed. */
const menus = [
  { page: "scenarios", label: "Scenarios", color: "#68d6a6", path: "M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M10 7h7v7" },
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

export function ScenariosPage({ state, name, setName, locked, open, create, sessionControl, update, invoke, authenticated, autoSyncEnabled, onState }: {
  state?: State; name: string; setName: (name: string) => void; locked: boolean;
  open: (id: string, focus?: { stepId: string; version: number }) => void; create: () => void;
  sessionControl?: React.ReactNode; update: (command: Command) => Promise<void>;
  invoke?: <T>(command: Command) => Promise<T>;
  authenticated?: boolean;
  autoSyncEnabled?: boolean;
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
  const [syncRows, setSyncRows] = useState<ScriptSyncRow[]>([]);
  const organization: ScenarioOrganization = state?.scenarioOrganization ?? { groups: [], membership: {}, ungroupedCollapsed: false };
  const disabled = locked || working;

  useEffect(() => {
    if (!invoke || !authenticated) return;
    void invoke<{ rows: ScriptSyncRow[] }>({ type: "seoOpsSyncStatus" })
      .then((r) => setSyncRows(r.rows))
      .catch(() => undefined);
  }, [invoke, authenticated, state?.flows?.length]);
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
  return <section className="app-page scenarios-page" aria-label="Scenarios">
    <div className="page-heading"><small>RPA Social Automation V2</small><h1>Scenarios</h1>
      <p>Mở nhiều kịch bản bằng tab. Bản nháp Editor được giữ riêng trong mỗi tab.</p></div>
    <div className="scenario-toolbar">
      <button disabled={disabled} onClick={() => show("create")}>+ Group</button>
      <button className="primary" disabled={disabled} onClick={() => setCreating(v => !v)}>+ Scenario</button>
      <button className="primary" disabled={disabled || !invoke} onClick={() => {
        if (!invoke) return; setWorking(true); setBackupResult({ status: "working", message: "Đang đóng gói và xác minh Full Backup…" });
        void invoke<BackupResult>({ type: "exportFullBackup" })
          .then(setBackupResult)
          .catch(() => setBackupResult({ status: "failed", message: "Không thể tạo Full Backup. Xem application log để biết chi tiết." }))
          .finally(() => setWorking(false));
      }}>Export Full Backup (.zip)</button>
      {sessionControl}
      {invoke && (
        <SeoOpsSyncControls
          locked={disabled}
          authenticated={Boolean(authenticated)}
          autoSyncEnabled={Boolean(autoSyncEnabled)}
          invoke={invoke}
          onRows={setSyncRows}
        />
      )}
    </div>
    {backupResult && <section className={`backup-result ${backupResult.status}`} role={backupResult.status === "incomplete" || backupResult.status === "failed" ? "alert" : "status"}>
      <b>{backupResult.status === "working" ? "Đang export"
        : backupResult.status === "verified" ? "Full Backup đã được lưu và xác minh"
          : backupResult.status === "incomplete" ? "Backup chưa hoàn chỉnh — chưa tạo file ZIP"
            : backupResult.status === "cancelled" ? "Đã hủy export" : "Export thất bại"}</b>
      {backupResult.message && <p>{backupResult.message}</p>}
      {backupResult.counts && <p>{backupResult.counts.scenarios} Scenario · {backupResult.counts.stepVersions} Step versions · {backupResult.counts.assets} assets · {backupResult.counts.missingFiles} file thiếu</p>}
      {backupResult.missing && backupResult.missing.length > 0 && <ul>{Object.entries(backupResult.missing.reduce<Record<string, { paths: string[]; scenarioId?: string }>>((groups, item) => {
        const group = groups[item.logicalReference] ??= { paths: [], scenarioId: item.scenarioId };
        group.paths.push(item.originalPath ?? "Không rõ đường dẫn"); return groups;
      }, {})).map(([reference, group]) => <li key={reference}><strong>{reference} → {group.paths.length} file thiếu</strong>
        {group.scenarioId && <button type="button" onClick={() => open(group.scenarioId!)}>Mở Scenario để sửa</button>}
        <details><summary>Xem đường dẫn</summary>{group.paths.map(file => <code key={file}>{file}</code>)}</details></li>)}</ul>}
    </section>}
    {creating && <form className="scenario-create" onSubmit={event => { event.preventDefault(); create(); }}>
      <label>Tên Scenario mới<input aria-label="Tên flow mới" value={name} disabled={disabled}
        onChange={event => setName(event.target.value)} /></label>
      <button className="primary" disabled={disabled || !state || !name.trim()} type="submit">Tạo Scenario</button>
    </form>}
    {!dialog && error && <p role="alert">{error}</p>}
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
              return <div className="scenario-item" key={flow.id}>
              <button className="scenario-title" disabled={disabled} onClick={() => open(flow.id)}>{flow.name}</button>
              <small>{flow.steps.length} Step</small>
              {invalidPinned.length > 0 && (
                <small className="hint" title={`${invalidPinned.length} pinned version lỗi — mở Script Health Check`}>
                  {invalidPinned.length} Step cần sửa
                </small>
              )}
              <small className="sync-badge" title={syncRows.find(r => r.flow_id === flow.id || r.script_id === flow.id)?.message}>
                {syncBadge(syncRows, flow.id)}
              </small>
              <button disabled={disabled} onClick={() => open(flow.id)}>Mở Creator</button>
              <details><summary aria-label={`Menu Scenario ${flow.name}`}>...</summary><div className="scenario-menu">
                <button disabled={disabled} onClick={() => show("move", flow.id, organization.membership[flow.id] ?? "")}>Move to Group</button>
                <button disabled={disabled} onClick={() => show("scenario-delete", flow.id)}>Delete Scenario</button>
              </div></details>
            </div>;
            })}
            {!flows.length && <p className="page-empty">Chưa có Scenario trong nhóm.</p>}
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
    {dialog && <UiPopover variant="modal" label={dialog.kind === "scenario-delete" ? "Delete Scenario" : "Scenario Group"} className="unsaved-confirm"
      close={() => { if (!working) setDialog(undefined); }}>
      <div className="popover-heading"><b>{dialog.kind === "scenario-delete" ? "Delete Scenario" : dialog.kind === "create" ? "Tạo Group" : dialog.kind === "rename" ? "Đổi tên Group" : dialog.kind === "delete" ? "Xóa Group" : "Move to Group"}</b>
        <button disabled={working} onClick={() => setDialog(undefined)}>×</button></div>
      {dialog.kind === "scenario-delete" ? <p>Xóa Scenario “{state?.flows.find(f => f.id === dialog.id)?.name}” cùng các Step/Version thuộc riêng Scenario này? Thao tác này không thể hoàn tác.</p>
        : dialog.kind === "delete" ? <p>Xóa Group này? Các Scenario sẽ chuyển về Chưa phân nhóm, toàn bộ dữ liệu được giữ nguyên.</p>
        : dialog.kind === "move" ? <label>Group<select value={value} disabled={working} onChange={e => setValue(e.target.value)}>
          <option value="">Chưa phân nhóm</option>{organization.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
        : <label>Tên Group<input value={value} maxLength={80} disabled={working} onChange={e => setValue(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}
      <div className="popover-footer"><button disabled={working} onClick={() => setDialog(undefined)}>Hủy</button>
        <button className="primary" disabled={disabled || (["create", "rename"].includes(dialog.kind) && !value.trim())} onClick={submit}>
          {dialog.kind === "scenario-delete" ? "Delete Scenario" : dialog.kind === "delete" ? "Xóa Group" : "Lưu"}</button></div>
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
