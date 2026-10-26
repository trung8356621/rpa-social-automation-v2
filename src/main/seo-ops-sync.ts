import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Flow, Step, ActionTag, ScriptRequest } from "../shared/contracts.js";
import { slugify } from "../shared/flow-model.js";
import {
  buildScriptCatalogSnapshot,
  type ScriptVideoDemo,
} from "../shared/script-release.js";
import { materializeScriptRelease } from "../shared/script-materialize.js";
import {
  createHttpSeoOpsAuthClient,
  assertRpaAdminRole,
  mapSeoOpsAuthError,
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
  publishBlockerMessage,
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
import { readSeoOpsJson } from "../shared/seo-ops-http.js";
import { isLegacyPublishedScriptVersion, parsePublishedScriptVersion } from "../shared/script-version.js";
import { resolveScriptReleaseState, type StoredScriptRelease } from "../shared/script-release-state.js";

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
  demo_reason?: string;
  published_version?: string;
  draft_status?: ScriptSyncRow["draft_status"];
  draft_version?: string;
  release_conflict?: string;
};

export async function collectScriptAssets(flow: Flow, steps: Step[], assetDir: string): Promise<{
  assets: Array<{ path: string; sha256: string; kind: string }>;
  complete: boolean;
  missing: string[];
}> {
  const missing: string[] = [], assets: Array<{ path: string; sha256: string; kind: string }> = [], seen = new Set<string>();
  for (const ref of flow.steps) {
    const asset = steps.find(step => step.id === ref.id && step.version === ref.version)?.payload.target?.asset;
    if (!asset || seen.has(asset)) continue;
    seen.add(asset);
    try {
      const buf = await readFile(path.join(assetDir, asset));
      assets.push({ path: asset, sha256: createHash("sha256").update(buf).digest("hex"), kind: "roi" });
    } catch { missing.push(asset); }
  }
  return { assets, complete: missing.length === 0, missing };
}

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
    if (!token) throw new Error("unauthenticated");
    const url = `${config().baseUrl}/api/v1/social-automation/rpa-admin${pathname}`;
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await readSeoOpsJson(response, init?.method ?? "GET", url);
    if (!response.ok || body.ok !== true) {
      const errList = Array.isArray(body.errors) ? (body.errors as string[]).join(", ") : String(body.errors ?? response.status);
      throw new Error(errList || `HTTP ${response.status}`);
    }
    return body;
  }

  let backupInFlight: Promise<Record<string, unknown>> | null = null;
  let backupInfoInFlight: Promise<Record<string, unknown>> | null = null;
  let backupGeneration = 0;
  let backedUpGeneration = -1;
  let lastBackupResult: Record<string, unknown> | null = null;

  async function performBackup() {
    const generation = backupGeneration;
    if (!dataPath) throw new Error("SEO_OPS_BACKUP: data path unavailable");
    const revision = Number(store.setting("seoOpsDraftRevisionIssued") || store.setting("seoOpsDraftRevision") || "0") + 1;
    store.setSetting("seoOpsDraftRevisionIssued", String(revision));
    const bundle = await createAdminBackup(store, dataPath, installationId, revision);
    const result = await adminApi("/backup", { method: "POST", body: JSON.stringify({ installation_id: installationId,
      draft_revision: revision, sha256: bundle.sha256, archive_base64: bundle.archive.toString("base64"), summary: bundle.manifest.counts }) });
    store.setSetting("seoOpsDraftRevision", String(revision));
    store.setSetting("seoOpsBackupStatus", JSON.stringify({ status: "backed_up", at: new Date().toISOString(), revision }));
    backedUpGeneration = generation;
    lastBackupResult = result;
    return result;
  }

  async function backupNow() {
    if (backedUpGeneration === backupGeneration && lastBackupResult) return lastBackupResult;
    if (backupInFlight) return backupInFlight;
    backupInFlight = performBackup().finally(() => { backupInFlight = null; });
    return backupInFlight;
  }

  function markBackupDirty() { backupGeneration += 1; }

  async function backupInfo() {
    if (backupInfoInFlight) return backupInfoInFlight;
    backupInfoInFlight = adminApi("/backup").finally(() => { backupInfoInFlight = null; });
    return backupInfoInFlight;
  }
  async function downloadBackup() {
    const body = await adminApi("/backup/download", { method: "POST", body: JSON.stringify({}) });
    return { archive: Buffer.from(String(body.archive_base64), "base64"), sha256: String(body.sha256), backup: body.backup };
  }
  async function syncActionTags(): Promise<{ ok: true; tags: ActionTag[]; count: number } | { ok: false; error: string }> {
    try {
      const token = tokenStore.getToken();
      if (!token) {
        return { ok: false, error: "Cần đăng nhập SEO-OPS tại Settings trước khi đồng bộ." };
      }
      const body = await adminApi("/action-tags");
      if (body && Array.isArray((body as { action_tags?: unknown[] }).action_tags)) {
        const tags = (body as { action_tags: ActionTag[] }).action_tags;
        store.upsertActionTags(tags);
        store.setSetting("seoOpsActionTags", JSON.stringify(tags));
        return { ok: true, tags, count: tags.length };
      }
      return { ok: false, error: "Dữ liệu trả về từ SEO-OPS không có danh sách Action Tags." };
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: mapSeoOpsAuthError(rawMsg) };
    }
  }

  async function fetchActionTags(): Promise<ActionTag[]> {
    try {
      const body = await adminApi("/action-tags");
      if (body && Array.isArray((body as { action_tags?: unknown[] }).action_tags)) {
        const tags = (body as { action_tags: ActionTag[] }).action_tags;
        store.upsertActionTags(tags);
        store.setSetting("seoOpsActionTags", JSON.stringify(tags));
        return tags;
      }
    } catch {
      /* offline / unauthenticated fallback */
    }
    return getCachedActionTags();
  }

  function getCachedActionTags(): ActionTag[] {
    try {
      const dbTags = store.actionTags();
      if (dbTags.length > 0) return dbTags;
      return JSON.parse(store.setting("seoOpsActionTags") || "[]") as ActionTag[];
    } catch {
      return [];
    }
  }

  async function fetchScriptRequests(status?: string): Promise<ScriptRequest[]> {
    try {
      const q = status ? `?status=${encodeURIComponent(status)}` : "";
      const body = await adminApi(`/script-requests${q}`);
      if (body && Array.isArray((body as { script_requests?: unknown[] }).script_requests)) {
        const requests = (body as { script_requests: ScriptRequest[] }).script_requests;
        store.setSetting("seoOpsScriptRequests", JSON.stringify(requests));
        return requests;
      }
    } catch {
      /* offline / unauthenticated fallback */
    }
    return getCachedScriptRequests();
  }

  function getCachedScriptRequests(): ScriptRequest[] {
    try {
      return JSON.parse(store.setting("seoOpsScriptRequests") || "[]") as ScriptRequest[];
    } catch {
      return [];
    }
  }

  async function createScriptFromRequest(requestId: string): Promise<Flow> {
    const requests = getCachedScriptRequests();
    const req = requests.find((r) => r.request_id === requestId);
    if (!req) {
      throw new Error(`Không tìm thấy Script Request: ${requestId}`);
    }

    const tags = getCachedActionTags();
    const tag = tags.find((t) => t.tag_key === req.action_tag_key);

    const baseName = tag?.name || req.action_tag_key.split(".").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
    const scriptId = slugify(req.action_tag_key.replace(/\./g, "-"));

    const existing = store.flows().find(f => f.id === scriptId || f.scriptRequestId === req.request_id);
    if (existing) {
      return existing;
    }

    const flow = store.newFlow(baseName, 1, {
      id: scriptId,
      actionTagKey: req.action_tag_key,
      scriptRequestId: req.request_id,
      resultType: "status",
      pathInputs: req.path_inputs,
      urlPattern: req.url_pattern,
    });

    req.status = "developing";
    req.script_id = flow.id;
    store.setSetting("seoOpsScriptRequests", JSON.stringify(requests));

    try {
      await adminApi(`/script-requests/${encodeURIComponent(requestId)}/claim`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch {
      /* offline - keep local progress */
    }

    return flow;
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

  function loadReleaseMeta(flowId: string): StoredScriptRelease {
    let pending: StoredScriptRelease = {};
    try { pending = JSON.parse(store.setting(`seoOpsPendingRelease:${flowId}`) || "{}") as StoredScriptRelease; }
    catch { pending = {}; }
    return {
      version: store.setting(`seoOpsVersion:${flowId}`) || undefined,
      contentDigest: store.setting(`seoOpsPublishedDigest:${flowId}`) || undefined,
      executionDigest: store.setting(`seoOpsPublishedExecutionDigest:${flowId}`) || undefined,
      pendingVersion: pending.pendingVersion,
      pendingContentDigest: pending.pendingContentDigest,
      pendingExecutionDigest: pending.pendingExecutionDigest,
    };
  }

  function saveRecoveredReleaseMeta(flowId: string, meta: StoredScriptRelease) {
    if (meta.version) store.setSetting(`seoOpsVersion:${flowId}`, meta.version);
    if (meta.contentDigest) store.setSetting(`seoOpsPublishedDigest:${flowId}`, meta.contentDigest);
    if (meta.executionDigest) store.setSetting(`seoOpsPublishedExecutionDigest:${flowId}`, meta.executionDigest);
  }

  function savePendingRelease(row: LocalCatalogRow) {
    store.setSetting(`seoOpsPendingRelease:${row.flow_id}`, JSON.stringify({
      pendingVersion: row.version,
      pendingContentDigest: row.content_digest,
      pendingExecutionDigest: row.execution_digest,
    } satisfies StoredScriptRelease));
  }

  function completeRelease(row: LocalCatalogRow) {
    store.setSetting(`seoOpsVersion:${row.flow_id}`, row.version);
    store.setSetting(`seoOpsPublishedDigest:${row.flow_id}`, row.content_digest);
    if (row.execution_digest) store.setSetting(`seoOpsPublishedExecutionDigest:${row.flow_id}`, row.execution_digest);
    store.setSetting(`seoOpsPendingRelease:${row.flow_id}`, "{}");
  }

  async function collectLocalAssets(flow: Flow, steps: Step[]): Promise<{
    assets: Array<{ path: string; sha256: string; kind: string }>;
    complete: boolean;
    missing: string[];
  }> {
    return collectScriptAssets(flow, steps, assetDir);
  }

  async function resolveVideoDemo(
    flow: Flow,
    version: string,
    executionDigest: string,
    legacyExecutionDigest?: string,
  ): Promise<{ demo?: ScriptVideoDemo; attachment?: VideoDemoAttachment; errors: string[] }> {
    const errors: string[] = [];
    const raw = store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`);
    if (!raw) return { errors: [MISSING_DEMO_REASON] };
    let attachment: VideoDemoAttachment;
    try {
      attachment = JSON.parse(raw) as VideoDemoAttachment;
    } catch {
      return { errors: ["VIDEO_DEMO: metadata is invalid JSON"] };
    }
    try {
      assertDemoBelongsToScript(attachment, flow.id);
      try { assertExecutionDigestMatches(attachment, executionDigest); }
      catch (error) {
        // Creator versions before asset-aware attachment computed the same
        // execution manifest with an empty asset catalog. Accept only that exact
        // legacy digest; Step pins are still checked below.
        if (!legacyExecutionDigest || attachment.executionDigest?.toLowerCase() !== legacyExecutionDigest.toLowerCase()) throw error;
      }
      if (attachment.scriptVersion) parsePublishedScriptVersion(attachment.scriptVersion);
      const expected = flow.steps.map(ref => `${ref.id}:${ref.version}`).sort();
      const actual = (attachment.stepVersions ?? []).map(ref => `${ref.id}:${ref.version}`).sort();
      if (expected.length !== actual.length || expected.some((ref, index) => ref !== actual[index]))
        throw new Error("VIDEO_DEMO: pinned Step versions changed — run Test Lab again");
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

  async function localRow(flow: Flow, version = "1"): Promise<LocalCatalogRow> {
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
    const legacyProbe = buildScriptCatalogSnapshot({ flow, steps, version, assets: [] });
    const hasStoredDemo = Boolean(store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`));
    const resolved = await resolveVideoDemo(flow, version, probe.execution_digest, legacyProbe.execution_digest);
    const snap = buildScriptCatalogSnapshot({
      flow,
      steps,
      version,
      assets,
      videoDemo: resolved.demo,
    });
    // The release builder only sees a ready demo. Preserve "missing" exclusively
    // for no association; a stored but stale/broken association gets its precise error.
    const reasons = snap.incomplete_reasons.filter(reason => !(hasStoredDemo && reason === MISSING_DEMO_REASON));
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
      if (!reasons.includes(e)) reasons.push(e);
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
      demo_status: resolved.demo ? "ready" : hasStoredDemo
        ? (resolved.errors.some(error => /execution changed|Step versions changed/i.test(error)) ? "outdated" : "error") : "missing",
      demo_reason: resolved.errors[0],
    };
  }

  async function buildLocalCatalog(remoteById = new Map<string, LocalScriptRow>()): Promise<LocalCatalogRow[]> {
    const out: LocalCatalogRow[] = [];
    for (const flow of store.flows()) {
      try {
        const stored = loadReleaseMeta(flow.id);
        const probe = await localRow(flow, stored.pendingVersion || stored.version || "1");
        const hasLegacyEvidence =
          Boolean(stored.version && !stored.executionDigest && isLegacyPublishedScriptVersion(stored.version)) &&
          !probe.incomplete &&
          probe.assets_complete &&
          probe.demo_status === "ready" &&
          probe.video_attachment?.reviewed === true &&
          Boolean(probe.video_attachment?.testRunId) &&
          probe.video_attachment?.executionDigest?.toLowerCase() === probe.execution_digest?.toLowerCase();
        const verifiedLegacy = hasLegacyEvidence
          ? { executionDigest: probe.execution_digest || "", contentDigest: probe.content_digest }
          : undefined;
        const release = resolveScriptReleaseState({
          local: stored,
          remote: remoteById.get(flow.id),
          currentExecutionDigest: probe.execution_digest || "",
          verifiedLegacy,
        });
        if (!release.ok) {
          out.push({ ...probe, incomplete: true, incomplete_reasons: [...new Set([release.error, ...probe.incomplete_reasons])], release_conflict: release.error,
            published_version: stored.version, draft_status: "blocked" });
          continue;
        }
        if (release.adoptedRemote || (hasLegacyEvidence && release.local.version !== stored.version)) {
          if (hasLegacyEvidence && stored.version && !store.setting(`seoOpsLegacyVersion:${flow.id}`)) {
            store.setSetting(`seoOpsLegacyVersion:${flow.id}`, stored.version);
          }
          saveRecoveredReleaseMeta(flow.id, release.local);
        }
        const row = release.targetVersion === probe.version ? probe : await localRow(flow, release.targetVersion);
        out.push({ ...row, published_version: release.local.version, draft_status: release.draftStatus,
          draft_version: release.draftVersion });
      } catch (e) {
        // Never let one broken Scenario crash the whole catalog.
        out.push({
          script_id: flow.id,
          flow_id: flow.id,
          package_key: flow.id,
          version: "1",
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
      if (result.errors.some(error => /^(?:unauthenticated|session_expired|token_expired)$/i.test(error))) {
        tokenStore.setToken(null);
      }
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
    let remote: LocalScriptRow[] = [];
    let plan: SyncPlan | null = null;
    let error: string | undefined;
    if (tokenStore.getToken()) {
      try {
        remote = await syncClient().catalog();
      } catch (e) {
        error = String((e as Error).message || e);
      }
    }
    const remoteMap = new Map(remote.map(row => [row.script_id, row]));
    const local = await buildLocalCatalog(remoteMap);
    // Plan/catalog use publishable rows only so incomplete Scripts never hit publish validation.
    const planLocal = local.filter((r) => !r.incomplete && r.publish_body);
    if (!error && tokenStore.getToken()) {
      try { plan = await syncClient().plan(planLocal.map(toPlanRow)); }
      catch (e) { error = String((e as Error).message || e); }
    }
    plan ??= planScriptSync(planLocal, remote);

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
        ? publishBlockerMessage(l?.incomplete_reasons || [MISSING_DEMO_REASON])
        : incomplete
          ? publishBlockerMessage(l?.incomplete_reasons || []) || "incomplete"
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
        demo_reason: l?.demo_reason,
        published_version: l?.published_version,
        draft_status: l?.release_conflict ? "blocked" : l?.draft_status,
        draft_version: l?.draft_version,
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

  async function syncAll(options?: { flowId?: string }) {
    if (!tokenStore.getToken()) throw new Error("SEO_OPS: cần đăng nhập trước khi sync");
    const client = syncClient();
    const remote = await client.catalog();
    const remoteById = new Map(remote.map(row => [row.script_id, row]));
    const selectedFlows = options?.flowId ? store.flows().filter(flow => flow.id === options.flowId) : store.flows();
    const selectedIds = new Set(selectedFlows.map(flow => flow.id));
    const refreshedLocal = (await buildLocalCatalog(remoteById)).filter(row => selectedIds.has(row.flow_id));
    const now = new Date().toISOString();
    const meta = loadMeta();
    const results: Array<{ script_id: string; action: string; ok: boolean; message?: string }> = [];

    // Incomplete Scripts are skipped individually — never block others / never publish.
    const publishable = refreshedLocal.filter((r) => !r.incomplete && r.publish_body);
    for (const row of refreshedLocal.filter((r) => r.incomplete)) {
      const missingDemo = hasMissingDemoReason(row.incomplete_reasons || []);
      // Missing-demo Scripts are skipped once — never thrown as sync errors (no auto-retry storm).
      const blockerMessage = publishBlockerMessage(row.incomplete_reasons || ["incomplete"]);
      results.push({
        script_id: row.script_id,
        action: "publish_blocked",
        ok: true,
        message: blockerMessage,
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
        message: blockerMessage,
        incomplete: true,
      };
    }

    const plan: SyncPlan = { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] };
    for (const row of publishable) {
      const server = remoteById.get(row.script_id);
      if (server && server.content_digest.toLowerCase() === row.content_digest.toLowerCase() && server.demo_status === "ready") {
        plan.skip.push({ script_id: row.script_id, reason: "same_digest" });
      } else {
        plan.push_to_remote.push(toPlanRow(row));
      }
    }
    if (!options?.flowId) {
      const localIds = new Set(refreshedLocal.map(row => row.script_id));
      plan.pull_to_local.push(...remote.filter(row => !localIds.has(row.script_id)));
    }

    for (const row of plan.push_to_remote) {
      try {
        const full = publishable.find((r) => r.script_id === row.script_id);
        if (!full?.publish_body) {
          results.push({ script_id: row.script_id, action: "skip", ok: true, message: "incomplete — no publish body" });
          continue;
        }
        savePendingRelease(full);
        const published = await client.publish(full.publish_body);
        let ok = published.httpStatus < 300 && (published as { ok?: boolean }).ok !== false;
        let message = ok ? "pushed" : JSON.stringify((published as { errors?: string[] }).errors ?? published);
        const responseDigest = (published as { release?: { content_digest?: string } }).release?.content_digest;
        if (ok && responseDigest && responseDigest.toLowerCase() !== full.content_digest.toLowerCase()) {
          ok = false;
          message = `publish digest mismatch: expected ${full.content_digest}, received ${responseDigest}`;
        }
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
            let thumbnailBinary: Buffer | undefined;
            if (full.video_attachment.thumbnailRef) {
              try {
                thumbnailBinary = await readFile(path.join(testRunsDir, full.video_attachment.thumbnailRef));
              } catch {
                // thumbnail binary optional
              }
            }
            const uploaded = await client.uploadVideoDemo({
              packageKey: full.package_key,
              version: full.version,
              binary,
              mime: "video/webm",
              sha256: full.video_attachment.sha256,
              thumbnailBinary,
              thumbnailSha256: full.video_attachment.thumbnailSha256,
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
          completeRelease(full);
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
      results.push({ script_id: skip.script_id, action: "unchanged", ok: true, message: skip.reason });
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
    meta.last_result = results.some(r => !r.ok) ? "partial"
      : results.some(r => r.action === "publish_blocked") ? "blocked" : "ok";
    saveMeta(meta);
    const reports = await fetchReports();
    await fetchActionTags();
    await fetchScriptRequests();
    const rows = await refreshStatusRows();
    return { plan, results, rows, summary: {
      published: results.filter(r => r.action === "push" && r.ok).length,
      downloaded: results.filter(r => r.action === "pull" && r.ok).length,
      unchanged: results.filter(r => r.action === "unchanged").length,
      blocked: refreshedLocal.filter(r => r.incomplete).length,
      failed: results.filter(r => !r.ok).length,
      reports_downloaded: reports.length,
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
    markBackupDirty,
    backupInfo,
    downloadBackup,
    fetchActionTags,
    syncActionTags,
    getCachedActionTags,
    fetchScriptRequests,
    getCachedScriptRequests,
    createScriptFromRequest,
  };
}

export type SeoOpsSyncService = ReturnType<typeof createSeoOpsSyncService>;
