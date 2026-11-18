import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { createSeoOpsMetadataGate } from "../src/shared/seo-ops-metadata-gate.js";
import { applyActionTagsToState } from "../src/renderer/action-tags-refresh.js";
import type { ActionTag, State } from "../src/shared/contracts.js";

test("metadata gate: TTL + in-flight coalesce + hard budget", async () => {
  let now = 1_000_000;
  const gate = createSeoOpsMetadataGate({
    now: () => now,
    maxPerWindow: 3,
    windowMs: 60_000,
    ttlMs: { "action-tags": 60_000 },
  });
  let calls = 0;
  const work = async () => { calls += 1; return { ok: true }; };

  const a = gate.run("action-tags", work, { force: false });
  const b = gate.run("action-tags", work, { force: false });
  await Promise.all([a, b]);
  assert.equal(calls, 1, "concurrent callers share one network request");

  const ttlBlocked = await gate.run("action-tags", work, { force: false });
  assert.equal(ttlBlocked.fromNetwork, false);
  if (!ttlBlocked.fromNetwork) assert.equal(ttlBlocked.blocked.reason, "ttl");
  assert.equal(calls, 1);

  // Force bypasses TTL but still counts toward budget.
  now += 1;
  assert.equal((await gate.run("action-tags", work, { force: true })).fromNetwork, true);
  assert.equal((await gate.run("action-tags", work, { force: true })).fromNetwork, true);
  assert.equal(calls, 3);

  const budgetBlocked = await gate.run("action-tags", work, { force: true });
  assert.equal(budgetBlocked.fromNetwork, false);
  if (!budgetBlocked.fromNetwork) assert.equal(budgetBlocked.blocked.reason, "budget");
  assert.equal(calls, 3);
});

test("metadata gate: 429 sets backoff that blocks force", async () => {
  let now = 5_000_000;
  const gate = createSeoOpsMetadataGate({
    now: () => now,
    defaultBackoffMs: 10_000,
    maxPerWindow: 20,
    ttlMs: { "action-tags": 1 },
  });
  await assert.rejects(
    () => gate.run("action-tags", async () => {
      throw new Error("SEO_OPS_HTTP: GET /action-tags status=429 category=rate_limited retry-after=30");
    }, { force: true }),
  );
  const blocked = await gate.run("action-tags", async () => ({ ok: true }), { force: true });
  assert.equal(blocked.fromNetwork, false);
  if (!blocked.fromNetwork) assert.equal(blocked.blocked.reason, "backoff");
  now += 31_000;
  const ok = await gate.run("action-tags", async () => ({ ok: true }), { force: true });
  assert.equal(ok.fromNetwork, true);
});

test("applyActionTagsToState never replaces flows/steps identity", () => {
  const steps = [{ id: "s1", version: 1 }];
  const flow = { id: "f1", name: "dd", zoom: 1, steps };
  const state = {
    appPage: "creator",
    flow,
    flows: [flow],
    steps: [],
    actionTags: [{ id: 1, tag_key: "facebook.group.post", platform: "facebook", target: "group", action: "post", name: "Post" }],
  } as unknown as State;
  const nextSnapshot = {
    ...state,
    flow: { ...flow, steps: [...steps] },
    flows: [{ ...flow, steps: [...steps] }],
    actionTags: [
      { id: 1, tag_key: "facebook.group.post", platform: "facebook", target: "group", action: "post", name: "Post" },
      { id: 11, tag_key: "mayhopphat.login", platform: "mayhopphat", target: "login", action: "", name: "Login" },
    ] as ActionTag[],
  } as unknown as State;

  const patched = applyActionTagsToState(state, nextSnapshot.actionTags!, nextSnapshot)!;
  assert.equal(patched.flow, state.flow);
  assert.equal(patched.flows, state.flows);
  assert.equal(patched.actionTags?.length, 2);
  assert.ok(patched.actionTags?.some(t => t.tag_key === "mayhopphat.login"));
});

test("100 refreshActionTags callers → bounded /action-tags hits", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-storm-"));
  const store = new Store(path.join(tmpDir, "creator.sqlite"));
  let token: string | null = "storm-token";
  const tokenStore = {
    getToken: () => token,
    setToken: (t: string | null) => { token = t; },
  };

  let actionTagHits = 0;
  let catalogHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.endsWith("/action-tags")) {
      actionTagHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        action_tags: [
          { id: 1, tag_key: "facebook.group.post", platform: "facebook", target: "group", action: "post", name: "Post" },
          { id: 11, tag_key: "mayhopphat.login", platform: "mayhopphat", target: "login", action: "", action_key: null, name: "Login" },
        ],
      }));
      return;
    }
    if (url.pathname.endsWith("/scripts") && req.method === "GET") {
      catalogHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scripts: [] }));
      return;
    }
    if (url.pathname.endsWith("/scripts/sync/plan")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, plan: { push_to_remote: [], pull_to_local: [], skip: [], conflicts: [] } }));
      return;
    }
    if (url.pathname.endsWith("/script-requests")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, script_requests: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");

  const service = createSeoOpsSyncService({
    store,
    assetDir: path.join(tmpDir, "targets"),
    tokenStore,
    dataPath: tmpDir,
  });
  service.setConfig(`http://127.0.0.1:${addr.port}`);
  service.resetMetadataGateForTests();

  try {
    // Simulate 100 Creator re-renders each requesting tag refresh (non-force).
    const results = await Promise.all(
      Array.from({ length: 100 }, () => service.refreshActionTags({ force: false })),
    );
    assert.ok(results.every(r => r.tags.some(t => t.tag_key === "mayhopphat.login")));
    assert.ok(actionTagHits <= 2, `expected ≤2 action-tags hits, got ${actionTagHits}`);

    // 50 sync-status polls should coalesce/TTL to few catalog calls.
    await Promise.all(Array.from({ length: 50 }, () => service.refreshStatusRows({ force: false })));
    assert.ok(catalogHits <= 2, `expected ≤2 catalog hits, got ${catalogHits}`);

    // Manual force still allowed but budget caps burst.
    service.resetMetadataGateForTests();
    actionTagHits = 0;
    for (let i = 0; i < 20; i++) {
      await service.refreshActionTags({ force: true });
    }
    assert.ok(actionTagHits <= 8, `force burst must respect budget, got ${actionTagHits}`);
    assert.ok(service.getEffectiveActionTags().some(t => t.tag_key === "mayhopphat.login"));
  } finally {
    store.db.close();
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
