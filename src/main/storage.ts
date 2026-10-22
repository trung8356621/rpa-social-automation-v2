import {
  resolvePayload,
  validateVariables,
  validateOrganization,
} from "../shared/flow-model.js";
import type { Variable, StepGroup } from "../shared/contracts.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { validateUploadFileList } from "./upload-files.js";
import type {
  Flow,
  Step,
  Override,
  Payload,
  InvalidStepRef,
} from "../shared/contracts.js";
import {
  validateZoom,
  validateRect,
  WEB_WIDTH,
  WEB_HEIGHT,
} from "../shared/geometry.js";
import { validateVisualEnvironment } from "../shared/visual-environment.js";
import { defaultNetworkSettings, validateNetworkSettings, type NetworkSettings } from "../shared/network-mode.js";
export function validatePayload(p: Payload) {
  if (
    !p ||
    ![
      "CLICK_TARGET",
      "CLICK_AND_TYPE",
      "UPLOAD_FILE",
      "QUICK_TAG",
      "TYPE_ONLY",
      "WAIT_VERIFY",
      "SCROLL",
      "SLEEP",
    ].includes(p.action)
  )
    throw new Error("Action không hỗ trợ.");
  if (p.action === "SLEEP" && p.target)
    throw new Error("SLEEP không dùng target.");
  if (p.action === "QUICK_TAG" && (!p.variableId || !Number.isInteger(p.quickTagRows) || p.quickTagRows! < 1 || p.quickTagRows! > 20 || p.target?.ocr || !p.target?.environment || ![undefined, "none"].includes(p.target.matchTo)))
    throw new Error("QUICK_TAG cần Variable Integer, ROI mới không OCR/scroll và số hàng 1–20.");
  if (p.action === "UPLOAD_FILE" && !p.variableId)
    validateUploadFileList(p.files);
  if (
    ["TYPE_ONLY", "CLICK_AND_TYPE"].includes(p.action) &&
    !p.variableId &&
    (!p.text || p.text.length > 20000)
  )
    throw new Error("Action nhập liệu cần text, tối đa 20.000 ký tự.");
  if (
    p.inputMethod !== undefined &&
    (!["TYPE_ONLY", "CLICK_AND_TYPE"].includes(p.action) ||
      !["keyboard", "clipboard"].includes(p.inputMethod))
  )
    throw new Error("Phương thức nhập không hợp lệ.");
  if (
    ["CLICK_TARGET", "CLICK_AND_TYPE", "UPLOAD_FILE", "WAIT_VERIFY", "QUICK_TAG"].includes(
      p.action,
    ) &&
    (!p.target || !/^[a-f0-9-]+\.png$/.test(p.target.asset))
  )
    throw new Error("Action cần ảnh target được crop.");
  if (
    ["CLICK_TARGET", "CLICK_AND_TYPE", "UPLOAD_FILE", "WAIT_VERIFY", "QUICK_TAG"].includes(
      p.action,
    )
  ) {
    if (p.target!.environment) validateVisualEnvironment(p.target!.environment);
    validateRect(
      p.target!.roi,
      p.target!.environment?.width ?? WEB_WIDTH,
      p.target!.environment?.height ?? WEB_HEIGHT,
    );
    if (p.action === "QUICK_TAG" && (p.target!.roi.width < 40 || p.target!.roi.height / p.quickTagRows! < 16))
      throw new Error("QUICK_TAG: ROI rộng ít nhất 40px và mỗi hàng cao ít nhất 16px.");
  }
  if (p.method !== undefined && !["auto", "image", "ocr"].includes(p.method))
    throw new Error("Phương thức target không hợp lệ.");
  if (p.target?.matchTo !== undefined &&
      (!["none", "current", "top", "middle", "bottom"].includes(p.target.matchTo) ||
       (!["none", "current"].includes(p.target.matchTo) && !p.target.ocr?.confirmed)))
    throw new Error("Match To cần OCR đã xác nhận.");
  if (p.target?.ocr) {
    const o = p.target.ocr,
      b = o.bbox;
    if (
      o.confirmed !== true ||
      o.language !== "vie+eng" ||
      !["line", "word"].includes(o.kind) ||
      !o.text?.trim() ||
      o.text.length > 2000 ||
      !Number.isFinite(o.confidence) ||
      o.confidence < 0 ||
      o.confidence > 100 ||
      !b ||
      !Object.values(b).every(Number.isFinite) ||
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > p.target.roi.width ||
      b.y + b.height > p.target.roi.height
    )
      throw new Error("Chữ OCR xác nhận/bounding box không hợp lệ.");
  }
  if (
    p.method === "ocr" &&
    (!["CLICK_TARGET", "CLICK_AND_TYPE", "UPLOAD_FILE", "WAIT_VERIFY"].includes(
      p.action,
    ) ||
      !p.target?.ocr?.confirmed)
  )
    throw new Error("OCR matching cần chữ do người dùng chọn và xác nhận.");
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
  private invalidStepRefs: InvalidStepRef[] = [];
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    const schema = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (schema.user_version > 2) {
      this.db.close();
      throw new Error(
        "Database schema is newer than this Creator; migration refused, data preserved.",
      );
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps(id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS overrides(id TEXT PRIMARY KEY,step_id TEXT NOT NULL,base_version INTEGER NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(step_id,base_version) REFERENCES steps(id,version));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      `);
    try {
      // Schema migration runs once. Business-data defects must not block reopen.
      if (schema.user_version < 2) this.migrateSchemaToV2();
      // Safe inline→Variable conversion may still be needed on v2 DBs that received
      // legacy rows out-of-band; never invent Variables for broken references.
      this.convertSafeLegacyPayloads();
      this.refreshInvalidStepRefs();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  invalidSteps(): InvalidStepRef[] {
    return this.invalidStepRefs.slice();
  }
  reindexInvalidSteps() {
    this.refreshInvalidStepRefs();
  }
  /** Runtime/publish gate — never invents Variables or rewrites payloads. */
  assertStepExecutable(stepId: string, version: number, flow?: Flow | null) {
    const hit = this.invalidStepRefs.find(
      (r) => r.stepId === stepId && r.version === version,
    );
    if (hit)
      throw new Error(
        `Invalid Step/Variable reference (${hit.reason}): ${hit.detail}`,
      );
    const f = flow ?? this.flowOwningStep(stepId);
    const step = this.step(stepId, version);
    const reason = this.variableRefIssue(step.payload, f);
    if (reason)
      throw new Error(`Invalid Step/Variable reference: ${reason.detail}`);
  }
  private flowOwningStep(stepId: string): Flow | null {
    return (
      this.flows().find((f) => f.steps.some((r) => r.id === stepId)) ?? null
    );
  }
  private variableRefIssue(
    payload: Payload,
    flow: Flow | null,
  ): Omit<InvalidStepRef, "flowId" | "stepId" | "version"> | null {
    if (
      !["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE", "QUICK_TAG"].includes(
        payload.action,
      )
    )
      return null;
    if (!payload.variableId) {
      if (
        ["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE"].includes(payload.action) &&
        (payload.action === "UPLOAD_FILE" ? payload.files : payload.text) ===
          undefined
      )
        return {
          reason: "legacy_incomplete",
          detail: "Action thiếu Variable và không còn giá trị inline.",
        };
      return null;
    }
    if (!flow?.variables?.some((v) => v.id === payload.variableId))
      return {
        reason: "missing_variable",
        variableId: payload.variableId,
        detail: `Referenced variable is missing (${payload.variableId}).`,
      };
    return null;
  }
  private refreshInvalidStepRefs() {
    const found: InvalidStepRef[] = [];
    for (const f of this.flows()) {
      const ids = new Set(f.steps.map((r) => r.id));
      for (const s of this.steps().filter((s) => ids.has(s.id))) {
        const issue = this.variableRefIssue(s.payload, f);
        if (issue)
          found.push({
            flowId: f.id,
            stepId: s.id,
            version: s.version,
            ...issue,
          });
      }
      for (const o of this.overrides().filter((o) => ids.has(o.stepId))) {
        for (const [i, p] of o.segment.entries()) {
          const issue = this.variableRefIssue(p, f);
          if (issue)
            found.push({
              flowId: f.id,
              stepId: o.stepId,
              version: o.baseVersion,
              reason: "override_invalid",
              variableId: issue.variableId,
              detail: `Override ${o.id} segment[${i}]: ${issue.detail}`,
            });
        }
      }
    }
    this.invalidStepRefs = found;
  }
  private importLegacy(payload: Payload, f: Flow): Payload {
    const p = { ...payload };
    if (!["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE"].includes(p.action))
      return p;
    if (!p.variableId) {
      const value = p.action === "UPLOAD_FILE" ? p.files : p.text;
      if (value === undefined)
        throw new Error("Legacy action missing text/files; migration aborted");
      const vars = (f.variables ??= []);
      let n = vars.length + 1;
      while (vars.some((v) => v.key === `legacy_${n}`)) n++;
      const v: Variable = {
        id: randomUUID(),
        key: `legacy_${n}`,
        type: p.action === "UPLOAD_FILE" ? "files" : "text",
      };
      vars.push(v);
      (f.defaultPattern ??= { values: {} }).values[v.id] = value;
      p.variableId = v.id;
    }
    const variable = f.variables?.find((v) => v.id === p.variableId);
    if (!variable)
      throw new Error("Referenced variable is missing; payload preserved");
    const inline = p.action === "UPLOAD_FILE" ? p.files : p.text;
    if (
      inline !== undefined &&
      JSON.stringify(inline) !==
        JSON.stringify(f.defaultPattern?.values[variable.id])
    )
      throw new Error(
        "Inline value conflicts with variable Default Pattern; payload preserved",
      );
    delete p.text;
    delete p.files;
    return p;
  }
  /** One-time schema/legacy conversion. Skips defective rows without rewriting them. */
  private migrateSchemaToV2() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyLegacyConversion(true);
      this.db.exec("PRAGMA user_version=2; COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw new Error(`Migration aborted; data preserved: ${String(e)}`);
    }
  }
  /** Convert only classic inline payloads (no variableId + has text/files). */
  private convertSafeLegacyPayloads() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.applyLegacyConversion(false);
      if (changed) this.db.exec("COMMIT");
      else this.db.exec("ROLLBACK");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw new Error(`Legacy conversion aborted; data preserved: ${String(e)}`);
    }
  }
  private applyLegacyConversion(forceAll: boolean): boolean {
    let changed = false;
    for (const f of this.flows()) {
      f.variables ??= [];
      f.defaultPattern ??= { values: {} };
      f.groups ??= [];
      let flowChanged = false;
      for (const s of this.steps().filter((s) =>
        f.steps.some((r) => r.id === s.id),
      )) {
        if (!forceAll && !this.isSafeInlineLegacy(s.payload)) continue;
        try {
          const next = this.importLegacy(s.payload, f);
          if (JSON.stringify(next) === JSON.stringify(s.payload)) continue;
          s.payload = next;
          this.db
            .prepare("UPDATE steps SET payload=? WHERE id=? AND version=?")
            .run(JSON.stringify(s), s.id, s.version);
          changed = true;
          flowChanged = true;
        } catch {
          // Keep original payload for Creator repair; do not invent Variables.
        }
      }
      for (const o of this.overrides().filter((o) =>
        f.steps.some((r) => r.id === o.stepId),
      )) {
        if (!forceAll && !o.segment.some((p) => this.isSafeInlineLegacy(p)))
          continue;
        try {
          const next = o.segment.map((p) =>
            forceAll || this.isSafeInlineLegacy(p) ? this.importLegacy(p, f) : p,
          );
          if (JSON.stringify(next) === JSON.stringify(o.segment)) continue;
          o.segment = next;
          this.db
            .prepare("UPDATE overrides SET payload=? WHERE id=?")
            .run(JSON.stringify(o), o.id);
          changed = true;
          flowChanged = true;
        } catch {
          // Preserve override segment as stored.
        }
      }
      if (flowChanged || forceAll) {
        this.db
          .prepare("UPDATE flows SET payload=? WHERE id=?")
          .run(JSON.stringify(f), f.id);
        changed = true;
      }
    }
    return changed;
  }
  private isSafeInlineLegacy(payload: Payload): boolean {
    if (!["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE"].includes(payload.action))
      return false;
    if (payload.variableId) return false;
    return (
      (payload.action === "UPLOAD_FILE" ? payload.files : payload.text) !==
      undefined
    );
  }
  updateVariables(
    variables: Variable[],
    values: Record<string, string | string[] | number>,
  ) {
    const f = this.flow();
    if (!f) throw new Error("Create flow first");
    validateVariables(variables, values);
    const used = [
      ...this.steps()
        .filter((s) => f.steps.some((r) => r.id === s.id))
        .map((s) => s.payload),
      ...this.overrides()
        .filter((o) => f.steps.some((r) => r.id === o.stepId))
        .flatMap((o) => o.segment),
    ];
    for (const p of used)
      if (
        p.variableId &&
        !variables.some(
          (v) =>
            v.id === p.variableId &&
            v.type ===
              f.variables?.find((old) => old.id === p.variableId)?.type,
        )
      )
        throw new Error(
          "Variable is used by a Step/version/Override; cannot delete or change type",
        );
    f.variables = variables;
    f.defaultPattern = { values };
    this.saveFlow(f);
    this.refreshInvalidStepRefs();
  }
  organize(groups: StepGroup[], stepIds: string[]) {
    const f = this.flow();
    if (!f) throw new Error("Create flow first");
    validateOrganization(f, groups, stepIds);
    f.groups = groups;
    f.steps = stepIds.map((id) => f.steps.find((s) => s.id === id)!);
    this.saveFlow(f);
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  networkSettings(): NetworkSettings {
    const saved = this.setting("networkMode");
    if (!saved) return defaultNetworkSettings();
    const settings = JSON.parse(saved) as NetworkSettings;
    validateNetworkSettings(settings);
    return settings;
  }
  setNetworkSettings(settings: NetworkSettings) {
    validateNetworkSettings(settings);
    this.setSetting("networkMode", JSON.stringify(settings));
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
      groups: [],
      variables: [],
      defaultPattern: { values: {} },
    };
    this.saveFlow(f);
    return f;
  }
  deleteFlow(id: string) {
    const flow = this.flows().find(f => f.id === id);
    if (!flow) throw new Error("Không tìm thấy Scenario.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lab = JSON.parse(this.setting("testLab") ?? '{"cases":[]}') as { cases: { flowId: string }[] };
      const count = lab.cases.filter(c => c.flowId === id).length;
      if (count) throw new Error(`${count} Test Case đang dùng Scenario này. Hãy sửa hoặc xóa các Case trước.`);
      const others = this.flows().filter(f => f.id !== id);
      const owned = flow.steps.filter(s => !others.some(f => f.steps.some(ref => ref.id === s.id))).map(s => s.id);
      for (const stepId of owned) {
        this.db.prepare("DELETE FROM overrides WHERE step_id=?").run(stepId);
        this.db.prepare("DELETE FROM steps WHERE id=?").run(stepId);
      }
      for (const row of this.db.prepare("SELECT id,payload FROM runs").all() as { id: string; payload: string }[]) {
        const run = JSON.parse(row.payload) as { flowId?: string; stepId?: string };
        if (run.flowId === id || (!run.flowId && run.stepId && owned.includes(run.stepId)))
          this.db.prepare("DELETE FROM runs WHERE id=?").run(row.id);
      }
      this.db.prepare("DELETE FROM flows WHERE id=?").run(id);
      if (this.setting("currentFlow") === id) this.setSetting("currentFlow", others[0]?.id ?? "");
      const organization = this.setting("scenarioOrganization");
      if (organization) {
        const value = JSON.parse(organization) as { membership: Record<string, string> };
        delete value.membership[id]; this.setSetting("scenarioOrganization", JSON.stringify(value));
      }
      this.db.exec("COMMIT");
      this.refreshInvalidStepRefs();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
    payload = this.importLegacy(payload, f);
    resolvePayload(payload, f);
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
    this.refreshInvalidStepRefs();
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
    const flow = this.flow();
    if (!flow || !flow.steps.some((s) => s.id === stepId))
      throw new Error("Step outside flow");
    segment = segment.map((p) => this.importLegacy(p, flow));
    segment.forEach((p) => resolvePayload(p, flow));
    const o: Override = {
      id: randomUUID(),
      stepId,
      baseVersion,
      name: name.trim() || "Manual context",
      segment,
    };
    this.db.exec("BEGIN");
    try {
      this.saveFlow(flow);
      this.db
        .prepare("INSERT INTO overrides VALUES(?,?,?,?)")
        .run(o.id, stepId, baseVersion, JSON.stringify(o));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.refreshInvalidStepRefs();
    return o;
  }
  close() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best-effort unlock for Windows temp DB cleanup */
    }
    this.db.close();
  }
}
