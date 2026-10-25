import test from "node:test";
import assert from "node:assert/strict";
import { nextPublishedScriptVersion, parsePublishedScriptVersion } from "../src/shared/script-version.js";

test("integer releases advance monotonically", () => {
  assert.equal(nextPublishedScriptVersion(), "1");
  assert.equal(nextPublishedScriptVersion("1"), "2");
  assert.deepEqual(parsePublishedScriptVersion("12"), { raw: "12", ordinal: 12, kind: "integer" });
});

test("canonical legacy X.0.0 releases remain readable and upgrade to the next integer", () => {
  assert.equal(nextPublishedScriptVersion("1.0.0"), "2");
  assert.equal(nextPublishedScriptVersion("7.0.0"), "8");
  assert.throws(() => nextPublishedScriptVersion("1.2.3"), /SCRIPT_VERSION_UNSUPPORTED/);
  assert.throws(() => nextPublishedScriptVersion("1.0.0-beta"), /SCRIPT_VERSION_UNSUPPORTED/);
});
