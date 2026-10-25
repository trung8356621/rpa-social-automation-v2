import test from "node:test";
import assert from "node:assert/strict";
import { readSeoOpsJson, SeoOpsHttpError } from "../src/shared/seo-ops-http.js";
import { syncIpcDiagnostic } from "../src/shared/sync-ipc.js";

test("SEO-OPS API rejects HTML before JSON parsing with redacted endpoint diagnostics", async () => {
  const response = new Response("<!DOCTYPE html><title>Forbidden</title>", { status: 403, headers: { "Content-Type": "text/html; charset=UTF-8" } });
  await assert.rejects(() => readSeoOpsJson(response, "POST", "https://seo.test/api/backup?token=secret"), (error: unknown) => {
    assert.ok(error instanceof SeoOpsHttpError); assert.equal(error.diagnostic.status, 403);
    assert.equal(error.diagnostic.endpoint, "/api/backup"); assert.doesNotMatch(error.message, /secret|DOCTYPE/);
    assert.equal(syncIpcDiagnostic(error).code, "AUTHORIZATION_FAILURE"); return true;
  });
});

test("SEO-OPS API reports redirects and accepts JSON errors without SyntaxError", async () => {
  const redirect = new Response("login", { status: 302, headers: { "Content-Type": "text/html", Location: "/login?next=secret" } });
  await assert.rejects(() => readSeoOpsJson(redirect, "GET", "https://seo.test/api/session"), /redirect=\/login/);
  const json = await readSeoOpsJson(new Response(JSON.stringify({ ok: false, errors: ["backup_schema_unavailable"] }),
    { status: 503, headers: { "Content-Type": "application/json" } }), "GET", "https://seo.test/api/backup");
  assert.deepEqual(json.errors, ["backup_schema_unavailable"]);
});

test("SEO-OPS HTTP 429 is classified before HTML parsing and preserves Retry-After", async () => {
  const response = new Response("<html>rate limited</html>", { status: 429,
    headers: { "Content-Type": "text/html", "Retry-After": "30" } });
  await assert.rejects(() => readSeoOpsJson(response, "GET", "https://seo.test/api/backup"), (error: unknown) => {
    assert.ok(error instanceof SeoOpsHttpError);
    assert.equal(error.diagnostic.category, "rate_limited");
    assert.equal(error.diagnostic.retryAfterSeconds, 30);
    const diagnostic = syncIpcDiagnostic(error);
    assert.equal(diagnostic.code, "RATE_LIMITED");
    assert.match(diagnostic.message, /30 giây/);
    return true;
  });
});

test("SEO-OPS HTTP diagnostics keep authorization, server, and unavailable responses separate", async () => {
  for (const [status, code] of [[403, "AUTHORIZATION_FAILURE"], [500, "SERVER_ERROR"], [503, "SERVICE_UNAVAILABLE"]] as const) {
    const response = new Response("<html>error</html>", { status, headers: { "Content-Type": "text/html" } });
    await assert.rejects(() => readSeoOpsJson(response, "GET", "https://seo.test/api/backup"), (error: unknown) => {
      assert.equal(syncIpcDiagnostic(error).code, code);
      return true;
    });
  }
});
