import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Flow, Step, Override, Payload } from "../shared/contracts.js";
import {
  validateZoom,
  validateRect,
  WEB_WIDTH,
  WEB_HEIGHT,
} from "../shared/geometry.js";
export function validatePayload(p: Payload) {
  if (
    !p ||
    !["CLICK_TARGET", "TYPE_ONLY", "WAIT_VERIFY", "SCROLL"].includes(p.action)
  )
    throw new Error("Action không hỗ trợ.");
  if (p.action === "TYPE_ONLY" && (!p.text || p.text.length > 20000))
    throw new Error("TYPE_ONLY cần text, tối đa 20.000 ký tự.");
  if (
    ["CLICK_TARGET", "WAIT_VERIFY"].includes(p.action) &&
    (!p.target || !/^[a-f0-9-]+\.png$/.test(p.target.asset))
  )
    throw new Error("Action cần ảnh target được crop.");
  if (["CLICK_TARGET", "WAIT_VERIFY"].includes(p.action))
    validateRect(p.target!.roi, WEB_WIDTH, WEB_HEIGHT);
  if (
    p.action === "SCROLL" &&
    (!Number.isFinite(p.deltaY) || Math.abs(p.deltaY!) > 3000)
  )
    throw new Error("Scroll không hợp lệ.");
  if (
    p.timeoutMs !== undefined &&
    (!Number.isFinite(p.timeoutMs) || p.timeoutMs < 0 || p.timeoutMs > 30000)
  )
    throw new Error("Timeout tối đa 30 giây.");
  if (
    p.threshold !== undefined &&
    (!Number.isFinite(p.threshold) || p.threshold < 0.8 || p.threshold > 1)
  )
    throw new Error("Threshold cần từ 0.8 đến 1.");
}
export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps(id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS overrides(id TEXT PRIMARY KEY,step_id TEXT NOT NULL,base_version INTEGER NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(step_id,base_version) REFERENCES steps(id,version));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  flow(): Flow | null {
    const id = this.setting("currentFlow");
    if (!id) return null;
    const row = this.db
      .prepare("SELECT payload FROM flows WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  flows(): Flow[] {
    return (
      this.db
        .prepare("SELECT payload FROM flows ORDER BY rowid DESC")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  saveFlow(flow: Flow) {
    this.db
      .prepare(
        "INSERT INTO flows VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(flow.id, JSON.stringify(flow));
    this.setSetting("currentFlow", flow.id);
  }
  newFlow(name: string, zoom: number): Flow {
    const f = {
      id: randomUUID(),
      name: name.trim() || "Untitled flow",
      zoom: validateZoom(zoom),
      steps: [],
    };
    this.saveFlow(f);
    return f;
  }
  steps(): Step[] {
    return (
      this.db.prepare("SELECT payload FROM steps ORDER BY rowid").all() as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));
  }
  step(id: string, version: number): Step {
    const r = this.db
      .prepare("SELECT payload FROM steps WHERE id=? AND version=?")
      .get(id, version) as { payload: string } | undefined;
    if (!r) throw new Error("Không tìm thấy phiên bản step.");
    return JSON.parse(r.payload);
  }
  saveStep(name: string, payload: Payload, id?: string): Step {
    validatePayload(payload);
    const f = this.flow();
    if (!f) throw new Error("Tạo flow trước.");
    if (id && !f.steps.some((s) => s.id === id))
      throw new Error("Step không thuộc flow đang mở.");
    const version = id
      ? Math.max(
          ...this.steps()
            .filter((s) => s.id === id)
            .map((s) => s.version),
        ) + 1
      : 1;
    const s: Step = {
      id: id || randomUUID(),
      version,
      name: name.trim() || payload.action,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO steps VALUES(?,?,?)")
        .run(s.id, s.version, JSON.stringify(s));
      const existing = f.steps.find((r) => r.id === s.id);
      if (existing) existing.version = version;
      else f.steps.push({ id: s.id, version });
      this.saveFlow(f);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return s;
  }
  selectVersion(id: string, version: number) {
    this.step(id, version);
    const f = this.flow();
    const ref = f?.steps.find((s) => s.id === id);
    if (!f || !ref) throw new Error("Step không thuộc flow.");
    ref.version = version;
    this.saveFlow(f);
  }
  overrides(): Override[] {
    return (
      this.db.prepare("SELECT payload FROM overrides").all() as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));
  }
  saveOverride(
    stepId: string,
    baseVersion: number,
    name: string,
    segment: Payload[],
  ) {
    this.step(stepId, baseVersion);
    if (!Array.isArray(segment) || !segment.length || segment.length > 8)
      throw new Error("Override cần 1–8 action.");
    segment.forEach(validatePayload);
    const o: Override = {
      id: randomUUID(),
      stepId,
      baseVersion,
      name: name.trim() || "Manual context",
      segment,
    };
    this.db
      .prepare("INSERT INTO overrides VALUES(?,?,?,?)")
      .run(o.id, stepId, baseVersion, JSON.stringify(o));
    return o;
  }
  close() {
    this.db.close();
  }
}
