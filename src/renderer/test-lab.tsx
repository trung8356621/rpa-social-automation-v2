import React, { useEffect, useRef, useState } from "react";
import type { Command, State, TestCase, TestCaseConfig, VariableValues } from "../shared/contracts";
import { validateVariables } from "../shared/flow-model";
import { UiPopover } from "./ui-popover";

export type CaseEditorHandle = {
  dirty: boolean; name: string; flowId: string; sessionId: string;
  save: () => Promise<void>; discard: () => void;
};
function initial(state: State): TestCaseConfig {
  const flow = state.flows[0], session = state.browserSessions?.find(s => s.id === state.activeBrowserSessionId);
  return { name: "", flowId: flow?.id ?? "", sessionId: session?.id ?? "", startUrl: session?.lastUrl ?? "",
    values: structuredClone(flow?.defaultPattern?.values ?? {}) };
}
export function TestCaseEditor({ tabId, item, state, locked, report, saved, saving, run }: {
  tabId: string; item?: TestCase; state: State; locked: boolean;
  report: (id: string, handle: CaseEditorHandle) => void;
  saved: (tabId: string, item: TestCase, state: State) => void; run: (id: string) => void;
  saving: (value: boolean) => void;
}) {
  const [config, setConfig] = useState<TestCaseConfig>(() => item ? structuredClone({ name: item.name,
    flowId: item.flowId, sessionId: item.sessionId, startUrl: item.startUrl, values: item.values }) : initial(state));
  const [baseline, setBaseline] = useState(config);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const saveLock = useRef(false);
  const dirty = !item || JSON.stringify(config) !== JSON.stringify(baseline);
  const flow = state.flows.find(f => f.id === config.flowId);
  async function save() {
    if (saveLock.current) throw new Error("Đang lưu Case; vui lòng đợi.");
    saveLock.current = true;
    setWorking(true); saving(true); setError("");
    try {
      validateVariables(flow?.variables ?? [], config.values);
      const next = await window.creator.invoke({ type: "saveTestCase", id: item?.id, config }) as State;
      const previousIds = new Set(state.testLab?.cases.map(c => c.id));
      const result = next.testLab!.cases.find(c => item ? c.id === item.id : !previousIds.has(c.id))!;
      if (!result) throw new Error("Không tìm thấy Case vừa lưu.");
      setConfig({ name: result.name, flowId: result.flowId, sessionId: result.sessionId, startUrl: result.startUrl, values: result.values });
      setBaseline({ name: result.name, flowId: result.flowId, sessionId: result.sessionId, startUrl: result.startUrl, values: result.values });
      saved(tabId, result, next);
    } catch (e) { setError(String(e)); throw e; }
    finally { saveLock.current = false; setWorking(false); saving(false); }
  }
  useEffect(() => { report(tabId, { dirty, name: config.name || "Test Case mới", flowId: config.flowId,
    sessionId: config.sessionId, save, discard: () => { setConfig(structuredClone(baseline)); setError(""); } });
  }, [tabId, config, baseline, dirty, state, report]);
  const disabled = locked || working;
  function values(next: VariableValues) { setConfig(previous => ({ ...previous, values: next })); }
  return <section className="app-page test-case-editor" aria-label="Test Case Editor">
    <div className="page-heading"><h1>{config.name || "Test Case mới"}{dirty ? " ●" : ""}</h1>
      <p>Cấu hình riêng cho Case. Chạy chỉ dùng Step Version đã lưu; không dùng draft Creator.</p></div>
    <div className="case-form">
      <label>Name<input disabled={disabled} maxLength={120} value={config.name} onChange={e => setConfig({ ...config, name: e.target.value })} /></label>
      <label>Scenario<select disabled={disabled} value={config.flowId} onChange={e => {
        const chosen = state.flows.find(f => f.id === e.target.value);
        setConfig({ ...config, flowId: e.target.value, values: structuredClone(chosen?.defaultPattern?.values ?? {}) });
      }}><option value="" disabled>Chọn Scenario</option>{state.flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      <label>Browser Session<select disabled={disabled} value={config.sessionId} onChange={e => setConfig({ ...config, sessionId: e.target.value })}>
        <option value="" disabled>Chọn Session</option>{state.browserSessions?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Start URL<input disabled={disabled} type="url" value={config.startUrl} placeholder="https://..." onChange={e => setConfig({ ...config, startUrl: e.target.value })} /></label>
      <h2>Variables</h2><p className="hint">Lần đầu lấy từ Default Pattern. Các giá trị bên dưới chỉ lưu vào Case này.</p>
      {(flow?.variables ?? []).map(v => <label key={v.id}>{v.key} <small>({v.type})</small>
        {v.type === "number" || v.type === "integer" ? <input disabled={disabled} type="number" step={v.type === "integer" ? 1 : "any"}
          value={typeof config.values[v.id] === "number" ? config.values[v.id] as number : ""}
          onChange={e => values({ ...config.values, [v.id]: e.target.value === "" ? "" : Number(e.target.value) })} />
          : <textarea disabled={disabled} value={Array.isArray(config.values[v.id]) ? (config.values[v.id] as string[]).join("\n") : config.values[v.id] ?? ""}
            placeholder={v.type === "files" ? "Mỗi dòng một đường dẫn file" : undefined}
            onChange={e => values({ ...config.values, [v.id]: v.type === "files" ? e.target.value.split("\n").filter(Boolean) : e.target.value })} />}
      </label>)}
      {flow && <button disabled={disabled} onClick={() => values(Object.fromEntries((flow.variables ?? []).map(v => [v.id,
        config.values[v.id] ?? flow.defaultPattern?.values[v.id] ?? (v.type === "files" ? [] : "")])))}>Đồng bộ với template hiện tại</button>}
      {error && <p role="alert">{error}</p>}
      <div className="case-actions"><button className="primary" disabled={disabled || !dirty} onClick={() => void save().catch(() => {})}>Lưu Case</button>
        <button disabled={disabled || dirty || !item} onClick={() => item && run(item.id)}>Run Test Case</button>
        {dirty && <small>Lưu cấu hình trước khi chạy.</small>}</div>
      {item?.lastResult && <CaseResultView item={item} />}
    </div>
  </section>;
}
export function CaseResultView({ item }: { item: TestCase }) {
  const result = item.lastResult;
  return result ? <div className="case-result" role="status"><b>{result.status}</b> · {new Date(result.finishedAt).toLocaleString()}
    {result.stepId && <p>Step: {result.stepName ?? result.stepId} · v{result.version}</p>}<p>{result.message}</p>
  </div> : <small>Chưa chạy</small>;
}

export function TestLabPage({ state, locked, update, open, create, canDelete }: {
  state?: State; locked: boolean; update: (command: Command) => Promise<void>;
  open: (id: string) => void; create: () => void; canDelete: (id: string) => boolean;
}) {
  const lab = state?.testLab ?? { groups: [], cases: [], ungroupedCollapsed: false };
  const [dialog, setDialog] = useState<{ kind: "create" | "rename" | "group-delete" | "delete" | "move"; id?: string; name?: string }>();
  const [value, setValue] = useState(""); const [error, setError] = useState(""); const [working, setWorking] = useState(false);
  const disabled = locked || working;
  function show(kind: NonNullable<typeof dialog>["kind"], id?: string, name?: string, initial = "") {
    setDialog({ kind, id, name }); setValue(initial); setError("");
  }
  async function apply(command: Command, close = false) {
    if (disabled) return;
    setWorking(true); setError("");
    try { await update(command); if (close) setDialog(undefined); }
    catch (e) { setError(String(e)); } finally { setWorking(false); }
  }
  function submit() {
    if (!dialog) return;
    if (dialog.kind === "delete" && !canDelete(dialog.id!)) { setError("Đóng tab Test Case này trước khi xóa để giữ an toàn dữ liệu đang sửa."); return; }
    void apply(dialog.kind === "delete" ? { type: "deleteTestCase", id: dialog.id!, confirmed: true }
      : dialog.kind === "move" ? { type: "moveTestCase", id: dialog.id!, groupId: value || undefined }
      : { type: "testGroup", operation: dialog.kind === "create" ? "create" : dialog.kind === "rename" ? "update" : "delete",
        id: dialog.id, name: value, confirmed: true }, true);
  }
  return <section className="app-page" aria-label="Test Lab"><div className="page-heading"><h1>Test Lab</h1>
    <p>Mỗi Case dùng Scenario, Session, URL và bộ Values riêng. Chạy từng Case bằng Runtime hiện có.</p></div>
    <div className="scenario-toolbar"><button disabled={disabled} onClick={() => show("create")}>+ Test Group</button>
      <button className="primary" disabled={disabled || !state?.flows.length} onClick={create}>+ Test Case</button></div>
    {!dialog && error && <p role="alert">{error}</p>}
    <div className="scenario-groups">{[...lab.groups, { id: "", name: "Chưa phân nhóm", collapsed: lab.ungroupedCollapsed }].map(group => {
      const cases = lab.cases.filter(c => (c.groupId ?? "") === group.id);
      return <section className="scenario-folder" key={group.id}><div className="scenario-folder-heading">
        <button disabled={disabled} aria-expanded={!group.collapsed} onClick={() => void apply(group.id
          ? { type: "testGroup", operation: "update", id: group.id, collapsed: !group.collapsed }
          : { type: "collapseUngroupedCases", collapsed: !group.collapsed })}>{group.collapsed ? "▸" : "▾"} {group.name} ({cases.length})</button>
        {group.id && <details><summary>...</summary><div className="scenario-menu"><button disabled={disabled} onClick={() => show("rename", group.id, group.name, group.name)}>Đổi tên</button>
          <button disabled={disabled} onClick={() => show("group-delete", group.id, group.name)}>Xóa Group</button></div></details>}</div>
        {!group.collapsed && <div className="scenario-items">{cases.map(item => <div className="test-case-item" key={item.id}>
          <div className="scenario-item"><button className="scenario-title" disabled={disabled} onClick={() => open(item.id)}>{item.name}</button>
            <small>{state?.flows.find(f => f.id === item.flowId)?.name}</small><button disabled={disabled} onClick={() => open(item.id)}>Mở Case</button>
            <details><summary>...</summary><div className="scenario-menu"><button disabled={disabled} onClick={() => show("move", item.id, item.name, item.groupId ?? "")}>Move to Group</button>
              <button disabled={disabled} onClick={() => show("delete", item.id, item.name)}>Delete Test Case</button></div></details></div>
          <small>{state?.browserSessions?.find(s => s.id === item.sessionId)?.name} · {item.startUrl}</small><CaseResultView item={item} />
        </div>)}{!cases.length && <p className="page-empty">Chưa có Test Case.</p>}</div>}
      </section>;
    })}</div>
    {dialog && <UiPopover variant="modal" label="Test Lab" className="unsaved-confirm" close={() => { if (!working) setDialog(undefined); }}>
      <b>{dialog.kind === "delete" || dialog.kind === "group-delete" ? `Xóa “${dialog.name}”?` : dialog.kind === "move" ? "Move to Group" : "Test Group"}</b>
      {dialog.kind === "group-delete" ? <p>Case trong Group sẽ chuyển về Chưa phân nhóm.</p> : dialog.kind === "delete" ? <p>Xóa cấu hình và Last Result của Case này?</p>
        : dialog.kind === "move" ? <select disabled={working} value={value} onChange={e => setValue(e.target.value)}><option value="">Chưa phân nhóm</option>{lab.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        : <label>Tên Group<input disabled={working} maxLength={120} value={value} onChange={e => setValue(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}<div className="popover-footer"><button disabled={working} onClick={() => setDialog(undefined)}>Hủy</button>
        <button disabled={disabled} onClick={submit}>Xác nhận</button></div>
    </UiPopover>}
  </section>;
}
