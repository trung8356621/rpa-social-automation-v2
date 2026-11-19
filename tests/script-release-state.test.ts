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

test("remote is source of truth — digest mismatch adopts remote instead of conflict block", () => {
  const adopted = resolveScriptReleaseState({
    local: { version: "2", contentDigest: "local", executionDigest: "exec-2" },
    remote: { version: "2", content_digest: "remote", execution_digest: "exec-2" },
    currentExecutionDigest: "exec-2",
  });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  assert.equal(adopted.local.contentDigest, "remote");
  assert.equal(adopted.targetVersion, "2");
  assert.equal(adopted.draftStatus, "unchanged");

  const bumpFromRemote = resolveScriptReleaseState({
    local: { version: "1", contentDigest: "stale", executionDigest: "old" },
    remote: { version: "3", content_digest: "r3", execution_digest: "e3" },
    currentExecutionDigest: "new-exec",
  });
  assert.equal(bumpFromRemote.ok, true);
  if (!bumpFromRemote.ok) return;
  assert.equal(bumpFromRemote.local.version, "3");
  assert.equal(bumpFromRemote.targetVersion, "4");

  assert.throws(() => resolveScriptReleaseState({ local: {}, remote: {
    version: "1.2.3", content_digest: "x", execution_digest: "x",
  }, currentExecutionDigest: "x" }), /SCRIPT_VERSION_UNSUPPORTED/);
});

test("legacy 1.0.0 without execution digest soft-recovers instead of blocking", () => {
  const soft = resolveScriptReleaseState({
    local: { version: "1.0.0" },
    currentExecutionDigest: "digest-1",
  });
  assert.equal(soft.ok, true);
  if (!soft.ok) return;
  assert.equal(soft.local.version, "1");
  assert.equal(soft.targetVersion, "2");

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
