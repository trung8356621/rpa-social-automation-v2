/** Offline: recompute content digests for Sandbox Script with current vs old tag. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const profile = path.join(root, ".local/qa-profile-facebook-sandbox");
const dbPath = path.join(profile, "creator.sqlite");
const assetDir = path.join(profile, "targets");

const { buildScriptPublishBody } = await import(pathToFileURL(path.join(root, "src/shared/script-release.ts")).href);
const { computeScriptContentDigest } = await import(pathToFileURL(path.join(root, "src/shared/script-digest.ts")).href);

const db = new DatabaseSync(dbPath, { readOnly: true });
const flows = db.prepare("SELECT id, payload FROM flows").all().map((r) => ({ id: r.id, ...JSON.parse(r.payload) }));
const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
const stepsRows = db.prepare("SELECT id, version, payload FROM steps").all().map((r) => ({
  id: r.id, version: r.version, ...JSON.parse(r.payload),
}));
db.close();

const focus = flows.find((f) => f.name === "Sandbox QA Facebook browser probe");
const version = settings[`seoOpsVersion:${focus.id}`] || "3";
const steps = focus.steps.map((ref) => stepsRows.find((s) => s.id === ref.id && Number(s.version) === Number(ref.version))).filter(Boolean);
const assets = [];
for (const st of steps) {
  const asset = st.payload?.target?.asset;
  if (!asset) continue;
  const abs = path.join(assetDir, asset);
  if (!fs.existsSync(abs)) continue;
  const buf = fs.readFileSync(abs);
  assets.push({ path: asset, sha256: createHash("sha256").update(buf).digest("hex"), kind: "roi" });
}

const current = buildScriptPublishBody({ flow: focus, steps, version: String(version), assets });
const oldTagFlow = { ...focus, actionTagKey: "facebook.group.post", actionTagId: 5 };
const old = buildScriptPublishBody({ flow: oldTagFlow, steps, version: String(version), assets });

const currentDigest = computeScriptContentDigest(current);
const oldDigest = computeScriptContentDigest(old);
const stored = settings[`seoOpsPublishedDigest:${focus.id}`];

console.log(JSON.stringify({
  currentTag: focus.actionTagKey,
  currentManifestTag: current.manifest.action_tag_key,
  oldManifestTag: old.manifest.action_tag_key,
  currentDigest,
  oldDigest,
  storedPublishedDigest: stored,
  tagChangesDigest: currentDigest !== oldDigest,
  currentEqualsStored: currentDigest === stored,
  oldEqualsStored: oldDigest === stored,
}, null, 2));
