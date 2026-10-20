import React, { useState } from "react";
import type { BrowserSession, Command, State } from "../shared/contracts";
import { UiPopover } from "./ui-popover";

export function SessionSelector({ state, locked, select }: {
  state?: State; locked: boolean; select: (id: string) => void;
}) {
  return <label className="session-selector">Session
    <select aria-label="Browser Session" disabled={locked || !state?.browserSessions?.length}
      value={state?.activeBrowserSessionId ?? ""} onChange={event => select(event.target.value)}>
      {state?.browserSessions?.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}
    </select>
  </label>;
}

export function BrowserSessionsPage({ state, locked, update, open }: {
  state?: State; locked: boolean; update: (command: Command) => Promise<void>; open: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState("");
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<BrowserSession>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const disabled = locked || working;
  async function run(command: Command) {
    if (disabled) return false;
    setWorking(true); setError("");
    try { await update(command); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setWorking(false); }
  }
  return <section className="app-page" aria-label="Browser Sessions">
    <div className="page-heading"><h1>Browser Sessions</h1>
      <p>Mỗi Session là một môi trường trình duyệt độc lập. Chọn Session để mở trong Creator.</p>
    </div>
    <form className="scenario-create" onSubmit={event => { event.preventDefault();
      void run({ type: "createBrowserSession", name }).then(ok => { if (ok) setName(""); }); }}>
      <label>Tên Session mới<input aria-label="Tên Session mới" maxLength={80} value={name} disabled={disabled}
        onChange={event => setName(event.target.value)} /></label>
      <button className="primary" disabled={disabled || !name.trim()} type="submit">Tạo Session</button>
    </form>
    {error && !deleting && <p role="alert">{error}</p>}
    <div className="scenario-grid">
      {state?.browserSessions?.map(session => <article className="scenario-card session-card" key={session.id}>
        {editing === session.id ? <form className="session-rename" onSubmit={event => { event.preventDefault();
          void run({ type: "renameBrowserSession", id: session.id, name: editName }).then(ok => { if (ok) setEditing(""); }); }}>
          <input aria-label="Đổi tên Session" disabled={disabled} maxLength={80} value={editName} onChange={event => setEditName(event.target.value)} />
          <button disabled={disabled || !editName.trim()} type="submit">Lưu tên</button>
          <button disabled={disabled} type="button" onClick={() => setEditing("")}>Hủy</button>
        </form> : <h2>{session.name} {session.id === state?.activeBrowserSessionId && <small className="session-active">Đang dùng</small>}</h2>}
        <div className="session-domains">{session.domains.map(domain => <span className="session-domain" key={domain}>{domain}
          <button disabled={disabled} aria-label={`Xóa tag ${domain} của ${session.name}`} title="Xóa tag; giữ dữ liệu đăng nhập"
            onClick={() => void run({ type: "removeSessionDomain", id: session.id, domain })}>×</button>
        </span>)}{!session.domains.length && <small>Chưa có Domain Tag</small>}</div>
        <p className="session-last-url" title={session.lastUrl}>Last URL: {session.lastUrl || "Chưa truy cập website"}</p>
        <div className="session-actions">
          <button disabled={disabled} onClick={() => open(session.id)}>Open</button>
          <button disabled={disabled} onClick={() => { setEditing(session.id); setEditName(session.name); setError(""); }}>Rename</button>
          {!session.isDefault && <button disabled={disabled || session.id === state?.activeBrowserSessionId}
            title={session.id === state?.activeBrowserSessionId ? "Chuyển sang Session khác trước khi xóa" : "Xóa Session"}
            onClick={() => { setError(""); setDeleting(session); }}>Delete</button>}
        </div>
      </article>)}
    </div>
    {deleting && <UiPopover variant="modal" label="Xác nhận xóa Session" className="unsaved-confirm"
      close={() => { if (!working) setDeleting(undefined); }}>
      <div className="popover-heading"><b>Xóa Session “{deleting.name}”?</b></div>
      <p>Session sẽ được xóa khỏi danh sách. Dữ liệu trình duyệt trên máy được giữ nguyên.</p>
      {error && <p role="alert">{error}</p>}
      <div className="popover-footer">
        <button disabled={disabled} onClick={() => void run({ type: "deleteBrowserSession", id: deleting.id, confirmed: true })
          .then(ok => { if (ok) setDeleting(undefined); })}>Xóa Session</button>
        <button disabled={working} onClick={() => setDeleting(undefined)}>Hủy</button>
      </div>
    </UiPopover>}
  </section>;
}
