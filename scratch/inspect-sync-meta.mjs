import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const get = (key) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value;
};

const meta = JSON.parse(get("seoOpsSyncMeta") || '{"rows":{}}');
console.log("=== seoOpsSyncMeta full ===");
console.log(JSON.stringify(meta, null, 2));

const flowIds = [
  "48f48584-75b8-4e01-8bff-20a95be2daba",
  "690493bd-a830-4648-83b3-86da1533c77a",
  "facebook-group-post-detail",
];

for (const id of flowIds) {
  const flow = JSON.parse(
    db.prepare("SELECT payload FROM flows WHERE id = ?").get(id)?.payload || "null",
  );
  const demo = get(`videoDemo:${id}`);
  const demoV1 = get(`videoDemo:${id}:1`);
  const demoV2 = get(`videoDemo:${id}:2`);
  const pending = get(`seoOpsPendingRelease:${id}`);
  const version = get(`seoOpsVersion:${id}`);
  const digest = get(`seoOpsPublishedDigest:${id}`);
  const exec = get(`seoOpsPublishedExecutionDigest:${id}`);
  const parsedDemo = demo ? JSON.parse(demo) : null;
  console.log(
    "\n===",
    id,
    "===",
    JSON.stringify(
      {
        name: flow?.name,
        tag: flow?.actionTagKey,
        steps: flow?.steps?.length,
        stepRefs: flow?.steps,
        seoOpsVersion: version,
        publishedDigest: digest?.slice?.(0, 16),
        publishedExec: exec?.slice?.(0, 16),
        pendingRelease: pending ? JSON.parse(pending) : null,
        demoCurrent: parsedDemo
          ? {
              scriptVersion: parsedDemo.scriptVersion,
              reviewed: parsedDemo.reviewed,
              sha256: parsedDemo.sha256?.slice?.(0, 16),
              executionDigest: parsedDemo.executionDigest?.slice?.(0, 16),
              artifactRef: parsedDemo.artifactRef,
              stepVersions: parsedDemo.stepVersions,
            }
          : null,
        hasDemoV1: Boolean(demoV1),
        hasDemoV2: Boolean(demoV2),
      },
      null,
      2,
    ),
  );

  // Check demo file existence
  if (parsedDemo?.artifactRef) {
    const candidates = [
      path.join(".local/creator/test-runs", parsedDemo.artifactRef),
      path.join(".local/creator", parsedDemo.artifactRef),
      path.join(".local", parsedDemo.artifactRef),
    ];
    for (const c of candidates) {
      console.log("  demo file", c, fs.existsSync(c) ? `EXISTS ${fs.statSync(c).size}b` : "MISSING");
    }
  }
}

// Check step assets for Facebook POC
const fb = JSON.parse(
  db.prepare("SELECT payload FROM flows WHERE id = ?").get(flowIds[0]).payload,
);
console.log("\n=== Facebook step asset check ===");
for (const ref of fb.steps || []) {
  const row = db
    .prepare("SELECT payload FROM steps WHERE id = ? AND version = ?")
    .get(ref.id, ref.version);
  if (!row) {
    console.log(ref.id, "v" + ref.version, "STEP ROW MISSING");
    continue;
  }
  const wrap = JSON.parse(row.payload);
  const payload = wrap.payload || wrap;
  const target = payload.target;
  const asset = target?.asset;
  const assetPath = asset ? path.join(".local/creator/targets", asset) : null;
  console.log(
    JSON.stringify({
      id: ref.id,
      version: ref.version,
      name: wrap.name,
      action: payload.action,
      hasTarget: Boolean(target),
      asset,
      assetExists: assetPath ? fs.existsSync(assetPath) : null,
      hasOcr: Boolean(target?.ocr?.text),
      matchTo: target?.matchTo,
    }),
  );
}

console.log("\n=== facebook.group_post_detail step ===");
const detail = JSON.parse(
  db.prepare("SELECT payload FROM flows WHERE id = ?").get(flowIds[2]).payload,
);
for (const ref of detail.steps || []) {
  const row = db
    .prepare("SELECT payload FROM steps WHERE id = ? AND version = ?")
    .get(ref.id, ref.version);
  const wrap = row ? JSON.parse(row.payload) : null;
  const payload = wrap?.payload || wrap;
  console.log(
    JSON.stringify({
      id: ref.id,
      version: ref.version,
      name: wrap?.name,
      action: payload?.action,
      target: payload?.target
        ? {
            asset: payload.target.asset,
            ocr: payload.target.ocr?.text,
            matchTo: payload.target.matchTo,
          }
        : null,
      keys: payload ? Object.keys(payload) : [],
    }),
  );
}
