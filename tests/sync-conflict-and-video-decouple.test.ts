import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { computeExecutionDigest } from "../src/shared/script-digest.js";
import { buildScriptCatalogSnapshot } from "../src/shared/script-release.js";
import { attachVideoDemo, toScriptVideoDemo } from "../src/shared/video-demo.js";
import type { Flow, Step } from "../src/shared/contracts.js";

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-sync-decouple-"));
  const dbPath = path.join(dir, "creator.sqlite");
  const assetDir = path.join(dir, "assets");
  const testRunsDir = path.join(dir, "test-runs");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.mkdirSync(testRunsDir, { recursive: true });
  const store = new Store(dbPath);
  return { dir, store, assetDir, testRunsDir };
}

function seedFlow(store: Store, assetDir: string, id: string, name: string, assetRel = `roi/${id}.png`): Flow {
  fs.mkdirSync(path.dirname(path.join(assetDir, assetRel)), { recursive: true });
  fs.writeFileSync(path.join(assetDir, assetRel), Buffer.from(`png-${id}`));
  const step: Step = {
    id: `step-${id}`,
    version: 1,
    name: "Add title",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      action: "CLICK_AND_TYPE",
      method: "auto",
      threshold: 0.96,
      timeoutMs: 3000,
      target: {
        asset: assetRel,
        roi: { x: 10, y: 20, width: 100, height: 36 },
        ocr: {
          text: "Add title",
          kind: "line",
          bbox: { x: 4, y: 8, width: 80, height: 18 },
          confidence: 92,
          confirmed: true,
          language: "vie+eng",
        },
      },
    },
  };
  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step.id, step.version, JSON.stringify(step));
  const flow: Flow = {
    id,
    name,
    zoom: 1,
    steps: [{ id: step.id, version: 1 }],
    variables: [],
    defaultPattern: { values: {} },
    groups: [],
  };
  store.saveFlow(flow);
  return flow;
}

function seedDemo(store: Store, testRunsDir: string, flow: Flow, scriptVersion = "1", executionDigest = "a".repeat(64)) {
  const videoRel = `demos/${flow.id}/run-1/recording.webm`;
  const thumbRel = `demos/${flow.id}/run-1/recording-thumb.jpg`;
  fs.mkdirSync(path.dirname(path.join(testRunsDir, videoRel)), { recursive: true });
  fs.writeFileSync(path.join(testRunsDir, videoRel), Buffer.from("webm-demo-bytes"));
  fs.writeFileSync(path.join(testRunsDir, thumbRel), Buffer.from("jpg-thumb-bytes"));
  const attachment = attachVideoDemo({
    scriptId: flow.id,
    scriptVersion,
    caseId: "case-1",
    testRunId: "run-1",
    executionDigest,
    thumbnailRef: thumbRel,
    reviewed: true,
    artifactRef: videoRel,
    stepVersions: flow.steps,
  });
  store.setSetting(`videoDemo:${flow.id}`, JSON.stringify(attachment));
  store.setSetting(`videoDemo:${flow.id}:${scriptVersion}`, JSON.stringify(attachment));
  return attachment;
}

async function startMockSeoOps(handler?: {
  onPublish?: (body: Record<string, unknown>, remoteByKey: Map<string, Record<string, unknown>[]>) => {
    status: number;
    body: Record<string, unknown>;
  } | undefined;
}) {
  const releases = new Map<string, Record<string, unknown>[]>();
  const publishCalls: Array<{ package_key: string; version: string; content_digest: string }> = [];

  const latestByKey = () => {
    const out: Record<string, unknown>[] = [];
    for (const list of releases.values()) {
      const last = list[list.length - 1];
      if (last) out.push(last);
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (req.method === "GET" && url.endsWith("/scripts")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, scripts: latestByKey() }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/scripts/sync/plan")) {
        const local = (json.local_scripts as Array<Record<string, string>>) || [];
        const push_to_remote: unknown[] = [];
        const skip: unknown[] = [];
        const conflicts: unknown[] = [];
        for (const item of local) {
          const list = releases.get(item.package_key) || [];
          const latest = list[list.length - 1] as Record<string, string> | undefined;
          if (!latest) {
            push_to_remote.push(item);
          } else if (latest.content_digest === item.content_digest) {
            skip.push({ script_id: item.script_id, reason: "same_digest" });
          } else if (latest.version === item.version) {
            conflicts.push({ script_id: item.script_id, reason: "version_digest_conflict" });
          } else {
            push_to_remote.push(item);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, plan: { push_to_remote, pull_to_local: [], skip, conflicts } }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/scripts/publish")) {
        const pkg = String(json.package_key);
        const version = String(json.version);
        const digest = String(json.content_digest);
        publishCalls.push({ package_key: pkg, version, content_digest: digest });

        const custom = handler?.onPublish?.(json, releases);
        if (custom) {
          res.writeHead(custom.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(custom.body));
          return;
        }

        const list = releases.get(pkg) || [];
        const sameVer = list.find((r) => r.version === version);
        if (sameVer) {
          if (sameVer.content_digest === digest) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, outcome: "idempotent", release: sameVer }));
            return;
          }
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, outcome: "conflict", errors: ["version_digest_conflict"] }));
          return;
        }
        const entry = {
          script_id: pkg,
          package_key: pkg,
          version,
          content_digest: digest,
          assets_complete: true,
          demo_status: "ready",
        };
        list.push(entry);
        releases.set(pkg, list);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, outcome: "published", release: entry }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/scripts/assets")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/scripts/video-demo")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.endsWith("/scripts/sync")) {
        const mode = String(json.mode || "normal");
        const srcPkg = String(json.source_package_key || json.package_key);
        const successorKey = mode === "new_version" ? `${srcPkg}-v2` : srcPkg;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          outcome: mode === "new_version" ? "new_version_created" : "synced",
          script_id: successorKey,
          package_key: successorKey,
          version: "1",
          content_digest: "b".repeat(64),
          assets_complete: true,
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reports: [], next_after_id: 0 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return { server, baseUrl, releases, publishCalls };
}

test("1-2, 6: Unchanged Script skips new version; changed Step publishes next immutable version and preserves prior release", async () => {
  const { store, assetDir, testRunsDir } = makeTempEnv();
  const flow = seedFlow(store, assetDir, "en-script", "create post wp en");
  const mock = await startMockSeoOps();
  try {
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "test-token", setToken: () => {} },
    });

    // Initial publish -> v1
    const first = await sync.syncAll();
    assert.equal(first.summary.published, 1);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");
    const v1Release = { ...mock.releases.get(flow.id)![0] };

    // Re-sync unchanged -> skipped, no v2
    const second = await sync.syncAll();
    assert.equal(second.summary.published, 0);
    assert.equal(second.summary.unchanged, 1);
    assert.equal(mock.releases.get(flow.id)!.length, 1);

    // Update Step to v2 -> Sync All allocates v2 and keeps v1 intact
    const step2: Step = {
      ...store.step(`step-${flow.id}`, 1),
      version: 2,
      payload: {
        ...store.step(`step-${flow.id}`, 1).payload,
        target: {
          ...store.step(`step-${flow.id}`, 1).payload.target!,
          roi: { x: 12, y: 24, width: 95, height: 34 },
        },
      },
    };
    store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step2.id, 2, JSON.stringify(step2));
    store.saveFlow({ ...flow, steps: [{ id: step2.id, version: 2 }] });

    const third = await sync.syncAll();
    assert.equal(third.summary.published, 1);
    assert.equal(third.summary.failed, 0);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "2");
    assert.equal(mock.releases.get(flow.id)!.length, 2);
    assert.deepEqual(mock.releases.get(flow.id)![0], v1Release);
  } finally {
    mock.server.close();
  }
});

test("3-5: version_digest_conflict & script_version_sequence_conflict recover with bounded retries", async () => {
  const { store, assetDir, testRunsDir } = makeTempEnv();
  const flow = seedFlow(store, assetDir, "conflict-script", "Conflict Script");

  let conflictMode: "digest" | "sequence" | "infinite" = "digest";
  let attempts = 0;
  const mock = await startMockSeoOps({
    onPublish: (body) => {
      attempts += 1;
      if (conflictMode === "digest" && body.version === "1") {
        return { status: 409, body: { ok: false, outcome: "conflict", errors: ["version_digest_conflict"] } };
      }
      if (conflictMode === "sequence" && Number(body.version) <= 2) {
        return { status: 409, body: { ok: false, outcome: "conflict", errors: ["script_version_sequence_conflict"] } };
      }
      if (conflictMode === "infinite") {
        return { status: 409, body: { ok: false, outcome: "conflict", errors: ["version_digest_conflict"] } };
      }
      return undefined;
    },
  });

  try {
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "test-token", setToken: () => {} },
    });

    // 3. version_digest_conflict -> bumps to v2 and succeeds
    conflictMode = "digest";
    attempts = 0;
    const digestRes = await sync.syncAll();
    assert.equal(digestRes.summary.published, 1);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "2");
    assert.equal(attempts, 2);

    // 4. script_version_sequence_conflict -> bumps until v3 succeeds
    store.setSetting(`seoOpsVersion:${flow.id}`, "1");
    mock.releases.delete(flow.id);
    conflictMode = "sequence";
    attempts = 0;
    const seqRes = await sync.syncAll();
    assert.equal(seqRes.summary.published, 1);
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "3");
    assert.equal(attempts, 3);

    // 5. Repeated conflict -> bounded failure (1 initial + 3 retries = 4)
    store.setSetting(`seoOpsVersion:${flow.id}`, "1");
    mock.releases.delete(flow.id);
    conflictMode = "infinite";
    attempts = 0;
    const failRes = await sync.syncAll();
    assert.equal(failRes.summary.failed, 1);
    assert.equal(attempts, 4);
  } finally {
    mock.server.close();
  }
});

test("7-13: VIDEO_DEMO is optional, decoupled from digest/pins, and emits zero health warnings", async () => {
  const { store, assetDir, testRunsDir } = makeTempEnv();
  const flowNoVideo = seedFlow(store, assetDir, "no-video", "No Video Script");
  const flowWithVideo = seedFlow(store, assetDir, "with-video", "With Video Script");
  // Attach demo recorded against older step pins & different execution digest
  const oldAttachment = seedDemo(store, testRunsDir, flowWithVideo, "1", "d".repeat(64));

  // Mutate step to v2 after video was recorded
  const stepV2: Step = {
    ...store.step(`step-${flowWithVideo.id}`, 1),
    version: 2,
    payload: {
      ...store.step(`step-${flowWithVideo.id}`, 1).payload,
      target: {
        ...store.step(`step-${flowWithVideo.id}`, 1).payload.target!,
        roi: { x: 50, y: 60, width: 90, height: 30 },
      },
    },
  };
  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(stepV2.id, 2, JSON.stringify(stepV2));
  store.saveFlow({ ...flowWithVideo, steps: [{ id: stepV2.id, version: 2 }] });

  const mock = await startMockSeoOps();
  try {
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "test-token", setToken: () => {} },
    });

    const rows = await sync.refreshStatusRows({ force: true });
    const noVidRow = rows.find((r) => r.flow_id === flowNoVideo.id)!;
    const withVidRow = rows.find((r) => r.flow_id === flowWithVideo.id)!;

    // 7-8: both publishable; 9-11: zero VIDEO_DEMO health warnings
    assert.equal(noVidRow.incomplete, false);
    assert.equal(noVidRow.demo_status, "missing");
    assert.equal(withVidRow.incomplete, false);
    assert.equal(withVidRow.demo_status, "ready");
    assert.equal(withVidRow.health_status, "valid");
    assert.deepEqual(withVidRow.health_warnings, []);

    // 12: Video does not affect executable digest
    const snapWithoutVideo = buildScriptCatalogSnapshot({
      flow: store.flows().find((f) => f.id === flowWithVideo.id)!,
      steps: [stepV2],
      version: "2",
      assets: [],
    });
    const snapWithVideo = buildScriptCatalogSnapshot({
      flow: store.flows().find((f) => f.id === flowWithVideo.id)!,
      steps: [stepV2],
      version: "2",
      assets: [],
      videoDemo: toScriptVideoDemo(oldAttachment),
    });
    assert.equal(snapWithoutVideo.execution_digest, snapWithVideo.execution_digest);
    assert.equal(
      computeExecutionDigest(snapWithoutVideo.publish_body!.manifest),
      computeExecutionDigest(snapWithVideo.publish_body!.manifest),
    );

    // 13: Existing media reference preserved after Sync All
    const res = await sync.syncAll();
    assert.equal(res.summary.published, 2);
    assert.equal(JSON.parse(store.setting(`videoDemo:${flowWithVideo.id}`)!).artifactRef, oldAttachment.artifactRef);
  } finally {
    mock.server.close();
  }
});

test("14-15: Independent VI/EN scripts remain unaffected and Sync New Version still works", async () => {
  const { store, assetDir, testRunsDir } = makeTempEnv();
  const viFlow = seedFlow(store, assetDir, "wp-vi", "create post wp vi");
  const enFlow = seedFlow(store, assetDir, "wp-en", "create post wp en");
  const mock = await startMockSeoOps();
  try {
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "test-token", setToken: () => {} },
    });
    const res = await sync.syncAll();
    assert.equal(res.summary.published, 2);
    assert.ok(mock.releases.has(viFlow.id));
    assert.ok(mock.releases.has(enFlow.id));

    const nv = await sync.syncNewVersion(enFlow.id);
    assert.equal(nv.ok, true);
    assert.equal(nv.successorId, `${enFlow.id}-v2`);
    assert.equal(store.flows().find((f) => f.id === enFlow.id)?.disabled, true);
    assert.equal(store.flows().find((f) => f.id === viFlow.id)?.disabled ?? false, false);
  } finally {
    mock.server.close();
  }
});
