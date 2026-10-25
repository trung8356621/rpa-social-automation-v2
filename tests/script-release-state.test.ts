import test from "node:test";
import assert from "node:assert/strict";
import { resolveScriptReleaseState } from "../src/shared/script-release-state.js";

test("new, unchanged, changed and repeatedly saved drafts keep Admin-owned versions", () => {
  const fresh = resolveScriptReleaseState({ local: {}, currentExecutionDigest: "a" });
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(fresh.targetVersion, "1");
  assert.equal(fresh.draftStatus, "new");

  const unchanged = resolveScriptReleaseState({
    local: { version: "1", contentDigest: "release-a", executionDigest: "a" },
    currentExecutionDigest: "a",
  });
  assert.equal(unchanged.ok, true);
  if (!unchanged.ok) return;
  assert.equal(unchanged.targetVersion, "1");
  assert.equal(unchanged.draftStatus, "unchanged");

  for (let save = 0; save < 3; save++) {
    const changed = resolveScriptReleaseState({
      local: { version: "1", contentDigest: "release-a", executionDigest: "a" },
      currentExecutionDigest: "b",
    });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.equal(changed.targetVersion, "2");
    assert.equal(changed.draftVersion, "1.1");
  }
});

test("pending media retry reuses the same immutable version", () => {
  const retry = resolveScriptReleaseState({
    local: { version: "1", contentDigest: "one", executionDigest: "exec-1",
      pendingVersion: "2", pendingContentDigest: "two", pendingExecutionDigest: "exec-2" },
    currentExecutionDigest: "exec-2",
  });
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.targetVersion, "2");
});

test("legacy 1.0.0 recovers as generation 1 and advances to integer 2", () => {
  const recovered = resolveScriptReleaseState({ local: {}, remote: {
    version: "1.0.0", content_digest: "legacy", execution_digest: "exec-1",
  }, currentExecutionDigest: "exec-2" });
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(recovered.local.version, "1.0.0");
  assert.equal(recovered.targetVersion, "2");
  assert.equal(recovered.draftVersion, "1.1");
});

test("version/digest conflicts and unknown legacy formats are rejected", () => {
  const conflict = resolveScriptReleaseState({ local: {
    version: "2", contentDigest: "local", executionDigest: "exec-2",
  }, remote: { version: "2", content_digest: "remote", execution_digest: "exec-2" }, currentExecutionDigest: "exec-2" });
  assert.deepEqual(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, "SCRIPT_VERSION_CONFLICT");
  assert.throws(() => resolveScriptReleaseState({ local: {}, remote: {
    version: "1.2.3", content_digest: "x", execution_digest: "x",
  }, currentExecutionDigest: "x" }), /SCRIPT_VERSION_UNSUPPORTED/);
});

test("legacy 1.0.0 without execution digest requires verified evidence or reports incomplete", () => {
  const unverified = resolveScriptReleaseState({
    local: { version: "1.0.0" },
    currentExecutionDigest: "digest-1",
  });
  assert.equal(unverified.ok, false);
  if (!unverified.ok) assert.equal(unverified.error, "SCRIPT_VERSION_METADATA_INCOMPLETE");

  const verified = resolveScriptReleaseState({
    local: { version: "1.0.0" },
    currentExecutionDigest: "digest-1",
    verifiedLegacy: { executionDigest: "digest-1", contentDigest: "content-1" },
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.targetVersion, "1");
  assert.equal(verified.draftStatus, "unchanged");
  assert.equal(verified.local.executionDigest, "digest-1");
  assert.equal(verified.local.contentDigest, "content-1");
});
