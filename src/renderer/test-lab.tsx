import React, { useEffect, useRef, useState } from "react";
import type { Command, ExecutionError, State, TestCase, TestCaseConfig, VariableValues } from "../shared/contracts";
import { validateVariables } from "../shared/flow-model";
import { canUseAsScriptDemo } from "../shared/video-demo-policy";
import { UiPopover } from "./ui-popover";
import { FileValidation, validateFileValues } from "./file-validation";
import { initialResultMedia, initialTestCaseMode, stepStatusLabel, type ResultMedia, type TestCaseViewMode } from "../shared/test-lab-view";

export type CaseEditorHandle = {
  dirty: boolean; name: string; flowId: string; sessionId: string;
  save: () => Promise<void>; discard: () => void;
};
export function ExecutionErrorView({ error, stepName, onFix }: {
  error: ExecutionError; stepName?: string; onFix?: (error: ExecutionError) => void;
}) {
  return <div className="structured-error" role="alert">
    <b>{stepName ?? error.stepId} · v{error.version}</b>
    <span>{error.category}</span>
    <p>{error.message}</p>
    {(error.variableKey || error.field) && <p><b>Cần sửa:</b> {error.variableKey ? `Variable ${error.variableKey}` : error.field}</p>}
    <p>{error.suggestedAction}</p>
    {onFix && <button type="button" onClick={() => onFix(error)}>{error.variableId ? "Mở Variables" : "Mở Step Editor"}</button>}
    {!!error.details?.length && <details><summary>Chi tiết kỹ thuật</summary><ul>{error.details.map(detail => <li key={detail}>{detail}</li>)}</ul></details>}
  </div>;
}
function initial(state: State): TestCaseConfig {
  const flow = state.flows[0], session = state.browserSessions?.find(s => s.id === state.activeBrowserSessionId);
  return { name: "", flowId: flow?.id ?? "", sessionId: session?.id ?? "", startUrl: session?.lastUrl ?? "",
    values: structuredClone(flow?.defaultPattern?.values ?? {}), recording: true };
}
export function TestCaseEditor({ tabId, item, state, locked, report, saved, saving, run, fix, back }: {
  tabId: string; item?: TestCase; state: State; locked: boolean;
  report: (id: string, handle: CaseEditorHandle) => void;
  saved: (tabId: string, item: TestCase, state: State) => void; run: (id: string) => void;
  saving: (value: boolean) => void;
  fix?: (error: ExecutionError) => void;
  back: () => void;
}) {
  const [config, setConfig] = useState<TestCaseConfig>(() => item ? structuredClone({ name: item.name,
    flowId: item.flowId, sessionId: item.sessionId, startUrl: item.startUrl, recording: true, values: item.values }) : initial(state));
  const [baseline, setBaseline] = useState(config);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [fileCheckRevision, setFileCheckRevision] = useState(0);
  const [mode, setMode] = useState<TestCaseViewMode>(() => initialTestCaseMode(item?.lastResult));
  const saveLock = useRef(false);
  const dirty = !item || JSON.stringify({ ...config, recording: true }) !== JSON.stringify({ ...baseline, recording: true });
  const flow = state.flows.find(f => f.id === config.flowId);
  useEffect(() => { if (item?.lastResult) setMode("result"); }, [item?.lastResult?.runId]);
  async function save() {
    if (saveLock.current) throw new Error("Đang lưu Case; vui lòng đợi.");
    saveLock.current = true;
    setWorking(true); saving(true); setError("");
    setFileCheckRevision(value => value + 1);
    try {
      validateVariables(flow?.variables ?? [], config.values);
      const fileChecks = await validateFileValues(flow?.variables ?? [], config.values);
      const invalid = fileChecks.find(check => check.report.status === "INVALID");
      if (invalid) throw new Error(`Variable ${invalid.variable.key}: ${invalid.report.invalidCount} file không hợp lệ.`);
      const next = await window.creator.invoke({ type: "saveTestCase", id: item?.id, config: { ...config, recording: true } }) as State;
      const previousIds = new Set(state.testLab?.cases.map(c => c.id));
      const result = next.testLab!.cases.find(c => item ? c.id === item.id : !previousIds.has(c.id))!;
      if (!result) throw new Error("Không tìm thấy Case vừa lưu.");
      const nextConfig = { name: result.name, flowId: result.flowId, sessionId: result.sessionId, startUrl: result.startUrl, recording: true, values: result.values };
      setConfig(nextConfig);
      setBaseline(nextConfig);
      saved(tabId, result, next);
    } catch (e) { setError(String(e)); throw e; }
    finally { saveLock.current = false; setWorking(false); saving(false); }
  }
  useEffect(() => { report(tabId, { dirty, name: config.name || "Test Case mới", flowId: config.flowId,
    sessionId: config.sessionId, save, discard: () => { setConfig(structuredClone(baseline)); setError(""); } });
  }, [tabId, config, baseline, dirty, state, report]);
  const disabled = locked || working;
  function values(next: VariableValues) { setConfig(previous => ({ ...previous, values: next })); }
  if (mode === "result" && item?.lastResult) return <section className="app-page test-case-result-page" aria-label="Test Case Result">
    <CaseResultView item={item} state={state} locked={disabled || dirty} runAgain={() => run(item.id)}
      edit={() => setMode("configure")} back={back} onFix={fix} />
  </section>;
  return <section className="app-page test-case-editor" aria-label="Test Case Configure">
    <div className="page-heading"><h1>{config.name || "Test Case mới"}{dirty ? " ●" : ""}</h1>
      <p>Cấu hình riêng cho Case. Mỗi lần Run tự quay Browser video (không audio). Chỉ dùng Step Version đã lưu.</p></div>
    <div className="case-configure">
      <div className="case-form">
        <label>Name<input disabled={disabled} maxLength={120} value={config.name} onChange={e => setConfig({ ...config, name: e.target.value })} /></label>
        <label>Scenario<select disabled={disabled} value={config.flowId} onChange={e => {
          const chosen = state.flows.find(f => f.id === e.target.value);
          setConfig({ ...config, flowId: e.target.value, values: structuredClone(chosen?.defaultPattern?.values ?? {}) });
        }}><option value="" disabled>Chọn Scenario</option>{state.flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Browser Session<select disabled={disabled} value={config.sessionId} onChange={e => setConfig({ ...config, sessionId: e.target.value })}>
          <option value="" disabled>Chọn Session</option>{state.browserSessions?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Start URL<input disabled={disabled} type="url" value={config.startUrl} placeholder="https://..." onChange={e => setConfig({ ...config, startUrl: e.target.value })} /></label>
        <p className="hint">Browser video được quay tự động mỗi lần Run (không desktop, không audio).</p>
        {flow && <>
          <h2>Steps sẽ chạy</h2>
          <p className="hint">Test Lab dùng Base version đã ghim trên Scenario. Xem version trong Creator Editor không đổi version chạy — cần bấm “Ghim version”.</p>
          <ol className="case-pinned-steps">
            {flow.steps.map(ref => {
              const step = state.steps.find(s => s.id === ref.id && s.version === ref.version);
              const invalid = (state.invalidSteps ?? []).find(r => r.stepId === ref.id && r.version === ref.version);
              return <li key={`${ref.id}@${ref.version}`}>
                <b>{step?.name ?? ref.id.slice(0, 8)} · v{ref.version}</b>
                {invalid
                  ? <span className="case-run-status" data-status="BLOCKED" title={invalid.detail}>Invalid</span>
                  : <small> · {step?.payload.action ?? "?"}</small>}
              </li>;
            })}
          </ol>
          {!flow.steps.length && <p className="hint">Scenario chưa có Step đã ghim.</p>}
        </>}
        <h2>Variables</h2><p className="hint">Lần đầu lấy từ Default Pattern. Các giá trị bên dưới chỉ lưu vào Case này.</p>
        {(flow?.variables ?? []).map(v => <label key={v.id}>{v.key} <small>({v.type})</small>
          {v.type === "number" || v.type === "integer" ? <input disabled={disabled} type="number" step={v.type === "integer" ? 1 : "any"}
            value={typeof config.values[v.id] === "number" ? config.values[v.id] as number : ""}
            onChange={e => values({ ...config.values, [v.id]: e.target.value === "" ? "" : Number(e.target.value) })} />
            : <><textarea disabled={disabled} value={Array.isArray(config.values[v.id]) ? (config.values[v.id] as string[]).join("\n") : config.values[v.id] ?? ""}
              placeholder={v.type === "files" ? "Mỗi dòng một đường dẫn file" : undefined}
              onChange={e => values({ ...config.values, [v.id]: v.type === "files" ? e.target.value.split("\n").filter(Boolean) : e.target.value })} />
              {(v.type === "file" || v.type === "files") && <FileValidation value={config.values[v.id]} disabled={disabled}
                refreshKey={fileCheckRevision}
                onChange={picked => values({ ...config.values, [v.id]: v.type === "file" ? picked[0] ?? "" : picked })} />}</>}
        </label>)}
        {flow && <button disabled={disabled} onClick={() => values(Object.fromEntries((flow.variables ?? []).map(v => [v.id,
          config.values[v.id] ?? flow.defaultPattern?.values[v.id] ?? (v.type === "files" ? [] : "")])))}>Đồng bộ với template hiện tại</button>}
        {error && <p role="alert">{error}</p>}
        <div className="case-actions"><button className="primary" disabled={disabled || !dirty} onClick={() => void save().catch(() => {})}>Lưu Case</button>
          <button disabled={disabled || dirty || !item} onClick={() => item && run(item.id)}>Run Test Case</button>
          {dirty && <small>Lưu cấu hình trước khi chạy.</small>}</div>
        {item?.lastResult && <button type="button" disabled={disabled || dirty} onClick={() => setMode("result")}>Xem kết quả mới nhất</button>}
      </div>
    </div>
  </section>;
}
const resultStatus = (status?: string) => status === "FAILED" ? "ERROR" : status ?? "Chưa chạy";

export function CaseResultView({ item, state, locked = false, runAgain, compact = false, onFix, edit, back }: {
  item: TestCase; state?: State; locked?: boolean; runAgain?: () => void; compact?: boolean;
  onFix?: (error: ExecutionError) => void;
  edit?: () => void; back?: () => void;
}) {
  const result = item.lastResult;
  const [image, setImage] = useState<{ runId: string; src: string }>();
  const [imageError, setImageError] = useState("");
  const [large, setLarge] = useState(false);
  const [video, setVideo] = useState<{ runId: string; src: string }>();
  const [videoError, setVideoError] = useState("");
  const [media, setMedia] = useState<ResultMedia>(() => result ? initialResultMedia(result) : "video");
  const [attachMsg, setAttachMsg] = useState("");
  const [attaching, setAttaching] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setImage(undefined); setImageError(""); setLarge(false);
    if (result?.runId && result.screenshotPath) void window.creator.invoke({ type: "testCaseScreenshot", caseId: item.id, runId: result.runId })
      .then(value => { if (!cancelled) setImage({ runId: result.runId!, src: value as string }); })
      .catch(error => { if (!cancelled) setImageError(String(error)); });
    return () => { cancelled = true; };
  }, [item.id, result?.runId, result?.screenshotPath]);
  useEffect(() => {
    let cancelled = false;
    setVideo(undefined); setVideoError(""); setAttachMsg("");
    if (!result) return () => { cancelled = true; };
    setMedia(initialResultMedia(result));
    if (!result.runId || !result.recordingPath) {
      if (result.recordingError) setVideoError(result.recordingError);
      return () => { cancelled = true; };
    }
    void window.creator.invoke({ type: "testCaseVideo", caseId: item.id, runId: result.runId })
      .then(value => { if (!cancelled) setVideo({ runId: result.runId!, src: value as string }); })
      .catch(error => { if (!cancelled) { setVideoError(String((error as Error).message || error)); setMedia("screenshot"); } });
    return () => { cancelled = true; };
  }, [item.id, result?.runId, result?.recordingPath, result?.recordingError]);
  if (!result) return <small>Chưa chạy</small>;
  const screenshot = image && image.runId === result.runId ? image.src : undefined;
  const videoSource = video && video.runId === result.runId ? video.src : undefined;
  const status = resultStatus(result.status);
  const seconds = Math.max(0, (new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()) / 1000);
  const demoOk = canUseAsScriptDemo(result).ok;
  if (compact) return <section className="case-result case-result-compact" aria-label="Last Result">
    <div className="case-result-heading"><b>Last Result</b><span className="case-run-status" data-status={status}>{status}</span>
      {runAgain && <button disabled={locked || result.status === "RUNNING"} onClick={runAgain}>Run Again</button>}</div>
    <p>{result.message}</p>{result.error && <ExecutionErrorView error={result.error} stepName={result.stepName} onFix={onFix} />}
  </section>;
  return <section className="case-result" aria-label="Last Result">
    <div className="case-result-header"><div><small>TEST RESULT</small><h1>{result.caseName ?? item.name}</h1>
      <p>{result.scenarioName ?? state?.flows.find(flow => flow.id === item.flowId)?.name ?? item.flowId}</p></div>
      <div className="case-result-summary"><span className="case-run-status" data-status={status}>{status}</span><b>{result.status === "RUNNING" ? "Đang chạy…" : `${seconds.toFixed(1)} giây`}</b></div></div>
    <div className="case-result-actions">
      {back && <button onClick={back}>← Danh sách Test Cases</button>}
      {edit && <button onClick={edit}>Edit Configuration</button>}
      {runAgain && <button className="primary" disabled={locked || result.status === "RUNNING"} onClick={runAgain}>Run Again</button>}
    </div>
    <section className="case-result-media" aria-label="Test media">
      <div className="case-media-tabs" role="tablist">
        <button role="tab" aria-selected={media === "video"} onClick={() => setMedia("video")}>Video quá trình</button>
        <button role="tab" aria-selected={media === "screenshot"} onClick={() => setMedia("screenshot")}>Ảnh cuối cùng</button>
      </div>
      {media === "video" ? videoSource
        ? <video className="case-video-player" controls preload="metadata" src={videoSource} />
        : <div className="case-media-state" role={videoError || result.recordingError ? "alert" : "status"}>
            {videoError || result.recordingError || (result.status === "RUNNING" || result.recordingPath ? "Đang chuẩn bị video" : "Không có video cho lượt chạy này.")}
            {(videoError || result.recordingError) && screenshot && <button onClick={() => setMedia("screenshot")}>Xem ảnh cuối cùng</button>}
          </div>
        : screenshot ? <button className="case-screenshot case-screenshot-primary" onClick={() => setLarge(true)} title="Xem ảnh lớn">
            <img src={screenshot} alt={`Screenshot cuối của ${result.caseName ?? item.name}`} /><span>Xem ảnh lớn · {result.screenshotAt && new Date(result.screenshotAt).toLocaleString()}</span>
          </button>
        : <div className="case-media-state" role={result.screenshotError || imageError ? "alert" : "status"}>{result.screenshotError || imageError || "Đang chuẩn bị ảnh cuối cùng"}</div>}
      <div className="case-media-tools"><button disabled={locked || attaching || !demoOk || !videoSource}
        title={demoOk ? "Gắn recording này làm Script Demo" : "Chỉ Run thành công + recording hoàn chỉnh mới làm được Script Demo"}
        onClick={() => {
          const version = window.prompt("Script version for video demo (semver)", "1.0.0");
          if (!version || !result.runId || !window.confirm("Confirm you reviewed this browser recording (no desktop/audio). Use as Script Demo?")) return;
          setAttaching(true); setAttachMsg("");
          void window.creator.invoke({ type: "attachScriptVideoDemo", caseId: item.id, runId: result.runId,
            scriptVersion: version.trim(), reviewed: true }).then(() => setAttachMsg("Đã gắn Script Demo cho version " + version.trim()))
            .catch(error => setAttachMsg(String((error as Error).message || error))).finally(() => setAttaching(false));
        }}>Use as Script Demo</button>{attachMsg && <span role={attachMsg.startsWith("Đã gắn") ? "status" : "alert"}>{attachMsg}</span>}</div>
    </section>
    <section className="case-step-results"><h2>Step Results</h2>
      <ol>{result.steps?.map((step, index) => <li key={`${step.stepId}-${step.version}`}>
        <div className="case-step-heading"><span className="case-step-number">{String(index + 1).padStart(2, "0")}</span>
          <b>{step.name} · v{step.version}</b><span className="case-run-status" data-status={step.status}>{stepStatusLabel(step.status)}</span></div>
        <p>{step.status === "ACTION_SENT" ? "Đã gửi thao tác, chưa xác nhận nghiệp vụ hoàn thành." : step.message}</p>
        {(step.error || step.message) && <details><summary>Diagnostic details</summary>
          {step.error ? <ExecutionErrorView error={step.error} stepName={step.name} onFix={onFix} /> : <p>{step.message}</p>}</details>}
      </li>)}</ol>
    </section>
    <details className="case-diagnostics"><summary>Run diagnostics</summary>
    <dl className="case-result-fields">
      <dt>Test Case</dt><dd>{result.caseName ?? item.name}</dd>
      <dt>Scenario</dt><dd>{result.scenarioName ?? state?.flows.find(flow => flow.id === item.flowId)?.name ?? item.flowId}</dd>
      <dt>Session</dt><dd>{result.sessionName ?? state?.browserSessions?.find(session => session.id === item.sessionId)?.name ?? item.sessionId}</dd>
      <dt>URL</dt><dd>{result.startUrl ?? item.startUrl}</dd>
      <dt>Bắt đầu</dt><dd>{new Date(result.startedAt).toLocaleString()}</dd>
      <dt>Thời gian</dt><dd>{result.status === "RUNNING" ? "Đang chạy…" : `${seconds.toFixed(1)} giây`}</dd>
      {result.stepId && <><dt>Step dừng</dt><dd>{result.stepName ?? result.stepId} · v{result.version}</dd></>}
    </dl>
    {result.error && <ExecutionErrorView error={result.error} stepName={result.stepName} onFix={onFix} />}
    <p role="status">{result.message}</p>
    <p className="hint">PASS chỉ theo xác nhận Runtime. ACTION_SENT cần kiểm tra website, không xác nhận hoàn tất nghiệp vụ.</p>
    {result.screenshotError && screenshot && <p role="alert">Lỗi chụp ảnh: {result.screenshotError}</p>}
    {result.evidenceError && <p role="alert">{result.evidenceError}</p>}
    </details>
    {large && screenshot && <UiPopover variant="modal" label="Screenshot Test Run" className="case-screenshot-modal" close={() => setLarge(false)}>
      <div className="popover-heading"><b>{result.caseName ?? item.name} · {status}</b><button onClick={() => setLarge(false)} aria-label="Đóng screenshot">×</button></div>
      <img src={screenshot} alt="Screenshot nội dung Browser tại cuối lượt chạy" />
    </UiPopover>}
  </section>;
}

export function TestLabPage({ state, locked, update, open, run, canRun, create, canDelete }: {
  state?: State; locked: boolean; update: (command: Command) => Promise<void>;
  open: (id: string) => void; run: (id: string) => void; canRun: (id: string) => boolean; create: () => void; canDelete: (id: string) => boolean;
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
    <p>Mỗi Case dùng Scenario, Session, URL và bộ Values riêng. Mỗi lần Run tự quay Browser video.</p></div>
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
        {!group.collapsed && <div className="test-lab-rows">
          <div className="test-lab-row test-lab-columns" aria-hidden="true"><b>Test Case</b><b>Scenario</b><b>Session</b><b>Last Result</b><span /><span /><span /></div>
          {cases.map(item => <div className="test-lab-row" key={item.id}>
            <button className="case-name" disabled={disabled} onClick={() => open(item.id)} title={item.name}>{item.name}</button>
            <span className="case-scenario" title={state?.flows.find(flow => flow.id === item.flowId)?.name}>{state?.flows.find(flow => flow.id === item.flowId)?.name ?? "Scenario không còn"}</span>
            <span className="case-session" title={state?.browserSessions?.find(session => session.id === item.sessionId)?.name}>{state?.browserSessions?.find(session => session.id === item.sessionId)?.name ?? "Session không còn"}</span>
            <span className="case-run-status" data-status={state?.runningTestCaseId === item.id ? "RUNNING" : resultStatus(item.lastResult?.status)} title={item.lastResult?.message}>
              {state?.runningTestCaseId === item.id ? "RUNNING" : resultStatus(item.lastResult?.status)}</span>
            <button disabled={disabled || !canRun(item.id)} onClick={() => run(item.id)} title={canRun(item.id) ? "Chạy Case đã lưu" : "Lưu hoặc bỏ draft Case trước khi chạy"}>Run</button>
            <button disabled={disabled} onClick={() => open(item.id)}>Chi tiết</button>
            <details><summary aria-label={`Menu ${item.name}`}>...</summary><div className="scenario-menu">
              <button disabled={disabled} onClick={() => show("move", item.id, item.name, item.groupId ?? "")}>Move to Group</button>
              <button disabled={disabled} onClick={() => show("delete", item.id, item.name)}>Delete Test Case</button></div></details>
          </div>)}{!cases.length && <p className="page-empty">Chưa có Test Case.</p>}
        </div>}
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
