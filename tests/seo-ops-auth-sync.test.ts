import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRpaAdminRole,
  createHttpSeoOpsAuthClient,
  mapSeoOpsAuthError,
  mapSeoOpsAuthErrors,
} from "../src/shared/seo-ops-auth.js";
import {
  importScriptRelease,
  planScriptSync,
} from "../src/shared/script-sync.js";

test("admin and owner roles allowed; staff rejected", () => {
  assert.equal(assertRpaAdminRole("admin"), true);
  assert.equal(assertRpaAdminRole("owner"), true);
  assert.equal(assertRpaAdminRole("staff"), false);
});

test("maps SEO-OPS auth errors to safe Vietnamese copy", () => {
  assert.equal(
    mapSeoOpsAuthError("schema_unavailable"),
    "SEO-OPS chưa hoàn tất thiết lập database Social Automation.",
  );
  assert.equal(mapSeoOpsAuthError("invalid_credentials"), "Email hoặc mật khẩu không đúng.");
  assert.equal(mapSeoOpsAuthError("forbidden"), "Tài khoản không có quyền sử dụng RPA Admin.");
  assert.equal(mapSeoOpsAuthError("role_staff_forbidden"), "Tài khoản không có quyền sử dụng RPA Admin.");
  assert.equal(mapSeoOpsAuthError("network_error"), "Không kết nối được SEO-OPS.");
  assert.equal(mapSeoOpsAuthError("Failed to fetch"), "Không kết nối được SEO-OPS.");
  assert.equal(mapSeoOpsAuthErrors(["schema_unavailable", "other"]), mapSeoOpsAuthError("schema_unavailable"));
});

test("login network failure returns network_error without throwing", async () => {
  const client = createHttpSeoOpsAuthClient({
    baseUrl: "http://seo-ops.test",
    tokenStore: { getToken: () => null, setToken: () => undefined },
    fetchImpl: (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch,
  });
  const result = await client.login("a@b.c", "x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, ["network_error"]);
});

test("login ignores user_id and stores token only via TokenStore", async () => {
  let stored: string | null = null;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(body.user_id, undefined);
    assert.equal(body.email, "owner@example.test");
    return new Response(
      JSON.stringify({
        ok: true,
        token: "opaque-token-value",
        expires_at: "2026-10-23T00:00:00Z",
        user: { id: 7, email: "owner@example.test", name: "Owner", role: "owner" },
      }),
      { status: 200 },
    );
  };
  const client = createHttpSeoOpsAuthClient({
    baseUrl: "http://seo-ops.test",
    tokenStore: {
      getToken: () => stored,
      setToken: (t) => {
        stored = t;
      },
    },
    fetchImpl: fetchImpl as typeof fetch,
  });
  const result = await client.login("owner@example.test", "secret");
  assert.equal(result.ok, true);
  assert.equal(stored, "opaque-token-value");
});

test("script missing one side syncs; same digest skips; conflict no overwrite", () => {
  const digA = "a".repeat(64);
  const digB = "b".repeat(64);
  const digC = "c".repeat(64);
  const plan = planScriptSync(
    [
      { script_id: "only-local", package_key: "only-local", version: "1.0.0", content_digest: digA },
      { script_id: "same", package_key: "same", version: "1.0.0", content_digest: digC },
      { script_id: "conflict", package_key: "conflict", version: "1.0.1", content_digest: digA },
    ],
    [
      { script_id: "only-remote", package_key: "only-remote", version: "1.0.0", content_digest: digB },
      { script_id: "same", package_key: "same", version: "1.0.0", content_digest: digC },
      { script_id: "conflict", package_key: "conflict", version: "1.0.2", content_digest: digB },
    ],
  );
  assert.equal(plan.push_to_remote.some((r) => r.script_id === "only-local"), true);
  assert.equal(plan.pull_to_local.some((r) => r.script_id === "only-remote"), true);
  assert.equal(plan.skip.some((s) => s.script_id === "same" && s.reason === "same_digest"), true);
  assert.equal(plan.conflicts.some((c) => c.script_id === "conflict"), true);
  assert.equal(plan.push_to_remote.some((r) => r.script_id === "conflict"), false);
  assert.equal(plan.pull_to_local.some((r) => r.script_id === "conflict"), false);
});

test("import marks incomplete when assets missing; usable when complete", () => {
  const incomplete = importScriptRelease({
    package_key: "s1",
    name: "S1",
    version: "1.0.0",
    content_digest: "d".repeat(64),
    manifest: {
      script_id: "s1",
      variables: [{ key: "t", type: "text" }],
      steps: [{ id: "1", action: "CLICK_TARGET" }],
      assets: [{ path: "a.png", sha256: "bad" }],
    },
  });
  assert.equal(incomplete.ready_to_execute, false);
  assert.equal(incomplete.incomplete, true);
  assert.equal(incomplete.flowPayload, null);

  const complete = importScriptRelease({
    package_key: "s1",
    name: "S1",
    version: "1.0.0",
    content_digest: "d".repeat(64),
    manifest: {
      script_id: "s1",
      variables: [{ key: "t", type: "text" }],
      steps: [{ id: "1", action: "CLICK_TARGET" }],
      assets: [{ path: "a.png", sha256: "a".repeat(64), kind: "roi" }],
    },
  });
  assert.equal(complete.ready_to_execute, true);
  assert.ok(complete.flowPayload);
  assert.equal(complete.flowPayload?.id, "s1");
});
