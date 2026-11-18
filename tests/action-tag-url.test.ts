import test from "node:test";
import assert from "node:assert/strict";
import {
  actionTagStartUrlMode,
  isAutoTagStartUrl,
  resolveActionTagUrl,
  resolveUrlFromActionTag,
} from "../src/shared/action-tag-url.js";
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

test("Start URL mode uses resolve contract only — never tag_key / domain heuristics", () => {
  const wp: ActionTag = {
    id: 1,
    tag_key: "mayhopphat.login",
    platform: "mayhopphat",
    target: "login",
    action: "",
    name: "WP Login",
    base_url: "https://mayhopphat.com",
    url_pattern: "/wp-login.php",
    path_inputs: [],
  };
  const fb: ActionTag = {
    id: 2,
    tag_key: "facebook.group.post",
    platform: "facebook",
    target: "group",
    action: "post",
    name: "FB Group Post",
    base_url: "https://www.facebook.com",
    url_pattern: "/groups/{group_id}",
    path_inputs: [{ key: "group_id", type: "string", required: true }],
  };
  const namedOnly: ActionTag = {
    id: 3,
    tag_key: "mayhopphat.login",
    platform: "mayhopphat",
    target: "login",
    action: "",
    name: "Looks dynamic by name only",
  };
  assert.equal(actionTagStartUrlMode(wp), "auto");
  assert.equal(isAutoTagStartUrl(wp), true);
  assert.equal(actionTagStartUrlMode(fb), "manual");
  assert.equal(isAutoTagStartUrl(fb), false);
  assert.equal(actionTagStartUrlMode(namedOnly), "manual");
  assert.equal(actionTagStartUrlMode(undefined), "manual");
});
