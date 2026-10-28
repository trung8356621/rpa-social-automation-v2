import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  categorizeSeoOpsStatus,
  mapSeoOpsApiError,
  mapSeoOpsApiErrors,
  seoOpsFetch,
  SeoOpsHttpError,
  SEO_OPS_PRODUCTION_BASE_URL,
  SEO_OPS_REQUEST_TIMEOUT_MS,
} from "../src/shared/seo-ops-http.js";
import { createHttpSeoOpsAuthClient } from "../src/shared/seo-ops-auth.js";
import { buildScriptPublishBody } from "../src/shared/script-release.js";
import { createHttpScriptSyncClient } from "../src/shared/script-sync.js";
import { syncIpcDiagnostic } from "../src/shared/sync-ipc.js";
import { attachVideoDemo, toScriptVideoDemo } from "../src/shared/video-demo.js";

test("HTTP status categories cover auth, conflict, validation, unavailable", () => {
  assert.equal(categorizeSeoOpsStatus(401), "authentication");
  assert.equal(categorizeSeoOpsStatus(403), "authorization");
  assert.equal(categorizeSeoOpsStatus(404), "not_found");
  assert.equal(categorizeSeoOpsStatus(409), "conflict");
  assert.equal(categorizeSeoOpsStatus(422), "validation");
  assert.equal(categorizeSeoOpsStatus(503), "service_unavailable");
});

test("publish/sync API error codes map to safe Vietnamese copy without secrets", () => {
  assert.match(mapSeoOpsApiError("version_digest_conflict"), /Xung đột phiên bản/);
  assert.match(mapSeoOpsApiError("script_version_sequence_conflict"), /Thứ tự version/);
  assert.match(mapSeoOpsApiErrors(["script_content_unchanged"]), /không đổi/);
  assert.doesNotMatch(mapSeoOpsApiError("Bearer abcdefghijklmnopqrstuvwxyz012345"), /abcdefghijklmnopqrstuvwxyz/);
  assert.equal(SEO_OPS_PRODUCTION_BASE_URL, "https://seo-ops.duckdns.org");
  assert.ok(SEO_OPS_REQUEST_TIMEOUT_MS >= 10_000);
});

test("sync IPC diagnostics classify 404/409/422/timeout", () => {
  assert.equal(syncIpcDiagnostic(new Error("SEO_OPS_HTTP: GET /x status=404 content-type= category=not_found")).code, "NOT_FOUND");
  assert.equal(syncIpcDiagnostic(new Error("version_digest_conflict")).code, "CONFLICT");
  assert.equal(syncIpcDiagnostic(new Error("SEO_OPS_HTTP: POST /x status=422 content-type=application/json category=validation")).code, "VALIDATION");
  assert.equal(syncIpcDiagnostic(new SeoOpsHttpError({
    method: "GET", endpoint: "/api/x", status: 0, contentType: "", category: "timeout",
  })).code, "TIMEOUT");
});

test("auth login maps invalid credentials and does not store password", async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/social-automation/rpa-admin/login") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["invalid_credentials"] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  let token: string | null = null;
  const client = createHttpSeoOpsAuthClient({
    baseUrl: `http://127.0.0.1:${port}`,
    tokenStore: { getToken: () => token, setToken: (t) => { token = t; } },
  });
  const result = await client.login("owner@example.com", "wrong-password");
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, ["invalid_credentials"]);
  assert.equal(token, null);
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("script catalog empty array and publish conflict/idempotent contracts", async () => {
  let publishCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (req.method === "GET" && url === "/api/v1/social-automation/rpa-admin/scripts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scripts: [] }));
      return;
    }
    if (req.method === "POST" && url === "/api/v1/social-automation/rpa-admin/scripts/publish") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        publishCount += 1;
        const parsed = JSON.parse(body) as { content_digest?: string; version?: string };
        if (publishCount === 1) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            outcome: "idempotent",
            release: { content_digest: parsed.content_digest, version: parsed.version },
          }));
          return;
        }
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, outcome: "conflict", errors: ["version_digest_conflict"] }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, errors: ["not_found"] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const client = createHttpScriptSyncClient({
    baseUrl: `http://127.0.0.1:${port}`,
    getToken: () => "test-token",
  });
  assert.deepEqual(await client.catalog(), []);

  const flow: Flow = {
    id: "contract-demo",
    name: "Contract Demo",
    zoom: 1,
    steps: [{ id: "s1", version: 1 }],
    groups: [],
    variables: [{ id: "v1", key: "text", type: "text" }],
    defaultPattern: { values: {} },
  };
  const steps: Step[] = [{
    id: "s1",
    version: 1,
    name: "sleep",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { action: "SLEEP", timeoutMs: 100 },
  }];
  const videoDemo = toScriptVideoDemo(attachVideoDemo({
    scriptId: flow.id,
    scriptVersion: "1",
    caseId: "11111111-1111-1111-1111-111111111111",
    testRunId: "22222222-2222-2222-2222-222222222222",
    executionDigest: "a".repeat(64),
    sha256: "b".repeat(64),
    thumbnailRef: "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/recording-thumb.jpg",
    thumbnailSha256: "c".repeat(64),
    reviewed: true,
  }));
  const body = buildScriptPublishBody({ flow, steps, version: "1", videoDemo });

  const idempotent = await client.publish(body);
  assert.equal(idempotent.httpStatus, 200);
  assert.equal((idempotent as { outcome?: string }).outcome, "idempotent");

  const conflict = await client.publish(body);
  assert.equal(conflict.httpStatus, 409);
  assert.deepEqual((conflict as { errors?: string[] }).errors, ["version_digest_conflict"]);
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("seoOpsFetch times out and surfaces timeout category", async () => {
  const server = http.createServer((_req, res) => {
    // never respond
    void res;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await assert.rejects(
    () => seoOpsFetch(`http://127.0.0.1:${port}/hang`, { method: "GET" }, fetch, 50),
    (error: unknown) => {
      assert.ok(error instanceof SeoOpsHttpError);
      assert.equal(error.diagnostic.category, "timeout");
      return true;
    },
  );
  server.close();
});
