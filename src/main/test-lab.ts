import { randomUUID } from "node:crypto";
import type { CaseResult, Flow, TestCase, TestCaseConfig, TestLabState } from "../shared/contracts.js";
import { validateVariables } from "../shared/flow-model.js";
import type { Store } from "./storage.js";
import type { BrowserSessions } from "./browser-sessions.js";

export class TestLab {
  constructor(private readonly store: Store, private readonly sessions: BrowserSessions) {
    // A process interruption cannot leave a saved Case looking permanently busy.
    const value = this.read();
    let interrupted = false;
    for (const item of value.cases) if (item.lastResult?.status === "RUNNING") {
      interrupted = true;
      const result = item.lastResult;
      result.status = "ERROR"; result.finishedAt = new Date().toISOString();
      result.message = "Ứng dụng đã dừng trước khi Test Run kết thúc. Kiểm tra website trước khi chạy lại.";
      if (!result.recordingPath && !result.recordingError) {
        result.recordingError = "Recording was interrupted before finalization.";
      }
      if (!result.screenshotPath) result.screenshotError = "Lượt chạy bị gián đoạn trước khi lưu screenshot cuối.";
      for (const step of result.steps ?? []) {
        if (step.status === "RUNNING") { step.status = "ERROR"; step.message = result.message; }
        else if (step.status === "PENDING") { step.status = "SKIPPED"; step.message = "Lượt chạy bị gián đoạn."; }
      }
    }
    if (interrupted) this.write(value);
  }
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
  validate(config: TestCaseConfig, checkValues = true) {
    this.name(config.name);
    if (config.recording !== undefined && typeof config.recording !== "boolean") throw new Error("Recording must be boolean.");
    const flow = this.store.flows().find(f => f.id === config.flowId);
    if (!flow) throw new Error("Scenario không còn tồn tại.");
    this.sessions.get(config.sessionId);
    let url: URL;
    try { url = new URL(config.startUrl); } catch { throw new Error("Start URL cần là HTTP/HTTPS hợp lệ."); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Start URL chỉ hỗ trợ HTTP/HTTPS.");
    if (!config.values || typeof config.values !== "object" || Array.isArray(config.values)) throw new Error("Values không hợp lệ.");
    if (checkValues) validateVariables(flow.variables ?? [], config.values);
    const pins = config.stepVersions !== undefined ? config.stepVersions : flow.steps;
    for (const ref of pins) {
      if (!flow.steps.some(step => step.id === ref.id)) throw new Error("Test Case chứa Step không thuộc Scenario.");
      this.store.step(ref.id, ref.version);
    }
    return { ...flow, steps: structuredClone(pins) } as Flow;
  }
  save(id: string | undefined, config: TestCaseConfig) {
    const value = this.read(), old = id ? this.get(id) : undefined;
    const flow = this.store.flows().find(f => f.id === config.flowId);
    const stepVersions = config.stepVersions ?? (old?.flowId === config.flowId ? old.stepVersions : undefined) ?? flow?.steps ?? [];
    const normalized = { ...config, stepVersions };
    this.validate(normalized);
    const item = { id: old?.id ?? randomUUID(), groupId: old?.groupId, lastResult: old?.lastResult,
      isDefaultAcceptance: old?.isDefaultAcceptance,
      name: this.name(config.name), flowId: config.flowId, sessionId: config.sessionId,
      startUrl: new URL(config.startUrl).href, recording: config.recording === true, values: structuredClone(config.values),
      stepVersions: structuredClone(stepVersions) };
    value.cases = old ? value.cases.map(c => c.id === id ? item : c) : [...value.cases, item];
    this.write(value);
    return item;
  }
  ensureForScenario(flowId: string, defaultAcceptance = false): TestCase {
    const flow = this.store.flows().find(item => item.id === flowId);
    if (!flow) throw new Error("Scenario không còn tồn tại.");
    const value = this.read();
    if (defaultAcceptance) {
      const existing = value.cases.find(item => item.flowId === flowId && item.isDefaultAcceptance);
      if (existing) {
        const refreshed = { ...existing, stepVersions: structuredClone(flow.steps) };
        value.cases = value.cases.map(item => item.id === existing.id ? refreshed : item);
        this.write(value);
        return refreshed;
      }
    }
    const session = this.sessions.list().find(item => item.id === this.sessions.activeId()) ?? this.sessions.list()[0];
    if (!session) throw new Error("Cần tạo Browser Session trước khi tạo Test Case.");
    const startUrl = session.lastUrl && /^https?:/i.test(session.lastUrl) ? session.lastUrl : "https://www.facebook.com/";
    const item: TestCase = {
      id: randomUUID(), name: defaultAcceptance ? `Nghiệm thu · ${flow.name}` : `Test · ${flow.name}`,
      flowId, sessionId: session.id, startUrl, recording: true,
      values: structuredClone(flow.defaultPattern?.values ?? {}), stepVersions: structuredClone(flow.steps),
      ...(defaultAcceptance ? { isDefaultAcceptance: true } : {}),
    };
    value.cases.push(item); this.write(value); return item;
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
