import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Flow, Step } from "../src/shared/contracts.js";
import {
  buildScriptExport,
  digestsEqual,
  phpCompatibleJsonEncode,
  publishToPackageRegistry,
  sha256OfCanonicalPayload,
  stripSecrets,
} from "../src/shared/seoOps/index.js";

test("digest is deterministic for identical canonical payload", () => {
  const canonical = {
    package_key: "script.demo",
    kind: "script",
    version: "1.0.0",
    schema_version: 1,
    manifest: { steps: [{ action: "CLICK_TARGET" }] },
    dependencies: [],
    runtime_compatibility: { runner_min: "0.1.0" },
  };
  const a = sha256OfCanonicalPayload(canonical);
  const b = sha256OfCanonicalPayload({ ...canonical });
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(
    a,
    createHash("sha256")
      .update(phpCompatibleJsonEncode(canonical), "utf8")
      .digest("hex"),
  );
});

test("secret strip removes cookies and account switch knobs", () => {
  const { value, stripped } = stripSecrets({
    action: "CLICK_TARGET",
    cookie: "x",
    nested: { password: "y", keep: 1 },
    account_switch: true,
  });
  const obj = value as Record<string, unknown>;
  assert.equal(obj.action, "CLICK_TARGET");
  assert.equal((obj.nested as { keep: number }).keep, 1);
  assert.ok(!("cookie" in obj));
  assert.ok(!("account_switch" in obj));
  assert.ok(stripped.some((p) => p.includes("cookie")));
  assert.ok(stripped.some((p) => p.includes("password")));
});

test("script export preserves step order and versions; blocks server publish", () => {
  const flow: Flow = {
    id: "flow-1",
    name: "Facebook Composer",
    zoom: 100,
    steps: [
      { id: "s1", version: 2 },
      { id: "s2", version: 1 },
    ],
  };
  const steps: Step[] = [
    {
      id: "s1",
      version: 1,
      name: "old",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        action: "CLICK_TARGET",
        target: {
          asset: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png",
          roi: { x: 1, y: 2, width: 3, height: 4 },
        },
      },
    },
    {
      id: "s1",
      version: 2,
      name: "open composer",
      createdAt: "2026-01-02T00:00:00.000Z",
      payload: {
        action: "CLICK_TARGET",
        target: {
          asset: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png",
          roi: { x: 10, y: 20, width: 30, height: 40 },
        },
      },
    },
    {
      id: "s2",
      version: 1,
      name: "type",
      createdAt: "2026-01-03T00:00:00.000Z",
      payload: {
        action: "TYPE_ONLY",
        text: "hello",
        inputMethod: "keyboard",
      },
    },
  ];

  const exported = buildScriptExport(flow, steps, [], {
    script_key: "script.facebook.composer",
    version: "1.0.0",
  });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  assert.equal(exported.server_publish_ready, false);
  assert.ok(exported.blockers.includes("server_kind_script_unsupported"));
  assert.equal(exported.body.kind, "script");
  const manifest = exported.body.manifest as {
    steps: Array<{ id: string; version: number; name: string }>;
  };
  assert.equal(manifest.steps.length, 2);
  assert.equal(manifest.steps[0].id, "s1");
  assert.equal(manifest.steps[0].version, 2);
  assert.equal(manifest.steps[0].name, "open composer");
  assert.equal(manifest.steps[1].id, "s2");
  assert.deepEqual(exported.asset_refs, [
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png",
  ]);

  const again = buildScriptExport(flow, steps, [], {
    script_key: "script.facebook.composer",
    version: "1.0.0",
    last_publish: {
      script_key: "script.facebook.composer",
      version: "1.0.0",
      content_digest: exported.content_digest,
    },
  });
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.unchanged_since_publish, true);
    assert.ok(digestsEqual(again.content_digest, exported.content_digest));
  }
});

test("publish client maps unauthorized without throwing", async () => {
  const result = await publishToPackageRegistry({
    baseUrl: "http://127.0.0.1:9",
    credential: "",
    body: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.http_status, 401);
  assert.deepEqual(result.errors, ["unauthorized"]);
});

test("publish client maps mock 409 conflict", async () => {
  const result = await publishToPackageRegistry({
    baseUrl: "http://example.test",
    credential: "tok",
    body: { package_key: "x" },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          outcome: "conflict",
          errors: ["version_digest_conflict"],
          existing_digest: "aa".repeat(32),
        }),
        { status: 409 },
      ),
  });
  assert.equal(result.ok, false);
  assert.equal(result.http_status, 409);
  assert.equal(result.outcome, "conflict");
});
