import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { buildScriptCatalogSnapshot } from "../src/shared/script-release.js";
import { attachVideoDemo } from "../src/shared/video-demo.js";

test("empty SEO-OPS catalog reports distinct publish blockers, never unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-sync-summary-"));
  const assets = path.join(root, "targets"); await mkdir(assets);
  const store = new Store(path.join(root, "creator.sqlite"));
  const originalFetch = globalThis.fetch;
  try {
    store.newFlow("No Steps", 1);
    store.newFlow("Missing Demo", 1);
    store.saveStep("Wait", { action: "SLEEP", sleepMs: 10 });
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith("/scripts")) return Response.json({ ok: true, scripts: [] });
      if (address.endsWith("/scripts/sync/plan")) {
        const body = JSON.parse(String(init?.body)) as { local_scripts: unknown[] };
        assert.deepEqual(body.local_scripts, [], "blocked Drafts must not be sent as publish candidates");
        return Response.json({ ok: true, plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] } });
      }
      if (address.includes("/execution-reports")) return Response.json({ ok: true, reports: [], next_after_id: 0 });
      throw new Error(`Unexpected test URL: ${address}`);
    };
    const service = createSeoOpsSyncService({ store, assetDir: assets, dataPath: root,
      tokenStore: { getToken: () => "test-token", setToken: () => undefined } });
    const sync = await service.syncAll();
    assert.deepEqual(sync.summary, { published: 0, downloaded: 0, unchanged: 0, blocked: 2, failed: 0, reports_downloaded: 0 });
    const blocked = sync.results.filter(result => result.action === "publish_blocked");
    assert.equal(blocked.length, 2);
    assert.match(blocked.find(result => result.script_id !== store.flow()?.id)?.message ?? "", /No Steps.*Missing demo/);
    assert.match(blocked.find(result => result.script_id === store.flow()?.id)?.message ?? "", /Missing demo/);
  } finally {
    globalThis.fetch = originalFetch; store.close(); await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("valid isolated v1 publishes to an empty catalog and second sync is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-sync-publish-"));
  const assets = path.join(root, "targets"), evidence = path.join(root, "test-runs");
  await mkdir(assets); await mkdir(evidence);
  const store = new Store(path.join(root, "creator.sqlite"));
  const originalFetch = globalThis.fetch;
  try {
    const flow = store.newFlow("Ready", 1), step = store.saveStep("Wait", { action: "SLEEP", sleepMs: 10 });
    const current = store.flow()!;
    const executionDigest = buildScriptCatalogSnapshot({ flow: current, steps: [step], version: "1", assets: [] }).execution_digest;
    const artifactRef = `${flow.id}/run-1/recording.webm`, thumbnailRef = `${flow.id}/run-1/recording-thumb.jpg`;
    await mkdir(path.join(evidence, flow.id, "run-1"), { recursive: true });
    await writeFile(path.join(evidence, artifactRef), "video"); await writeFile(path.join(evidence, thumbnailRef), "thumb");
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify(attachVideoDemo({ scriptId: flow.id, scriptVersion: "1",
      caseId: "case-1", testRunId: "run-1", executionDigest, reviewed: true, artifactRef, thumbnailRef,
      sha256: "a".repeat(64), stepVersions: current.steps, selectedAt: new Date().toISOString() })));
    let remote: Record<string, unknown> | undefined, publishCalls = 0;
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith("/scripts")) return Response.json({ ok: true, scripts: remote ? [remote] : [] });
      if (address.endsWith("/scripts/sync/plan")) return Response.json({ ok: true, plan: { push_to_remote: [], pull_to_local: [],
        skip: remote ? [{ script_id: flow.id, reason: "same_digest" }] : [], conflicts: [] } });
      if (address.endsWith("/scripts/publish")) {
        publishCalls++; const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        remote = { script_id: flow.id, package_key: flow.id, version: body.version, content_digest: body.content_digest,
          execution_digest: executionDigest, assets_complete: true, demo_status: "ready" };
        return Response.json({ ok: true });
      }
      if (address.endsWith("/scripts/video-demo")) return Response.json({ ok: true });
      if (address.includes("/execution-reports")) return Response.json({ ok: true, reports: [], next_after_id: 0 });
      throw new Error(`Unexpected test URL: ${address}`);
    };
    const service = createSeoOpsSyncService({ store, assetDir: assets, testRunsDir: evidence, dataPath: root,
      tokenStore: { getToken: () => "test-token", setToken: () => undefined } });
    const first = await service.syncAll();
    assert.equal(first.summary.published, 1); assert.equal(first.summary.unchanged, 0);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");
    const second = await service.syncAll();
    assert.equal(second.summary.published, 0); assert.equal(second.summary.unchanged, 1, JSON.stringify(second));
    assert.equal(publishCalls, 1); assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");

    const changedStep = store.saveStep("Wait changed", { action: "SLEEP", sleepMs: 20 }, step.id);
    const changedFlow = store.flow()!;
    const changedDigest = buildScriptCatalogSnapshot({ flow: changedFlow, steps: [changedStep], version: "2", assets: [] }).execution_digest;
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify(attachVideoDemo({ scriptId: flow.id, scriptVersion: "2",
      caseId: "case-1", testRunId: "run-1", executionDigest: changedDigest, reviewed: true, artifactRef, thumbnailRef,
      sha256: "a".repeat(64), stepVersions: changedFlow.steps, selectedAt: new Date().toISOString() })));
    const third = await service.syncAll();
    assert.equal(third.summary.published, 1, JSON.stringify(third));
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "2");
    const fourth = await service.syncAll();
    assert.equal(fourth.summary.published, 0); assert.equal(fourth.summary.unchanged, 1, JSON.stringify(fourth));
    assert.equal(publishCalls, 2, "changed release publishes v2 once and never creates v3");
  } finally {
    globalThis.fetch = originalFetch; store.close(); await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
