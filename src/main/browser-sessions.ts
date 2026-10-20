import { randomUUID } from "node:crypto";
import type { BrowserSession } from "../shared/contracts.js";
import type { Store } from "./storage.js";

// This is the existing Creator partition. Never rename it or move its storage.
export const DEFAULT_SESSION_PARTITION = "persist:creator-default";
export const DEFAULT_SESSION_ID = "default";
function address(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return;
    return { url: url.href, hostname: url.hostname.toLowerCase().replace(/^www\./, "") };
  } catch { return; }
}
function sessionName(name: string) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw new Error("Tên Session cần từ 1–80 ký tự.");
  return name.trim();
}
/** Metadata only. No cookies, browser files or Flow data are copied or deleted. */
export class BrowserSessions {
  constructor(private readonly store: Store) {
    const saved = store.setting("browserSessions");
    if (!saved) {
      const at = new Date().toISOString();
      this.save([{ id: DEFAULT_SESSION_ID, name: "Default", partition: DEFAULT_SESSION_PARTITION,
        isDefault: true, lastUrl: address(store.setting("lastUrl") ?? "")?.url,
        domains: [], createdAt: at, updatedAt: at }]);
    }
    const sessions = this.list();
    const fallback = sessions.find(s => s.id === DEFAULT_SESSION_ID);
    if (!fallback || !fallback.isDefault || fallback.partition !== DEFAULT_SESSION_PARTITION ||
        new Set(sessions.map(s => s.id)).size !== sessions.length ||
        new Set(sessions.map(s => s.partition)).size !== sessions.length ||
        sessions.some(s => s.id !== DEFAULT_SESSION_ID &&
          (s.isDefault || !/^[a-f0-9-]{36}$/.test(s.id) || s.partition !== `persist:rpa-session-${s.id}`)))
      throw new Error("Metadata Browser Session không hợp lệ; dữ liệu trình duyệt được giữ nguyên.");
  }
  list(): BrowserSession[] { return JSON.parse(this.store.setting("browserSessions")!) as BrowserSession[]; }
  get(id: string) {
    const session = this.list().find(s => s.id === id);
    if (!session) throw new Error("Không tìm thấy Browser Session.");
    return session;
  }
  activeId() {
    const id = this.store.setting("activeBrowserSessionId");
    return this.list().some(s => s.id === id) ? id! : DEFAULT_SESSION_ID;
  }
  select(id: string) { this.get(id); this.store.setSetting("activeBrowserSessionId", id); }
  create(name: string) {
    const id = randomUUID(), at = new Date().toISOString();
    const session: BrowserSession = { id, name: sessionName(name), partition: `persist:rpa-session-${id}`,
      isDefault: false, domains: [], createdAt: at, updatedAt: at };
    this.save([...this.list(), session]);
    return session;
  }
  rename(id: string, name: string) {
    const value = sessionName(name);
    this.get(id);
    this.save(this.list().map(s => s.id === id ? { ...s, name: value, updatedAt: new Date().toISOString() } : s));
  }
  delete(id: string, activeId: string) {
    if (this.get(id).isDefault) throw new Error("Không thể xóa Default Session.");
    if (id === activeId) throw new Error("Chuyển sang Session khác trước khi xóa Session đang dùng.");
    this.save(this.list().filter(s => s.id !== id));
  }
  removeDomain(id: string, domain: string) {
    this.get(id);
    this.save(this.list().map(s => s.id === id ? { ...s, domains: s.domains.filter(d => d !== domain), updatedAt: new Date().toISOString() } : s));
  }
  recordVisit(id: string, value: string) {
    const visit = address(value);
    if (!visit) return;
    this.save(this.list().map(s => s.id === id ? { ...s, lastUrl: visit.url,
      domains: [...new Set([...s.domains, visit.hostname])], updatedAt: new Date().toISOString() } : s));
  }
  private save(sessions: BrowserSession[]) { this.store.setSetting("browserSessions", JSON.stringify(sessions)); }
}
