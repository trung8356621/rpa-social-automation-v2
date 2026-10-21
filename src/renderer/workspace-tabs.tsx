import React from "react";
import type { MainPage, State, WorkspaceTab } from "../shared/contracts";

export function WorkspaceTabs({ tabs, activeId, state, mainPage, locked, dirty, caseName, open, close, scenarios }: {
  tabs: WorkspaceTab[]; activeId?: string; state?: State; locked: boolean;
  mainPage: MainPage; caseName: (id: string) => string | undefined;
  dirty: (id: string) => boolean; open: (tab: WorkspaceTab) => void;
  close: (id: string) => void; scenarios: () => void;
}) {
  return <div className="workspace-tabs" aria-label="Workspace tabs">
    <button className="scenarios-tab" aria-current={state?.appPage === mainPage ? "page" : undefined}
      disabled={locked} onClick={scenarios}>{{ scenarios: "Scenarios", "browser-sessions": "Browser Sessions", "test-lab": "Test Lab", settings: "Settings", variations: "Variations", "widget-registry": "Widget Registry", workflows: "Workflows", "builds-releases": "Builds & Releases" }[mainPage]}</button>
    <div className="workspace-tab-items">
      {tabs.map(tab => {
        const name = tab.kind === "studio" ? tab.flowId || "Studio" : tab.kind === "test-case" ? caseName(tab.id) ?? state?.testLab?.cases.find(c => c.id === tab.caseId)?.name ?? "Test Case mới"
          : state?.flows.find(f => f.id === tab.flowId)?.name ?? "Scenario";
        const active = activeId === tab.id && ["creator", "test-case", "variations", "widget-registry", "workflows"].includes(state?.appPage ?? "");
        return <div className={`workspace-tab${active ? " active" : ""}`} key={tab.id}>
          <button disabled={locked} aria-current={active ? "page" : undefined} title={name}
            onClick={() => open(tab)}>{dirty(tab.id) ? "● " : ""}{name}</button>
          <button className="tab-close" disabled={locked} aria-label={`Đóng ${name}`} onClick={() => close(tab.id)}>×</button>
        </div>;
      })}
    </div>
  </div>;
}
