import test from "node:test";
import assert from "node:assert/strict";
import { resolveActionTagUrl, resolveUrlFromActionTag } from "../src/shared/action-tag-url.js";
import type { ActionTag } from "../src/shared/contracts.js";

test("resolve mayhopphat.login from site base + path pattern", () => {
  const result = resolveActionTagUrl({
    baseUrl: "https://mayhopphat.com",
    urlPattern: "/wp-login.php",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url, "https://mayhopphat.com/wp-login.php");
});

test("resolve facebook.group.post with group_id input", () => {
  const result = resolveActionTagUrl({
    baseUrl: "https://www.facebook.com",
    urlPattern: "/groups/{group_id}",
    pathInputs: [{ key: "group_id", type: "string", required: true }],
    values: { group_id: "seovamarketing" },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url, "https://www.facebook.com/groups/seovamarketing");
});

test("missing required path input does not invent URL", () => {
  const result = resolveActionTagUrl({
    baseUrl: "https://www.facebook.com",
    urlPattern: "/groups/{group_id}/posts",
    pathInputs: [{ key: "group_id", type: "string", required: true }],
    values: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_inputs");
    assert.deepEqual(result.missingKeys, ["group_id"]);
  }
});

test("missing metadata returns URL unavailable — never derive from tag_key", () => {
  const tag: ActionTag = {
    id: 11,
    tag_key: "mayhopphat.login",
    platform: "mayhopphat",
    target: "login",
    action: "",
    name: "Login",
  };
  const result = resolveUrlFromActionTag(tag);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_metadata");
    assert.equal(result.message, "URL unavailable");
  }
});

test("absolute pattern wins over base join", () => {
  const result = resolveActionTagUrl({
    baseUrl: "https://mayhopphat.com",
    urlPattern: "https://mayhopphat.com/wp-admin/",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url, "https://mayhopphat.com/wp-admin/");
});
