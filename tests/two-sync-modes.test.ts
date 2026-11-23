import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import { formatScriptDemoLabel, formatScriptSyncLabel } from "../src/renderer/app-shell.js";
import { computeExecutionDigest, computeScriptContentDigest } from "../src/shared/script-digest.js";
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
        ocr: {
          text: "Submit",
          kind: "line",
          bbox: { x: 1, y: 2, width: 10, height: 10 },
          confidence: 95,
          confirmed: true,
          language: "vie+eng",
        },
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

async function startMockBackend(options?: {
  seedExisting?: boolean;
  failSync?: boolean;
  noChangesOnNormal?: boolean;
  assetsCompleteOnSync?: boolean;
  delayMs?: number;
}) {
  const remoteScripts = new Map<string, Record<string, unknown>>();
  const syncCalls: Array<Record<string, unknown>> = [];
  const publishCalls: Array<Record<string, unknown>> = [];
  const uploadedAssets: Array<Record<string, unknown>> = [];
  const seenIdempotencyKeys = new Map<string, Record<string, unknown>>();

  if (options?.seedExisting) {
    remoteScripts.set("flow-alpha", {
      script_id: "flow-alpha",
      package_key: "flow-alpha",
      version: "1",
      content_digest: "seed-digest",
      assets_complete: true,
      demo_status: "ready",
    });
  }

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
          const r = remoteScripts.get(item.script_id) ?? [...remoteScripts.values()].find((v) => v.package_key === item.package_key);
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
      if (req.method === "POST" && url.endsWith("/scripts/sync")) {
        if (options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        syncCalls.push(jsonBody);
        if (options?.failSync) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, mode: jsonBody.mode, outcome: "error", errors: ["sync_failed"] }));
          return;
        }
        const mode = String(jsonBody.mode || "");
        if (mode === "normal") {
          const pkgKey = String(jsonBody.package_key || "");
          const existing = [...remoteScripts.values()].find((r) => r.package_key === pkgKey);
          if (!existing) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, mode: "normal", outcome: "error", errors: ["script_not_found"] }));
            return;
          }
          if (options?.noChangesOnNormal) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: true,
              mode: "normal",
              outcome: "no_changes",
              changed: false,
              idempotent: true,
              package_key: pkgKey,
              script_id: existing.script_id,
              release_id: 10,
              version: existing.version,
              status: "published",
              content_digest: existing.content_digest,
              execution_digest: "exec-1",
              demo_required: false,
              predecessor_disabled: false,
            }));
            return;
          }
          const nextVer = String(Number(existing.version || "1") + 1);
          const manifestObj = jsonBody.manifest as Record<string, unknown>;
          const digest = computeScriptContentDigest({
            package_key: pkgKey,
            kind: "script",
            name: String(jsonBody.name || "Alpha Script"),
            version: nextVer,
            schema_version: 1,
            manifest: manifestObj as never,
            dependencies: [],
            runtime_compatibility: { runner_min: "2.0.0" },
            ...(manifestObj.action_tag_key ? { action_tag_key: String(manifestObj.action_tag_key) } : {}),
          });
          existing.version = nextVer;
          existing.content_digest = digest;
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            mode: "normal",
            outcome: "synced",
            changed: true,
            idempotent: false,
            package_key: pkgKey,
            script_id: existing.script_id,
            release_id: 11,
            version: nextVer,
            previous_release_id: 10,
            previous_version: "1",
            status: "published",
            content_digest: digest,
            execution_digest: computeExecutionDigest(manifestObj as never),
            assets_complete: options?.assetsCompleteOnSync ?? true,
            demo_preserved: true,
            demo_required: false,
            predecessor_disabled: false,
          }));
          return;
        }
        if (mode === "new_version") {
          const sourceKey = String(jsonBody.source_package_key || "");
          const idemKey = String(jsonBody.idempotency_key || "");
          if (idemKey && seenIdempotencyKeys.has(idemKey)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ...seenIdempotencyKeys.get(idemKey), changed: false, idempotent: true }));
            return;
          }
          const succKey = `${sourceKey}-v2`;
          const succScriptId = `${sourceKey}-v2`;
          const succDigest = "succ-digest-1";
          remoteScripts.set(succScriptId, {
            script_id: succScriptId,
            package_key: succKey,
            version: "1",
            content_digest: succDigest,
            assets_complete: true,
            demo_status: "missing",
          });
          const payload = {
            ok: true,
            mode: "new_version",
            outcome: "new_version_created",
            changed: true,
            idempotent: false,
            package_key: succKey,
            script_id: succScriptId,
            release_id: 21,
            version: "1",
            status: "pending_media",
            content_digest: succDigest,
            execution_digest: "succ-exec-1",
            assets_complete: options?.assetsCompleteOnSync ?? false,
            demo_required: true,
            predecessor_package_key: sourceKey,
            predecessor_release_id: 10,
            predecessor_disabled: true,
            release: { name: String(jsonBody.name || "Alpha Script v2") },
          };
          if (idemKey) seenIdempotencyKeys.set(idemKey, payload);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }
      }
      if (req.method === "POST" && url.endsWith("/scripts/publish")) {
        publishCalls.push(jsonBody);
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
          release: { package_key: jsonBody.package_key, version: jsonBody.version, content_digest: jsonBody.content_digest },
        }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/asset")) {
        uploadedAssets.push(jsonBody);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
    syncCalls,
    publishCalls,
    uploadedAssets,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test("Normal Sync invokes Backend mode=normal, handles synced and no_changes, preserves Demo & Active state", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockBackend({ seedExisting: true });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    store.setSetting("activeScriptsByTag", JSON.stringify({ "fb.like": flow.id }));
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

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    const res = await syncService.syncFlowNormal(flow.id);
    assert.equal(res.summary.published, 1);
    assert.equal(mock.syncCalls.length, 1);
    assert.equal(mock.syncCalls[0].mode, "normal");
    assert.equal(mock.syncCalls[0].package_key, "flow-alpha");
    assert.equal(store.setting(`seoOpsVersion:${flow.id}`), "2");
    assert.ok(store.setting(`videoDemo:${flow.id}`), "existing demo preserved");
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], flow.id);
    assert.equal(formatScriptSyncLabel(res.rows.find((r) => r.flow_id === flow.id)), "Synced");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Normal Sync handles Backend no_changes outcome cleanly", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockBackend({ seedExisting: true, noChangesOnNormal: true });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    const res = await syncService.syncFlowNormal(flow.id);
    assert.equal(res.summary.unchanged, 1);
    assert.equal(res.results[0].action, "unchanged");
    assert.equal(res.results[0].message, "no_changes");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Sync New Version invokes mode=new_version, reconciles successor identity, preserves steps/assets, clears demo, disables predecessor, and deduplicates concurrent clicks", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockBackend({ seedExisting: true, delayMs: 30, assetsCompleteOnSync: false });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);
    store.setSetting("activeScriptsByTag", JSON.stringify({ "fb.like": flow.id }));
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

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    const [r1, r2] = await Promise.all([
      syncService.syncNewVersion(flow.id),
      syncService.syncNewVersion(flow.id),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.successorId, "flow-alpha-v2");
    assert.equal(r2.successorId, "flow-alpha-v2");
    assert.equal(mock.syncCalls.length, 1);
    assert.equal(mock.syncCalls[0].mode, "new_version");
    assert.equal(mock.syncCalls[0].source_package_key, "flow-alpha");
    assert.ok(String(mock.syncCalls[0].idempotency_key).startsWith("nv:flow-alpha:"));

    const pred = store.flows().find((f) => f.id === flow.id)!;
    const succ = store.flows().find((f) => f.id === "flow-alpha-v2")!;
    assert.equal(pred.disabled, true);
    assert.equal(pred.supersededByFlowId, succ.id);
    assert.deepEqual(succ.steps, pred.steps);
    assert.equal(store.setting(`seoOpsPackageKey:${succ.id}`), "flow-alpha-v2");
    assert.equal(store.setting(`videoDemo:${succ.id}`), undefined);
    assert.equal(mock.uploadedAssets.some((a) => a.package_key === "flow-alpha-v2"), true);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], undefined);
    assert.equal(formatScriptDemoLabel(r1.sync?.rows.find((r) => r.flow_id === succ.id), false), "Demo missing");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Backend error does not disable predecessor and preserves stable idempotency_key for retry", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockBackend({ seedExisting: true, failSync: true });
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

    const r1 = await syncService.syncNewVersion(flow.id);
    const r2 = await syncService.syncNewVersion(flow.id);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(mock.syncCalls.length, 2);
    assert.equal(mock.syncCalls[0].idempotency_key, mock.syncCalls[1].idempotency_key);
    assert.equal(store.flows().length, 1);
    assert.equal(store.flows()[0].disabled, undefined);
    assert.equal(JSON.parse(store.setting("activeScriptsByTag") || "{}")["fb.like"], flow.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Failed local reconciliation can retry safely with same idempotency_key and no duplicate successor", async () => {
  const { dir, store, assetDir, testRunsDir } = makeTempEnv();
  const mock = await startMockBackend({ seedExisting: true, assetsCompleteOnSync: true });
  try {
    const flow = seedFlowWithAsset(store, assetDir);
    store.setSetting("seoOpsBaseUrl", mock.baseUrl);

    const syncService = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok-1", setToken: () => undefined },
    });

    // Simulate local saveFlow failure on first attempt after Backend succeeds
    const origSaveFlow = store.saveFlow.bind(store);
    let failOnce = true;
    store.saveFlow = (f: Flow) => {
      if (failOnce && f.id === "flow-alpha-v2") {
        failOnce = false;
        throw new Error("disk_full");
      }
      return origSaveFlow(f);
    };

    const first = await syncService.syncNewVersion(flow.id);
    assert.equal(first.ok, false);
    assert.match(String(first.error), /lưu local thất bại/);
    assert.equal(store.flows()[0].disabled, undefined, "predecessor not disabled when local save fails");
    const firstIdem = mock.syncCalls[0].idempotency_key;

    // Retry reconciles using the same idempotency_key
    const retry = await syncService.syncNewVersion(flow.id);
    assert.equal(retry.ok, true);
    assert.equal(mock.syncCalls[1].idempotency_key, firstIdem);
    assert.equal(store.flows().length, 2);
    assert.equal(store.flows().find((f) => f.id === flow.id)?.disabled, true);
    assert.equal(store.flows().find((f) => f.id === "flow-alpha-v2")?.disabled, false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("Demo selection has no Sync trigger side effects", () => {
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
