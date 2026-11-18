import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const root = process.cwd();
const { Store } = await import(pathToFileURL(path.join(root, "dist/main/storage.js")).href);
const {
  buildScriptCatalogSnapshot,
} = await import(pathToFileURL(path.join(root, "dist/shared/script-release.js")).href);
const { attachVideoDemo } = await import(
  pathToFileURL(path.join(root, "dist/shared/video-demo.js")).href
).catch(() => ({ attachVideoDemo: null }));

const store = new Store(path.join(root, ".local/creator/creator.sqlite"));
const flowId = "48f48584-75b8-4e01-8bff-20a95be2daba";
const flow = store.flows().find((f) => f.id === flowId);
const steps = flow.steps.map((ref) => store.step(ref.id, ref.version));
const assets = [];
for (const step of steps) {
  const asset = step.payload?.target?.asset;
  if (!asset) continue;
  const file = path.join(root, ".local/creator/targets", asset);
  if (!fs.existsSync(file)) {
    console.log("missing asset", asset);
    continue;
  }
  const buf = fs.readFileSync(file);
  const crypto = await import("node:crypto");
  assets.push({
    path: `targets/${asset}`,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
  });
}

const publishedExec = store.setting(`seoOpsPublishedExecutionDigest:${flowId}`);
const publishedContent = store.setting(`seoOpsPublishedDigest:${flowId}`);
const pending = JSON.parse(store.setting(`seoOpsPendingRelease:${flowId}`) || "{}");
const demo = JSON.parse(store.setting(`videoDemo:${flowId}`) || "null");

const snapV1 = buildScriptCatalogSnapshot({ flow, steps, version: "1", assets });
const snapV2 = buildScriptCatalogSnapshot({ flow, steps, version: "2", assets });

console.log(
  JSON.stringify(
    {
      name: flow.name,
      tag: flow.actionTagKey,
      stepCount: steps.length,
      assetCount: assets.length,
      published: {
        version: store.setting(`seoOpsVersion:${flowId}`),
        content: publishedContent,
        execution: publishedExec,
      },
      pending,
      demo: demo
        ? {
            scriptVersion: demo.scriptVersion,
            executionDigest: demo.executionDigest,
            reviewed: demo.reviewed,
            stepVersionsMatch:
              JSON.stringify(demo.stepVersions) === JSON.stringify(flow.steps),
          }
        : null,
      current: {
        v1_content: snapV1.content_digest,
        v1_exec: snapV1.execution_digest,
        v2_content: snapV2.content_digest,
        v2_exec: snapV2.execution_digest,
        incomplete_reasons_v2: snapV2.incomplete_reasons,
        matchesPublishedExec: snapV1.execution_digest === publishedExec,
        matchesPendingExec: snapV2.execution_digest === pending.pendingExecutionDigest,
        matchesDemoExec: demo && snapV1.execution_digest === demo.executionDigest,
        demoMatchesCurrent: demo && snapV2.execution_digest === demo.executionDigest,
      },
    },
    null,
    2,
  ),
);
store.close();
