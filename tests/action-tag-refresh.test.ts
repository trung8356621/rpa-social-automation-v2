import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import {
  mergeActionTagsWithRequests,
  normalizeActionTag,
  normalizeActionTags,
} from "../src/shared/action-tags.js";
import type { ScriptRequest } from "../src/shared/contracts.js";

test("normalizeActionTag supports two-part keys and null action_key", () => {
  const login = normalizeActionTag({
    id: 11,
    tag_key: "mayhopphat.login",
    platform: "mayhopphat",
    target: "login",
    action: "",
    action_key: null,
    name: "Mayhopphat Login",
  });
  assert.ok(login);
  assert.equal(login.tag_key, "mayhopphat.login");
  assert.equal(login.action_key, null);
  assert.equal(login.action, "");
  assert.equal(login.platform, "mayhopphat");
  assert.equal(login.target, "login");

  const detail = normalizeActionTag({
    id: 12,
    tag_key: "facebook.group_post_detail",
    name: "Group Post Detail",
  });
  assert.ok(detail);
  assert.equal(detail.platform, "facebook");
  assert.equal(detail.target, "group_post_detail");
  assert.equal(detail.action, "");
  assert.equal(detail.action_key, null);

  const legacy = normalizeActionTag({
    id: 13,
    tag_key: "facebook.group.post",
    platform: "facebook",
    target: "group",
    action: "post",
    action_key: "post",
    name: "Facebook Group Post",
  });
  assert.ok(legacy);
  assert.equal(legacy.action, "post");
  assert.equal(legacy.action_key, "post");

  const deduped = normalizeActionTags([login!, login!, detail!]);
  assert.equal(deduped.length, 2);
});

test("refreshActionTags is tag-only, updates SQLite, preserves cache on errors, coalesces races", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-tag-refresh-"));
  const dbFile = path.join(tmpDir, "creator.sqlite");
  const store = new Store(dbFile);
  let token: string | null = "tok-refresh";
  const tokenStore = {
    getToken: () => token,
    setToken: (t: string | null) => { token = t; },
  };

  let hits = 0;
  let mode: "ok" | "offline" | "auth" = "ok";
  let mockTags = [
    {
      id: 1,
      tag_key: "facebook.group.post",
      platform: "facebook",
      target: "group",
      action: "post",
      name: "Facebook Group Post",
    },
    {
      id: 2,
      tag_key: "mayhopphat.login",
      platform: "mayhopphat",
      target: "login",
      action: "",
      action_key: null,
      name: "Mayhopphat Login",
    },
    {
      id: 3,
      tag_key: "facebook.group_post_detail",
      platform: "facebook",
      target: "group_post_detail",
      action: "",
      action_key: null,
      name: "Group Post Detail",
    },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/v1/social-automation/rpa-admin/action-tags") {
      hits += 1;
      if (mode === "offline") {
        res.destroy();
        return;
      }
      if (mode === "auth") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors: ["unauthenticated"] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action_tags: mockTags }));
      return;
    }
    if (url.pathname === "/api/v1/social-automation/rpa-admin/active-scripts") {
      // Must never be hit by tag-only refresh.
      hits += 1000;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, active_scripts: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const service = createSeoOpsSyncService({
    store,
    assetDir: path.join(tmpDir, "targets"),
    tokenStore,
    dataPath: tmpDir,
  });
  service.setConfig(baseUrl);

  try {
    // Seed stale cache with legacy tag only.
    store.upsertActionTags([
      {
        id: 1,
        tag_key: "facebook.group.post",
        platform: "facebook",
        target: "group",
        action: "post",
        name: "Facebook Group Post",
      },
    ]);
    assert.equal(store.actionTags().length, 1);

    const first = await service.refreshActionTags({ force: true });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.source, "api");
    assert.equal(first.count, 3);
    assert.ok(first.tags.some(t => t.tag_key === "mayhopphat.login"));
    assert.ok(first.tags.some(t => t.tag_key === "facebook.group_post_detail"));
    assert.equal(store.actionTags().length, 3);
    assert.equal(hits, 1);

    // Stale=false should reuse cache without another API call.
    const cached = await service.refreshActionTags({ force: false });
    assert.equal(cached.ok, true);
    if (cached.ok) assert.equal(cached.source, "cache");
    assert.equal(hits, 1);

    // Race: concurrent force refreshes coalesce to one request.
    hits = 0;
    mockTags = [
      ...mockTags,
      {
        id: 4,
        tag_key: "wordpress.login",
        platform: "wordpress",
        target: "login",
        action: "",
        action_key: null,
        name: "WordPress Login",
      },
    ];
    const [a, b] = await Promise.all([
      service.refreshActionTags({ force: true }),
      service.refreshActionTags({ force: true }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(hits, 1);
    assert.ok(store.actionTags().some(t => t.tag_key === "wordpress.login"));

    // Offline keeps cache and reports failure.
    const beforeOffline = store.actionTags().length;
    mode = "offline";
    const offline = await service.refreshActionTags({ force: true });
    assert.equal(offline.ok, false);
    assert.equal(offline.source, "cache");
    assert.equal(offline.tags.length, beforeOffline);
    assert.equal(store.actionTags().length, beforeOffline);

    // 401 keeps cache, signals re-login.
    mode = "auth";
    const unauthorized = await service.refreshActionTags({ force: true });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.authRequired, true);
    assert.equal(store.actionTags().length, beforeOffline);

    // No token: auth required, cache intact.
    token = null;
    mode = "ok";
    const noToken = await service.refreshActionTags({ force: true });
    assert.equal(noToken.ok, false);
    assert.equal(noToken.authRequired, true);
    assert.equal(store.actionTags().length, beforeOffline);
  } finally {
    store.db.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("effective tags merge Script Requests when /action-tags is rate-limited", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-tag-429-"));
  const store = new Store(path.join(tmpDir, "creator.sqlite"));
  let token: string | null = "tok-429";
  const tokenStore = {
    getToken: () => token,
    setToken: (t: string | null) => { token = t; },
  };

  const requests: ScriptRequest[] = [
    {
      id: 1,
      request_id: "req-detail",
      action_tag_id: 12,
      action_tag_key: "facebook.group_post_detail",
      request_type: "create",
      status: "pending",
    },
    {
      id: 2,
      request_id: "req-login",
      action_tag_id: 11,
      action_tag_key: "mayhopphat.login",
      request_type: "create",
      status: "pending",
      action_key: null as unknown as undefined,
    },
    {
      id: 3,
      request_id: "req-post",
      action_tag_id: 1,
      action_tag_key: "facebook.group.post",
      request_type: "create",
      status: "pending",
    },
  ];
  store.setSetting("seoOpsScriptRequests", JSON.stringify(requests));
  store.upsertActionTags([
    {
      id: 1,
      tag_key: "facebook.group.post",
      platform: "facebook",
      target: "group",
      action: "post",
      name: "Facebook Group Post",
    },
  ]);

  const server = http.createServer((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" });
    res.end(JSON.stringify({ ok: false, errors: ["rate_limited"] }));
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

  try {
    const merged = mergeActionTagsWithRequests(store.actionTags(), requests);
    assert.equal(merged.length, 3);
    assert.ok(merged.some((t) => t.tag_key === "mayhopphat.login"));

    const result = await service.refreshActionTags({ force: true });
    assert.equal(result.ok, false);
    assert.equal(result.rateLimited, true);
    assert.ok(result.tags.some((t) => t.tag_key === "mayhopphat.login"));
    assert.ok(result.tags.some((t) => t.tag_key === "facebook.group_post_detail"));
    assert.equal(service.getEffectiveActionTags().length, 3);

    // Cooldown: second force refresh must not hammer API again but still return enriched tags.
    const second = await service.refreshActionTags({ force: true });
    assert.equal(second.ok, false);
    assert.equal(second.rateLimited, true);
    assert.ok(second.tags.some((t) => t.tag_key === "mayhopphat.login"));
  } finally {
    store.db.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("upsertActionTags stores two-part tags without duplicating", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-tag-upsert-"));
  const store = new Store(path.join(tmpDir, "creator.sqlite"));
  try {
    const tags = normalizeActionTags([
      { id: 21, tag_key: "mayhopphat.login", action_key: null, name: "Login" },
      { id: 22, tag_key: "facebook.group.post", platform: "facebook", target: "group", action: "post", name: "Post" },
    ]);
    store.upsertActionTags(tags);
    store.upsertActionTags(tags);
    const loaded = store.actionTags();
    assert.equal(loaded.length, 2);
    const login = store.actionTag("mayhopphat.login");
    assert.ok(login);
    assert.equal(login.action_key, null);
    const flow = store.newFlow("WP Login", 1, {
      actionTagId: login.id,
      actionTagKey: login.tag_key,
    });
    assert.equal(flow.actionTagKey, "mayhopphat.login");
    assert.equal(flow.actionTagId, 21);
  } finally {
    store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
