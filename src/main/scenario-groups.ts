import { randomUUID } from "node:crypto";
import type { ScenarioOrganization } from "../shared/contracts.js";
import type { Store } from "./storage.js";

/** List organization only; never modifies a Flow or its Step versions. */
export class ScenarioGroups {
  constructor(private readonly store: Store) {}
  read(): ScenarioOrganization {
    const saved = this.store.setting("scenarioOrganization");
    return saved ? JSON.parse(saved) as ScenarioOrganization : { groups: [], membership: {}, ungroupedCollapsed: false };
  }
  private save(value: ScenarioOrganization) {
    this.store.setSetting("scenarioOrganization", JSON.stringify(value));
  }
  create(name: string) {
    const value = this.read();
    value.groups.push({ id: randomUUID(), name: this.name(name), collapsed: false });
    this.save(value);
  }
  update(id: string, change: { name?: string; collapsed?: boolean }) {
    const value = this.read(), group = value.groups.find(g => g.id === id);
    if (!group) throw new Error("Không tìm thấy Scenario Group.");
    if (change.name !== undefined) group.name = this.name(change.name);
    if (change.collapsed !== undefined) {
      if (typeof change.collapsed !== "boolean") throw new Error("Trạng thái Group không hợp lệ.");
      group.collapsed = change.collapsed;
    }
    this.save(value);
  }
  delete(id: string) {
    const value = this.read();
    value.groups = value.groups.filter(g => g.id !== id);
    for (const flowId of Object.keys(value.membership))
      if (value.membership[flowId] === id) delete value.membership[flowId];
    this.save(value);
  }
  move(flowId: string, groupId?: string) {
    const value = this.read();
    if (!this.store.flows().some(f => f.id === flowId)) throw new Error("Không tìm thấy Scenario.");
    if (groupId !== undefined && !value.groups.some(g => g.id === groupId)) throw new Error("Không tìm thấy Scenario Group.");
    if (groupId) value.membership[flowId] = groupId;
    else delete value.membership[flowId];
    this.save(value);
  }
  collapseUngrouped(collapsed: boolean) {
    if (typeof collapsed !== "boolean") throw new Error("Trạng thái Group không hợp lệ.");
    this.save({ ...this.read(), ungroupedCollapsed: collapsed });
  }
  private name(name: string) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
      throw new Error("Tên Group cần từ 1–80 ký tự.");
    return name.trim();
  }
}
