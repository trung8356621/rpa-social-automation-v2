import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildScriptCatalogSnapshot,
  isScriptHealthWarningReason,
} from "../src/shared/script-release.ts";
import { toScriptVideoDemo } from "../src/shared/video-demo.ts";

const FLOW_ID = "48f48584-75b8-4e01-8bff-20a95be2daba";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const getSetting = (key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
};
const flowRow = db.prepare("SELECT payload FROM flows WHERE id = ?").get(FLOW_ID) as
  | { payload: string }
  | undefined;
if (!flowRow) {
  console.log(JSON.stringify({ error: "flow_not_found", FLOW_ID }));
  process.exit(1);
}
const flow = JSON.parse(flowRow.payload);
const steps = flow.steps
  .map((ref: { id: string; version: number }) => {
    const row = db
      .prepare("SELECT payload FROM steps WHERE id = ? AND version = ?")
      .get(ref.id, ref.version) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  })
  .filter(Boolean);
const assets: Array<{ path: string; sha256: string; kind: "roi" }> = [];
for (const step of steps) {
  const asset = step.payload?.target?.asset as string | undefined;
  if (!asset) continue;
  const assetPath = path.join(".local/creator/targets", asset);
  if (!fs.existsSync(assetPath)) continue;
  const buf = fs.readFileSync(assetPath);
  assets.push({
    path: asset,
    sha256: createHash("sha256").update(buf).digest("hex"),
    kind: "roi",
  });
}
const version = getSetting(`seoOpsVersion:${FLOW_ID}`) || "1";
const rawDemo =
  getSetting(`videoDemo:${FLOW_ID}`) || getSetting(`videoDemo:${FLOW_ID}:${version}`);
let videoDemo;
let demoFileOk = false;
let demoError: string | null = null;
if (rawDemo) {
  const att = JSON.parse(rawDemo);
  const videoAbs = path.join(".local/creator/test-runs", att.artifactRef);
  demoFileOk = fs.existsSync(videoAbs) && fs.statSync(videoAbs).size > 0;
  try {
    videoDemo = toScriptVideoDemo(att);
  } catch (e) {
    demoError = String((e as Error).message || e);
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
  (s) => (s as { id?: string }).id === "076fa189-83ed-497c-860e-e82e665d429d",
) as { target?: unknown } | undefined;
console.log(
  JSON.stringify(
    {
      name: flow.name,
      stepCount: flow.steps.length,
      stepIds: flow.steps.map((s: { id: string }) => s.id),
      assetsIncluded: assets.length,
      hasStoredDemo: Boolean(rawDemo),
      demoFileOk,
      demoError,
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
