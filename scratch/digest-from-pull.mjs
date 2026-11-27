import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const profile = path.resolve(import.meta.dirname, "../.local/qa-profile-facebook-sandbox");
app.setPath("userData", path.join(profile, "chromium"));
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";
const id = "ea7822b3-ed2b-48e9-ab55-7ec7fe5349a1";
const outFile = path.join(profile, "backups", "pull-release-sandbox-v3.json");

function phpCompatibleJsonStringify(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) return null;
    if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0) return [];
    return item;
  });
}

function computeScriptContentDigest(body) {
  const canonical = {
    package_key: body.package_key,
    kind: body.kind,
    version: body.version,
    schema_version: body.schema_version,
    manifest: body.manifest,
    dependencies: body.dependencies ?? [],
    runtime_compatibility: body.runtime_compatibility ?? {},
  };
  return createHash("sha256").update(phpCompatibleJsonStringify(canonical)).digest("hex");
}

app.whenReady().then(async () => {
  const token = safeStorage.decryptString(fs.readFileSync(path.join(profile, "seo-ops-rpa-admin.token")));
  const res = await fetch(`${base}/scripts/pull`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ package_key: id, version: "3" }),
  });
  const body = await res.json();
  const release = body.release || {};
  // Persist sanitized release for offline digest analysis (no secrets).
  const sanitized = {
    package_key: release.package_key,
    version: release.version,
    name: release.name,
    kind: release.kind,
    schema_version: release.schema_version,
    content_digest: release.content_digest,
    execution_digest: release.execution_digest,
    action_tag_key: release.action_tag_key || release.manifest?.action_tag_key,
    dependencies: release.dependencies,
    runtime_compatibility: release.runtime_compatibility,
    manifest: {
      ...(release.manifest || {}),
      // keep steps but strip huge binaries if any
    },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(sanitized, null, 2));

  // Try reconstruct publish-like body from release fields if present
  const publishLike = {
    package_key: release.package_key,
    kind: release.kind || "script",
    version: String(release.version),
    schema_version: release.schema_version ?? 1,
    manifest: release.manifest,
    dependencies: release.dependencies ?? [],
    runtime_compatibility: release.runtime_compatibility ?? {},
  };
  let recomputed = null;
  try {
    recomputed = computeScriptContentDigest(publishLike);
  } catch (e) {
    recomputed = `error:${e.message}`;
  }

  const steps = release.manifest?.steps || [];
  const ocrOk = steps.every((st) => st.target?.ocr?.text || st.target?.ocr?.confirmed);
  const matchOk = steps.every((st) => !!st.target?.matchTo);
  const assetOk = steps.every((st) => !!st.target?.asset);

  console.log(JSON.stringify({
    pullOk: body.ok,
    releaseDigest: release.content_digest,
    recomputedFromPullManifest: recomputed,
    digestMatch: recomputed === release.content_digest,
    manifestActionTag: release.manifest?.action_tag_key || null,
    releaseActionTag: release.action_tag_key || null,
    stepCount: steps.length,
    allHaveOcr: ocrOk,
    allHaveMatchTo: matchOk,
    allHaveAsset: assetOk,
    sampleStep: steps[0] ? {
      id: steps[0].id,
      action: steps[0].action,
      asset: steps[0].target?.asset,
      ocrText: steps[0].target?.ocr?.text,
      matchTo: steps[0].target?.matchTo,
    } : null,
    saved: outFile,
  }, null, 2));
  app.exit(0);
});
