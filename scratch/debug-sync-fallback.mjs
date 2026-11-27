import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const { Store } = await import(pathToFileURL(path.join(root, "src/main/storage.js")).href);
const { createSeoOpsSyncService } = await import(pathToFileURL(path.join(root, "src/main/seo-ops-sync.js")).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-sync-debug-"));
const store = new Store(path.join(dir, "creator.sqlite"));
const assetDir = path.join(dir, "targets");
fs.mkdirSync(assetDir, { recursive: true });
const assetRel = "roi/btn.png";
fs.mkdirSync(path.join(assetDir, "roi"), { recursive: true });
const bytes = Buffer.from("fake-png-bytes");
fs.writeFileSync(path.join(assetDir, assetRel), bytes);
const step = {
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
const flow = {
  id: "flow-local",
  name: "Local Script",
  zoom: 1,
  actionTagKey: "fb.like",
  steps: [{ id: "step-1", version: 1 }],
  variables: [{ id: "var-1", key: "target_url", type: "text" }],
  defaultPattern: { values: { "var-1": "https://example.com" } },
  groups: [],
};
store.saveFlow(flow);
store.setSetting(
  `videoDemo:${flow.id}`,
  JSON.stringify({
    scriptId: flow.id,
    testRunId: "run-1",
    artifactRef: "demo.webm",
    thumbnailRef: "thumb.jpg",
    reviewed: true,
    audio: false,
    desktopCapture: false,
    attachedAt: "2026-01-01T00:00:00.000Z",
    sha256: createHash("sha256").update("demo").digest("hex"),
  }),
);
const testRunsDir = path.join(dir, "test-runs");
fs.mkdirSync(testRunsDir, { recursive: true });
fs.writeFileSync(path.join(testRunsDir, "demo.webm"), Buffer.from("demo"));
fs.writeFileSync(path.join(testRunsDir, "thumb.jpg"), Buffer.from("thumb"));

const hits = [];
const server = http.createServer((req, res) => {
  const url = req.url || "";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    hits.push(`${req.method} ${url}`);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.method === "GET" && url.endsWith("/scripts")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scripts: [] }));
      return;
    }
    if (req.method === "POST" && url.endsWith("/scripts/sync")) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html>nf</html>");
      return;
    }
    if (req.method === "POST" && url.endsWith("/scripts/publish")) {
      const parsed = JSON.parse(body);
      console.log("PUBLISH", {
        version: parsed.version,
        assets: parsed.manifest?.assets?.length,
        video: !!parsed.manifest?.video_demo,
        digest: parsed.content_digest?.slice?.(0, 12),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          outcome: "created",
          release: {
            package_key: parsed.package_key,
            version: parsed.version,
            content_digest: parsed.content_digest,
          },
        }),
      );
      return;
    }
    if (req.method === "POST" && url.endsWith("/scripts/asset")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.includes("video")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (/execution-reports|script-requests|action-tags/.test(url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reports: [], next_after_id: 0, script_requests: [], action_tags: [] }));
      return;
    }
    console.log("UNHANDLED", req.method, url);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, errors: ["not_found"] }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
store.setSetting("seoOpsBaseUrl", `http://127.0.0.1:${port}`);
const sync = createSeoOpsSyncService({
  store,
  assetDir,
  testRunsDir,
  tokenStore: { getToken: () => "tok", setToken: () => undefined },
});
try {
  const res = await sync.syncFlowNormal(flow.id);
  console.log(JSON.stringify({ summary: res.summary, results: res.results }, null, 2));
} catch (e) {
  console.error("THROW", e);
}
store.close();
fs.rmSync(dir, { recursive: true, force: true });
await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
console.log("HITS", hits);
