import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { promoteScriptDemoFiles } from "../src/main/script-demo-store.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { buildScriptCatalogSnapshot } from "../src/shared/script-release.js";
import { attachVideoDemo } from "../src/shared/video-demo.js";

const caseId = "11111111-1111-1111-1111-111111111111";
const run1 = "22222222-2222-2222-2222-222222222222";
const run2 = "33333333-3333-3333-3333-333333333333";

test("selected Test Run demo persists, survives newer runs, updates explicitly, and reports outdated/missing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-demo-link-"));
  const database = path.join(root, "creator.sqlite"), evidence = path.join(root, "test-runs"), assets = path.join(root, "targets");
  await mkdir(assets, { recursive: true });
  let store = new Store(database);
  try {
    const flow = store.newFlow("Demo Scenario", 1);
    const step1 = store.saveStep("Wait", { action: "SLEEP", sleepMs: 10 });
    const current = store.flow()!;
    const digest1 = buildScriptCatalogSnapshot({ flow: current, steps: [step1], version: "1.0.0", assets: [] }).execution_digest;
    async function source(runId: string, value: string) {
      const directory = path.join(evidence, caseId, runId); await mkdir(directory, { recursive: true });
      const video = path.join(directory, "recording.webm"), thumb = path.join(directory, "recording-thumb.jpg");
      await writeFile(video, `video-${value}`); await writeFile(thumb, `thumb-${value}`); return { video, thumb };
    }
    const firstSource = await source(run1, "one");
    const firstRefs = await promoteScriptDemoFiles({ testRunsDir: evidence, flowId: flow.id, runId: run1,
      videoSource: firstSource.video, thumbnailSource: firstSource.thumb });
    const first = attachVideoDemo({ scriptId: flow.id, scriptVersion: "1.0.0", caseId, testRunId: run1,
      executionDigest: digest1, reviewed: true, ...firstRefs, stepVersions: current.steps, selectedAt: new Date().toISOString() });
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify(first));
    store.close();

    store = new Store(database);
    assert.equal(JSON.parse(store.setting(`videoDemo:${flow.id}`)!).testRunId, run1);
    const secondSource = await source(run2, "two");
    const secondRefs = await promoteScriptDemoFiles({ testRunsDir: evidence, flowId: flow.id, runId: run2,
      videoSource: secondSource.video, thumbnailSource: secondSource.thumb });
    assert.equal(JSON.parse(store.setting(`videoDemo:${flow.id}`)!).testRunId, run1, "new run must not replace selection");
    assert.equal(await readFile(path.join(evidence, first.artifactRef), "utf8"), "video-one");

    let token: string | null = null;
    const service = createSeoOpsSyncService({ store, assetDir: assets, testRunsDir: evidence,
      tokenStore: { getToken: () => token, setToken: value => { token = value; } } });
    assert.equal((await service.refreshStatusRows()).find(row => row.script_id === flow.id)?.demo_status, "ready");

    const step2 = store.saveStep("Wait", { action: "SLEEP", sleepMs: 20 }, step1.id);
    assert.equal((await service.refreshStatusRows()).find(row => row.script_id === flow.id)?.demo_status, "outdated");
    const changed = store.flow()!;
    const digest2 = buildScriptCatalogSnapshot({ flow: changed, steps: [step2], version: "1.0.0", assets: [] }).execution_digest;
    const second = attachVideoDemo({ scriptId: flow.id, scriptVersion: "1.0.0", caseId, testRunId: run2,
      executionDigest: digest2, reviewed: true, ...secondRefs, stepVersions: changed.steps, selectedAt: new Date().toISOString() });
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify(second));
    assert.equal((await service.refreshStatusRows()).find(row => row.script_id === flow.id)?.demo_status, "ready");
    assert.equal(JSON.parse(store.setting(`videoDemo:${flow.id}`)!).testRunId, run2);
    const selectedMetadata = store.setting(`videoDemo:${flow.id}`)!;
    const originalFetch = globalThis.fetch;
    let publishedVersion = "";
    let publishCalls = 0;
    token = "test-token";
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith("/scripts")) {
        return new Response(JSON.stringify({ ok: true, scripts: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (address.endsWith("/scripts/sync/plan")) {
        const body = JSON.parse(String(init?.body)) as { local_scripts: unknown[] };
        return new Response(JSON.stringify({ ok: true, plan: { push_to_remote: body.local_scripts, pull_to_local: [], skip: [], conflicts: [] } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (address.endsWith("/scripts/publish")) {
        publishCalls++;
        publishedVersion = String((JSON.parse(String(init?.body)) as { version?: unknown }).version ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (address.endsWith("/scripts/video-demo")) return new Response(JSON.stringify({ ok: false, errors: ["test upload failure"] }), { status: 500 });
      throw new Error(`Unexpected test URL: ${address}`);
    };
    try {
      const sync = await service.syncAll({ flowId: flow.id, version: "1.0.0" });
      const push = sync.results.find(result => result.action === "push");
      assert.equal(push?.ok, false, "metadata publish must not count as success when video transfer fails");
      assert.equal(publishedVersion, "1", "Admin assigns version 1 without user input");
      assert.match(push?.message ?? "", /video upload failed/);
      assert.equal(store.setting(`videoDemo:${flow.id}`), selectedMetadata);
      assert.equal(await readFile(path.join(evidence, second.artifactRef), "utf8"), "video-two");
      await service.syncAll({ flowId: flow.id });
      assert.equal(publishCalls, 2, "interrupted media upload retries the same immutable release");
      assert.equal(publishedVersion, "1", "retry does not allocate a duplicate version");
    } finally { globalThis.fetch = originalFetch; token = null; }
    await unlink(path.join(evidence, second.artifactRef));
    assert.equal((await service.refreshStatusRows()).find(row => row.script_id === flow.id)?.demo_status, "error");
    assert.equal(JSON.parse(store.setting(`videoDemo:${flow.id}`)!).testRunId, run2, "status checks must preserve metadata");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
