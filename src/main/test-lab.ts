import { randomUUID } from "node:crypto";
import type { CaseResult, TestCaseConfig, TestLabState } from "../shared/contracts.js";
import { validateVariables } from "../shared/flow-model.js";
import type { Store } from "./storage.js";
import type { BrowserSessions } from "./browser-sessions.js";

export class TestLab {
  constructor(private readonly store: Store, private readonly sessions: BrowserSessions) {}
  read(): TestLabState {
    const saved = this.store.setting("testLab");
    return saved ? JSON.parse(saved) as TestLabState : { groups: [], cases: [], ungroupedCollapsed: false };
  }
  private write(value: TestLabState) { this.store.setSetting("testLab", JSON.stringify(value)); }
  private name(value: string) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new Error("Tên cần từ 1–120 ký tự.");
    return value.trim();
  }
  get(id: string) {
    const item = this.read().cases.find(c => c.id === id);
    if (!item) throw new Error("Không tìm thấy Test Case.");
    return item;
  }
  validate(config: TestCaseConfig) {
    this.name(config.name);
    const flow = this.store.flows().find(f => f.id === config.flowId);
    if (!flow) throw new Error("Scenario không còn tồn tại.");
    this.sessions.get(config.sessionId);
    let url: URL;
    try { url = new URL(config.startUrl); } catch { throw new Error("Start URL cần là HTTP/HTTPS hợp lệ."); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Start URL chỉ hỗ trợ HTTP/HTTPS.");
    if (!config.values || typeof config.values !== "object" || Array.isArray(config.values)) throw new Error("Values không hợp lệ.");
    validateVariables(flow.variables ?? [], config.values);
    return flow;
  }
  save(id: string | undefined, config: TestCaseConfig) {
    this.validate(config);
    const value = this.read(), old = id ? this.get(id) : undefined;
    const item = { id: old?.id ?? randomUUID(), groupId: old?.groupId, lastResult: old?.lastResult,
      name: this.name(config.name), flowId: config.flowId, sessionId: config.sessionId,
      startUrl: new URL(config.startUrl).href, values: structuredClone(config.values) };
    value.cases = old ? value.cases.map(c => c.id === id ? item : c) : [...value.cases, item];
    this.write(value);
    return item;
  }
  delete(id: string) { this.get(id); const value = this.read(); value.cases = value.cases.filter(c => c.id !== id); this.write(value); }
  move(id: string, groupId?: string) {
    const value = this.read(); this.get(id);
    if (groupId && !value.groups.some(g => g.id === groupId)) throw new Error("Không tìm thấy Test Group.");
    value.cases = value.cases.map(c => c.id === id ? { ...c, groupId } : c); this.write(value);
  }
  result(id: string, lastResult: CaseResult) {
    const value = this.read(); this.get(id);
    value.cases = value.cases.map(c => c.id === id ? { ...c, lastResult } : c); this.write(value);
  }
  group(operation: "create" | "update" | "delete", id?: string, name?: string, collapsed?: boolean) {
    const value = this.read();
    if (operation === "create") value.groups.push({ id: randomUUID(), name: this.name(name ?? ""), collapsed: false });
    else {
      const group = value.groups.find(g => g.id === id);
      if (!group) throw new Error("Không tìm thấy Test Group.");
      if (operation === "delete") {
        value.groups = value.groups.filter(g => g.id !== id);
        value.cases = value.cases.map(c => c.groupId === id ? { ...c, groupId: undefined } : c);
      } else if (operation === "update") {
        if (name !== undefined) group.name = this.name(name);
        if (collapsed !== undefined) {
          if (typeof collapsed !== "boolean") throw new Error("Trạng thái Group không hợp lệ.");
          group.collapsed = collapsed;
        }
      } else throw new Error("Thao tác Group không hợp lệ.");
    }
    this.write(value);
  }
  collapse(collapsed: boolean) {
    if (typeof collapsed !== "boolean") throw new Error("Trạng thái không hợp lệ.");
    this.write({ ...this.read(), ungroupedCollapsed: collapsed });
  }
}
