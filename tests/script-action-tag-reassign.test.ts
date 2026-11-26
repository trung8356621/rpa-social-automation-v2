import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { planActionTagReassignment } from "../src/shared/script-action-tag-reassign.js";
import type { ActionTag, Flow, Step } from "../src/shared/contracts.js";

const tags: ActionTag[] = [
  {
    id: 5,
    tag_key: "facebook.group.post",
    platform: "facebook",
    target: "group",
    action: "post",
    name: "Facebook Group Post",
  },
  {
    id: 25,
    tag_key: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
    platform: "qa_sandbox_facebook",
    target: "qa_sandbox_facebook_publish",
    action: "",
    name: "QA Sandbox Publish",
  },
];

function seed(store: Store, assetDir: string): Flow {
  const assetRel = "roi/publish.png";
  fs.mkdirSync(path.join(assetDir, "roi"), { recursive: true });
  fs.writeFileSync(path.join(assetDir, assetRel), Buffer.from("png-bytes"));
  const step: Step = {
    id: "step-publish",
    version: 1,
    name: "Publish",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      action: "CLICK_TARGET",
      target: {
        asset: assetRel,
        roi: { x: 1, y: 2, width: 10, height: 10 },
        ocr: {
          text: "Publish",
          kind: "line",
          bbox: { x: 1, y: 2, width: 10, height: 10 },
          confidence: 92,
          confirmed: true,
          language: "vie+eng",
        },
      },
    },
  };
  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step.id, step.version, JSON.stringify(step));
  const flow: Flow = {
    id: "script-keep-id",
    name: "Sandbox QA Facebook browser probe",
    zoom: 1,
    actionTagKey: "facebook.group.post",
    actionTagId: 5,
    steps: [{ id: step.id, version: 1 }],
    variables: [],
    defaultPattern: { values: {} },
    groups: [],
  };
  store.saveFlow(flow);
  return flow;
}

test("planner blocks Active destination conflict and same-tag no-ops", () => {
  const flow: Flow = {
    id: "a",
    name: "A",
    zoom: 1,
    actionTagKey: "facebook.group.post",
    steps: [],
  };
  const other: Flow = {
    id: "b",
    name: "B",
    zoom: 1,
    actionTagKey: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
    steps: [],
  };
  const same = planActionTagReassignment({
    flow,
    tags,
    flows: [flow, other],
    activeScriptsByTag: {},
    destinationTagKey: "facebook.group.post",
  });
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.conflict.code, "SAME_TAG");

  const active = planActionTagReassignment({
    flow,
    tags,
    flows: [flow, other],
    activeScriptsByTag: { "qa_sandbox_facebook.qa_sandbox_facebook_publish": "b" },
    destinationTagKey: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
  });
  assert.equal(active.ok, false);
  if (!active.ok) assert.equal(active.conflict.code, "DESTINATION_ACTIVE_CONFLICT");
});

test("reassignment preserves Script id/steps/assets and marks requires Sync", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-retag-"));
  const store = new Store(path.join(dir, "creator.sqlite"));
  const assetDir = path.join(dir, "targets");
  try {
    const flow = seed(store, assetDir);
    store.upsertActionTags(tags);
    store.setSetting(`seoOpsPublishedDigest:${flow.id}`, "abc");
    store.setSetting("activeScriptsByTag", JSON.stringify({ "facebook.group.post": flow.id }));

    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      tokenStore: { getToken: () => null, setToken: () => undefined },
    });
    const sibling: Flow = {
      id: "other-qa",
      name: "QA_SANDBOX_Facebook_Publish",
      zoom: 1,
      actionTagKey: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
      actionTagId: 25,
      steps: [],
      variables: [],
      defaultPattern: { values: {} },
      groups: [],
    };
    store.saveFlow(sibling);

    const blocked = sync.reassignActionTag({
      flowId: flow.id,
      destinationTagKey: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
    });
    assert.equal(blocked.ok, false);

    const ok = sync.reassignActionTag({
      flowId: flow.id,
      destinationTagKey: "qa_sandbox_facebook.qa_sandbox_facebook_publish",
      allowDestinationSiblings: true,
    });
    assert.equal(ok.ok, true);
    const updated = store.flows().find((f) => f.id === flow.id)!;
    assert.equal(updated.id, "script-keep-id");
    assert.equal(updated.name, "Sandbox QA Facebook browser probe");
    assert.equal(updated.actionTagKey, "qa_sandbox_facebook.qa_sandbox_facebook_publish");
    assert.deepEqual(updated.steps, flow.steps);
    assert.equal(fs.existsSync(path.join(assetDir, "roi/publish.png")), true);
    assert.equal(store.setting(`seoOpsPublishedDigest:${flow.id}`), undefined);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["facebook.group.post"], undefined);
    assert.equal(sync.loadMeta().rows[flow.id]?.status, "local_changes");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
