/**
 * Read-only live verification: local QA SQLite vs SEO-OPS catalog/pull/asset.
 * Never prints Authorization headers or token contents.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const profile = path.join(root, ".local/qa-profile-facebook-sandbox");
const tokenPath = path.join(profile, "seo-ops-rpa-admin.token");
const dbPath = path.join(profile, "creator.sqlite");
const assetDir = path.join(profile, "targets");
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";

const SCRIPT_NAME = "Sandbox QA Facebook browser probe";
const EXPECTED_TAG = "qa_sandbox_facebook.qa_sandbox_facebook_publish";

function sanitizeBody(text, ct) {
  const trimmed = String(text || "").slice(0, 4000);
  if (/html/i.test(ct) || /^\s*</.test(trimmed)) {
    return { kind: "html", length: text.length, preview: trimmed.replace(/\s+/g, " ").slice(0, 180) };
  }
  try {
    const json = JSON.parse(text);
    // Strip any accidental secret-looking keys.
    const walk = (v) => {
      if (!v || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (/token|password|authorization|secret|cookie/i.test(k)) out[k] = "[redacted]";
        else out[k] = walk(val);
      }
      return out;
    };
    return { kind: "json", body: walk(json) };
  } catch {
    return { kind: "text", preview: trimmed.replace(/\s+/g, " ").slice(0, 180) };
  }
}

async function api(method, route, body) {
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("token file empty");
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
  return {
    method,
    route,
    status: res.status,
    contentType: ct,
    response: sanitizeBody(text, ct),
    rawText: text,
  };
}

function loadLocal() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const flows = db.prepare("SELECT id, payload FROM flows").all().map((r) => ({
    id: r.id,
    ...(JSON.parse(r.payload)),
  }));
  const settings = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]),
  );
  const steps = db.prepare("SELECT id, version, payload FROM steps").all().map((r) => ({
    id: r.id,
    version: r.version,
    ...(JSON.parse(r.payload)),
  }));
  db.close();
  return { flows, settings, steps };
}

function stepHasOcrMatch(step) {
  const payload = step?.payload || {};
  const target = payload.target || {};
  const ocr = target.ocr || payload.ocr;
  const matchTo = target.matchTo || payload.matchTo || ocr?.matchTo;
  return {
    hasOcr: !!(ocr && (ocr.text || ocr.confirmed)),
    hasMatchTo: !!matchTo,
    ocrText: ocr?.text ? String(ocr.text).slice(0, 40) : null,
    asset: target.asset || null,
  };
}

const local = loadLocal();
const sandbox = local.flows.find((f) => f.name === SCRIPT_NAME || f.actionTagKey === EXPECTED_TAG);
const byName = local.flows.find((f) => f.name === SCRIPT_NAME);

const focus = byName || sandbox;
if (!focus) {
  console.log(JSON.stringify({ error: "local_script_not_found", flowNames: local.flows.map((f) => f.name) }, null, 2));
  process.exit(1);
}

const localStepRefs = focus.steps || [];
const localSteps = localStepRefs.map((ref) => {
  const full = local.steps.find((s) => s.id === ref.id && Number(s.version) === Number(ref.version));
  return { ref, full, checks: full ? stepHasOcrMatch(full) : { missing: true } };
});

const localAssets = [];
for (const s of localSteps) {
  const asset = s.checks?.asset;
  if (!asset) continue;
  const abs = path.join(assetDir, asset);
  const exists = fs.existsSync(abs);
  localAssets.push({
    path: asset,
    exists,
    sha256: exists ? createHash("sha256").update(fs.readFileSync(abs)).digest("hex") : null,
    bytes: exists ? fs.statSync(abs).size : 0,
  });
}

const localMeta = {
  id: focus.id,
  name: focus.name,
  actionTagKey: focus.actionTagKey,
  actionTagId: focus.actionTagId,
  disabled: !!focus.disabled,
  stepCount: localStepRefs.length,
  steps: localSteps.map((s) => ({
    id: s.ref.id,
    version: s.ref.version,
    name: s.full?.name,
    ...s.checks,
  })),
  assets: localAssets,
  settings: {
    packageKey: local.settings[`seoOpsPackageKey:${focus.id}`] || null,
    version: local.settings[`seoOpsVersion:${focus.id}`] || null,
    publishedDigest: local.settings[`seoOpsPublishedDigest:${focus.id}`] || null,
    publishedExecDigest: local.settings[`seoOpsPublishedExecutionDigest:${focus.id}`] || null,
    activeScriptsByTag: (() => {
      try { return JSON.parse(local.settings.activeScriptsByTag || "{}"); } catch { return {}; }
    })(),
  },
};

// Sync meta row if present
let syncMetaRow = null;
try {
  const metaRaw = local.settings.seoOpsSyncMeta || local.settings["seoOps:syncMeta"];
  if (metaRaw) {
    const meta = JSON.parse(metaRaw);
    syncMetaRow = meta.rows?.[focus.id] || meta.rows?.[localMeta.settings.packageKey] || null;
  }
} catch { /* ignore */ }

// Also search settings keys for sync status cache
const syncKeys = Object.keys(local.settings).filter((k) => /seoOps|sync/i.test(k) && k.includes(focus.id));
for (const k of Object.keys(local.settings)) {
  if (/seoOpsSync/i.test(k) && !syncMetaRow) {
    try {
      const parsed = JSON.parse(local.settings[k]);
      if (parsed?.rows?.[focus.id]) syncMetaRow = parsed.rows[focus.id];
    } catch { /* ignore */ }
  }
}

console.log("=== LOCAL ===");
console.log(JSON.stringify({ localMeta, syncMetaRow, syncKeys }, null, 2));

console.log("=== LIVE API (read-only) ===");
const catalog = await api("GET", "/scripts");
console.log(JSON.stringify({ catalog: { status: catalog.status, contentType: catalog.contentType, kind: catalog.response.kind } }, null, 2));

let scripts = [];
if (catalog.response.kind === "json" && catalog.response.body?.scripts) {
  scripts = catalog.response.body.scripts;
}

const remoteCandidates = scripts.filter((s) =>
  s.script_id === focus.id ||
  s.package_key === focus.id ||
  s.package_key === localMeta.settings.packageKey ||
  s.script_id === localMeta.settings.packageKey ||
  (s.name && s.name === SCRIPT_NAME) ||
  (s.action_tag_key && s.action_tag_key === EXPECTED_TAG) ||
  (s.manifest?.action_tag_key === EXPECTED_TAG)
);

// Prefer exact id match
const remote =
  scripts.find((s) => s.script_id === focus.id || s.package_key === focus.id) ||
  scripts.find((s) => localMeta.settings.packageKey && (s.script_id === localMeta.settings.packageKey || s.package_key === localMeta.settings.packageKey)) ||
  remoteCandidates[0] ||
  null;

console.log(JSON.stringify({
  catalogCount: scripts.length,
  candidateCount: remoteCandidates.length,
  candidates: remoteCandidates.map((s) => ({
    script_id: s.script_id,
    package_key: s.package_key,
    version: s.version,
    name: s.name,
    action_tag_key: s.action_tag_key || s.manifest?.action_tag_key || null,
    content_digest: s.content_digest,
    execution_digest: s.execution_digest,
    assets_complete: s.assets_complete,
    demo_status: s.demo_status,
  })),
  selected: remote ? {
    script_id: remote.script_id,
    package_key: remote.package_key,
    version: remote.version,
    name: remote.name,
    action_tag_key: remote.action_tag_key || remote.manifest?.action_tag_key || null,
    content_digest: remote.content_digest,
    execution_digest: remote.execution_digest,
    assets_complete: remote.assets_complete,
  } : null,
}, null, 2));

// Probe unified sync endpoint (read-like probe with nonexistent key — expect 404/html or validation)
const syncProbe = await api("POST", "/scripts/sync", {
  mode: "normal",
  package_key: "__probe_no_write__",
  name: "probe",
  schema_version: 1,
  runtime_compatibility: {},
  dependencies: [],
  manifest: { script_id: "__probe_no_write__", steps: [], variables: [], assets: [] },
});
console.log(JSON.stringify({
  syncProbe: {
    status: syncProbe.status,
    contentType: syncProbe.contentType,
    kind: syncProbe.response.kind,
    preview: syncProbe.response.kind === "html" ? syncProbe.response.preview : undefined,
    errors: syncProbe.response.kind === "json" ? syncProbe.response.body?.errors : undefined,
    ok: syncProbe.response.kind === "json" ? syncProbe.response.body?.ok : undefined,
  },
}, null, 2));

if (remote?.package_key && remote?.version) {
  const pull = await api("POST", "/scripts/pull", {
    package_key: remote.package_key,
    version: String(remote.version),
  });
  const pullBody = pull.response.kind === "json" ? pull.response.body : null;
  const release = pullBody?.release || null;
  const manifest = release?.manifest || release || null;
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : [];
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const actionTag =
    manifest?.action_tag_key ||
    release?.action_tag_key ||
    remote.action_tag_key ||
    null;

  const stepChecks = steps.map((st) => {
    const payload = st.payload || {};
    const target = payload.target || {};
    const ocr = target.ocr || payload.ocr;
    const matchTo = target.matchTo || payload.matchTo || ocr?.matchTo;
    return {
      id: st.id,
      version: st.version,
      name: st.name,
      action: payload.action,
      asset: target.asset || null,
      hasOcr: !!(ocr && (ocr.text || ocr.confirmed)),
      ocrText: ocr?.text ? String(ocr.text).slice(0, 40) : null,
      hasMatchTo: !!matchTo,
      matchTo: matchTo || null,
    };
  });

  console.log(JSON.stringify({
    pull: {
      status: pull.status,
      contentType: pull.contentType,
      ok: pullBody?.ok,
      errors: pullBody?.errors,
      assets_complete: pullBody?.assets_complete,
      ready_to_execute: pullBody?.ready_to_execute,
      release: release ? {
        package_key: release.package_key,
        version: release.version,
        name: release.name,
        content_digest: release.content_digest,
        execution_digest: release.execution_digest,
        action_tag_key: actionTag,
        stepCount: steps.length,
        assetCount: assets.length,
        assets: assets.map((a) => ({ path: a.path, sha256: a.sha256, kind: a.kind })),
        steps: stepChecks,
      } : null,
    },
  }, null, 2));

  // Asset GET for each ROI (read-only)
  const assetResults = [];
  for (const a of assets) {
    const q = `/scripts/asset?package_key=${encodeURIComponent(remote.package_key)}&version=${encodeURIComponent(String(remote.version))}&asset_path=${encodeURIComponent(a.path)}`;
    const ar = await api("GET", q);
    const body = ar.response.kind === "json" ? ar.response.body : null;
    const b64 = body?.asset_base64 || body?.content_base64 || null;
    let sha = null;
    let bytes = 0;
    if (typeof b64 === "string" && b64.length) {
      const buf = Buffer.from(b64, "base64");
      bytes = buf.length;
      sha = createHash("sha256").update(buf).digest("hex");
    }
    assetResults.push({
      path: a.path,
      expectedSha: String(a.sha256 || "").toLowerCase(),
      status: ar.status,
      ok: body?.ok,
      errors: body?.errors,
      bytes,
      sha256: sha,
      shaMatch: sha && a.sha256 ? sha === String(a.sha256).toLowerCase() : null,
      localExists: fs.existsSync(path.join(assetDir, a.path)),
      localSha: (() => {
        const p = path.join(assetDir, a.path);
        if (!fs.existsSync(p)) return null;
        return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      })(),
    });
  }
  console.log(JSON.stringify({ assets: assetResults }, null, 2));

  // Digest compare
  console.log(JSON.stringify({
    digests: {
      localPublished: localMeta.settings.publishedDigest,
      remoteContent: release?.content_digest || remote.content_digest || null,
      match: localMeta.settings.publishedDigest && (release?.content_digest || remote.content_digest)
        ? String(localMeta.settings.publishedDigest).toLowerCase() ===
          String(release?.content_digest || remote.content_digest).toLowerCase()
        : null,
      localVersion: localMeta.settings.version,
      remoteVersion: String(remote.version),
      localTag: localMeta.actionTagKey,
      remoteTag: actionTag,
      tagMatch: localMeta.actionTagKey === actionTag,
    },
  }, null, 2));
} else {
  console.log(JSON.stringify({ pull: "skipped_no_remote_match" }, null, 2));
}

// Plan endpoint (read-like with empty / local summary — no publish)
const plan = await api("POST", "/scripts/sync/plan", { local_scripts: [] });
console.log(JSON.stringify({
  plan: {
    status: plan.status,
    contentType: plan.contentType,
    kind: plan.response.kind,
    ok: plan.response.kind === "json" ? plan.response.body?.ok : undefined,
    planSummary: plan.response.kind === "json" ? {
      push: plan.response.body?.plan?.push_to_remote?.length,
      pull: plan.response.body?.plan?.pull_to_local?.length,
      skip: plan.response.body?.plan?.skip?.length,
      conflicts: plan.response.body?.plan?.conflicts?.length,
    } : undefined,
  },
}, null, 2));
