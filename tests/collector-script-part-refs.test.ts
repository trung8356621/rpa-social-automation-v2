import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
} from "../src/shared/collectors/part-library-repository.js";
import {
  addPartRef,
  removePartRefAt,
  resolveScriptPartRefs,
} from "../src/shared/collectors/script-part-refs.js";

test("add Visual + Network to one Collector Script", () => {
  const repo = new PartLibraryRepository(new MemoryKeyValueStorage());
  const visual = repo.createVisualFeedItemPart("test");
  const network = repo.createNetworkDraftPart("test network");
  let refs = addPartRef([], { partId: visual.partId, partVersion: visual.version }).refs;
  refs = addPartRef(refs, { partId: network.partId, partVersion: network.version }).refs;
  const script = repo.createCollectorScript("compose-both", refs);
  assert.equal(script.partRefs.length, 2);
  assert.equal(script.partRefs[0]?.partId, visual.partId);
  assert.equal(script.partRefs[1]?.partId, network.partId);
});

test("add two different Visual Parts without replacing the first", () => {
  const repo = new PartLibraryRepository(new MemoryKeyValueStorage());
  const a = repo.createVisualFeedItemPart("visual-a");
  const b = repo.createVisualFeedItemPart("visual-b");
  let refs = addPartRef([], { partId: a.partId, partVersion: a.version }).refs;
  const second = addPartRef(refs, { partId: b.partId, partVersion: b.version });
  assert.equal(second.added, true);
  assert.equal(second.refs.length, 2);
  assert.equal(second.refs[0]?.partId, a.partId);
  assert.equal(second.refs[1]?.partId, b.partId);
});

test("remove one Part without affecting others", () => {
  const refs = [
    { partId: "p1", partVersion: 1 },
    { partId: "p2", partVersion: 1 },
    { partId: "p3", partVersion: 1 },
  ];
  const next = removePartRefAt(refs, 1);
  assert.deepEqual(next, [
    { partId: "p1", partVersion: 1 },
    { partId: "p3", partVersion: 1 },
  ]);
});

test("save and reopen preserves all references; single-Part scripts remain valid", () => {
  const storage = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(storage);
  const visual = repo.createVisualFeedItemPart("test");
  const network = repo.createNetworkDraftPart("test network");
  const multi = repo.createCollectorScript("multi", [
    { partId: visual.partId, partVersion: visual.version },
    { partId: network.partId, partVersion: network.version },
  ]);
  const single = repo.createCollectorScript("single", [
    { partId: visual.partId, partVersion: visual.version },
  ]);

  const reloaded = new PartLibraryRepository(storage);
  assert.deepEqual(reloaded.getScript(multi.scriptId)?.partRefs, multi.partRefs);
  assert.deepEqual(reloaded.getScript(single.scriptId)?.partRefs, single.partRefs);
  assert.equal(reloaded.getScript(single.scriptId)?.partRefs.length, 1);
});

test("prevent accidental duplicate partId+partVersion references", () => {
  const refs = [{ partId: "p1", partVersion: 1 }];
  const dup = addPartRef(refs, { partId: "p1", partVersion: 1 });
  assert.equal(dup.added, false);
  assert.equal(dup.reason, "duplicate");
  assert.equal(dup.refs.length, 1);
  const otherVersion = addPartRef(refs, { partId: "p1", partVersion: 2 });
  assert.equal(otherVersion.added, true);
  assert.equal(otherVersion.refs.length, 2);
});

test("missing Part reference remains visible as unresolved", () => {
  const refs = [
    { partId: "alive", partVersion: 1 },
    { partId: "gone", partVersion: 3 },
  ];
  const lookup = new Map<
    string,
    { name: string; partType: "visual" | "network"; version: number } | undefined
  >([
    ["alive", { name: "test", partType: "visual", version: 1 }],
  ]);
  const resolved = resolveScriptPartRefs(refs, lookup);
  assert.equal(resolved[0]?.resolved, true);
  assert.equal(resolved[0]?.name, "test");
  assert.equal(resolved[1]?.resolved, false);
  assert.equal(resolved[1]?.partId, "gone");
  assert.equal(resolved[1]?.partVersion, 3);
  // Unresolved ref is retained in the array (not silently dropped).
  assert.equal(resolved.length, 2);
});

test("CollectorsHome uses multi-Part composition editor, not single-select replace", () => {
  const home = fs.readFileSync(
    new URL("../src/renderer/collectors/CollectorsHome.tsx", import.meta.url),
    "utf8",
  );
  assert.match(home, /ScriptPartCompositionEditor/);
  assert.match(home, /Add Part/);
  assert.match(home, /Selected Parts/);
  assert.match(home, /addPartRef/);
  assert.match(home, /removePartRefAt/);
  assert.match(home, /Missing Part|unresolved/);
  assert.doesNotMatch(
    home,
    /partRefs:\s*\[\s*\{\s*partId:\s*part\.partId,\s*partVersion:\s*part\.version\s*\}\s*\]/,
  );
});
