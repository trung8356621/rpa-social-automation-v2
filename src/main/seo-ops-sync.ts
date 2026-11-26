import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Flow, Step, ActionTag, ScriptRequest } from "../shared/contracts.js";
import {
  ACTION_TAGS_RATE_LIMIT_COOLDOWN_MS,
  ACTION_TAGS_STALE_MS,
  mergeActionTagsWithRequests,
  normalizeActionTag,
  normalizeActionTags,
  type ActionTagsRefreshResult,
} from "../shared/action-tags.js";
import { slugify } from "../shared/flow-model.js";
import {
  buildScriptCatalogSnapshot,
  isScriptHealthWarningReason,
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
  nextSuccessorName,
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
  hasMissingDemoReason,
  MISSING_DEMO_REASON,
} from "../shared/video-demo-policy.js";
import { validatePayload, type Store } from "./storage.js";
import { createAdminBackup } from "./admin-backup.js";
import {
  mapSeoOpsApiError,
  mapSeoOpsApiErrors,
  readSeoOpsJson,
  retryAfterSeconds,
  seoOpsFetch,
  SeoOpsHttpError,
  SEO_OPS_DEFAULT_BASE_URL,
} from "../shared/seo-ops-http.js";
import { createSeoOpsMetadataGate } from "../shared/seo-ops-metadata-gate.js";
import { resolveActionTagUrl } from "../shared/action-tag-url.js";
import {
  isLegacyPublishedScriptVersion,
  nextPublishedScriptVersion,
  parsePublishedScriptVersion,
} from "../shared/script-version.js";
import { resolveScriptReleaseState, type StoredScriptRelease } from "../shared/script-release-state.js";
import { planActionTagReassignment } from "../shared/script-action-tag-reassign.js";

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
  health_warnings: string[];
  health_status: ScriptSyncRow["health_status"];
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
  const dataPath = options.dataPath;
  const testRunsDir = options.testRunsDir || (dataPath ? path.join(dataPath, "test-runs") : undefined);
  const installationId = store.setting("seoOpsInstallationId") || randomUUID();
  if (!store.setting("seoOpsInstallationId")) store.setSetting("seoOpsInstallationId", installationId);
  let actionTagsRefreshInFlight: Promise<ActionTagsRefreshResult> | null = null;
  let scriptRequestsInFlight: Promise<ScriptRequest[]> | null = null;
  let statusRowsInFlight: Promise<ScriptSyncRow[]> | null = null;
  let statusRowsCached: ScriptSyncRow[] | null = null;
  let statusRowsCachedAt = 0;
  const newVersionInFlight = new Map<string, Promise<{
    ok: boolean;
    predecessorId: string;
    successorId?: string;
    successorName?: string;
    error?: string;
    sync?: Awaited<ReturnType<typeof syncAll>>;
  }>>();
  const metadataGate = createSeoOpsMetadataGate({
    onBlock: (info) => {
      if (info.reason === "budget" || info.reason === "backoff") {
        console.warn(
          `[seo-ops-metadata-gate] blocked ${info.endpoint} reason=${info.reason}`
          + (info.retryAfterMs != null ? ` retryAfterMs=${Math.round(info.retryAfterMs)}` : ""),
        );
      }
    },
  });

  function config(): SeoOpsConfig {
    const raw = store.setting("seoOpsBaseUrl");
    return { baseUrl: (raw || SEO_OPS_DEFAULT_BASE_URL).replace(/\/$/, "") };
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
    const response = await seoOpsFetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await readSeoOpsJson(response, init?.method ?? "GET", url);
    if (!response.ok || body.ok !== true) {
      const errList = Array.isArray(body.errors)
        ? mapSeoOpsApiErrors(body.errors as string[])
        : mapSeoOpsApiError(String(body.errors ?? response.status));
      throw new Error(errList || `HTTP ${response.status}`);
    }
    return body;
  }

  async function downloadAdminFile(
    pathname: string,
    targetPath: string,
    expectedSha256?: string
  ): Promise<{ sha256: string; bytes: number }> {
    const token = tokenStore.getToken();
    if (!token) throw new Error("unauthenticated");
    const url = `${config().baseUrl}/api/v1/social-automation/rpa-admin${pathname}`;
    const response = await seoOpsFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, video/*, image/*, application/octet-stream, */*",
      },
    });

    if (!response.ok) {
      let errDetail = "";
      try {
        const body = await readSeoOpsJson(response, "GET", url);
        errDetail = Array.isArray(body.errors) ? (body.errors as string[]).join(", ") : String(body.errors ?? "");
      } catch {
        errDetail = await response.text().catch(() => "");
      }
      throw new Error(errDetail || `HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    let buf: Buffer;

    if (contentType.includes("application/json")) {
      const body = await readSeoOpsJson(response, "GET", url);
      if (body.ok !== true) {
        const errDetail = Array.isArray(body.errors) ? (body.errors as string[]).join(", ") : String(body.errors ?? "download_failed");
        throw new Error(errDetail);
      }
      const rawBase64 = String(body.content_base64 || body.asset_base64 || "");
      if (!rawBase64) {
        throw new Error("missing content_base64 in response");
      }
      buf = Buffer.from(rawBase64, "base64");
    } else {
      const arrayBuffer = await response.arrayBuffer();
      buf = Buffer.from(arrayBuffer);
    }

    if (buf.length === 0) {
      throw new Error("file is empty");
    }

    const computedSha = createHash("sha256").update(buf).digest("hex").toLowerCase();
    if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha) {
      throw new Error(`Checksum mismatch: expected ${expectedSha256}, got ${computedSha}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const tempFile = `${targetPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tempFile, buf);
      await rename(tempFile, targetPath);
    } catch (e) {
      await unlink(tempFile).catch(() => {});
      throw e;
    }

    return { sha256: computedSha, bytes: buf.length };
  }

  async function ensureAdminFile(
    pathname: string,
    targetPath: string,
    expectedSha256?: string
  ): Promise<{ sha256: string; downloaded: boolean }> {
    try {
      const existing = await readFile(targetPath);
      if (existing.length > 0) {
        const existingSha = createHash("sha256").update(existing).digest("hex").toLowerCase();
        if (!expectedSha256 || existingSha === expectedSha256.toLowerCase()) {
          return { sha256: existingSha, downloaded: false };
        }
      }
    } catch {
      // file missing or unreadable, download
    }

    const result = await downloadAdminFile(pathname, targetPath, expectedSha256);
    return { sha256: result.sha256, downloaded: true };
  }

  let backupInFlight: Promise<Record<string, unknown>> | null = null;
  let backupInfoInFlight: Promise<Record<string, unknown>> | null = null;
  let backupGeneration = 0;
  let backedUpGeneration = -1;
  let lastBackupResult: Record<string, unknown> | null = null;
  let syncAllInFlight: Promise<{
    plan: SyncPlan;
    results: Array<{ script_id: string; action: string; ok: boolean; message?: string }>;
    rows: ScriptSyncRow[];
    summary: { published: number; downloaded: number; unchanged: number; blocked: number; failed: number; reports_downloaded: number };
  }> | null = null;

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
  async function syncActionTags(): Promise<
    | { ok: true; tags: ActionTag[]; count: number; scriptsCount: number }
    | { ok: false; error: string }
  > {
    try {
      const token = tokenStore.getToken();
      if (!token) {
        return { ok: false, error: "Cần đăng nhập SEO-OPS tại Settings trước khi đồng bộ." };
      }
      const body = await adminApi("/action-tags");
      if (!body || !Array.isArray((body as { action_tags?: unknown[] }).action_tags)) {
        return { ok: false, error: "Dữ liệu trả về từ SEO-OPS không có danh sách Action Tags." };
      }
      const tags = normalizeActionTags((body as { action_tags: unknown[] }).action_tags);
      store.upsertActionTags(tags);
      store.setSetting("seoOpsActionTags", JSON.stringify(tags));
      store.setSetting("seoOpsActionTagsFetchedAt", new Date().toISOString());

      let activeScripts: Array<Record<string, unknown>> = [];
      try {
        const activeBody = await adminApi("/active-scripts");
        if (activeBody && Array.isArray((activeBody as { active_scripts?: unknown[] }).active_scripts)) {
          activeScripts = (activeBody as { active_scripts: Array<Record<string, unknown>> }).active_scripts;
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return { ok: false, error: mapSeoOpsAuthError(raw) };
      }

      let activeByTag: Record<string, string> = {};
      try {
        activeByTag = JSON.parse(store.setting("activeScriptsByTag") || "{}");
      } catch {
        activeByTag = {};
      }

      const meta = loadMeta();
      const now = new Date().toISOString();
      let scriptsCount = 0;

      for (const item of activeScripts) {
        const release = item.release as Record<string, unknown> | undefined;
        if (!release) continue;

        const tagKey = String(item.action_tag_key ?? "");
        const tagId = typeof item.action_tag_id === "number" ? item.action_tag_id : undefined;
        const scriptId = String(item.script_id ?? item.package_key ?? "");
        const version = String(item.version ?? "1");
        const contentDigest = String(item.content_digest ?? "");
        const executionDigest = String(item.execution_digest ?? "");
        const packageKey = String(item.package_key ?? scriptId);
        const name = String(item.name ?? release.name ?? scriptId);

        if (!scriptId) continue;

        const effectiveTestRunsDir = testRunsDir || (dataPath ? path.join(dataPath, "test-runs") : undefined);
        const manifest = (release.manifest ?? {}) as Record<string, unknown>;
        const videoDemoMeta = (manifest.video_demo ?? (item as Record<string, unknown>).video_demo) as Record<string, unknown> | undefined;

        // RULE: An active script MUST have a demo video
        if (!videoDemoMeta || typeof videoDemoMeta !== "object") {
          throw new Error(`Đồng bộ Active Script "${name}" (${scriptId}) v${version} thất bại: Script Activate bắt buộc phải có Demo Video trên SEO-OPS.`);
        }

        // Check if matching flow already exists locally
        const existingFlow = store.flows().find(f => f.id === scriptId)
          ?? (tagKey ? store.flows().find(f => (f.actionTagKey === tagKey || (tagId !== undefined && f.actionTagId === tagId)) && f.id === activeByTag[tagKey]) : undefined);

        if (existingFlow) {
          const stored = loadReleaseMeta(existingFlow.id);
          // Check if local demo video exists and matches checksum
          let hasValidDemo = false;
          if (effectiveTestRunsDir) {
            const storedDemoRaw = store.setting(`videoDemo:${existingFlow.id}`) || store.setting(`videoDemo:${existingFlow.id}:${version}`);
            if (storedDemoRaw) {
              try {
                const parsed = JSON.parse(storedDemoRaw) as VideoDemoAttachment;
                if (parsed.artifactRef && parsed.thumbnailRef) {
                  const vidPath = path.resolve(effectiveTestRunsDir, parsed.artifactRef);
                  const thPath = path.resolve(effectiveTestRunsDir, parsed.thumbnailRef);
                  const expectedVidSha = typeof videoDemoMeta.sha256 === "string" ? videoDemoMeta.sha256.toLowerCase() : undefined;
                  if (existsSync(vidPath) && existsSync(thPath)) {
                    if (!expectedVidSha || (parsed.sha256 && parsed.sha256.toLowerCase() === expectedVidSha)) {
                      hasValidDemo = true;
                    }
                  }
                }
              } catch {}
            }
          }

          // Idempotent check: if snapshot is unchanged AND local demo video is valid, do not rewrite or re-download
          if (
            stored.contentDigest &&
            stored.contentDigest.toLowerCase() === contentDigest.toLowerCase() &&
            stored.version === version &&
            hasValidDemo
          ) {
            if (tagKey && !activeByTag[tagKey]) {
              activeByTag[tagKey] = existingFlow.id;
            }
            scriptsCount++;
            continue;
          }

          // Check if local flow has unsaved changes / edits ahead
          const probe = await localRow(existingFlow, stored.pendingVersion || stored.version || "1");
          const localChanged = Boolean(stored.version && stored.executionDigest && stored.executionDigest !== probe.execution_digest);
          if (localChanged || stored.pendingVersion) {
            // Do NOT overwrite script that user is editing or has unsaved changes
            continue;
          }
        }

        if (!effectiveTestRunsDir) {
          throw new Error("VIDEO_DEMO: test-runs directory unavailable");
        }

        const runId = String(videoDemoMeta.test_run_id || "demo-run");
        let rawArtifactRef = typeof videoDemoMeta.artifact_ref === "string" ? videoDemoMeta.artifact_ref : "";
        if (!rawArtifactRef || rawArtifactRef.includes("..") || path.isAbsolute(rawArtifactRef)) {
          rawArtifactRef = `demos/${scriptId}/${runId}/recording.webm`;
        }
        let rawThumbnailRef = typeof videoDemoMeta.thumbnail_ref === "string" ? videoDemoMeta.thumbnail_ref : "";
        if (!rawThumbnailRef || rawThumbnailRef.includes("..") || path.isAbsolute(rawThumbnailRef)) {
          rawThumbnailRef = `demos/${scriptId}/${runId}/recording-thumb.jpg`;
        }

        const videoAbsPath = path.resolve(effectiveTestRunsDir, rawArtifactRef);
        const thumbAbsPath = path.resolve(effectiveTestRunsDir, rawThumbnailRef);
        const resolvedTestRunsDir = path.resolve(effectiveTestRunsDir);

        if (!videoAbsPath.startsWith(`${resolvedTestRunsDir}${path.sep}`) ||
            !thumbAbsPath.startsWith(`${resolvedTestRunsDir}${path.sep}`)) {
          throw new Error(`VIDEO_DEMO: Invalid media path reference for script "${name}" (${scriptId})`);
        }

        let videoSha = typeof videoDemoMeta.sha256 === "string" ? videoDemoMeta.sha256 : "";
        let thumbSha = typeof videoDemoMeta.thumbnail_sha256 === "string" ? videoDemoMeta.thumbnail_sha256 : "";

        try {
          const vidRes = await ensureAdminFile(
            `/scripts/video-demo?package_key=${encodeURIComponent(packageKey)}&version=${encodeURIComponent(version)}&kind=video_demo`,
            videoAbsPath,
            videoSha || undefined
          );
          videoSha = vidRes.sha256;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Đồng bộ Demo Video cho Active Script "${name}" (${scriptId}) v${version} thất bại: ${msg}`);
        }

        try {
          const thRes = await ensureAdminFile(
            `/scripts/video-demo?package_key=${encodeURIComponent(packageKey)}&version=${encodeURIComponent(version)}&kind=thumbnail`,
            thumbAbsPath,
            thumbSha || undefined
          );
          thumbSha = thRes.sha256;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Đồng bộ Thumbnail Demo cho Active Script "${name}" (${scriptId}) v${version} thất bại: ${msg}`);
        }

        // Download any declared assets from SEO-OPS if missing locally
        const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
        for (const asset of assets) {
          if (!asset || typeof asset !== "object") continue;
          const a = asset as Record<string, unknown>;
          const relPath = String(a.path ?? "");
          if (!relPath) continue;
          const absPath = path.join(assetDir, relPath);
          try {
            await access(absPath);
          } catch {
            try {
              const dlRes = await adminApi(
                `/scripts/asset?package_key=${encodeURIComponent(packageKey)}&version=${encodeURIComponent(version)}&asset_path=${encodeURIComponent(relPath)}`
              );
              if (dlRes && typeof dlRes.asset_base64 === "string") {
                const buf = Buffer.from(dlRes.asset_base64, "base64");
                await mkdir(path.dirname(absPath), { recursive: true });
                await writeFile(absPath, buf);
              }
            } catch {
              // asset download unavailable, proceed with metadata/steps
            }
          }
        }

        // Materialize release into Flow and Steps
        const existingSteps = store.steps();
        const materialized = materializeScriptRelease({
          release: {
            ...release,
            name,
            manifest: {
              ...manifest,
              script_id: scriptId,
              action_tag_key: tagKey || manifest.action_tag_key,
              action_tag_id: tagId,
            },
          },
          existing: existingFlow ?? null,
          existingSteps,
          validatePayload,
        });

        if (!materialized.ok) {
          // If conflict or invalid, do not break other scripts
          continue;
        }

        store.db.exec("BEGIN");
        try {
          // Insert missing steps (never overwrite existing step@version)
          for (const step of materialized.inserts) {
            store.db
              .prepare("INSERT INTO steps VALUES(?,?,?)")
              .run(step.id, step.version, JSON.stringify(step));
          }

          const flowToSave: Flow = {
            ...materialized.flow,
            id: scriptId,
            name,
            actionTagKey: tagKey || materialized.flow.actionTagKey,
            ...(tagId !== undefined ? { actionTagId: tagId } : {}),
          };

          store.saveFlow(flowToSave);
          store.setSetting(`seoOpsVersion:${flowToSave.id}`, version);
          if (contentDigest) {
            store.setSetting(`seoOpsPublishedDigest:${flowToSave.id}`, contentDigest);
          }
          const flowSteps = flowToSave.steps
            .map(ref => {
              try { return store.step(ref.id, ref.version); } catch { return undefined; }
            })
            .filter((s): s is Step => Boolean(s));
          const localProbe = buildScriptCatalogSnapshot({ flow: flowToSave, steps: flowSteps, version, assets: [] });
          store.setSetting(`seoOpsPublishedExecutionDigest:${flowToSave.id}`, localProbe.execution_digest);

          const attachment: VideoDemoAttachment = {
            scriptId: flowToSave.id,
            scriptVersion: version,
            testRunId: runId,
            caseId: flowToSave.id,
            artifactRef: rawArtifactRef,
            mime: "video/webm",
            sha256: videoSha,
            reviewed: true,
            executionDigest: localProbe.execution_digest,
            thumbnailRef: rawThumbnailRef,
            thumbnailSha256: thumbSha,
            stepVersions: flowToSave.steps.map(s => ({ id: s.id, version: s.version })),
            selectedAt: now,
          };

          store.setSetting(`videoDemo:${flowToSave.id}`, JSON.stringify(attachment));
          store.setSetting(`videoDemo:${flowToSave.id}:${version}`, JSON.stringify(attachment));

          // Set as active script if tag has no active script or it's this flow
          if (tagKey) {
            const currentActive = activeByTag[tagKey];
            if (!currentActive || currentActive === flowToSave.id || !store.flows().some(f => f.id === currentActive)) {
              activeByTag[tagKey] = flowToSave.id;
            }
          }

          store.db.exec("COMMIT");
          scriptsCount++;

          meta.rows[flowToSave.id] = {
            script_id: flowToSave.id,
            flow_id: flowToSave.id,
            package_key: packageKey,
            name: flowToSave.name,
            local_version: version,
            remote_version: version,
            local_digest: contentDigest,
            remote_digest: contentDigest,
            status: "synced",
            last_sync_at: now,
            last_result: "synced",
            published_version: version,
          };
        } catch (e) {
          store.db.exec("ROLLBACK");
          throw e;
        }
      }

      store.setSetting("activeScriptsByTag", JSON.stringify(activeByTag));
      saveMeta(meta);

      return {
        ok: true,
        tags,
        count: tags.length,
        scriptsCount,
      };
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: mapSeoOpsAuthError(rawMsg) };
    }
  }

  function getCachedActionTags(): ActionTag[] {
    try {
      const dbTags = store.actionTags();
      if (dbTags.length > 0) return dbTags;
      const fromSettings = JSON.parse(store.setting("seoOpsActionTags") || "[]") as unknown[];
      return normalizeActionTags(Array.isArray(fromSettings) ? fromSettings : []);
    } catch {
      return [];
    }
  }

  function getCachedScriptRequests(): ScriptRequest[] {
    try {
      return JSON.parse(store.setting("seoOpsScriptRequests") || "[]") as ScriptRequest[];
    } catch {
      return [];
    }
  }

  /** SQLite tags + gaps filled from Script Requests (so Creator sees mayhopphat.login etc.). */
  function getEffectiveActionTags(): ActionTag[] {
    return mergeActionTagsWithRequests(getCachedActionTags(), getCachedScriptRequests());
  }

  function actionTagsFetchedAt(): number {
    const raw = store.setting("seoOpsActionTagsFetchedAt");
    if (!raw) return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  function areActionTagsStale(maxAgeMs = ACTION_TAGS_STALE_MS): boolean {
    const fetched = actionTagsFetchedAt();
    if (!fetched) return true;
    return Date.now() - fetched > maxAgeMs;
  }

  function rateLimitUntilMs(): number {
    const raw = store.setting("seoOpsActionTagsRateLimitedUntil");
    if (!raw) return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  function markActionTagsRateLimited(retrySec?: number): void {
    const waitMs = Math.max(
      ACTION_TAGS_RATE_LIMIT_COOLDOWN_MS,
      (typeof retrySec === "number" && retrySec > 0 ? retrySec : 60) * 1000,
    );
    store.setSetting("seoOpsActionTagsRateLimitedUntil", new Date(Date.now() + waitMs).toISOString());
  }

  function clearActionTagsRateLimit(): void {
    store.setSetting("seoOpsActionTagsRateLimitedUntil", "");
  }

  function persistActionTags(tags: ActionTag[]): void {
    store.upsertActionTags(tags);
    store.setSetting("seoOpsActionTags", JSON.stringify(tags));
    store.setSetting("seoOpsActionTagsFetchedAt", new Date().toISOString());
    clearActionTagsRateLimit();
  }

  /** Persist only request tags that carry a real SEO-OPS action_tag_id (never synthetic ids). */
  function upsertTagsFromScriptRequests(requests: ScriptRequest[]): number {
    const existingKeys = new Set(getCachedActionTags().map((t) => t.tag_key));
    const toUpsert: ActionTag[] = [];
    for (const req of requests) {
      const tagKey = String(req.action_tag_key ?? "").trim();
      if (!tagKey || existingKeys.has(tagKey)) continue;
      if (typeof req.action_tag_id !== "number" || !Number.isFinite(req.action_tag_id)) continue;
      if (store.actionTag(req.action_tag_id)) continue;
      const tag = normalizeActionTag({
        id: req.action_tag_id,
        tag_key: tagKey,
        site_key: req.site_key,
        path_key: req.path_key,
        action_key: req.action_key ?? null,
        base_url: req.site_base_url,
        url_pattern: req.url_pattern,
        path_inputs: req.path_inputs,
        name: tagKey,
      });
      if (!tag) continue;
      toUpsert.push(tag);
      existingKeys.add(tagKey);
    }
    if (toUpsert.length) {
      store.upsertActionTags(toUpsert);
      store.setSetting("seoOpsActionTags", JSON.stringify(getCachedActionTags()));
    }
    return toUpsert.length;
  }

  function enrichedTagsResult(base: {
    ok: boolean;
    source: "api" | "cache" | "requests";
    error?: string;
    authRequired?: boolean;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
  }): ActionTagsRefreshResult {
    const tags = getEffectiveActionTags();
    const fromRequests = tags.length > getCachedActionTags().length;
    if (base.ok) {
      return {
        ok: true,
        tags,
        count: tags.length,
        source: fromRequests && base.source === "cache" ? "requests" : base.source,
        fetchedAt: store.setting("seoOpsActionTagsFetchedAt") || undefined,
      };
    }
    return {
      ok: false,
      error: base.error || "Không làm mới được Action Tags.",
      tags,
      count: tags.length,
      source: fromRequests ? "requests" : "cache",
      authRequired: base.authRequired,
      rateLimited: base.rateLimited,
      retryAfterSeconds: base.retryAfterSeconds,
    };
  }

  async function refreshActionTags(options?: { force?: boolean }): Promise<ActionTagsRefreshResult> {
    if (actionTagsRefreshInFlight) return actionTagsRefreshInFlight;

    const run = async (): Promise<ActionTagsRefreshResult> => {
      // Always surface request-derived tags even before hitting the API.
      upsertTagsFromScriptRequests(getCachedScriptRequests());
      const effective = getEffectiveActionTags();

      if (!options?.force && !areActionTagsStale() && effective.length > 0) {
        return enrichedTagsResult({ ok: true, source: "cache" });
      }

      const limitedUntil = rateLimitUntilMs();
      if (limitedUntil > Date.now()) {
        const retryAfterSeconds = Math.ceil((limitedUntil - Date.now()) / 1000);
        return enrichedTagsResult({
          ok: false,
          source: "cache",
          error: `SEO-OPS đang giới hạn yêu cầu. Thử lại sau ${retryAfterSeconds} giây.`,
          rateLimited: true,
          retryAfterSeconds,
        });
      }

      const token = tokenStore.getToken();
      if (!token) {
        return enrichedTagsResult({
          ok: false,
          source: "cache",
          error: "Cần đăng nhập SEO-OPS tại Settings trước khi làm mới Action Tags.",
          authRequired: true,
        });
      }

      try {
        const gated = await metadataGate.run(
          "action-tags",
          async () => adminApi("/action-tags"),
          { force: Boolean(options?.force) },
        );
        if (!gated.fromNetwork) {
          const retryAfterSeconds = gated.blocked.retryAfterMs
            ? Math.ceil(gated.blocked.retryAfterMs / 1000)
            : undefined;
          if (gated.blocked.reason === "ttl") {
            return enrichedTagsResult({ ok: true, source: "cache" });
          }
          return enrichedTagsResult({
            ok: false,
            source: "cache",
            error: gated.blocked.reason === "budget"
              ? "RPA Client đã chặn burst Action Tags (request budget). Thử lại sau."
              : `SEO-OPS Action Tags đang cooldown. Thử lại sau ${retryAfterSeconds ?? 60} giây.`,
            rateLimited: true,
            retryAfterSeconds,
          });
        }
        const body = gated.value;
        if (!body || !Array.isArray((body as { action_tags?: unknown[] }).action_tags)) {
          return enrichedTagsResult({
            ok: false,
            source: "cache",
            error: "Dữ liệu trả về từ SEO-OPS không có danh sách Action Tags.",
          });
        }
        const tags = normalizeActionTags((body as { action_tags: unknown[] }).action_tags);
        persistActionTags(tags);
        return {
          ok: true,
          tags: getEffectiveActionTags(),
          count: getEffectiveActionTags().length,
          source: "api",
          fetchedAt: store.setting("seoOpsActionTagsFetchedAt") || undefined,
        };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const error = mapSeoOpsAuthError(raw);
        const rateLimited =
          (e instanceof SeoOpsHttpError && e.diagnostic.category === "rate_limited")
          || /category=rate_limited|\b429\b|giới hạn yêu cầu/i.test(raw + " " + error);
        if (rateLimited) {
          markActionTagsRateLimited(retryAfterSeconds(e));
        }
        const authRequired = /unauthenticated|hết hạn|phiên|đăng nhập|401/i.test(raw + " " + error)
          && !rateLimited;
        return enrichedTagsResult({
          ok: false,
          source: "cache",
          error,
          authRequired,
          rateLimited,
          retryAfterSeconds: rateLimited ? (retryAfterSeconds(e) ?? 60) : undefined,
        });
      }
    };

    actionTagsRefreshInFlight = run().finally(() => {
      actionTagsRefreshInFlight = null;
    });
    return actionTagsRefreshInFlight;
  }

  /** Best-effort tag pull used by Script sync; respects TTL unless caller needs a warm cache. */
  async function fetchActionTags(): Promise<ActionTag[]> {
    const result = await refreshActionTags({ force: false });
    return result.tags;
  }

  async function fetchScriptRequests(status?: string, options?: { force?: boolean }): Promise<ScriptRequest[]> {
    if (scriptRequestsInFlight) return scriptRequestsInFlight;
    const run = async (): Promise<ScriptRequest[]> => {
      const cached = getCachedScriptRequests();
      const gated = await metadataGate.run(
        "script-requests",
        async () => {
          const q = status ? `?status=${encodeURIComponent(status)}` : "";
          return adminApi(`/script-requests${q}`);
        },
        { force: Boolean(options?.force) },
      );
      if (!gated.fromNetwork) return cached;
      try {
        const body = gated.value;
        if (body && Array.isArray((body as { script_requests?: unknown[] }).script_requests)) {
          const requests = (body as { script_requests: ScriptRequest[] }).script_requests;
          store.setSetting("seoOpsScriptRequests", JSON.stringify(requests));
          upsertTagsFromScriptRequests(requests);
          metadataGate.markSuccess("script-requests");
          return requests;
        }
      } catch {
        /* offline / unauthenticated fallback */
      }
      return cached;
    };
    scriptRequestsInFlight = run().finally(() => { scriptRequestsInFlight = null; });
    return scriptRequestsInFlight;
  }

  async function createScriptFromRequest(requestId: string): Promise<Flow> {
    const requests = getCachedScriptRequests();
    const req = requests.find((r) => r.request_id === requestId);
    if (!req) {
      throw new Error(`Không tìm thấy Script Request: ${requestId}`);
    }

    const tags = getEffectiveActionTags();
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
      actionTagId: typeof req.action_tag_id === "number" ? req.action_tag_id : tag?.id,
      scriptRequestId: req.request_id,
      resultType: "status",
      pathInputs: req.path_inputs ?? tag?.path_inputs,
      urlPattern: req.url_pattern ?? tag?.url_pattern,
    });
    const resolved = resolveActionTagUrl({
      baseUrl: tag?.base_url ?? req.site_base_url,
      urlPattern: req.url_pattern ?? tag?.url_pattern,
      pathInputs: req.path_inputs ?? tag?.path_inputs,
      values: {},
    });
    store.updateFlowMeta(flow.id, {
      pathInputs: req.path_inputs ?? tag?.path_inputs ?? [],
      urlPattern: req.url_pattern ?? tag?.url_pattern ?? "",
      pathInputValues: {},
      startUrl: resolved.ok ? resolved.url : "",
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
  ): Promise<{ demo?: ScriptVideoDemo; attachment?: VideoDemoAttachment; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const raw = store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`);
    if (!raw) return { errors: [MISSING_DEMO_REASON], warnings };
    let attachment: VideoDemoAttachment;
    try {
      attachment = JSON.parse(raw) as VideoDemoAttachment;
    } catch {
      return { errors: ["VIDEO_DEMO: metadata is invalid JSON"], warnings };
    }
    try {
      assertDemoBelongsToScript(attachment, flow.id);
      if (attachment.scriptVersion) parsePublishedScriptVersion(attachment.scriptVersion);
    } catch (e) {
      return { errors: [String((e as Error).message || e)], warnings };
    }
    // VIDEO_DEMO is optional explanatory media for humans — never warn on digest or step-pin diffs.
    if (!testRunsDir) {
      errors.push("VIDEO_DEMO: test-runs directory unavailable");
      return { errors, warnings };
    }
    const videoAbs = path.join(testRunsDir, attachment.artifactRef);
    try {
      await access(videoAbs);
      const buf = await readFile(videoAbs);
      if (!buf.length) return { errors: ["VIDEO_DEMO: video file empty"], warnings };
      if (!attachment.sha256) {
        attachment.sha256 = createHash("sha256").update(buf).digest("hex");
      }
    } catch {
      return { errors: ["VIDEO_DEMO: video file missing or unreadable"], warnings };
    }
    if (attachment.thumbnailRef) {
      try {
        const thumb = await readFile(path.join(testRunsDir, attachment.thumbnailRef));
        if (!thumb.length) return { errors: ["VIDEO_DEMO: thumbnail empty"], warnings };
      } catch {
        return { errors: ["VIDEO_DEMO: thumbnail missing"], warnings };
      }
    } else {
      return { errors: ["VIDEO_DEMO: thumbnail required"], warnings };
    }
    if (!attachment.reviewed) {
      return { errors: ["VIDEO_DEMO: demo must be reviewed via Use as Script Demo"], warnings };
    }
    try {
      // Associate release Demo with current Script version; never rehydrate deleted Steps.
      const demo = toScriptVideoDemo({
        ...attachment,
        scriptVersion: version,
        stepVersions: structuredClone(flow.steps),
        executionDigest,
      });
      return { demo, attachment, errors: [], warnings };
    } catch (e) {
      return { errors: [String((e as Error).message || e)], warnings };
    }
  }

  async function localRow(flow: Flow, version = "1"): Promise<LocalCatalogRow> {
    // Authoritative executable list — only current flow.steps (never historical Case pins).
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
    const explicitPkgKey = store.setting(`seoOpsPackageKey:${flow.id}`);
    // Probe execution digest first (video metadata must not affect it).
    const probe = buildScriptCatalogSnapshot({ flow, steps, version, assets, packageKey: explicitPkgKey });
    const legacyProbe = buildScriptCatalogSnapshot({ flow, steps, version, assets: [], packageKey: explicitPkgKey });
    const hasStoredDemo = Boolean(store.setting(`videoDemo:${flow.id}`) || store.setting(`videoDemo:${flow.id}:${version}`));
    const resolved = await resolveVideoDemo(flow, version, probe.execution_digest, legacyProbe.execution_digest);
    const snap = buildScriptCatalogSnapshot({
      flow,
      steps,
      version,
      assets,
      videoDemo: resolved.demo,
      packageKey: explicitPkgKey,
    });
    const health_warnings: string[] = [...(snap.health_warnings ?? []), ...resolved.warnings];
    // Transport / demo integrity only — Step Health is non-blocking for distribution.
    const reasons = snap.incomplete_reasons.filter(
      (reason) => !(hasStoredDemo && reason === MISSING_DEMO_REASON) && !isScriptHealthWarningReason(reason),
    );
    for (const invalid of store.invalidSteps()) {
      if (
        invalid.flowId !== flow.id ||
        !flow.steps.some((ref) => ref.id === invalid.stepId && ref.version === invalid.version)
      ) {
        continue;
      }
      if (invalid.reason === "invalid_payload") {
        health_warnings.push(`invalid_step:${invalid.stepId}:${invalid.detail || invalid.reason}`);
      } else if (invalid.reason === "missing_variable" || invalid.reason === "legacy_incomplete" || invalid.reason === "inline_conflict") {
        health_warnings.push(`invalid_variable_ref:${invalid.stepId}:${invalid.detail || invalid.reason}`);
      } else {
        health_warnings.push(`invalid_step:${invalid.stepId}:${invalid.reason}`);
      }
    }
    // Missing ROI files: ship available assets; warn — do not invent files or block packaging.
    if (!complete) {
      health_warnings.push(...missing.map((m) => `missing_asset:${m}`));
    }
    const uniqueWarnings = [...new Set(health_warnings)];
    const uniqueReasons = [...new Set(reasons)];
    const incomplete = uniqueReasons.length > 0 || !snap.publish_body;
    const lineageRaw = store.setting(`seoOpsLineage:${flow.id}`);
    const lineage = lineageRaw ? (JSON.parse(lineageRaw) as string[]) : [];
    const health_status: ScriptSyncRow["health_status"] = uniqueWarnings.length
      ? uniqueWarnings.some((w) => w.startsWith("invalid_step:") || w.startsWith("invalid_variable_ref"))
        ? "invalid_steps"
        : "warnings"
      : "valid";
    return {
      script_id: flow.id,
      flow_id: flow.id,
      package_key: snap.package_key,
      version: snap.version,
      content_digest: snap.content_digest,
      execution_digest: snap.execution_digest,
      lineage,
      assets_complete: complete,
      publish_body: incomplete ? undefined : snap.publish_body ?? undefined,
      name: flow.name,
      incomplete,
      incomplete_reasons: uniqueReasons,
      health_warnings: uniqueWarnings,
      health_status,
      video_attachment: resolved.attachment,
      demo_status: resolved.demo
        ? "ready"
        : hasStoredDemo
          ? "error"
          : "missing",
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
        // High-trust: version state always resolves; remote is baseline, never block the catalog.
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
          health_warnings: [],
          health_status: "valid",
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
      const joined = result.errors.join(" ");
      const authLost = result.errors.some(error =>
        /^(?:unauthenticated|session_expired|token_expired)$/i.test(error),
      );
      const transient = /category=rate_limited|\b429\b|network_error|timeout|category=timeout|category=service_unavailable|\b503\b/i.test(joined);
      if (authLost) {
        tokenStore.setToken(null);
        return {
          configured: true,
          baseUrl,
          authenticated: false,
          error: mapSeoOpsAuthErrors(result.errors),
        };
      }
      // 429 / network blip: keep session usable so Tag refresh / Sync stay clickable.
      if (transient) {
        return {
          configured: true,
          baseUrl,
          authenticated: true,
          error: mapSeoOpsApiError(joined),
        };
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
    // Warm Action Tag cache after login (tag metadata only).
    void refreshActionTags({ force: true }).catch(() => undefined);
    return result;
  }

  async function logout() {
    return authClient().logout();
  }

  async function refreshStatusRows(options?: {
    offlinePending?: boolean;
    force?: boolean;
  }): Promise<ScriptSyncRow[]> {
    const STATUS_TTL_MS = metadataGate.ttlMs["scripts-catalog"];
    if (
      !options?.force
      && statusRowsCached
      && Date.now() - statusRowsCachedAt < STATUS_TTL_MS
    ) {
      return statusRowsCached;
    }
    if (statusRowsInFlight) return statusRowsInFlight;

    const runStatus = async (): Promise<ScriptSyncRow[]> => {
    const meta = loadMeta();
    let remote: LocalScriptRow[] = [];
    let plan: SyncPlan | null = null;
    let error: string | undefined;
    if (tokenStore.getToken()) {
      try {
        const gated = await metadataGate.run(
          "scripts-catalog",
          () => syncClient().catalog(),
          { force: Boolean(options?.force) },
        );
        if (gated.fromNetwork) remote = gated.value;
        else if (statusRowsCached) return statusRowsCached;
      } catch (e) {
        error = String((e as Error).message || e);
      }
    }
    const remoteMap = new Map(remote.map(row => [row.script_id, row]));
    const local = await buildLocalCatalog(remoteMap);
    // Plan/catalog use publishable rows only so incomplete Scripts never hit publish validation.
    const planLocal = local.filter((r) => !r.incomplete && r.publish_body);
    if (!error && tokenStore.getToken() && planLocal.length > 0) {
      try {
        const gatedPlan = await metadataGate.run(
          "scripts-plan",
          () => syncClient().plan(planLocal.map(toPlanRow)),
          { force: Boolean(options?.force) },
        );
        if (gatedPlan.fromNetwork) plan = gatedPlan.value;
      } catch (e) {
        error = String((e as Error).message || e);
      }
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
      const incomplete = Boolean(l?.incomplete || (r && r.assets_complete === false));
      const status = statusFromPlanSides({
        hasLocal: !!l,
        hasRemote: !!r,
        sameDigest: skipIds.has(id),
        conflict: conflictIds.has(id),
        localAhead: pushIds.has(id) && !!r,
        remoteAhead: pullIds.has(id) && !!l,
        incomplete,
        missingDemo: false,
        error: error && (l || r) && !incomplete ? error : undefined,
        offlinePending: Boolean(options?.offlinePending && l && !incomplete && !skipIds.has(id)),
      });
      const prev = meta.rows[id];
      const healthNote =
        l?.health_warnings?.length
          ? l.health_status === "invalid_steps"
            ? "Script Health: Invalid Steps — vẫn có thể đồng bộ; Step cần cấu hình trước khi thực thi"
            : `Script Health: Warnings — ${(l.health_warnings || []).slice(0, 2).join("; ")}`
          : undefined;
      // Digests already match ⇒ remote is current. Drop stale "cần Sync" / reassignment banners.
      const message = incomplete
        ? publishBlockerMessage(l?.incomplete_reasons || []) || "incomplete"
        : error && (l || r)
          ? error
          : status === "synced"
            ? healthNote || undefined
            : healthNote ||
              // Drop stale Invalid Step / incomplete / VIDEO_DEMO warning text once health is non-blocking.
              (prev?.message && /Invalid Step|incomplete|VIDEO_DEMO:|No Steps|Missing demo|script_video_demo_required/i.test(prev.message)
                ? healthNote || undefined
                : prev?.message);
      const last_result = status === "synced" && prev?.last_result === "action_tag_reassigned"
        ? "synced"
        : prev?.last_result;
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
        last_result,
        message,
        incomplete,
        demo_status: l?.demo_status,
        demo_reason: l?.demo_reason,
        health_status: l?.health_status,
        health_warnings: l?.health_warnings,
        published_version: l?.published_version,
        draft_status: l?.release_conflict ? "blocked" : l?.draft_status,
        draft_version: l?.draft_version,
      };
    });

    meta.rows = Object.fromEntries(rows.map((r) => [r.script_id, r]));
    saveMeta(meta);
    statusRowsCached = rows;
    statusRowsCachedAt = Date.now();
    return rows;
    };

    statusRowsInFlight = runStatus().finally(() => { statusRowsInFlight = null; });
    return statusRowsInFlight;
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

    // Ensure ROI assets exist locally before mutating Scripts. Download missing
    // digests from SEO-OPS (Desktop profiles often lack historical targets/).
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const packageKey = String(release.package_key ?? payload.package_key ?? scriptId);
    const version = String(release.version ?? payload.version ?? "");
    const missing: string[] = [];
    for (const asset of assets) {
      const a = asset as Record<string, unknown>;
      const rel = String(a.path ?? "");
      if (!rel) continue;
      const absPath = path.join(assetDir, rel);
      try {
        await access(absPath);
        continue;
      } catch {
        // try remote download below
      }
      if (!packageKey || !version) {
        missing.push(rel);
        continue;
      }
      try {
        const dl = await adminApi(
          `/scripts/asset?package_key=${encodeURIComponent(packageKey)}&version=${encodeURIComponent(version)}&asset_path=${encodeURIComponent(rel)}`,
        );
        if (dl && typeof (dl as { asset_base64?: unknown }).asset_base64 === "string") {
          const buf = Buffer.from(String((dl as { asset_base64: string }).asset_base64), "base64");
          const expectedSha = String(a.sha256 ?? "").toLowerCase();
          if (expectedSha) {
            const got = createHash("sha256").update(buf).digest("hex");
            if (got !== expectedSha) {
              missing.push(rel);
              continue;
            }
          }
          await mkdir(path.dirname(absPath), { recursive: true });
          await writeFile(absPath, buf);
        } else {
          missing.push(rel);
        }
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
    if (syncAllInFlight) throw new Error("SEO_OPS: sync đang chạy — không gửi request trùng");
    const run = runSyncAll(options);
    syncAllInFlight = run.finally(() => { syncAllInFlight = null; });
    return syncAllInFlight;
  }

  async function runSyncAll(options?: { flowId?: string }) {
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
      if (server && server.content_digest.toLowerCase() === row.content_digest.toLowerCase()) {
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
        let full = publishable.find((r) => r.script_id === row.script_id);
        if (!full?.publish_body) {
          results.push({ script_id: row.script_id, action: "skip", ok: true, message: "incomplete — no publish body" });
          continue;
        }
        // When remote already has an immutable release at or above local version with a different digest,
        // allocate the next version up front rather than attempting to overwrite an immutable release.
        const remoteServer = remoteById.get(row.script_id);
        if (
          remoteServer?.version &&
          remoteServer.content_digest.toLowerCase() !== full.content_digest.toLowerCase()
        ) {
          const remoteOrdinal = parsePublishedScriptVersion(remoteServer.version).ordinal;
          const localOrdinal = parsePublishedScriptVersion(full.version).ordinal;
          if (localOrdinal <= remoteOrdinal) {
            const flow = store.flows().find((f) => f.id === full!.flow_id);
            const nextVersion = String(remoteOrdinal + 1);
            if (flow) {
              const bumped = await localRow(flow, nextVersion);
              if (bumped.publish_body && !bumped.incomplete) {
                full = bumped;
              }
            }
          }
        }
        savePendingRelease(full);
        const publishOnce = async (body: NonNullable<LocalCatalogRow["publish_body"]>) =>
          client.publish(body) as Promise<{
            httpStatus: number;
            ok?: boolean;
            outcome?: string;
            errors?: string[];
            release?: { content_digest?: string };
          }>;
        if (!full.publish_body) {
          results.push({ script_id: row.script_id, action: "skip", ok: true, message: "incomplete — no publish body" });
          continue;
        }
        let published = await publishOnce(full.publish_body);
        let outcome = String(published.outcome ?? "");
        let publishErrors = Array.isArray(published.errors) ? published.errors : undefined;
        let ok = published.httpStatus < 300 && published.ok !== false;
        let message = ok
          ? (outcome === "idempotent" ? "idempotent — cùng digest đã có trên SEO-OPS" : "pushed")
          : mapSeoOpsApiErrors(publishErrors, `HTTP ${published.httpStatus}`);
        if (!ok && (published.httpStatus === 409 || outcome === "conflict")) {
          message = mapSeoOpsApiErrors(publishErrors, message);
        }
        // Bounded version-conflict recovery for both version_digest_conflict and script_version_sequence_conflict.
        const MAX_VERSION_CONFLICT_RETRIES = 3;
        let conflictRetries = 0;
        const isVersionConflict = (errs?: string[], msg?: string) =>
          /script_version_sequence_conflict|version_digest_conflict/i.test(
            [...(errs || []), msg || ""].join(" "),
          );
        while (!ok && isVersionConflict(publishErrors, message) && conflictRetries < MAX_VERSION_CONFLICT_RETRIES) {
          conflictRetries += 1;
          const server = remoteById.get(row.script_id);
          const remoteOrdinal = server?.version
            ? parsePublishedScriptVersion(server.version).ordinal
            : 0;
          const triedOrdinal = parsePublishedScriptVersion(full.version).ordinal;
          const bump = String(Math.max(remoteOrdinal, triedOrdinal) + 1);
          const flow = store.flows().find((f) => f.id === full!.flow_id);
          if (!flow || bump === full.version) break;
          const retried = await localRow(flow, bump);
          if (!retried.publish_body || retried.incomplete) break;
          full = retried;
          savePendingRelease(full);
          published = await publishOnce(retried.publish_body);
          outcome = String(published.outcome ?? "");
          publishErrors = Array.isArray(published.errors) ? published.errors : undefined;
          ok = published.httpStatus < 300 && published.ok !== false;
          message = ok
            ? (outcome === "idempotent" ? "idempotent — cùng digest đã có trên SEO-OPS" : "pushed")
            : mapSeoOpsApiErrors(publishErrors, `HTTP ${published.httpStatus}`);
          if (!ok && (published.httpStatus === 409 || outcome === "conflict")) {
            message = mapSeoOpsApiErrors(publishErrors, message);
          }
        }
        const publishBody = full.publish_body;
        if (!publishBody) {
          results.push({ script_id: row.script_id, action: "skip", ok: true, message: "incomplete — no publish body" });
          continue;
        }
        const responseDigest = published.release?.content_digest;
        if (ok && responseDigest && responseDigest.toLowerCase() !== full.content_digest.toLowerCase()) {
          ok = false;
          message = `publish digest mismatch: expected ${full.content_digest}, received ${responseDigest}`;
        }
        if (ok) {
          for (const asset of publishBody.manifest.assets) {
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
    // Reports/tags refresh must not erase a completed Script sync result.
    let reports: unknown[] = [];
    try {
      reports = await fetchReports();
    } catch {
      reports = [];
    }
    try { await fetchActionTags(); } catch { /* ignore */ }
    try { await fetchScriptRequests(); } catch { /* ignore */ }
    const rows = await refreshStatusRows({ force: true });
    return { plan, results, rows, summary: {
      published: results.filter(r => r.action === "push" && r.ok).length,
      downloaded: results.filter(r => r.action === "pull" && r.ok).length,
      unchanged: results.filter(r => r.action === "unchanged").length,
      blocked: refreshedLocal.filter(r => r.incomplete).length,
      failed: results.filter(r => !r.ok).length,
      reports_downloaded: reports.length,
    } };
  }

  async function uploadReleaseAssets(
    client: ReturnType<typeof syncClient>,
    packageKey: string,
    version: string,
    assets: Array<{ path: string; sha256: string; kind: string }>,
  ): Promise<{ ok: boolean; message?: string }> {
    for (const asset of assets) {
      const uploaded = await client.uploadAsset({
        packageKey,
        version,
        assetPath: asset.path,
        sha256: asset.sha256,
        binary: await readFile(path.join(assetDir, asset.path)),
      });
      if (!uploaded.ok) {
        return { ok: false, message: `release asset upload failed: ${(uploaded.errors ?? []).join(",")}` };
      }
    }
    return { ok: true };
  }

  async function syncFlowNormal(flowId: string) {
    if (!tokenStore.getToken()) throw new Error("SEO_OPS: cần đăng nhập trước khi sync");
    if (syncAllInFlight) throw new Error("SEO_OPS: sync đang chạy — không gửi request trùng");

    const run = (async () => {
      const flow = store.flows().find((f) => f.id === flowId);
      if (!flow) throw new Error("Không tìm thấy Script để Sync.");
      const stored = loadReleaseMeta(flow.id);
      const local = await localRow(flow, stored.version || "1");
      if (local.incomplete || !local.publish_body) {
        const msg = publishBlockerMessage(local.incomplete_reasons || ["incomplete"]);
        return {
          plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
          results: [{ script_id: flow.id, action: "publish_blocked", ok: false, message: msg }],
          rows: await refreshStatusRows({ force: true }).catch(() => []),
          summary: { published: 0, downloaded: 0, unchanged: 0, blocked: 1, failed: 1, reports_downloaded: 0 },
        };
      }

      const client = syncClient();
      const manifestForSync = { ...(local.publish_body.manifest as unknown as Record<string, unknown>) };
      // Omit video_demo unless locally attached so Backend preserves existing Demo association.
      if (!manifestForSync.video_demo) delete manifestForSync.video_demo;

      let syncRes: Awaited<ReturnType<typeof client.sync>>;
      try {
        syncRes = await client.sync({
          mode: "normal",
          package_key: local.package_key,
          name: flow.name,
          schema_version: 1,
          runtime_compatibility: local.publish_body.runtime_compatibility,
          dependencies: [],
          manifest: manifestForSync,
        });
      } catch (error) {
        // readSeoOpsJson throws on HTML/SPA 404 — treat as missing unified sync endpoint.
        const technical = String((error as Error).message || error);
        if (/status=404/i.test(technical)) {
          return await runSyncAll({ flowId });
        }
        throw error;
      }

      // JSON 404 (script_not_found or missing route) also uses catalog/publish path.
      if (!syncRes.ok && syncRes.httpStatus === 404) {
        return await runSyncAll({ flowId });
      }

      if (!syncRes.ok) {
        const msg = mapSeoOpsApiErrors(syncRes.errors, `HTTP ${syncRes.httpStatus}`);
        const meta = loadMeta();
        meta.rows[flow.id] = {
          ...(meta.rows[flow.id] ?? { script_id: flow.id, package_key: local.package_key, name: flow.name, status: "sync_error" }),
          status: "sync_error",
          last_sync_at: new Date().toISOString(),
          last_result: "push_error",
          message: msg,
        };
        saveMeta(meta);
        return {
          plan: { push_to_remote: [toPlanRow(local)], pull_to_local: [], skip: [], conflicts: [] },
          results: [{ script_id: flow.id, action: "push", ok: false, message: msg }],
          rows: await refreshStatusRows({ force: true }).catch(() => []),
          summary: { published: 0, downloaded: 0, unchanged: 0, blocked: 0, failed: 1, reports_downloaded: 0 },
        };
      }

      if (syncRes.outcome === "synced" && syncRes.assets_complete === false && local.publish_body.manifest.assets.length > 0) {
        const assetRes = await uploadReleaseAssets(
          client,
          syncRes.package_key,
          syncRes.version,
          local.publish_body.manifest.assets,
        );
        if (!assetRes.ok) {
          return {
            plan: { push_to_remote: [toPlanRow(local)], pull_to_local: [], skip: [], conflicts: [] },
            results: [{ script_id: flow.id, action: "push", ok: false, message: assetRes.message }],
            rows: await refreshStatusRows({ force: true }).catch(() => []),
            summary: { published: 0, downloaded: 0, unchanged: 0, blocked: 0, failed: 1, reports_downloaded: 0 },
          };
        }
      }

      completeRelease({
        ...local,
        package_key: syncRes.package_key,
        version: syncRes.version,
        content_digest: syncRes.content_digest || local.content_digest,
        execution_digest: syncRes.execution_digest || local.execution_digest,
      });
      store.setSetting(`seoOpsPackageKey:${flow.id}`, syncRes.package_key);
      const rows = await refreshStatusRows({ force: true });
      const unchanged = syncRes.outcome === "no_changes";
      return {
        plan: {
          push_to_remote: unchanged ? [] : [toPlanRow(local)],
          pull_to_local: [],
          skip: unchanged ? [{ script_id: flow.id, reason: "no_changes" }] : [],
          conflicts: [],
        },
        results: [{ script_id: flow.id, action: unchanged ? "unchanged" : "push", ok: true, message: syncRes.outcome }],
        rows,
        summary: {
          published: unchanged ? 0 : 1,
          downloaded: 0,
          unchanged: unchanged ? 1 : 0,
          blocked: 0,
          failed: 0,
          reports_downloaded: 0,
        },
      };
    })();

    syncAllInFlight = run.finally(() => { syncAllInFlight = null; });
    return syncAllInFlight;
  }

  async function syncNewVersion(flowId: string) {
    if (!tokenStore.getToken()) throw new Error("SEO_OPS: cần đăng nhập trước khi sync");
    const existingFlight = newVersionInFlight.get(flowId);
    if (existingFlight) return existingFlight;

    const run = (async () => {
      const predecessor = store.flows().find((f) => f.id === flowId);
      if (!predecessor) throw new Error("Không tìm thấy Script để tạo phiên bản mới.");
      if (predecessor.disabled && !store.setting(`seoOpsNewVersionIdem:${predecessor.id}`)) {
        throw new Error("Script đã ở trạng thái Disabled.");
      }

      const stored = loadReleaseMeta(predecessor.id);
      const local = await localRow(predecessor, stored.version || "1");
      if (local.incomplete || !local.publish_body) {
        return {
          ok: false,
          predecessorId: predecessor.id,
          error: publishBlockerMessage(local.incomplete_reasons || ["incomplete"]),
        };
      }

      const idemKeySetting = `seoOpsNewVersionIdem:${predecessor.id}`;
      let idempotencyKey = store.setting(idemKeySetting);
      if (!idempotencyKey) {
        idempotencyKey = `nv:${predecessor.id}:${randomUUID()}`;
        store.setSetting(idemKeySetting, idempotencyKey);
      }

      const successorManifest: Record<string, unknown> = {
        ...(local.publish_body.manifest as unknown as Record<string, unknown>),
      };
      delete successorManifest.video_demo;
      delete successorManifest.script_request_id;

      const successorName = nextSuccessorName(predecessor.name, store.flows().map((f) => f.name));
      const client = syncClient();

      let syncRes: Awaited<ReturnType<typeof client.sync>>;
      try {
        syncRes = await client.sync({
          mode: "new_version",
          source_package_key: local.package_key,
          name: successorName,
          schema_version: 1,
          runtime_compatibility: local.publish_body.runtime_compatibility,
          dependencies: [],
          manifest: successorManifest,
          idempotency_key: idempotencyKey,
        });
      } catch (err) {
        // Keep idempotency_key for safe network retry.
        return {
          ok: false,
          predecessorId: predecessor.id,
          error: String((err as Error).message || err),
        };
      }

      if (!syncRes.ok) {
        if (syncRes.httpStatus === 404 || syncRes.httpStatus === 422) {
          store.db.prepare("DELETE FROM settings WHERE key = ?").run(idemKeySetting);
        }
        return {
          ok: false,
          predecessorId: predecessor.id,
          error: mapSeoOpsApiErrors(syncRes.errors, `HTTP ${syncRes.httpStatus}`),
        };
      }

      if (syncRes.assets_complete === false && local.publish_body.manifest.assets.length > 0) {
        const assetRes = await uploadReleaseAssets(
          client,
          syncRes.package_key,
          syncRes.version,
          local.publish_body.manifest.assets,
        );
        if (!assetRes.ok) {
          return {
            ok: false,
            predecessorId: predecessor.id,
            error: assetRes.message || "Asset upload failed",
          };
        }
      }

      const successorId = syncRes.script_id || syncRes.package_key;
      const resolvedName = String((syncRes.release?.name as string | undefined) || successorName);
      try {
        const existingSuccessor = store.flows().find((f) => f.id === successorId);
        const successor: Flow = existingSuccessor
          ? { ...existingSuccessor, disabled: false, predecessorFlowId: predecessor.id }
          : {
              id: successorId,
              name: resolvedName,
              zoom: predecessor.zoom,
              steps: structuredClone(predecessor.steps),
              ...(predecessor.variables ? { variables: structuredClone(predecessor.variables) } : {}),
              ...(predecessor.defaultPattern ? { defaultPattern: structuredClone(predecessor.defaultPattern) } : {}),
              ...(predecessor.placeholders ? { placeholders: structuredClone(predecessor.placeholders) } : {}),
              ...(predecessor.groups ? { groups: structuredClone(predecessor.groups) } : {}),
              ...(predecessor.actionTagId !== undefined ? { actionTagId: predecessor.actionTagId } : {}),
              ...(predecessor.actionTagKey ? { actionTagKey: predecessor.actionTagKey } : {}),
              ...(predecessor.resultType ? { resultType: predecessor.resultType } : {}),
              ...(predecessor.collectionType ? { collectionType: predecessor.collectionType } : {}),
              ...(predecessor.pathInputs ? { pathInputs: structuredClone(predecessor.pathInputs) } : {}),
              ...(predecessor.urlPattern ? { urlPattern: predecessor.urlPattern } : {}),
              ...(predecessor.pathInputValues ? { pathInputValues: structuredClone(predecessor.pathInputValues) } : {}),
              ...(predecessor.startUrl ? { startUrl: predecessor.startUrl } : {}),
              predecessorFlowId: predecessor.id,
              disabled: false,
            };
        store.saveFlow(successor);
        store.setSetting(`seoOpsPackageKey:${successor.id}`, syncRes.package_key);
        store.setSetting(`seoOpsVersion:${successor.id}`, syncRes.version);
        if (syncRes.content_digest) store.setSetting(`seoOpsPublishedDigest:${successor.id}`, syncRes.content_digest);
        if (syncRes.execution_digest) store.setSetting(`seoOpsPublishedExecutionDigest:${successor.id}`, syncRes.execution_digest);
        // Clear any Demo association on successor.
        store.db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`videoDemo:${successor.id}%`);

        // Disable predecessor locally only after Backend + successor persistence succeed.
        store.saveFlow({
          ...predecessor,
          disabled: true,
          supersededByFlowId: successor.id,
        });
        if (predecessor.actionTagKey) {
          try {
            const active = JSON.parse(store.setting("activeScriptsByTag") || "{}") as Record<string, string>;
            if (active[predecessor.actionTagKey] === predecessor.id) {
              delete active[predecessor.actionTagKey];
              store.setSetting("activeScriptsByTag", JSON.stringify(active));
            }
          } catch { /* ignore */ }
        }
        store.db.prepare("DELETE FROM settings WHERE key = ?").run(idemKeySetting);
      } catch (localErr) {
        // Keep idempotency_key so retry reconciles without creating a duplicate successor on Backend.
        return {
          ok: false,
          predecessorId: predecessor.id,
          successorId,
          error: `Backend đã tạo phiên bản mới nhưng lưu local thất bại (${String((localErr as Error).message || localErr)}). Bấm thử lại để đồng bộ.`,
        };
      }

      const rows = await refreshStatusRows({ force: true }).catch(() => []);
      return {
        ok: true,
        outcome: syncRes.outcome,
        predecessorId: predecessor.id,
        successorId,
        successorName: resolvedName,
        sync: {
          plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] },
          results: [{ script_id: successorId, action: "push", ok: true, message: syncRes.outcome }],
          rows,
          summary: { published: 1, downloaded: 0, unchanged: 0, blocked: 0, failed: 0, reports_downloaded: 0 },
        },
      };
    })();

    newVersionInFlight.set(flowId, run);
    try {
      return await run;
    } finally {
      newVersionInFlight.delete(flowId);
    }
  }

  function reassignActionTag(input: {
    flowId: string;
    destinationTagKey: string;
    destinationTagId?: number;
    allowDestinationSiblings?: boolean;
  }) {
    let activeScriptsByTag: Record<string, string> = {};
    try {
      activeScriptsByTag = JSON.parse(store.setting("activeScriptsByTag") || "{}") as Record<string, string>;
    } catch {
      activeScriptsByTag = {};
    }
    const plan = planActionTagReassignment({
      flow: store.flows().find((f) => f.id === input.flowId),
      tags: getEffectiveActionTags(),
      flows: store.flows(),
      activeScriptsByTag,
      destinationTagKey: input.destinationTagKey,
      destinationTagId: input.destinationTagId,
      allowDestinationSiblings: input.allowDestinationSiblings,
    });
    if (!plan.ok) return { ok: false as const, conflict: plan.conflict };

    store.db.exec("BEGIN IMMEDIATE");
    try {
      const flow = store.flows().find((f) => f.id === input.flowId);
      if (!flow) throw new Error("FLOW_NOT_FOUND");
      const previousTagKey = flow.actionTagKey;
      store.updateFlowMeta(flow.id, {
        actionTagKey: plan.nextTagKey,
        actionTagId: plan.nextTagId,
      });
      // Drop Active binding for the old tag if this Script held it. Do not auto-activate destination.
      if (previousTagKey && activeScriptsByTag[previousTagKey] === flow.id) {
        delete activeScriptsByTag[previousTagKey];
        store.setSetting("activeScriptsByTag", JSON.stringify(activeScriptsByTag));
      }
      // Force Sync status to reflect local change vs remote package (same script_id/package_key).
      store.db.prepare("DELETE FROM settings WHERE key = ?").run(`seoOpsPublishedDigest:${flow.id}`);
      store.db.prepare("DELETE FROM settings WHERE key = ?").run(`seoOpsPublishedExecutionDigest:${flow.id}`);
      const meta = loadMeta();
      meta.rows[flow.id] = {
        ...(meta.rows[flow.id] ?? {
          script_id: flow.id,
          package_key: flow.id,
          name: flow.name,
          status: "local_changes",
        }),
        status: "local_changes",
        last_result: "action_tag_reassigned",
        message: `Action Tag → ${plan.nextTagKey}; cần Sync để cập nhật SEO-OPS`,
        incomplete: false,
      };
      saveMeta(meta);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    statusRowsCached = null;
    statusRowsCachedAt = 0;
    return {
      ok: true as const,
      plan,
      flow: store.flows().find((f) => f.id === input.flowId),
    };
  }

  return {
    config,
    setConfig,
    sessionState,
    login,
    logout,
    refreshStatusRows,
    syncAll,
    syncFlowNormal,
    syncNewVersion,
    reassignActionTag,
    loadMeta,
    backupNow,
    markBackupDirty,
    backupInfo,
    downloadBackup,
    fetchActionTags,
    refreshActionTags,
    areActionTagsStale,
    syncActionTags,
    getCachedActionTags,
    getEffectiveActionTags,
    fetchScriptRequests,
    getCachedScriptRequests,
    createScriptFromRequest,
    metadataGateStats: () => metadataGate.stats(),
    resetMetadataGateForTests: () => {
      metadataGate.resetForTests();
      statusRowsCached = null;
      statusRowsCachedAt = 0;
    },
  };
}

export type SeoOpsSyncService = ReturnType<typeof createSeoOpsSyncService>;
