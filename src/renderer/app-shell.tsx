import React from "react";
import type { AppPage, State } from "../shared/contracts";

const menus = [
  { page: "scenarios", label: "Scenarios", color: "#68d6a6", path: "M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M10 7h7v7" },
  { page: "browser-sessions", label: "Browser Sessions", color: "#75b9ff", path: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" },
  { page: "test-lab", label: "Test Lab", color: "#f4ae67", path: "M9 3h6M10 3v7L4 19q-1 2 2 2h12q3 0 2-2l-6-9V3M7 15h10" },
  { page: "settings", label: "Settings", color: "#a8b2c2", path: "m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h4l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
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

export function ScenariosPage({ state, name, setName, locked, open, create }: {
  state?: State; name: string; setName: (name: string) => void; locked: boolean;
  open: (id: string) => void; create: () => void;
}) {
  return <section className="app-page scenarios-page" aria-label="Scenarios">
    <div className="page-heading"><small>RPA Social Automation V2</small><h1>Scenarios</h1>
      <p>Chọn kịch bản để mở Creator hoặc tạo kịch bản mới.</p></div>
    <form className="scenario-create" onSubmit={event => { event.preventDefault(); create(); }}>
      <label>Tên Scenario mới<input aria-label="Tên flow mới" value={name} disabled={locked}
        onChange={event => setName(event.target.value)} /></label>
      <button className="primary" disabled={locked || !state || !name.trim()} type="submit">Tạo Scenario</button>
    </form>
    <div className="scenario-grid">
      {state?.flows.map(flow => <article className="scenario-card" key={flow.id}>
        <h2>{flow.name}</h2><p>{flow.steps.length} Step · Zoom {Math.round(flow.zoom * 100)}%</p>
        <button disabled={locked} onClick={() => open(flow.id)}>Mở Creator →</button>
      </article>)}
    </div>
    {state && !state.flows.length && <p className="page-empty">Chưa có Scenario. Tạo kịch bản đầu tiên để bắt đầu.</p>}
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
