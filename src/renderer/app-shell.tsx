import React, { useEffect, useState } from "react";
import { UiPopover } from "./ui-popover";
import type { AppPage, Command, Flow, State } from "../shared/contracts";
import type { ScriptSyncRow } from "../shared/sync-status";
import { SeoOpsSyncControls, scriptVersionLabel, type SeoOpsSessionState } from "./seo-ops-panel";
import { ScriptHealthPanel } from "./script-health-panel";

/** Primary Admin nav only — Browser Sessions, Settings, and Scripts (with Test Lab inside Scripts). */
const menus = [
  { page: "scenarios", label: "Scripts", color: "#68d6a6", path: "M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M10 7h7v7" },
  { page: "browser-sessions", label: "Browser Sessions", color: "#75b9ff", path: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" },
  { page: "settings", label: "Settings", color: "#a8b2c2", path: "m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
] as const;

export function AppNavigation({ page, collapsed, locked, navigate, toggle }: {
  page: AppPage; collapsed: boolean; locked: boolean;
  navigate: (page: AppPage) => void; toggle: () => void;
}) {
  const activeNav = ["scenarios", "test-lab", "creator", "test-case"].includes(page) ? "scenarios" : page;
  return <div className={`app-sidebar${collapsed ? " collapsed" : ""}`}>
    <div className="app-sidebar-heading">
      {!collapsed && <b>RPA Social <small>V2</small></b>}
      <button disabled={locked} aria-label={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}
        title={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"} onClick={toggle}>{collapsed ? "»" : "«"}</button>
    </div>
    <nav className="app-menu" aria-label="Điều hướng chính">
      {menus.map(item => <button key={item.page} disabled={locked} title={item.label}
        aria-label={item.label} aria-current={activeNav === item.page ? "page" : undefined}
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
        {video && <UiPopover variant="modal" label="Script Demo" className="scenario-demo-preview" close={() => setVideo("")}>
      <div className="popover-heading"><b>Script Demo</b><button onClick={() => setVideo("")} aria-label="Đóng video">×</button></div>
      <video controls autoPlay={false} preload="metadata" src={video} />
    </UiPopover>}
  </>;
}

export function ScenariosPage({ state, name, setName, locked, open, create, quickAcceptance, sessionControl, update, invoke, seoOpsSession, autoSyncEnabled, onSeoOpsSession, reconnectSeoOps, onState, navigate }: {
  state?: State; name: string; setName: (name: string) => void; locked: boolean;
  open: (id: string, focus?: { stepId: string; version: number }) => void;
  create: (actionTagKey?: string, customName?: string) => void;
  quickAcceptance: (id: string) => void;
  sessionControl?: React.ReactNode; update: (command: Command) => Promise<void>;
  invoke?: <T>(command: Command) => Promise<T>;
  seoOpsSession?: SeoOpsSessionState;
  autoSyncEnabled?: boolean;
  onSeoOpsSession?: (session: SeoOpsSessionState) => void;
  reconnectSeoOps?: () => void;
  onState?: (state: State) => void;
  navigate?: (page: AppPage) => void;
}) {
  type BackupResult = { status: "working" | "verified" | "incomplete" | "cancelled" | "failed";
    message?: string; counts?: { scenarios: number; stepVersions: number; assets: number; missingFiles: number };
    missing?: Array<{ logicalReference: string; originalPath?: string; scenarioId?: string; variableKey?: string }> };
  
  const [dialog, setDialog] = useState<
    | { kind: "create-script"; tagKey?: string }
    | { kind: "delete-blocked"; flow: Flow; tagKey?: string }
    | { kind: "confirm-delete"; flow: Flow }
  >();
  const [scriptNameInput, setScriptNameInput] = useState("");
  const [selectedTagKey, setSelectedTagKey] = useState("");
  const [collapsedTags, setCollapsedTags] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [backupResult, setBackupResult] = useState<BackupResult>();
  const [importResult, setImportResult] = useState<{ status: string; token?: string; message?: string;
    counts?: BackupResult["counts"]; hasExistingData?: boolean; rollbackPath?: string }>();
  const [syncRows, setSyncRows] = useState<ScriptSyncRow[]>([]);
  const disabled = locked || working;

  const actionTags = state?.actionTags ?? [];
  const flows = state?.flows ?? [];
  const activeScriptsByTag = state?.activeScriptsByTag ?? {};

  useEffect(() => {
    if (!invoke) return;
    void invoke<{ rows: ScriptSyncRow[] }>({ type: "seoOpsSyncStatus" })
      .then((r) => setSyncRows(r.rows))
      .catch(() => undefined);
  }, [invoke, seoOpsSession?.authenticated, state?.flows]);

  async function apply(command: Command, close = false) {
    if (disabled) return;
    setWorking(true); setError("");
    try { await update(command); if (close) setDialog(undefined); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }

  function handleStartCreate(tagKey?: string) {
    setSelectedTagKey(tagKey ?? actionTags[0]?.tag_key ?? "");
    setScriptNameInput("");
    setError("");
    setDialog({ kind: "create-script", tagKey });
  }

  function submitCreateScript() {
    if (!scriptNameInput.trim()) return;
    create(selectedTagKey || undefined, scriptNameInput.trim());
    setDialog(undefined);
  }

  function handleDeleteClick(flow: Flow, isActive: boolean, tagKey?: string) {
    if (isActive) {
      setDialog({ kind: "delete-blocked", flow, tagKey });
      return;
    }
    setDialog({ kind: "confirm-delete", flow });
  }

  async function handleActivate(flow: Flow, tagKey?: string) {
    if (disabled || !invoke) return;
    setError("");

    if (!flow.steps.length) {
      setError("Không thể Activate: Script cần có ít nhất một Step hợp lệ.");
      return;
    }
    const demo = state?.scenarioDemos?.[flow.id];
    if (!demo || demo.status !== "ready") {
      setError("Không thể Activate: Bắt buộc phải có Script Demo hợp lệ. Mở Test Lab, chạy Script và bấm Use as Script Demo trước.");
      return;
    }
    const syncRow = syncRows.find(r => r.flow_id === flow.id || r.script_id === flow.id);
    if (syncRow?.incomplete) {
      setError(`Không thể Activate: ${syncRow.message || "Script chưa đủ assets để publish."}`);
      return;
    }
    if (!seoOpsSession?.authenticated) {
      setError("Cần đăng nhập SEO-OPS tại Settings trước khi Activate Script.");
      return;
    }

    setWorking(true);
    try {
      const res = await invoke<{ ok: boolean; results?: Array<{ ok: boolean; action?: string; message?: string }>; error?: { message: string } }>({
        type: "seoOpsSyncFlow",
        flowId: flow.id,
      });
      const failedPush = res.results?.find(r => !r.ok && r.action === "push");
      if (!res.ok || failedPush) {
        const msg = res.error?.message || failedPush?.message || "SEO-OPS từ chối release.";
        setError(`Activate thất bại: ${msg}. Script Active trước đó vẫn được giữ nguyên.`);
        return;
      }
      if (tagKey) {
        await invoke({ type: "setActiveScript", tagKey, flowId: flow.id });
      }
      const refreshed = await invoke<{ rows: ScriptSyncRow[] }>({ type: "seoOpsSyncStatus" });
      setSyncRows(refreshed.rows);
    } catch (err) {
      setError(`Activate thất bại: ${String(err)}. Script Active trước đó vẫn được giữ nguyên.`);
    } finally {
      setWorking(false);
    }
  }

  const unassignedFlows = flows.filter(f => !f.actionTagKey || !actionTags.some(t => t.tag_key === f.actionTagKey));

  return <section className="app-page scenarios-page" aria-label="Scripts">
    <div className="scripts-top-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={true}
        className="scripts-tab-btn active"
        onClick={() => navigate?.("scenarios")}
      >
        Scripts
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={false}
        className="scripts-tab-btn"
        onClick={() => navigate?.("test-lab")}
      >
        Test Lab
      </button>
    </div>

    <div className="page-heading">
      <small>RPA Social Automation V2</small>
      <h1>Scripts</h1>
      <p>Quản lý Script theo Action Tag. Mỗi Tag chỉ có tối đa một Script Active.</p>
    </div>

    <div className="scenario-toolbar">
      <button className="primary" disabled={disabled} onClick={() => handleStartCreate()}>+ Script</button>
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
          onSyncComplete={(tags) => {
            if (onState && state) onState({ ...state, actionTags: tags });
          }}
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

    {error && <p role="alert" style={{ color: "#f87171", background: "rgba(248, 113, 113, 0.1)", padding: "8px 12px", borderRadius: 6, margin: "10px 0" }}>{error}</p>}

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
                      if (invoke) void invoke({ type: "createScriptFromRequest", requestId: req.request_id });
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

    {actionTags.length === 0 && (
      <div className="empty-tags-box">
        <h3 style={{ margin: "0 0 8px 0", color: "#e2e8f0" }}>Chưa có Action Tag từ SEO-OPS</h3>
        <p style={{ margin: 0 }}>Action Tags được quản lý và định nghĩa từ SEO-OPS. Đăng nhập và đồng bộ SEO-OPS tại Settings để tải danh sách Tag và tạo Script.</p>
      </div>
    )}

    <div className="scenario-groups">
      {actionTags.map(tag => {
        const tagFlows = flows.filter(f => f.actionTagKey === tag.tag_key || (f.actionTagId !== undefined && f.actionTagId === tag.id));
        const assignedActiveId = activeScriptsByTag[tag.tag_key];
        const activeFlow = assignedActiveId
          ? tagFlows.find(f => f.id === assignedActiveId)
          : tagFlows.find(f => {
              const row = syncRows.find(r => r.flow_id === f.id || r.script_id === f.id);
              return row?.status === "synced" || Boolean(row?.published_version);
            });
        const isCollapsed = Boolean(collapsedTags[tag.tag_key]);

        return <section className="tag-group-folder" key={tag.tag_key}>
          <div className="tag-folder-heading">
            <button
              className="tag-folder-toggle"
              disabled={disabled}
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsedTags(p => ({ ...p, [tag.tag_key]: !p[tag.tag_key] }))}
            >
              <span>{isCollapsed ? "▸" : "▾"}</span>
              <code>{tag.tag_key}</code>
              {tag.name && <span className="tag-folder-name">— {tag.name}</span>}
              <span className="tag-folder-count">
                ({tagFlows.length} Script{activeFlow ? ` · 1 Active` : ""})
              </span>
            </button>
            <button
              className="btn-new-script-tag"
              disabled={disabled}
              onClick={() => handleStartCreate(tag.tag_key)}
              title={`Tạo Script mới trong tag ${tag.tag_key}`}
            >
              + Script
            </button>
          </div>

          {!isCollapsed && (
            <div className="scenario-items">
              {tagFlows.map(flow => {
                const isActive = Boolean(activeFlow && flow.id === activeFlow.id);
                const demo = state?.scenarioDemos?.[flow.id];
                const syncRow = syncRows.find(r => r.flow_id === flow.id || r.script_id === flow.id);
                const isMissingDemo = syncRow?.status === "missing_demo" || !demo || demo.status !== "ready";
                const invalidPinned = flow.steps.filter(ref =>
                  (state?.invalidSteps ?? []).some(r => r.stepId === ref.id && r.version === ref.version));

                return <div className="scenario-item" key={flow.id}>
                  <div className="scenario-title-cell">
                    <button className="scenario-title" disabled={disabled} onClick={() => open(flow.id)} title={flow.name}>
                      {flow.name}
                    </button>
                    {isActive ? (
                      <span className="script-badge badge-active" title="Script Active trên SEO-OPS">Active</span>
                    ) : (
                      <span className="script-badge badge-draft" title="Script Draft">Draft</span>
                    )}
                    {isMissingDemo && (
                      <span className="script-badge badge-missing-demo" title="Chưa có Script Demo hợp lệ">Missing demo</span>
                    )}
                  </div>
                  <small>{flow.steps.length} Step</small>
                  <ScenarioDemo flowId={flow.id} state={state} invoke={invoke} />
                  {invalidPinned.length > 0 && (
                    <small className="hint" title={`${invalidPinned.length} pinned version lỗi — mở Script Health Check`}>
                      {invalidPinned.length} Step cần sửa
                    </small>
                  )}
                  <small className="script-version" aria-label={`Version ${flow.name}`}>{scriptVersionLabel(syncRows, flow.id)}</small>
                  {!isActive && (
                    <button
                      className="btn-activate"
                      disabled={disabled}
                      onClick={() => void handleActivate(flow, tag.tag_key)}
                      title="Publish release lên SEO-OPS và đặt làm Active Script"
                    >
                      Activate
                    </button>
                  )}
                  <button disabled={disabled} onClick={() => open(flow.id)}>Mở Creator</button>
                  <button className="scenario-acceptance" disabled={disabled} onClick={() => quickAcceptance(flow.id)}>Nghiệm thu</button>
                  <button
                    className="delete-script-btn"
                    disabled={disabled}
                    title={isActive ? "Không thể xóa Script Active" : "Xóa Script"}
                    aria-label={`Xóa Script ${flow.name}`}
                    onClick={() => handleDeleteClick(flow, isActive, tag.tag_key)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>;
              })}
              {!tagFlows.length && <p className="page-empty" style={{ margin: "8px 0" }}>Chưa có Script</p>}
            </div>
          )}
        </section>;
      })}

      {unassignedFlows.length > 0 && (
        <section className="tag-group-folder" key="unassigned">
          <div className="tag-folder-heading" style={{ background: "#202428" }}>
            <button
              className="tag-folder-toggle"
              disabled={disabled}
              aria-expanded={!collapsedTags["_unassigned_"]}
              onClick={() => setCollapsedTags(p => ({ ...p, _unassigned_: !p._unassigned_ }))}
            >
              <span>{collapsedTags["_unassigned_"] ? "▸" : "▾"}</span>
              <span style={{ color: "#a0aec0", fontWeight: 600 }}>Chưa gắn Tag</span>
              <span className="tag-folder-count">({unassignedFlows.length} Script)</span>
            </button>
          </div>
          {!collapsedTags["_unassigned_"] && (
            <div className="scenario-items">
              {unassignedFlows.map(flow => {
                const demo = state?.scenarioDemos?.[flow.id];
                const syncRow = syncRows.find(r => r.flow_id === flow.id || r.script_id === flow.id);
                const isMissingDemo = syncRow?.status === "missing_demo" || !demo || demo.status !== "ready";
                return <div className="scenario-item" key={flow.id}>
                  <div className="scenario-title-cell">
                    <button className="scenario-title" disabled={disabled} onClick={() => open(flow.id)} title={flow.name}>
                      {flow.name}
                    </button>
                    <span className="script-badge badge-draft">Draft</span>
                    {isMissingDemo && <span className="script-badge badge-missing-demo">Missing demo</span>}
                  </div>
                  <small>{flow.steps.length} Step</small>
                  <ScenarioDemo flowId={flow.id} state={state} invoke={invoke} />
                  <small className="script-version">{scriptVersionLabel(syncRows, flow.id)}</small>
                  <button disabled={disabled} onClick={() => open(flow.id)}>Mở Creator</button>
                  <button className="scenario-acceptance" disabled={disabled} onClick={() => quickAcceptance(flow.id)}>Nghiệm thu</button>
                  <button
                    className="delete-script-btn"
                    disabled={disabled}
                    title="Xóa Script"
                    aria-label={`Xóa Script ${flow.name}`}
                    onClick={() => handleDeleteClick(flow, false)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>;
              })}
            </div>
          )}
        </section>
      )}
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

    {dialog?.kind === "create-script" && (
      <UiPopover
        variant="modal"
        label="Tạo Script mới"
        className="unsaved-confirm"
        close={() => setDialog(undefined)}
      >
        <div className="popover-heading">
          <b>Tạo Script mới</b>
          <button disabled={working} onClick={() => setDialog(undefined)}>×</button>
        </div>
        <div style={{ display: "grid", gap: 12, padding: "8px 0" }}>
          {dialog.tagKey ? (
            <div>
              <small style={{ color: "#8c9ba8" }}>Thuộc Action Tag:</small>
              <div style={{ marginTop: 4 }}>
                <code style={{ color: "#68d6a6", fontSize: 13 }}>{dialog.tagKey}</code>
              </div>
            </div>
          ) : actionTags.length > 0 ? (
            <label>
              Action Tag
              <select
                disabled={working}
                value={selectedTagKey}
                onChange={e => setSelectedTagKey(e.target.value)}
                style={{ width: "100%", marginTop: 4 }}
              >
                {actionTags.map(t => (
                  <option key={t.tag_key} value={t.tag_key}>{t.tag_key} {t.name ? `(${t.name})` : ""}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="hint">Chưa có Tag từ SEO-OPS. Script sẽ được tạo ở trạng thái Chưa gắn Tag.</p>
          )}

          <label>
            Tên Script
            <input
              autoFocus
              value={scriptNameInput}
              disabled={working}
              maxLength={80}
              placeholder="Ví dụ: Group Post v1"
              onChange={e => setScriptNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitCreateScript(); }}
              style={{ width: "100%", marginTop: 4 }}
            />
          </label>
        </div>
        <div className="popover-footer">
          <button disabled={working} onClick={() => setDialog(undefined)}>Hủy</button>
          <button
            className="primary"
            disabled={disabled || !scriptNameInput.trim()}
            onClick={submitCreateScript}
          >
            Tạo Script
          </button>
        </div>
      </UiPopover>
    )}

    {dialog?.kind === "delete-blocked" && (
      <UiPopover
        variant="modal"
        label="Không thể xóa Script Active"
        className="unsaved-confirm"
        close={() => setDialog(undefined)}
      >
        <div className="popover-heading">
          <b style={{ color: "#f87171" }}>Không thể xóa Script Active</b>
          <button onClick={() => setDialog(undefined)}>×</button>
        </div>
        <div style={{ padding: "8px 0" }}>
          <p>
            Script <strong>“{dialog.flow.name}”</strong> đang ở trạng thái <strong>Active</strong> trên SEO-OPS cho Tag <code>{dialog.tagKey}</code>.
          </p>
          <p style={{ color: "#9bb0c7", fontSize: 12 }}>
            SEO-OPS yêu cầu duy trì release Script an toàn cho Automation. Để xóa Script này, bạn cần chuyển trạng thái Active sang một Script khác cùng Tag hoặc thu hồi release từ SEO-OPS.
          </p>
        </div>
        <div className="popover-footer">
          <button className="primary" onClick={() => setDialog(undefined)}>Đã hiểu</button>
        </div>
      </UiPopover>
    )}

    {dialog?.kind === "confirm-delete" && (
      <UiPopover
        variant="modal"
        label="Xóa Script"
        className="unsaved-confirm"
        close={() => { if (!working) setDialog(undefined); }}
      >
        <div className="popover-heading">
          <b>Xóa Script</b>
          <button disabled={working} onClick={() => setDialog(undefined)}>×</button>
        </div>
        <div style={{ padding: "8px 0" }}>
          <p>
            Xóa Script <strong>“{dialog.flow.name}”</strong> cùng các Step/Version thuộc riêng Script này?
          </p>
          <p style={{ color: "#f87171", fontSize: 12 }}>
            Thao tác này không thể hoàn tác.
          </p>
        </div>
        <div className="popover-footer">
          <button disabled={working} onClick={() => setDialog(undefined)}>Hủy</button>
          <button
            className="primary"
            style={{ background: "#dc2626", borderColor: "#ef4444" }}
            disabled={disabled}
            onClick={() => void apply({ type: "deleteScenario", id: dialog.flow.id, confirmed: true }, true)}
          >
            Xác nhận xóa
          </button>
        </div>
      </UiPopover>
    )}
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
