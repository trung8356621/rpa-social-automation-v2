/**
 * Electron helper: decrypt safeStorage token and run read-only SEO-OPS probes.
 * Prints no token/credentials.
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const profile = path.join(root, ".local/qa-profile-facebook-sandbox");
const chromiumUserData = path.join(profile, "chromium");
app.setPath("userData", fs.existsSync(path.join(chromiumUserData, "Local State")) ? chromiumUserData : profile);

const tokenPath = path.join(profile, "seo-ops-rpa-admin.token");
const dbPath = path.join(profile, "creator.sqlite");
const assetDir = path.join(profile, "targets");
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";
const SCRIPT_NAME = "Sandbox QA Facebook browser probe";
const EXPECTED_TAG = "qa_sandbox_facebook.qa_sandbox_facebook_publish";

function redact(v) {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redact);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = /token|password|authorization|secret|cookie/i.test(k) ? "[redacted]" : redact(val);
  }
  return out;
}

async function api(token, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let parsed = null;
  let kind = "text";
  if (/html/i.test(ct) || /^\s*</.test(text)) kind = "html";
  else {
    try {
      parsed = JSON.parse(text);
      kind = "json";
    } catch {
      kind = "text";
    }
  }
  return {
    method,
    route,
    status: res.status,
    contentType: ct,
    kind,
    body: kind === "json" ? redact(parsed) : undefined,
    preview: kind !== "json" ? text.replace(/\s+/g, " ").slice(0, 220) : undefined,
  };
}

app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.log(JSON.stringify({ error: "safeStorage_unavailable" }));
      app.exit(2);
      return;
    }
    const token = safeStorage.decryptString(fs.readFileSync(tokenPath));
    if (!token) {
      console.log(JSON.stringify({ error: "token_decrypt_empty" }));
      app.exit(3);
      return;
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const flows = db.prepare("SELECT id, payload FROM flows").all().map((r) => ({ id: r.id, ...JSON.parse(r.payload) }));
    const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
    const stepsRows = db.prepare("SELECT id, version, payload FROM steps").all().map((r) => ({
      id: r.id,
      version: r.version,
      ...JSON.parse(r.payload),
    }));
    db.close();

    const focus = flows.find((f) => f.name === SCRIPT_NAME);
    if (!focus) {
      console.log(JSON.stringify({ error: "local_script_missing" }));
      app.exit(4);
      return;
    }
    const syncMeta = JSON.parse(settings.seoOpsSyncMeta || '{"rows":{}}');
    const row = syncMeta.rows?.[focus.id];
    const storedPublished = settings[`seoOpsPublishedDigest:${focus.id}`] || null;
    const version = settings[`seoOpsVersion:${focus.id}`] || null;
    const packageKey = settings[`seoOpsPackageKey:${focus.id}`] || focus.id;

    const localSteps = (focus.steps || []).map((ref) => {
      const full = stepsRows.find((s) => s.id === ref.id && Number(s.version) === Number(ref.version));
      const target = full?.payload?.target || {};
      const ocr = target.ocr;
      const matchTo = target.matchTo || ocr?.matchTo;
      return {
        id: ref.id,
        version: ref.version,
        name: full?.name,
        asset: target.asset || null,
        hasOcr: !!(ocr && (ocr.text || ocr.confirmed)),
        ocrText: ocr?.text ? String(ocr.text).slice(0, 48) : null,
        hasMatchTo: !!matchTo,
        assetExists: target.asset ? fs.existsSync(path.join(assetDir, target.asset)) : false,
      };
    });

    console.log(JSON.stringify({
      local: {
        id: focus.id,
        name: focus.name,
        actionTagKey: focus.actionTagKey,
        actionTagId: focus.actionTagId,
        packageKey,
        version,
        storedPublishedDigest: storedPublished,
        stepCount: localSteps.length,
        steps: localSteps,
        syncMeta: row ? {
          status: row.status,
          last_result: row.last_result,
          message: row.message,
          local_digest: row.local_digest,
          remote_digest: row.remote_digest,
          last_sync_at: row.last_sync_at,
        } : null,
      },
    }, null, 2));

    const catalog = await api(token, "GET", "/scripts");
    const scripts = catalog.body?.scripts || [];
    console.log(JSON.stringify({
      catalog: { status: catalog.status, kind: catalog.kind, count: scripts.length, errors: catalog.body?.errors },
    }, null, 2));

    const remote = scripts.find((s) => s.script_id === focus.id || s.package_key === focus.id)
      || scripts.find((s) => s.package_key === packageKey || s.script_id === packageKey)
      || null;

    // Also list any scripts with expected tag or same name for orphan detection
    const related = scripts.filter((s) =>
      s.name === SCRIPT_NAME ||
      s.action_tag_key === EXPECTED_TAG ||
      s.script_id === focus.id ||
      s.package_key === packageKey
    ).map((s) => ({
      script_id: s.script_id,
      package_key: s.package_key,
      version: s.version,
      name: s.name,
      action_tag_key: s.action_tag_key || null,
      content_digest: s.content_digest,
      assets_complete: s.assets_complete,
      demo_status: s.demo_status,
    }));

    console.log(JSON.stringify({
      remoteCatalogEntry: remote ? {
        script_id: remote.script_id,
        package_key: remote.package_key,
        version: remote.version,
        name: remote.name,
        action_tag_key: remote.action_tag_key || remote.manifest?.action_tag_key || null,
        content_digest: remote.content_digest,
        execution_digest: remote.execution_digest,
        assets_complete: remote.assets_complete,
        demo_status: remote.demo_status,
      } : null,
      related,
      digestVsStored: remote && storedPublished
        ? String(remote.content_digest).toLowerCase() === String(storedPublished).toLowerCase()
        : null,
    }, null, 2));

    const syncProbe = await api(token, "POST", "/scripts/sync", {
      mode: "normal",
      package_key: "__verify_no_write__",
      name: "verify",
      schema_version: 1,
      runtime_compatibility: {},
      dependencies: [],
      manifest: { script_id: "__verify_no_write__", steps: [], variables: [], assets: [] },
    });
    console.log(JSON.stringify({
      syncEndpoint: {
        status: syncProbe.status,
        kind: syncProbe.kind,
        contentType: syncProbe.contentType,
        preview: syncProbe.preview,
        ok: syncProbe.body?.ok,
        errors: syncProbe.body?.errors,
        outcome: syncProbe.body?.outcome,
      },
    }, null, 2));

    if (!remote?.package_key || remote?.version == null) {
      console.log(JSON.stringify({ pull: "skipped_no_remote", comparison: { remoteExists: false } }, null, 2));
      app.exit(0);
      return;
    }

    const pull = await api(token, "POST", "/scripts/pull", {
      package_key: remote.package_key,
      version: String(remote.version),
    });
    const release = pull.body?.release;
    const manifest = release?.manifest || {};
    const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
    const assetsManifest = Array.isArray(manifest.assets) ? manifest.assets : [];
    const tag = manifest.action_tag_key || release?.action_tag_key || remote.action_tag_key || null;

    console.log(JSON.stringify({
      pull: {
        status: pull.status,
        kind: pull.kind,
        ok: pull.body?.ok,
        errors: pull.body?.errors,
        assets_complete: pull.body?.assets_complete,
        ready_to_execute: pull.body?.ready_to_execute,
        package_key: release?.package_key,
        version: release?.version,
        name: release?.name,
        content_digest: release?.content_digest,
        action_tag_key: tag,
        stepCount: steps.length,
        assetCount: assetsManifest.length,
        steps: steps.map((st) => {
          const target = st.payload?.target || {};
          const ocr = target.ocr || st.payload?.ocr;
          const matchTo = target.matchTo || st.payload?.matchTo || ocr?.matchTo;
          return {
            id: st.id,
            version: st.version,
            name: st.name,
            asset: target.asset || null,
            hasOcr: !!(ocr && (ocr.text || ocr.confirmed)),
            ocrText: ocr?.text ? String(ocr.text).slice(0, 48) : null,
            hasMatchTo: !!matchTo,
          };
        }),
        assets: assetsManifest.map((a) => ({ path: a.path, sha256: a.sha256, kind: a.kind })),
      },
    }, null, 2));

    const assetResults = [];
    for (const a of assetsManifest) {
      const q = `/scripts/asset?package_key=${encodeURIComponent(remote.package_key)}&version=${encodeURIComponent(String(remote.version))}&asset_path=${encodeURIComponent(a.path)}`;
      const ar = await api(token, "GET", q);
      const b64 = ar.body?.asset_base64 || ar.body?.content_base64;
      let sha = null;
      let bytes = 0;
      if (typeof b64 === "string" && b64.length) {
        const buf = Buffer.from(b64, "base64");
        bytes = buf.length;
        sha = createHash("sha256").update(buf).digest("hex");
      }
      assetResults.push({
        path: a.path,
        status: ar.status,
        ok: ar.body?.ok,
        errors: ar.body?.errors,
        bytes,
        shaMatch: sha && a.sha256 ? sha === String(a.sha256).toLowerCase() : null,
        localExists: fs.existsSync(path.join(assetDir, a.path)),
      });
    }
    console.log(JSON.stringify({ assetVerification: assetResults }, null, 2));

    // Plan with empty local (read-like)
    const plan = await api(token, "POST", "/scripts/sync/plan", { local_scripts: [] });
    console.log(JSON.stringify({
      plan: {
        status: plan.status,
        kind: plan.kind,
        ok: plan.body?.ok,
        pullCount: plan.body?.plan?.pull_to_local?.length,
        pushCount: plan.body?.plan?.push_to_remote?.length,
      },
    }, null, 2));

    console.log(JSON.stringify({
      comparison: {
        remoteExists: true,
        remoteScriptId: remote.script_id,
        remotePackageKey: remote.package_key,
        remoteTag: tag,
        localTag: focus.actionTagKey,
        tagMatch: tag === focus.actionTagKey,
        expectedTag: EXPECTED_TAG,
        remoteHasExpectedTag: tag === EXPECTED_TAG,
        remoteVersion: String(remote.version),
        localVersion: String(version),
        remoteSteps: steps.length,
        localSteps: focus.steps?.length,
        stepsMatch: steps.length === (focus.steps?.length || 0),
        remoteDigest: release?.content_digest || remote.content_digest,
        storedPublishedDigest: storedPublished,
        digestMatchStored: storedPublished
          ? String(storedPublished).toLowerCase() === String(release?.content_digest || remote.content_digest).toLowerCase()
          : null,
        allRemoteStepsHaveOcr: steps.every((st) => {
          const ocr = st.payload?.target?.ocr || st.payload?.ocr;
          return !!(ocr && (ocr.text || ocr.confirmed));
        }),
        allRemoteStepsHaveMatchTo: steps.every((st) => {
          const target = st.payload?.target || {};
          const ocr = target.ocr || st.payload?.ocr;
          return !!(target.matchTo || st.payload?.matchTo || ocr?.matchTo);
        }),
        allAssetsOk: assetResults.length > 0 && assetResults.every((a) => a.ok && a.shaMatch),
        uiStatusSyncedButNeedsSyncMessage: row?.status === "synced" && /cần Sync/i.test(row?.message || ""),
      },
    }, null, 2));

    app.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack || "").split("\n").slice(0, 8) }));
    app.exit(1);
  }
});
