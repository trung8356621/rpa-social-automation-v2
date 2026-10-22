import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Flow, Step, Variable } from "../shared/contracts.js";
import { buildScriptPublishBody, assertScriptPublishBody } from "../shared/script-release.js";
import { computeExecutionDigest, computeScriptContentDigest } from "../shared/script-digest.js";
import {
  createHttpSeoOpsAuthClient,
  assertRpaAdminRole,
  type RpaAdminUser,
  type TokenStore,
} from "../shared/seo-ops-auth.js";
import {
  createHttpScriptSyncClient,
  importScriptRelease,
  planScriptSync,
  type LocalScriptRow,
  type SyncPlan,
} from "../shared/script-sync.js";
import {
  labelForStatus,
  statusFromPlanSides,
  type ScriptSyncRow,
  type SyncStatusCode,
} from "../shared/sync-status.js";
import type { Store } from "./storage.js";

export type SeoOpsConfig = {
  baseUrl: string;
};

type SyncMeta = {
  rows: Record<string, ScriptSyncRow>;
  last_sync_at?: string;
  last_result?: string;
};

export function createSeoOpsSyncService(options: {
  store: Store;
  assetDir: string;
  tokenStore: TokenStore;
}) {
  const { store, assetDir, tokenStore } = options;

  function config(): SeoOpsConfig {
    const raw = store.setting("seoOpsBaseUrl");
    return { baseUrl: (raw || "http://seo-ops.test").replace(/\/$/, "") };
  }

  function setConfig(baseUrl: string) {
    const url = baseUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(url)) throw new Error("SEO_OPS: endpoint phải bắt đầu bằng http(s)://");
    store.setSetting("seoOpsBaseUrl", url);
  }

  function authClient() {
    return createHttpSeoOpsAuthClient({ baseUrl: config().baseUrl, tokenStore });
  }

  function syncClient() {
    return createHttpScriptSyncClient({
      baseUrl: config().baseUrl,
      getToken: () => tokenStore.getToken(),
    });
  }

  function loadMeta(): SyncMeta {
    try {
      return JSON.parse(store.setting("seoOpsSyncMeta") || '{"rows":{}}') as SyncMeta;
    } catch {
      return { rows: {} };
    }
  }

  function saveMeta(meta: SyncMeta) {
    store.setSetting("seoOpsSyncMeta", JSON.stringify(meta));
  }

  async function collectLocalAssets(flow: Flow, steps: Step[]): Promise<{
    assets: Array<{ path: string; sha256: string; kind: string }>;
    complete: boolean;
    missing: string[];
  }> {
    const missing: string[] = [];
    const assets: Array<{ path: string; sha256: string; kind: string }> = [];
    const seen = new Set<string>();
    for (const ref of flow.steps) {
      const step = steps.find((s) => s.id === ref.id && s.version === ref.version);
      const asset = step?.payload.target?.asset;
      if (!asset || seen.has(asset)) continue;
      seen.add(asset);
      const file = path.join(assetDir, asset);
      try {
        await access(file);
        const buf = await readFile(file);
        assets.push({
          path: asset,
          sha256: createHash("sha256").update(buf).digest("hex"),
          kind: "roi",
        });
      } catch {
        missing.push(asset);
      }
    }
    return { assets, complete: missing.length === 0, missing };
  }

  async function localRow(flow: Flow, version = "1.0.0"): Promise<LocalScriptRow & { name: string; incomplete: boolean }> {
    const steps = flow.steps.map((ref) => store.step(ref.id, ref.version));
    const { assets, complete } = await collectLocalAssets(flow, steps);
    const body = assertScriptPublishBody(
      buildScriptPublishBody({ flow, steps, version, assets }),
    );
    const content_digest = computeScriptContentDigest(body);
    const lineageRaw = store.setting(`seoOpsLineage:${flow.id}`);
    const lineage = lineageRaw ? (JSON.parse(lineageRaw) as string[]) : [];
    return {
      script_id: flow.id,
      package_key: body.package_key,
      version: body.version,
      content_digest,
      execution_digest: computeExecutionDigest(body.manifest),
      lineage,
      assets_complete: complete,
      publish_body: body,
      name: flow.name,
      incomplete: !complete,
    };
  }

  async function buildLocalCatalog(): Promise<Array<LocalScriptRow & { name: string; incomplete: boolean; flow_id: string }>> {
    const out = [];
    for (const flow of store.flows()) {
      const version = store.setting(`seoOpsVersion:${flow.id}`) || "1.0.0";
      const row = await localRow(flow, version);
      out.push({ ...row, flow_id: flow.id });
    }
    return out;
  }

  async function sessionState(): Promise<{
    configured: boolean;
    baseUrl: string;
    authenticated: boolean;
    user?: RpaAdminUser;
    error?: string;
  }> {
    const { baseUrl } = config();
    if (!tokenStore.getToken()) {
      return { configured: true, baseUrl, authenticated: false };
    }
    const result = await authClient().session();
    if (!result.ok) {
      return {
        configured: true,
        baseUrl,
        authenticated: false,
        error: result.errors.join(", "),
      };
    }
    if (!assertRpaAdminRole(result.user.role)) {
      tokenStore.setToken(null);
      return {
        configured: true,
        baseUrl,
        authenticated: false,
        error: "role_staff_forbidden",
      };
    }
    return { configured: true, baseUrl, authenticated: true, user: result.user };
  }

  async function login(email: string, password: string) {
    const result = await authClient().login(email, password, "rpa-admin-v2");
    if (!result.ok) return result;
    if (!assertRpaAdminRole(result.user.role)) {
      tokenStore.setToken(null);
      return { ok: false as const, errors: ["role_staff_forbidden"] };
    }
    return result;
  }

  async function logout() {
    return authClient().logout();
  }

  async function refreshStatusRows(): Promise<ScriptSyncRow[]> {
    const meta = loadMeta();
    const local = await buildLocalCatalog();
    let remote: LocalScriptRow[] = [];
    let plan: SyncPlan | null = null;
    let error: string | undefined;
    if (tokenStore.getToken()) {
      try {
        remote = await syncClient().catalog();
        plan = await syncClient().plan(local);
      } catch (e) {
        error = String((e as Error).message || e);
        plan = planScriptSync(local, remote);
      }
    } else {
      plan = planScriptSync(local, []);
    }

    const conflictIds = new Set(plan.conflicts.map((c) => c.script_id));
    const pushIds = new Set(plan.push_to_remote.map((r) => r.script_id));
    const pullIds = new Set(plan.pull_to_local.map((r) => r.script_id));
    const skipIds = new Set(plan.skip.map((s) => s.script_id));
    const localBy = Object.fromEntries(local.map((r) => [r.script_id, r]));
    const remoteBy = Object.fromEntries(remote.map((r) => [r.script_id, r]));
    const ids = [...new Set([...Object.keys(localBy), ...Object.keys(remoteBy)])].sort();

    const rows: ScriptSyncRow[] = ids.map((id) => {
      const l = localBy[id];
      const r = remoteBy[id];
      const status = statusFromPlanSides({
        hasLocal: !!l,
        hasRemote: !!r,
        sameDigest: skipIds.has(id),
        conflict: conflictIds.has(id),
        localAhead: pushIds.has(id) && !!r,
        remoteAhead: pullIds.has(id) && !!l,
        incomplete: Boolean(l?.incomplete || (r && r.assets_complete === false)),
        error: error && (l || r) ? error : undefined,
      });
      const prev = meta.rows[id];
      return {
        script_id: id,
        flow_id: l?.flow_id,
        package_key: l?.package_key || r?.package_key || id,
        name: l?.name || r?.package_key || id,
        local_version: l?.version,
        remote_version: r?.version,
        local_digest: l?.content_digest,
        remote_digest: r?.content_digest,
        status,
        last_sync_at: prev?.last_sync_at,
        last_result: prev?.last_result,
        message: error,
        incomplete: Boolean(l?.incomplete),
      };
    });

    meta.rows = Object.fromEntries(rows.map((r) => [r.script_id, r]));
    saveMeta(meta);
    return rows;
  }

  async function materializeImport(release: Record<string, unknown>): Promise<{
    flowId: string;
    incomplete: boolean;
    ready_to_execute: boolean;
  }> {
    const imported = importScriptRelease(release);
    if (!imported.flowPayload) {
      return { flowId: imported.script_id, incomplete: true, ready_to_execute: false };
    }
    const payload = imported.flowPayload;
    const scriptId = String(payload.id);
    const existing = store.flows().find((f) => f.id === scriptId);
    let flow: Flow = existing ?? {
      id: scriptId,
      name: String(payload.name || scriptId),
      zoom: 1,
      steps: [],
      groups: [],
      variables: [],
      defaultPattern: { values: {} },
    };
    flow.name = String(payload.name || flow.name);
    const vars = Array.isArray(payload.variables) ? payload.variables : [];
    flow.variables = vars.map((v, i) => {
      const row = v as Record<string, unknown>;
      return {
        id: String(row.id ?? `var-${i}-${row.key}`),
        key: String(row.key ?? `var_${i}`),
        type: (String(row.type ?? "text") as Variable["type"]),
        ...(row.description ? { description: String(row.description) } : {}),
      };
    });

    // Persist ROI assets when bytes were not transferred — mark incomplete if files missing.
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const missing: string[] = [];
    for (const asset of assets) {
      const a = asset as Record<string, unknown>;
      const rel = String(a.path ?? "");
      if (!rel) continue;
      try {
        await access(path.join(assetDir, rel));
      } catch {
        missing.push(rel);
      }
    }

    const stepRows = Array.isArray(payload.steps) ? payload.steps : [];
    const stepRefs: Flow["steps"] = [];
    store.saveFlow(flow);
    store.setSetting("currentFlow", flow.id);

    for (const raw of stepRows) {
      const s = raw as Record<string, unknown>;
      const actionRaw = String(s.action ?? "SLEEP");
      const action = (
        [
          "CLICK_TARGET",
          "CLICK_AND_TYPE",
          "UPLOAD_FILE",
          "QUICK_TAG",
          "TYPE_ONLY",
          "WAIT_VERIFY",
          "SCROLL",
          "SLEEP",
        ].includes(actionRaw)
          ? actionRaw
          : "SLEEP"
      ) as Step["payload"]["action"];
      const variableKey = s.variable_key ? String(s.variable_key) : undefined;
      const variableId = variableKey
        ? flow.variables?.find((v) => v.key === variableKey)?.id
        : undefined;
      const targetRaw = s.target && typeof s.target === "object"
        ? (s.target as Record<string, unknown>)
        : undefined;
      const assetName = targetRaw ? String(targetRaw.asset ?? "") : "";
      const assetMissing = assetName !== "" && missing.includes(assetName);
      const roi = targetRaw?.roi && typeof targetRaw.roi === "object"
        ? (targetRaw.roi as { x: number; y: number; width: number; height: number })
        : undefined;

      let payloadStep: Step["payload"];
      if (assetMissing || !targetRaw || !roi) {
        payloadStep = { action: "SLEEP", timeoutMs: 100 };
      } else {
        payloadStep = {
          action,
          ...(variableId ? { variableId } : {}),
          target: {
            asset: assetName,
            roi,
            matchTo: targetRaw.matchTo as "none" | "current" | "top" | "middle" | "bottom" | undefined,
            environment: targetRaw.environment as { width: number; height: number; zoom: number } | undefined,
          },
        };
      }

      const stepId = String(s.id ?? cryptoRandom());
      const version = Number(s.version ?? 1) || 1;
      const step: Step = {
        id: stepId,
        version,
        name: String(s.name ?? action),
        payload: payloadStep,
        createdAt: new Date().toISOString(),
      };
      store.db.prepare("DELETE FROM steps WHERE id=? AND version=?").run(step.id, step.version);
      store.db.prepare("INSERT INTO steps VALUES(?,?,?)").run(step.id, step.version, JSON.stringify(step));
      stepRefs.push({ id: step.id, version: step.version });
    }

    flow = store.flows().find((f) => f.id === scriptId)!;
    flow.steps = stepRefs;
    store.saveFlow(flow);
    store.setSetting(`seoOpsVersion:${flow.id}`, imported.version);
    const digest = String(release.content_digest ?? "");
    if (digest) {
      const lineage = JSON.parse(store.setting(`seoOpsLineage:${flow.id}`) || "[]") as string[];
      if (!lineage.includes(digest)) {
        lineage.push(digest);
        store.setSetting(`seoOpsLineage:${flow.id}`, JSON.stringify(lineage.slice(-20)));
      }
    }

    const incomplete = missing.length > 0 || imported.incomplete;
    return {
      flowId: flow.id,
      incomplete,
      ready_to_execute: !incomplete && imported.ready_to_execute,
    };
  }

  function cryptoRandom(): string {
    return createHash("sha1").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 32);
  }

  async function syncAll(options?: { flowId?: string; version?: string }) {
    if (!tokenStore.getToken()) throw new Error("SEO_OPS: cần đăng nhập trước khi sync");
    const localAll = await buildLocalCatalog();
    const local = options?.flowId
      ? localAll.filter((r) => r.flow_id === options.flowId)
      : localAll;
    if (options?.flowId && options.version) {
      for (const row of local) {
        store.setSetting(`seoOpsVersion:${row.flow_id}`, options.version);
      }
    }
    const refreshedLocal = options?.flowId
      ? await buildLocalCatalog().then((rows) => rows.filter((r) => r.flow_id === options.flowId))
      : await buildLocalCatalog();

    const client = syncClient();
    const plan = await client.plan(refreshedLocal);
    const now = new Date().toISOString();
    const meta = loadMeta();
    const results: Array<{ script_id: string; action: string; ok: boolean; message?: string }> = [];

    for (const row of plan.push_to_remote) {
      const full = refreshedLocal.find((r) => r.script_id === row.script_id);
      if (!full?.publish_body) {
        results.push({ script_id: row.script_id, action: "push", ok: false, message: "missing publish body" });
        continue;
      }
      if (full.incomplete) {
        results.push({
          script_id: row.script_id,
          action: "push",
          ok: false,
          message: "incomplete assets — không tuyên bố sync thành công",
        });
        meta.rows[row.script_id] = {
          ...(meta.rows[row.script_id] ?? {
            script_id: row.script_id,
            package_key: row.package_key,
            name: full.name,
            status: "incomplete_assets" as SyncStatusCode,
          }),
          status: "incomplete_assets",
          last_sync_at: now,
          last_result: "incomplete_assets",
          message: "Thiếu ROI asset trên đĩa local",
        };
        continue;
      }
      const published = await client.publish(full.publish_body);
      const ok = published.httpStatus < 300 && (published as { ok?: boolean }).ok !== false;
      results.push({
        script_id: row.script_id,
        action: "push",
        ok,
        message: ok ? "pushed" : JSON.stringify((published as { errors?: string[] }).errors ?? published),
      });
      if (ok) {
        const lineage = JSON.parse(store.setting(`seoOpsLineage:${full.flow_id}`) || "[]") as string[];
        lineage.push(full.content_digest);
        store.setSetting(`seoOpsLineage:${full.flow_id}`, JSON.stringify(lineage.slice(-20)));
      }
    }

    for (const row of plan.pull_to_local) {
      const pulled = await client.pull(row.package_key, row.version);
      if (!pulled.ok || !pulled.release) {
        results.push({
          script_id: row.script_id,
          action: "pull",
          ok: false,
          message: (pulled.errors || []).join(","),
        });
        continue;
      }
      const materialized = await materializeImport(pulled.release);
      results.push({
        script_id: row.script_id,
        action: "pull",
        ok: !materialized.incomplete,
        message: materialized.incomplete
          ? "imported incomplete (missing ROI assets)"
          : "imported",
      });
    }

    for (const skip of plan.skip) {
      results.push({ script_id: skip.script_id, action: "skip", ok: true, message: skip.reason });
    }
    for (const conflict of plan.conflicts) {
      results.push({
        script_id: conflict.script_id,
        action: "conflict",
        ok: false,
        message: "divergent_edits — không overwrite",
      });
    }

    meta.last_sync_at = now;
    meta.last_result = results.every((r) => r.ok || r.action === "conflict" || r.action === "skip")
      ? "ok"
      : "partial";
    saveMeta(meta);
    const rows = await refreshStatusRows();
    return { plan, results, rows, label: labelForStatus };
  }

  return {
    config,
    setConfig,
    sessionState,
    login,
    logout,
    refreshStatusRows,
    syncAll,
    loadMeta,
  };
}

export type SeoOpsSyncService = ReturnType<typeof createSeoOpsSyncService>;
