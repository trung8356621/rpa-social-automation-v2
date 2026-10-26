import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import type { ActionTag, Flow } from "../src/shared/contracts.js";

test("Fresh SQLite schema initialization and Action Tags table", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-fresh-db-"));
  const dbFile = path.join(tmpDir, "creator.sqlite");
  const store = new Store(dbFile);

  try {
    // 1. Verify schema tables exist
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    assert.ok(tables.includes("settings"));
    assert.ok(tables.includes("flows"));
    assert.ok(tables.includes("steps"));
    assert.ok(tables.includes("overrides"));
    assert.ok(tables.includes("runs"));
    assert.ok(tables.includes("action_tags"));

    // 2. Fresh db is clean: 0 flows, 0 steps, 0 action tags
    assert.equal(store.flows().length, 0);
    assert.equal(store.steps().length, 0);
    assert.equal(store.actionTags().length, 0);

    // 3. Upsert action tag
    const tag1: ActionTag = {
      id: 1,
      tag_key: "facebook.group.post",
      platform: "facebook",
      target: "group",
      action: "post",
      name: "Facebook Group Post",
      description: "Thao tác Post tại Facebook Group",
    };
    store.upsertActionTags([tag1]);

    const loaded = store.actionTags();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 1);
    assert.equal(loaded[0].tag_key, "facebook.group.post");
    assert.equal(loaded[0].name, "Facebook Group Post");

    // 4. Repeated sync with same tag ID updates without duplicating
    const tag1Updated: ActionTag = {
      ...tag1,
      name: "Facebook Group Post Updated",
    };
    store.upsertActionTags([tag1Updated]);
    const reloaded = store.actionTags();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].name, "Facebook Group Post Updated");

    // 5. Creating flow with actionTagKey and actionTagId
    const flow1 = store.newFlow("Post Scenario A", 1, {
      actionTagId: 1,
      actionTagKey: "facebook.group.post",
    });
    assert.equal(flow1.actionTagId, 1);
    assert.equal(flow1.actionTagKey, "facebook.group.post");

    // 6. Creating a second flow with same tag
    const flow2 = store.newFlow("Post Scenario B", 1, {
      actionTagId: 1,
      actionTagKey: "facebook.group.post",
    });
    assert.equal(flow2.actionTagId, 1);
    assert.equal(flow2.actionTagKey, "facebook.group.post");

    const flowsUnderTag = store.flows().filter(f => f.actionTagId === 1 || f.actionTagKey === "facebook.group.post");
    assert.equal(flowsUnderTag.length, 2);

    // 7. Lookup tag by id or tag_key
    assert.equal(store.actionTag(1)?.tag_key, "facebook.group.post");
    assert.equal(store.actionTag("facebook.group.post")?.id, 1);

    // 8. Snapshot preserves action_tags
    const snap = store.backupSnapshot();
    assert.ok(Array.isArray(snap.action_tags));
    assert.equal(snap.action_tags.length, 1);

    // 9. Restore snapshot into second store restores action_tags
    const store2 = new Store(path.join(tmpDir, "creator2.sqlite"));
    store2.restoreSnapshot(snap);
    assert.equal(store2.actionTags().length, 1);
    assert.equal(store2.actionTags()[0].tag_key, "facebook.group.post");
    store2.db.close();

    // 10. Backward compatible restore: older backup without action_tags succeeds
    const legacySnap = {
      settings: snap.settings,
      flows: snap.flows,
      steps: snap.steps,
      overrides: snap.overrides,
      runs: snap.runs,
    };
    const store3 = new Store(path.join(tmpDir, "creator3.sqlite"));
    store3.restoreSnapshot(legacySnap);
    assert.equal(store3.flows().length, 2);
    store3.db.close();
  } finally {
    store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("syncActionTags service authentication and error reporting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-sync-test-"));
  const dbFile = path.join(tmpDir, "creator.sqlite");
  const store = new Store(dbFile);
  let memoryToken: string | null = null;
  const tokenStore = {
    getToken: () => memoryToken,
    setToken: (t: string | null) => { memoryToken = t; },
  };

  const service = createSeoOpsSyncService({
    store,
    assetDir: path.join(tmpDir, "targets"),
    tokenStore,
    dataPath: tmpDir,
  });

  try {
    // 1. Without token, returns error explaining authentication is required
    const unauthResult = await service.syncActionTags();
    assert.equal(unauthResult.ok, false);
    if (!unauthResult.ok) {
      assert.match(unauthResult.error, /đăng nhập/i);
    }

    // 2. With invalid endpoint / server down, returns connection error, not fake success
    memoryToken = "test_token_123";
    service.setConfig("http://127.0.0.1:59999"); // unreachable port
    const networkFailResult = await service.syncActionTags();
    assert.equal(networkFailResult.ok, false);
    if (!networkFailResult.ok) {
      assert.match(networkFailResult.error, /Không kết nối được SEO-OPS/i);
    }
  } finally {
    store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
