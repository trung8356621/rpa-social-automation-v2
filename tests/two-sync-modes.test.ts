import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { formatScriptDemoLabel, formatScriptSyncLabel } from "../src/renderer/app-shell.js";
import type { Flow, Step } from "../src/shared/contracts.js";

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-two-sync-"));
  const dbPath = path.join(dir, "creator.sqlite");
  const assetDir = path.join(dir, "assets");
  const testRunsDir = path.join(dir, "test-runs");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.mkdirSync(testRunsDir, { recursive: true });
  const store = new Store(dbPath);
  return { dir, store, assetDir, testRunsDir };
}

function seedFlowWithAsset(store: Store, assetDir: string, flowId = "flow-alpha"): Flow {
  const assetRel = "roi/btn.png";
  fs.mkdirSync(path.join(assetDir, "roi"), { recursive: true });
  fs.writeFileSync(path.join(assetDir, assetRel), Buffer.from("fake-png-bytes"));

  const step1: Step = {
    id: "step-1",
    version: 1,
    name: "Open target",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      action: "CLICK_TARGET",
      target: {
        asset: assetRel,
        roi: { x: 1, y: 2, width: 10, height: 10 },
        ocr: { text: "Submit", mode: "exact" },
      },
    },
  };
  const step2: Step = {
    id: "step-2",
    version: 1,
    name: "Wait",
    createdAt: "2026-01-01T00:00:01.000Z",
    payload: { action: "SLEEP", timeoutMs: 250 },
  };

  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step1.id, step1.version, JSON.stringify(step1));
  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step2.id, step2.version, JSON.stringify(step2));

  const flow: Flow = {
    id: flowId,
    name: "Alpha Script",
    zoom: 1,
    actionTagKey: "fb.like",
    steps: [
      { id: "step-1", version: 1 },
      { id: "step-2", version: 1 },
    ],
    variables: [{ id: "var-1", key: "target_url", type: "text" }],
    defaultPattern: { values: { "var-1": "https://example.com" } },
    groups: [],
  };
  store.saveFlow(flow);
  return flow;
}

async function startMockSeoOps(options?: { failPublish?: boolean; publishDelayMs?: number }) {
  const remoteScripts = new Map<string, Record<string, unknown>>();
  const publishedBodies: Array<Record<string, unknown>> = [];
  const uploadedAssets: Array<Record<string, unknown>> = [];
  const uploadedDemos: Array<Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const jsonBody = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};

      if (req.method === "GET" && url.endsWith("/scripts")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, scripts: [...remoteScripts.values()] }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/sync/plan")) {
        const local = (jsonBody.local_scripts as Array<Record<string, string>>) || [];
        const push_to_remote: unknown[] = [];
        const skip: unknown[] = [];
        for (const item of local) {
          const r = remoteScripts.get(item.script_id);
          if (r && String(r.content_digest).toLowerCase() === String(item.content_digest).toLowerCase()) {
            skip.push({ script_id: item.script_id, reason: "same_digest" });
          } else {
            push_to_remote.push(item);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, plan: { push_to_remote, pull_to_local: [], skip, conflicts: [] } }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/publish")) {
        if (options?.publishDelayMs) await new Promise((r) => setTimeout(r, options.publishDelayMs));
        if (options?.failPublish) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, outcome: "validation", errors: ["publish_rejected"] }));
          return;
        }
        publishedBodies.push(jsonBody);
        const manifest = jsonBody.manifest as Record<string, unknown>;
        const scriptId = String(manifest.script_id);
        remoteScripts.set(scriptId, {
          script_id: scriptId,
          package_key: jsonBody.package_key,
          version: jsonBody.version,
          content_digest: jsonBody.content_digest,
          assets_complete: true,
          demo_status: manifest.video_demo ? "ready" : "missing",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          outcome: "created",
          release: {
            package_key: jsonBody.package_key,
            version: jsonBody.version,
            content_digest: jsonBody.content_digest,
          },
        }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/asset")) {
        uploadedAssets.push(jsonBody);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/video-demo")) {
        uploadedDemos.push(jsonBody);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && url.includes("/action-tags")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, action_tags: [{ id: 1, tag_key: "fb.like", name: "FB Like" }] }));
        return;
      }
      if (req.method === "GET" && url.includes("/script-requests")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, script_requests: [] }));
        return;
      }
      if (req.method === "GET" && url.includes("/execution-reports")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, reports: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["not_found"] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    remoteScripts,
    publishedBodies,
    uploadedAssets,
    uploadedDemos,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test("Normal Sync works without Demo, preserves identity & Active state, updates release metadata, and reflects Backend status", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockSeoOps();
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    store.setSetting("activeScriptsByTag", JSON.stringify({ "fb.like": flow.id }));

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    // Before sync: Not synced & Demo missing
    const beforeRows = await syncService.refreshStatusRows({ force: true });
    const beforeRow = beforeRows.find((r) => r.flow_id === flow.id);
    assert.equal(formatScriptSyncLabel(beforeRow), "Not synced");
    assert.equal(formatScriptDemoLabel(beforeRow, false), "Demo missing");

    // Normal Sync without Demo
    const res = await syncService.syncAll({ flowId: flow.id });
    assert.equal(res.summary.published, 1);
    assert.equal(res.summary.failed, 0);
    assert.equal(mock.publishedBodies.length, 1);
    assert.equal(mock.uploadedAssets.length, 1);
    assert.equal(mock.uploadedDemos.length, 0);

    // Preserves identity & Active state
    assert.equal(store.flows().length, 1);
    assert.equal(store.flows()[0].id, flow.id);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], flow.id);

    // Updates release/version metadata & status reflects Backend
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "1");
    const afterRow = res.rows.find((r) => r.flow_id === flow.id);
    assert.equal(formatScriptSyncLabel(afterRow), "Synced");
    assert.equal(formatScriptDemoLabel(afterRow, false), "Demo missing");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Normal Sync preserves existing Demo without re-requiring selection", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockSeoOps();
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    fs.writeFileSync(path.join(testRunsDir, "demo.webm"), Buffer.from("webm-bytes"));
    fs.writeFileSync(path.join(testRunsDir, "thumb.jpg"), Buffer.from("jpg-bytes"));
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify({
      scriptId: flow.id,
      testRunId: "run-1",
      artifactRef: "demo.webm",
      thumbnailRef: "thumb.jpg",
      reviewed: true,
      audio: false,
      desktopCapture: false,
      attachedAt: "2026-01-01T00:00:00.000Z",
    }));
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    const res = await syncService.syncAll({ flowId: flow.id });
    assert.equal(res.summary.published, 1);
    assert.ok(store.setting(`videoDemo:${flow.id}`), "existing demo preserved");
    const row = res.rows.find((r) => r.flow_id === flow.id);
    assert.equal(formatScriptSyncLabel(row), "Synced");
    assert.equal(formatScriptDemoLabel(row, true), "Selected");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Sync New Version creates distinct successor, preserves steps & assets, clears demo, disables predecessor, and deduplicates concurrent clicks", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockSeoOps({ publishDelayMs: 40 });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify({
      scriptId: flow.id,
      testRunId: "run-1",
      artifactRef: "demo.webm",
      thumbnailRef: "thumb.jpg",
      reviewed: true,
      audio: false,
      desktopCapture: false,
      attachedAt: "2026-01-01T00:00:00.000Z",
    }));
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    store.setSetting("activeScriptsByTag", JSON.stringify({ "fb.like": flow.id }));

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    // Repeated concurrent clicks do not create duplicate successors
    const [r1, r2] = await Promise.all([
      syncService.syncNewVersion(flow.id),
      syncService.syncNewVersion(flow.id),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.successorId, r2.successorId);

    const flows = store.flows();
    assert.equal(flows.length, 2, "predecessor + 1 successor only");
    const pred = flows.find((f) => f.id === flow.id)!;
    const succ = flows.find((f) => f.id === r1.successorId)!;

    // Predecessor is disabled and kept visible; no longer active
    assert.equal(pred.disabled, true);
    assert.equal(pred.supersededByFlowId, succ.id);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], undefined);

    // Successor preserves step sequence & assets, clears demo, is not auto-activated
    assert.notEqual(succ.id, pred.id);
    assert.deepEqual(succ.steps, pred.steps);
    assert.equal(succ.disabled, false);
    assert.equal(store.setting(`videoDemo:${succ.id}`), undefined);
    assert.equal(mock.uploadedAssets.some((a) => a.package_key === succ.id), true);

    const succRow = r1.sync?.rows.find((r) => r.flow_id === succ.id);
    assert.equal(formatScriptSyncLabel(succRow), "Synced");
    assert.equal(formatScriptDemoLabel(succRow, false), "Demo missing");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Failed Sync New Version leaves predecessor unchanged and rolls back successor", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockSeoOps({ failPublish: true });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    store.setSetting("activeScriptsByTag", JSON.stringify({ "fb.like": flow.id }));

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    const res = await syncService.syncNewVersion(flow.id);
    assert.equal(res.ok, false);
    assert.equal(store.flows().length, 1);
    assert.equal(store.flows()[0].disabled, undefined);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], flow.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Demo selection module has no sync trigger side effects", () => {
  const mainTs = fs.readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
  const attachBlock = mainTs.slice(
    mainTs.indexOf('case "attachScriptVideoDemo":'),
    mainTs.indexOf('case "exportFullBackup":'),
  );
  assert.equal(attachBlock.includes("seoOpsSyncFlow"), false);
  assert.equal(attachBlock.includes("manualSeoOpsSync"), false);

  const testLabTsx = fs.readFileSync(path.join(process.cwd(), "src/renderer/test-lab.tsx"), "utf8");
  assert.equal(testLabTsx.includes("seoOpsSyncFlow"), false);
});
