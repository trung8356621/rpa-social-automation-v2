import React from "react";
import type { State, WorkspaceTab } from "../shared/contracts";

export function WorkspaceTabs({ tabs, activeId, state, locked, dirty, open, close, scenarios }: {
  tabs: WorkspaceTab[]; activeId?: string; state?: State; locked: boolean;
  dirty: (id: string) => boolean; open: (tab: WorkspaceTab) => void;
  close: (id: string) => void; scenarios: () => void;
}) {
  return <div className="workspace-tabs" aria-label="Workspace tabs">
    <button className="scenarios-tab" aria-current={state?.appPage === "scenarios" ? "page" : undefined}
      disabled={locked} onClick={scenarios}>Scenarios</button>
    <div className="workspace-tab-items">
      {tabs.map(tab => {
        const name = state?.flows.find(f => f.id === tab.flowId)?.name ?? "Scenario";
        const active = activeId === tab.id && state?.appPage === "creator";
        return <div className={`workspace-tab${active ? " active" : ""}`} key={tab.id}>
          <button disabled={locked} aria-current={active ? "page" : undefined} title={name}
            onClick={() => open(tab)}>{dirty(tab.id) ? "● " : ""}{name}</button>
          <button className="tab-close" disabled={locked} aria-label={`Đóng ${name}`} onClick={() => close(tab.id)}>×</button>
        </div>;
      })}
    </div>
  </div>;
}
