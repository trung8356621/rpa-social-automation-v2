import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildScriptCatalogSnapshot,
  isScriptHealthWarningReason,
} from "../src/shared/script-release.ts";
import { toScriptVideoDemo } from "../src/shared/video-demo.ts";
import { validatePayload } from "../src/main/storage.ts";

const FLOW_ID = "48f48584-75b8-4e01-8bff-20a95be2daba";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const getSetting = (key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
};
const flow = JSON.parse(
  (db.prepare("SELECT payload FROM flows WHERE id = ?").get(FLOW_ID) as { payload: string }).payload,
);
const steps = flow.steps.map((ref: { id: string; version: number }) => {
  const row = db
    .prepare("SELECT payload FROM steps WHERE id = ? AND version = ?")
    .get(ref.id, ref.version) as { payload: string };
  return JSON.parse(row.payload);
});

const health_warnings: string[] = [];
for (const step of steps) {
  try {
    validatePayload(step.payload);
  } catch (e) {
    health_warnings.push(`invalid_step:${step.id}:${String((e as Error).message || e)}`);
  }
}

const assets: Array<{ path: string; sha256: string; kind: "roi" }> = [];
for (const step of steps) {
  const asset = step.payload?.target?.asset as string | undefined;
  if (!asset) continue;
  const assetPath = path.join(".local/creator/targets", asset);
  if (!fs.existsSync(assetPath)) {
    health_warnings.push(`missing_asset:${asset}`);
    continue;
  }
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
const att = rawDemo ? JSON.parse(rawDemo) : null;
const demoFileOk = Boolean(
  att?.artifactRef &&
    fs.existsSync(path.join(".local/creator/test-runs", att.artifactRef)) &&
    fs.statSync(path.join(".local/creator/test-runs", att.artifactRef)).size > 0,
);
const videoDemo = demoFileOk ? toScriptVideoDemo(att) : undefined;
const snap = buildScriptCatalogSnapshot({ flow, steps, version, assets, videoDemo });
const reasons = snap.incomplete_reasons.filter((r) => !isScriptHealthWarningReason(r));
const warnings = [...new Set([...(snap.health_warnings || []), ...health_warnings])];
const incomplete = reasons.length > 0 || !snap.publish_body || !videoDemo;

console.log(
  JSON.stringify(
    {
      name: flow.name,
      demoFileOk,
      publishable: Boolean(snap.publish_body) && !incomplete,
      incomplete,
      incomplete_reasons: reasons,
      health_warnings: warnings,
      health_status: warnings.some((w) => w.startsWith("invalid_step:"))
        ? "invalid_steps"
        : warnings.length
          ? "warnings"
          : "valid",
      publishStepCount: snap.publish_body?.manifest?.steps?.length ?? 0,
      brokenInManifest: Boolean(
        snap.publish_body?.manifest?.steps?.some(
          (s) => (s as { id?: string }).id === "076fa189-83ed-497c-860e-e82e665d429d",
        ),
      ),
      brokenTarget:
        (
          snap.publish_body?.manifest?.steps?.find(
            (s) => (s as { id?: string }).id === "076fa189-83ed-497c-860e-e82e665d429d",
          ) as { target?: unknown } | undefined
        )?.target ?? null,
    },
    null,
    2,
  ),
);
