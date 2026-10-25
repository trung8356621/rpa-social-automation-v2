import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";

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
      if (address.endsWith("/backup")) return Response.json({ ok: true });
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
    assert.deepEqual(sync.summary, { backed_up: 2, published: 0, unchanged: 0, blocked: 2, failed: 0, reports: 0 });
    const blocked = sync.results.filter(result => result.action === "publish_blocked");
    assert.equal(blocked.length, 2);
    assert.match(blocked.find(result => result.script_id !== store.flow()?.id)?.message ?? "", /No Steps.*Missing demo/);
    assert.match(blocked.find(result => result.script_id === store.flow()?.id)?.message ?? "", /Missing demo/);
  } finally {
    globalThis.fetch = originalFetch; store.close(); await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
