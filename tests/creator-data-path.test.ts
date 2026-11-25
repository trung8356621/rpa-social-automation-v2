import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQaProfileArg,
  resolveCreatorDataDirName,
  sanitizeQaProfileName,
} from "../src/shared/creator-data-path.js";

test("sanitizeQaProfileName accepts facebook-sandbox", () => {
  assert.equal(sanitizeQaProfileName("facebook-sandbox"), "facebook-sandbox");
  assert.equal(sanitizeQaProfileName(" Facebook Sandbox "), "facebook-sandbox");
});

test("sanitizeQaProfileName rejects empty and reserved names", () => {
  assert.throws(() => sanitizeQaProfileName("@@@"), /empty/);
  assert.throws(() => sanitizeQaProfileName("creator"), /reserved/);
});

test("parseQaProfileArg supports = and separate forms", () => {
  assert.equal(parseQaProfileArg(["--qa-profile=facebook-sandbox"]), "facebook-sandbox");
  assert.equal(parseQaProfileArg(["--qa-profile", "facebook-sandbox"]), "facebook-sandbox");
  assert.equal(parseQaProfileArg(["--qa-isolated"]), undefined);
});

test("qa-profile is stable and preferred over qa-isolated", () => {
  assert.equal(
    resolveCreatorDataDirName({
      argv: ["--qa-isolated", "--qa-profile=facebook-sandbox"],
      pid: 22096,
    }),
    "qa-profile-facebook-sandbox",
  );
  assert.equal(
    resolveCreatorDataDirName({ argv: ["--qa-isolated"], pid: 22096 }),
    "qa-isolated-22096",
  );
  assert.equal(resolveCreatorDataDirName({ argv: [], pid: 1 }), "creator");
});
