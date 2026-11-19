import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Prefer compiled dist if present; else fail clearly.
const require = createRequire(import.meta.url);
let buildScriptCatalogSnapshot;
let isScriptHealthWarningReason;
let toScriptVideoDemo;
try {
  ({ buildScriptCatalogSnapshot, isScriptHealthWarningReason } = await import(
    "../dist/shared/script-release.js"
  ));
  ({ toScriptVideoDemo } = await import("../dist/shared/video-demo.js"));
} catch {
  console.error("Need dist/ — run build or use tsx against src.");
  process.exit(2);
}

const FLOW_ID = "48f48584-75b8-4e01-8bff-20a95be2daba";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const get = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const flowRow = db.prepare("SELECT payload FROM flows WHERE id = ?").get(FLOW_ID);
if (!flowProps) {
  console.log(JSON.stringify({ error: "flow_not_found", FLOW_ID }));
  process.exit(1);
}
const flow = JSON.parse(flowProps.payload);
const steps = flow.steps
  .map((ref) => {
    const row = db.prepare("SELECT payload FROM steps WHERE id = ? AND version = ?").get(ref.id, ref.version);
    return row ? JSON.parse(row.payload) : null;
  })
  .filter(Boolean);
const assets = [];
for (const step of steps) {
  const asset = step.payload?.target?.asset;
  if (!asset) continue;
  const p = path.join(".local/creator/targets", asset);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  assets.push({ path: asset, sha256: createHash("sha256").update(buf).digest("hex"), kind: "roi" });
}
const version = get(`seoOpsVersion:${FLOW_ID}`) || "1";
const rawDemo = get(`videoDemo:${FLOW_ID}`) || get(`videoDemo:${FLOW_ID}:${version}`);
let videoDemo;
let demoFileOk = false;
let demoError;
if (rawDemo) {
  const att = JSON.parse(rawDemo);
  const videoAbs = path.join(".local/creator/test-runs", att.artifactRef);
  demoFileOk = fs.existsSync(videoAbs) && fs.statSync(videoAbs).size > 0;
  try {
    videoDemo = toScriptVideoDemo(att);
  } catch (e) {
    demoError = String(e.message || e);
  }
}
const snap = buildScriptCatalogSnapshot({
  flow,
  steps,
  version,
  assets,
  videoDemo: demoFileOk ? videoDemo : undefined,
});
const broken = snap.publish_body?.manifest?.steps?.find(
  (s) => s.id === "076fa189-83ed-497c-860e-e82e665d429d",
);
console.log(
  JSON.stringify(
    {
      name: flow.name,
      stepCount: flow.steps.length,
      stepIds: flow.steps.map((s) => s.id),
      assetsIncluded: assets.length,
      hasStoredDemo: Boolean(rawDemo),
      demoFileOk,
      demoError: demoError || null,
      incomplete: snap.incomplete,
      incomplete_reasons: snap.incomplete_reasons,
      health_warnings: snap.health_warnings,
      publishable: Boolean(snap.publish_body),
      publishStepCount: snap.publish_body?.manifest?.steps?.length ?? 0,
      brokenStepTarget: broken?.target ?? null,
      warningClassifierOk: (snap.health_warnings || []).every(isScriptHealthWarningReason),
    },
    null,
    2,
  ),
);
void require;
