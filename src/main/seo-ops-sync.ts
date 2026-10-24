import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Flow, Step } from "../shared/contracts.js";
import {
  buildScriptCatalogSnapshot,
  type ScriptVideoDemo,
} from "../shared/script-release.js";
import { materializeScriptRelease } from "../shared/script-materialize.js";
import {
  createHttpSeoOpsAuthClient,
  assertRpaAdminRole,
  mapSeoOpsAuthErrors,
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
  statusFromPlanSides,
  type ScriptSyncRow,
  type SyncStatusCode,
} from "../shared/sync-status.js";
import {
  toScriptVideoDemo,
  type VideoDemoAttachment,
} from "../shared/video-demo.js";
import {
  assertDemoBelongsToScript,
  assertExecutionDigestMatches,
  hasMissingDemoReason,
  MISSING_DEMO_REASON,
} from "../shared/video-demo-policy.js";
import { validatePayload, type Store } from "./storage.js";
import { createAdminBackup } from "./admin-backup.js";

export type SeoOpsConfig = {
  baseUrl: string;
};

type SyncMeta = {
  rows: Record<string, ScriptSyncRow>;
  last_sync_at?: string;
  last_result?: string;
};

type LocalCatalogRow = LocalScriptRow & {
  name: string;
  incomplete: boolean;
  incomplete_reasons: string[];
  flow_id: string;
  video_attachment?: VideoDemoAttachment;
  demo_status?: ScriptSyncRow["demo_status"];
};

function toPlanRow(row: LocalScriptRow): LocalScriptRow {
  return {
    script_id: row.script_id,
    package_key: row.package_key,
    version: row.version,
    content_digest: row.content_digest,
    execution_digest: row.execution_digest,
    lineage: row.lineage,
    assets_complete: row.assets_complete,
  };
}

export function createSeoOpsSyncService(options: {
  store: Store;
  assetDir: string;
  tokenStore: TokenStore;
  /** Root of Test Lab evidence (`…/test-runs`). */
  testRunsDir?: string;
  dataPath?: string;
}) {
  const { store, assetDir, tokenStore } = options;
  const testRunsDir = options.testRunsDir;
  const dataPath = options.dataPath;
  const installationId = store.setting("seoOpsInstallationId") || randomUUID();
  if (!store.setting("seoOpsInstallationId")) store.setSetting("seoOpsInstallationId", installationId);

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

  async function adminApi(pathname: string, init?: RequestInit) {
    const token = tokenStore.getToken();
    if (!token) throw new Error("SEO_OPS: cần đăng nhập trước khi backup");
    const response = await fetch(`${config().baseUrl}/api/v1/social-automation/rpa-admin${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw new Error(`SEO_OPS_BACKUP: ${JSON.stringify(body.errors ?? response.status)}`);
    return body;
  }

  async function backupNow() {
    if (!dataPath) throw new Error("SEO_OPS_BACKUP: data path unavailable");
    const revision = Number(store.setting("seoOpsDraftRevisionIssued") || store.setting("seoOpsDraftRevision") || "0") + 1;
    store.setSetting("seoOpsDraftRevisionIssued", String(revision));
    const bundle = await createAdminBackup(store, dataPath, installationId, revision);
    const result = await adminApi("/backup", { method: "POST", body: JSON.stringify({ installation_id: installationId,
      draft_revision: revision, sha256: bundle.sha256, archive_base64: bundle.archive.toString("base64"), summary: bundle.manifest.counts }) });
    store.setSetting("seoOpsDraftRevision", String(revision));
    store.setSetting("seoOpsBackupStatus", JSON.stringify({ status: "backed_up", at: new Date().toISOString(), revision }));
    return result;
  }

  async function backupInfo() { return adminApi("/backup"); }
  async function downloadBackup() {
    const body = await adminApi("/backup/download", { method: "POST", body: JSON.stringify({}) });
    return { archive: Buffer.from(String(body.archive_base64), "base64"), sha256: String(body.sha256), backup: body.backup };
  }
  async function fetchReports() {
    const after = Number(store.setting("seoOpsReportsAfterId") || "0");
    const body = await adminApi(`/execution-reports?after_id=${after}`);
    store.setSetting("seoOpsReportsAfterId", String(body.next_after_id ?? after));
    store.setSetting("seoOpsExecutionReports", JSON.stringify(body.reports ?? []));
    return body.reports as unknown[];
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

  async function resolveVideoDemo(
    flow: Flow,
    version: string,
    executionDigest: string,
  ): Promise<{ demo?: ScriptVideoDemo; attachment?: VideoDemoAttachment; errors: string[] }> {
    const errors: string[] = [];
    const raw = store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`);
    if (!raw) return { errors: [MISSING_DEMO_REASON] };
    let attachment: VideoDemoAttachment;
    try {
      attachment = JSON.parse(raw) as VideoDemoAttachment;
    } catch {
      return { errors: [MISSING_DEMO_REASON] };
    }
    try {
      assertDemoBelongsToScript(attachment, flow.id);
      assertExecutionDigestMatches(attachment, executionDigest);
    } catch (e) {
      return { errors: [String((e as Error).message || e)] };
    }
    if (!testRunsDir) {
      errors.push("VIDEO_DEMO: test-runs directory unavailable");
      return { errors };
    }
    const videoAbs = path.join(testRunsDir, attachment.artifactRef);
    try {
      await access(videoAbs);
      const buf = await readFile(videoAbs);
      if (!buf.length) return { errors: ["VIDEO_DEMO: video file empty"] };
      if (!attachment.sha256) {
        attachment.sha256 = createHash("sha256").update(buf).digest("hex");
      }
    } catch {
      return { errors: ["VIDEO_DEMO: video file missing or unreadable"] };
    }
    if (attachment.thumbnailRef) {
      try {
        const thumb = await readFile(path.join(testRunsDir, attachment.thumbnailRef));
        if (!thumb.length) return { errors: ["VIDEO_DEMO: thumbnail empty"] };
      } catch {
        return { errors: ["VIDEO_DEMO: thumbnail missing"] };
      }
    } else {
      return { errors: ["VIDEO_DEMO: thumbnail required"] };
    }
    if (!attachment.reviewed) {
      return { errors: ["VIDEO_DEMO: demo must be reviewed via Use as Script Demo"] };
    }
    try {
      const demo = toScriptVideoDemo({ ...attachment, scriptVersion: version });
      return { demo, attachment, errors: [] };
    } catch (e) {
      return { errors: [String((e as Error).message || e)] };
    }
  }

  async function localRow(flow: Flow, version = "1.0.0"): Promise<LocalCatalogRow> {
    const steps = flow.steps
      .map((ref) => {
        try {
          return store.step(ref.id, ref.version);
        } catch {
          return undefined;
        }
      })
      .filter((s): s is Step => Boolean(s));
    const { assets, complete, missing } = await collectLocalAssets(flow, steps);
    // Probe execution digest first (video metadata must not affect it).
    const probe = buildScriptCatalogSnapshot({ flow, steps, version, assets });
    const hasStoredDemo = Boolean(store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`));
    const resolved = await resolveVideoDemo(flow, version, probe.execution_digest);
    const snap = buildScriptCatalogSnapshot({
      flow,
      steps,
      version,
      assets,
      videoDemo: resolved.demo,
    });
    const reasons = [...snap.incomplete_reasons];
    if (
      store
        .invalidSteps()
        .some(
          (r) =>
            r.flowId === flow.id &&
            flow.steps.some((ref) => ref.id === r.stepId && ref.version === r.version),
        )
    ) {
      reasons.push("invalid_variable_ref");
    }
    if (!complete) {
      reasons.push(...missing.map((m) => `missing_asset:${m}`));
    }
    for (const e of resolved.errors) {
      if (!reasons.includes(e)) reasons.push(e.startsWith("VIDEO_DEMO") ? e : e);
      if (e === MISSING_DEMO_REASON || e.startsWith("VIDEO_DEMO")) {
        if (!reasons.includes(MISSING_DEMO_REASON)) reasons.push(MISSING_DEMO_REASON);
      }
    }
    const incomplete = reasons.length > 0 || snap.incomplete || !complete || !snap.publish_body;
    const lineageRaw = store.setting(`seoOpsLineage:${flow.id}`);
    const lineage = lineageRaw ? (JSON.parse(lineageRaw) as string[]) : [];
    return {
      script_id: flow.id,
      flow_id: flow.id,
      package_key: snap.package_key,
      version: snap.version,
      content_digest: snap.content_digest,
      execution_digest: snap.execution_digest,
      lineage,
      assets_complete: complete && !incomplete,
      publish_body: incomplete ? undefined : snap.publish_body ?? undefined,
      name: flow.name,
      incomplete,
      incomplete_reasons: [...new Set(reasons)],
      video_attachment: resolved.attachment,
      demo_status: resolved.demo ? "ready" : hasStoredDemo ? (resolved.errors.some(error => /execution changed/i.test(error)) ? "outdated" : "error") : "missing",
    };
  }

  async function buildLocalCatalog(): Promise<LocalCatalogRow[]> {
    const out: LocalCatalogRow[] = [];
    for (const flow of store.flows()) {
      try {
        const version = store.setting(`seoOpsVersion:${flow.id}`) || "1.0.0";
        out.push(await localRow(flow, version));
      } catch (e) {
        // Never let one broken Scenario crash the whole catalog.
        out.push({
          script_id: flow.id,
          flow_id: flow.id,
          package_key: flow.id,
          version: "0.0.0",
          content_digest: "0".repeat(64),
          lineage: [],
          assets_complete: false,
          name: flow.name,
          incomplete: true,
          incomplete_reasons: [String((e as Error).message || e)],
        });
      }
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
        error: mapSeoOpsAuthErrors(result.errors),
      };
    }
    if (!assertRpaAdminRole(result.user.role)) {
      tokenStore.setToken(null);
      return {
        configured: true,
        baseUrl,
        authenticated: false,
        error: mapSeoOpsAuthErrors(["role_staff_forbidden"]),
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

  async function refreshStatusRows(options?: { offlinePending?: boolean }): Promise<ScriptSyncRow[]> {
    const meta = loadMeta();
    const local = await buildLocalCatalog();
    let remote: LocalScriptRow[] = [];
    let plan: SyncPlan | null = null;
    let error: string | undefined;
    // Plan/catalog use publishable rows only so incomplete Scripts never hit publish validation.
    const planLocal = local.filter((r) => !r.incomplete && r.publish_body);
    if (tokenStore.getToken()) {
      try {
        remote = await syncClient().catalog();
        plan = await syncClient().plan(planLocal.map(toPlanRow));
      } catch (e) {
        error = String((e as Error).message || e);
        plan = planScriptSync(planLocal, remote);
      }
    } else {
      plan = planScriptSync(planLocal, []);
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
      const missingDemo = Boolean(l && hasMissingDemoReason(l.incomplete_reasons || []));
      const incomplete = Boolean(l?.incomplete || (r && r.assets_complete === false));
      const status = statusFromPlanSides({
        hasLocal: !!l,
        hasRemote: !!r,
        sameDigest: skipIds.has(id),
        conflict: conflictIds.has(id),
        localAhead: pushIds.has(id) && !!r,
        remoteAhead: pullIds.has(id) && !!l,
        incomplete: incomplete && !missingDemo,
        missingDemo,
        error: error && (l || r) && !incomplete ? error : undefined,
        offlinePending: Boolean(options?.offlinePending && l && !incomplete && !skipIds.has(id)),
      });
      const prev = meta.rows[id];
      const message = missingDemo
        ? "Missing demo — mở Test Lab, Run, rồi Use as Script Demo"
        : incomplete
          ? (l?.incomplete_reasons || []).slice(0, 3).join(", ") || "incomplete"
          : error && (l || r)
            ? error
            : prev?.message;
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
        message,
        incomplete,
        demo_status: l?.demo_status,
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
    reason?: string;
  }> {
    const imported = importScriptRelease(release);
    if (!imported.flowPayload) {
      const reason = imported.incomplete_reasons.includes("invalid_payload")
        ? "invalid_payload"
        : imported.incomplete_reasons[0] || "incomplete";
      return {
        flowId: imported.script_id,
        incomplete: true,
        ready_to_execute: false,
        reason,
      };
    }
    const payload = imported.flowPayload;
    const scriptId = String(payload.id);

    // Validate assets on disk before any local mutation.
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
    if (missing.length) {
      return {
        flowId: scriptId,
        incomplete: true,
        ready_to_execute: false,
        reason: "incomplete_assets",
      };
    }

    const existing = store.flows().find((f) => f.id === scriptId) ?? null;
    const existingSteps = store
      .steps()
      .filter((s) => (existing?.steps ?? []).some((ref) => ref.id === s.id) ||
        // Also load any prior versions of packaged step ids for conflict checks.
        (Array.isArray(payload.steps) &&
          payload.steps.some(
            (raw) =>
              raw &&
              typeof raw === "object" &&
              String((raw as { id?: unknown }).id ?? "") === s.id,
          )));

    const materialized = materializeScriptRelease({
      release: {
        ...release,
        name: payload.name,
        manifest: {
          ...((release.manifest as object) ?? {}),
          script_id: scriptId,
          variables: payload.variables,
          steps: payload.steps,
          default_pattern: payload.default_pattern,
          groups: payload.groups,
          zoom: payload.zoom,
        },
      },
      existing,
      existingSteps,
      validatePayload,
    });
    if (!materialized.ok) {
      return {
        flowId: scriptId,
        incomplete: true,
        ready_to_execute: false,
        reason: materialized.reason,
      };
    }

    store.db.exec("BEGIN");
    try {
      // Never DELETE/overwrite an existing step@version — only insert missing ones.
      for (const step of materialized.inserts) {
        store.db
          .prepare("INSERT INTO steps VALUES(?,?,?)")
          .run(step.id, step.version, JSON.stringify(step));
      }
      const flow: Flow = materialized.flow;
      store.saveFlow(flow);
      store.setSetting("currentFlow", flow.id);
      store.setSetting(`seoOpsVersion:${flow.id}`, imported.version);
      const digest = String(release.content_digest ?? "");
      if (digest) {
        const lineage = JSON.parse(store.setting(`seoOpsLineage:${flow.id}`) || "[]") as string[];
        if (!lineage.includes(digest)) {
          lineage.push(digest);
          store.setSetting(`seoOpsLineage:${flow.id}`, JSON.stringify(lineage.slice(-20)));
        }
      }
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
    store.reindexInvalidSteps();

    return {
      flowId: materialized.flow.id,
      incomplete: false,
      ready_to_execute: true,
    };
  }

  async function syncAll(options?: { flowId?: string; version?: string }) {
    if (!tokenStore.getToken()) throw new Error("SEO_OPS: cần đăng nhập trước khi sync");
    let backupError: string | undefined;
    try { await backupNow(); } catch (error) { backupError = String((error as Error).message || error); }
    const client = syncClient();
    const remote = await client.catalog();
    const remoteById = new Map(remote.map(row => [row.script_id, row]));
    const selectedFlows = options?.flowId ? store.flows().filter(flow => flow.id === options.flowId) : store.flows();
    const refreshedLocal: LocalCatalogRow[] = [];
    for (const flow of selectedFlows) {
      const server = remoteById.get(flow.id);
      const currentVersion = server?.version ?? store.setting(`seoOpsVersion:${flow.id}`) ?? "1";
      const current = await localRow(flow, currentVersion);
      if (!server || current.content_digest !== server.content_digest) {
        const parsed = Number.parseInt(server?.version ?? "0", 10);
        const nextVersion = String(Number.isSafeInteger(parsed) && parsed >= 0 ? parsed + 1 : 1);
        refreshedLocal.push(await localRow(flow, nextVersion));
      } else {
        refreshedLocal.push(current);
      }
    }
    const now = new Date().toISOString();
    const meta = loadMeta();
    const results: Array<{ script_id: string; action: string; ok: boolean; message?: string }> = [];
    if (backupError) results.push({ script_id: "admin-backup", action: "backup", ok: false, message: backupError });

    // Incomplete Scripts are skipped individually — never block others / never publish.
    const publishable = refreshedLocal.filter((r) => !r.incomplete && r.publish_body);
    for (const row of refreshedLocal.filter((r) => r.incomplete)) {
      const missingDemo = hasMissingDemoReason(row.incomplete_reasons || []);
      // Missing-demo Scripts are skipped once — never thrown as sync errors (no auto-retry storm).
      results.push({
        script_id: row.script_id,
        action: "skip",
        ok: true,
        message: missingDemo
          ? "missing_demo — open Test Lab to create demo"
          : (row.incomplete_reasons || ["incomplete"]).join(", "),
      });
      meta.rows[row.script_id] = {
        ...(meta.rows[row.script_id] ?? {
          script_id: row.script_id,
          package_key: row.package_key,
          name: row.name,
          status: (missingDemo ? "missing_demo" : "incomplete_assets") as SyncStatusCode,
        }),
        status: missingDemo ? "missing_demo" : "incomplete_assets",
        last_sync_at: now,
        last_result: missingDemo ? "missing_demo" : "incomplete",
        message: missingDemo
          ? "Missing demo — mở Test Lab, Run, rồi Use as Script Demo"
          : (row.incomplete_reasons || []).slice(0, 3).join(", "),
        incomplete: true,
      };
    }

    const plan: SyncPlan = { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] };
    for (const row of publishable) {
      const server = remoteById.get(row.script_id);
      if (server && server.content_digest === row.content_digest && server.demo_status === "ready") {
        plan.skip.push({ script_id: row.script_id, reason: "same_digest" });
      } else {
        plan.push_to_remote.push(toPlanRow(row));
      }
    }

    for (const row of plan.push_to_remote) {
      try {
        const full = publishable.find((r) => r.script_id === row.script_id);
        if (!full?.publish_body) {
          results.push({ script_id: row.script_id, action: "skip", ok: true, message: "incomplete — no publish body" });
          continue;
        }
        const published = await client.publish(full.publish_body);
        let ok = published.httpStatus < 300 && (published as { ok?: boolean }).ok !== false;
        let message = ok ? "pushed" : JSON.stringify((published as { errors?: string[] }).errors ?? published);
        if (ok) {
          for (const asset of full.publish_body.manifest.assets) {
            const uploaded = await client.uploadAsset({ packageKey: full.package_key, version: full.version,
              assetPath: asset.path, sha256: asset.sha256, binary: await readFile(path.join(assetDir, asset.path)) });
            if (!uploaded.ok) { ok = false; message = `release asset upload failed: ${(uploaded.errors ?? []).join(",")}`; break; }
          }
        }
        if (ok && full.video_attachment && testRunsDir) {
          try {
            const binary = await readFile(path.join(testRunsDir, full.video_attachment.artifactRef));
            const uploaded = await client.uploadVideoDemo({
              packageKey: full.package_key,
              version: full.version,
              binary,
              mime: "video/webm",
              sha256: full.video_attachment.sha256,
            });
            if (!uploaded.ok) {
              ok = false;
              message = `pushed metadata but video upload failed: ${(uploaded.errors || []).join(",")}`;
            } else {
              message = "pushed+video";
            }
          } catch (e) {
            ok = false;
            message = `pushed metadata but video unreadable: ${String((e as Error).message || e)}`;
          }
        }
        results.push({
          script_id: row.script_id,
          action: "push",
          ok,
          message,
        });
        if (ok) {
          store.setSetting(`seoOpsVersion:${full.flow_id}`, full.version);
          const lineage = JSON.parse(store.setting(`seoOpsLineage:${full.flow_id}`) || "[]") as string[];
          lineage.push(full.content_digest);
          store.setSetting(`seoOpsLineage:${full.flow_id}`, JSON.stringify(lineage.slice(-20)));
        }
      } catch (e) {
        results.push({
          script_id: row.script_id,
          action: "push",
          ok: false,
          message: String((e as Error).message || e),
        });
        meta.rows[row.script_id] = {
          ...(meta.rows[row.script_id] ?? {
            script_id: row.script_id,
            package_key: row.package_key,
            name: row.package_key,
            status: "sync_error",
          }),
          status: "sync_error",
          last_sync_at: now,
          last_result: "push_error",
          message: String((e as Error).message || e),
        };
      }
    }

    for (const row of plan.pull_to_local) {
      try {
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
        const invalid = materialized.reason === "invalid_payload";
        const conflict = materialized.reason === "version_conflict";
        const message = !materialized.incomplete
          ? "imported"
          : invalid
            ? "invalid_payload — remote release thiếu OCR/Match To; chờ publish lại từ RPA Admin"
            : conflict
              ? "version_conflict — local step version differs; refuse overwrite"
              : materialized.reason === "incomplete_assets"
              ? "incomplete_assets — missing ROI files; local steps not overwritten"
              : materialized.reason === "missing_variable_id"
                ? "missing_variable_id — remote release thiếu Variable id; chờ republish"
              : `incomplete — ${materialized.reason || "rejected"}`;
        results.push({
          script_id: row.script_id,
          action: "pull",
          ok: !materialized.incomplete,
          message,
        });
        if (materialized.incomplete) {
          meta.rows[row.script_id] = {
            ...(meta.rows[row.script_id] ?? {
              script_id: row.script_id,
              package_key: row.package_key,
              name: row.package_key,
              status: invalid ? "sync_error" : "incomplete_assets",
            }),
            status: invalid ? "sync_error" : "incomplete_assets",
            last_sync_at: now,
            last_result: materialized.reason || "incomplete",
            message,
            incomplete: true,
          };
        }
      } catch (e) {
        results.push({
          script_id: row.script_id,
          action: "pull",
          ok: false,
          message: String((e as Error).message || e),
        });
        meta.rows[row.script_id] = {
          ...(meta.rows[row.script_id] ?? {
            script_id: row.script_id,
            package_key: row.package_key,
            name: row.package_key,
            status: "sync_error",
          }),
          status: "sync_error",
          last_sync_at: now,
          last_result: "pull_error",
          message: String((e as Error).message || e),
        };
      }
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
    const reports = await fetchReports();
    const rows = await refreshStatusRows();
    return { plan, results, rows, summary: {
      backed_up: backupError ? 0 : refreshedLocal.length,
      published: results.filter(r => r.action === "push" && r.ok).length,
      unchanged: results.filter(r => r.action === "skip").length,
      blocked: refreshedLocal.filter(r => r.incomplete).length,
      failed: results.filter(r => !r.ok).length,
      reports: reports.length,
    } };
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
    backupNow,
    backupInfo,
    downloadBackup,
  };
}

export type SeoOpsSyncService = ReturnType<typeof createSeoOpsSyncService>;
