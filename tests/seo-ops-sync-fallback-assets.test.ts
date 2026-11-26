import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import type { Flow, Step } from "../src/shared/contracts.js";
import { syncIpcDiagnostic } from "../src/shared/sync-ipc.js";

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-sync-fix-"));
  const store = new Store(path.join(dir, "creator.sqlite"));
  const assetDir = path.join(dir, "targets");
  fs.mkdirSync(assetDir, { recursive: true });
  return { dir, store, assetDir };
}

function seedFlow(store: Store, assetDir: string, flowId = "flow-local"): Flow {
  const assetRel = "roi/btn.png";
  fs.mkdirSync(path.join(assetDir, "roi"), { recursive: true });
  const bytes = Buffer.from("fake-png-bytes");
  fs.writeFileSync(path.join(assetDir, assetRel), bytes);
  const step: Step = {
    id: "step-1",
    version: 1,
    name: "Click",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      action: "CLICK_TARGET",
      target: {
        asset: assetRel,
        roi: { x: 1, y: 2, width: 10, height: 10 },
        ocr: {
          text: "Go",
          kind: "line",
          bbox: { x: 1, y: 2, width: 10, height: 10 },
          confidence: 95,
          confirmed: true,
          language: "vie+eng",
        },
      },
    },
  };
  store.db.prepare("INSERT OR REPLACE INTO steps VALUES(?,?,?)").run(step.id, step.version, JSON.stringify(step));
  const flow: Flow = {
    id: flowId,
    name: "Local Script",
    zoom: 1,
    actionTagKey: "fb.like",
    steps: [{ id: "step-1", version: 1 }],
    variables: [{ id: "var-1", key: "target_url", type: "text" }],
    defaultPattern: { values: { "var-1": "https://example.com" } },
    groups: [],
  };
  store.saveFlow(flow);
  return flow;
}

test("HTML 404 on /scripts/sync is API_UNEXPECTED_RESPONSE not missing Script", () => {
  const detail = syncIpcDiagnostic(
    new Error(
      "SEO_OPS_HTTP: POST /api/v1/social-automation/rpa-admin/scripts/sync status=404 content-type=text/html; charset=utf-8 category=not_found",
    ),
  );
  assert.equal(detail.code, "API_UNEXPECTED_RESPONSE");
});

test("individual Sync falls back to publish when /scripts/sync returns HTML 404", async () => {
  const { dir, store, assetDir } = makeTempEnv();
  const publishCalls: unknown[] = [];
  const syncHits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && url.endsWith("/scripts")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, scripts: [] }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/sync/plan")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          plan: { push_to_remote: JSON.parse(body).local_scripts || [], pull_to_local: [], skip: [], conflicts: [] },
        }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/sync")) {
        syncHits.push(body);
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html>not found</html>");
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/publish")) {
        publishCalls.push(JSON.parse(body));
        const parsed = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          outcome: "created",
          release: {
            package_key: parsed.package_key,
            version: parsed.version,
            content_digest: parsed.content_digest,
          },
        }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/asset")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/scripts/video-demo")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && /execution-reports|script-requests|action-tags/.test(url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          reports: [],
          next_after_id: 0,
          script_requests: [],
          action_tags: [],
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["not_found"] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const flow = seedFlow(store, assetDir);
    store.setSetting("seoOpsBaseUrl", `http://127.0.0.1:${port}`);
    // Attach a ready demo so publish is not blocked by missing_demo when required by health.
    store.setSetting(`videoDemo:${flow.id}`, JSON.stringify({
      scriptId: flow.id,
      testRunId: "run-1",
      artifactRef: "demo.webm",
      thumbnailRef: "thumb.jpg",
      reviewed: true,
      audio: false,
      desktopCapture: false,
      attachedAt: "2026-01-01T00:00:00.000Z",
      sha256: createHash("sha256").update("demo").digest("hex"),
    }));
    const testRunsDir = path.join(dir, "test-runs");
    fs.mkdirSync(testRunsDir, { recursive: true });
    fs.writeFileSync(path.join(testRunsDir, "demo.webm"), Buffer.from("demo"));
    fs.writeFileSync(path.join(testRunsDir, "thumb.jpg"), Buffer.from("thumb"));

    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      testRunsDir,
      tokenStore: { getToken: () => "tok", setToken: () => undefined },
    });
    const res = await sync.syncFlowNormal(flow.id);
    assert.equal(syncHits.length, 1, "tried unified /scripts/sync once");
    assert.ok(publishCalls.length >= 1, "fell back to /scripts/publish");
    assert.equal(res.summary.failed, 0);
    assert.ok((res.summary.published ?? 0) + (res.summary.unchanged ?? 0) + (res.summary.blocked ?? 0) >= 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("pull downloads missing ROI assets before materializing", async () => {
  const { dir, store, assetDir } = makeTempEnv();
  const bytes = Buffer.from("remote-roi-bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const remoteScriptId = "remote-script-1";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && url.pathname.endsWith("/scripts")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          scripts: [{
            script_id: remoteScriptId,
            package_key: remoteScriptId,
            version: "1",
            content_digest: "digest-remote",
            assets_complete: true,
          }],
        }));
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/scripts/sync/plan")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          plan: {
            push_to_remote: [],
            pull_to_local: [{
              script_id: remoteScriptId,
              package_key: remoteScriptId,
              version: "1",
              content_digest: "digest-remote",
            }],
            skip: [],
            conflicts: [],
          },
        }));
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/scripts/pull")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          assets_complete: true,
          ready_to_execute: true,
          release: {
            package_key: remoteScriptId,
            version: "1",
            name: "Remote Script",
            content_digest: "digest-remote",
            manifest: {
              script_id: remoteScriptId,
              variables: [{ id: "var-1", key: "u", type: "text" }],
              steps: [{
                id: "remote-step",
                version: 1,
                name: "Click",
                createdAt: "2026-01-01T00:00:00.000Z",
                payload: {
                  action: "CLICK_TARGET",
                  target: {
                    asset: "roi/remote.png",
                    roi: { x: 1, y: 2, width: 8, height: 8 },
                    ocr: {
                      text: "Go",
                      kind: "line",
                      bbox: { x: 1, y: 2, width: 8, height: 8 },
                      confidence: 90,
                      confirmed: true,
                      language: "vie+eng",
                    },
                  },
                },
              }],
              assets: [{ path: "roi/remote.png", sha256: sha, kind: "roi" }],
            },
          },
        }));
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/scripts/asset")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, asset_base64: bytes.toString("base64") }));
        return;
      }
      if (req.method === "GET" && /execution-reports|script-requests|action-tags/.test(url.pathname + url.search)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          reports: [],
          next_after_id: 0,
          script_requests: [],
          action_tags: [],
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["not_found"] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    store.setSetting("seoOpsBaseUrl", `http://127.0.0.1:${port}`);
    const sync = createSeoOpsSyncService({
      store,
      assetDir,
      tokenStore: { getToken: () => "tok", setToken: () => undefined },
    });
    const res = await sync.syncAll();
    const pull = res.results.find((r) => r.script_id === remoteScriptId);
    assert.equal(pull?.ok, true, pull?.message);
    assert.equal(fs.existsSync(path.join(assetDir, "roi/remote.png")), true);
    assert.equal(store.flows().some((f) => f.id === remoteScriptId), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
