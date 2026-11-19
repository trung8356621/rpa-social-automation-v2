import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
} from "../src/shared/collectors/part-library-repository.js";
import type { VisualFeedItemPartConfig } from "../src/shared/collectors/part-library-types.js";
import {
  adoptExistingVisualFeedData,
  findVisualFeedOwnersByFingerprint,
  isCompleteVisualFeedConfig,
  visualFeedContentFingerprint,
} from "../src/shared/collectors/visual-feed-adoption.js";
import {
  LEGACY_FEED_VISUAL_RUN_KEY,
  LEGACY_FEED_VISUAL_TEMPLATES_KEY,
  buildVisualFeedConfigFromLegacy,
  legacyVisualFeedRawSnapshot,
  peekLegacyVisualFeedData,
} from "../src/shared/collectors/visual-feed-legacy-import.js";

function seedLegacy(kv: MemoryKeyValueStorage) {
  const templates = {
    like: {
      kind: "like",
      dataUrl: "data:legacy-like",
      width: 8,
      height: 8,
      sourceFrameId: "f1",
      bbox: { x: 0, y: 0, width: 8, height: 8 },
    },
    comment: {
      kind: "comment",
      dataUrl: "data:legacy-comment",
      width: 8,
      height: 8,
      sourceFrameId: "f1",
      bbox: { x: 0, y: 0, width: 8, height: 8 },
    },
    share: {
      kind: "share",
      dataUrl: "data:legacy-share",
      width: 8,
      height: 8,
      sourceFrameId: "f1",
      bbox: { x: 0, y: 0, width: 8, height: 8 },
    },
  };
  const reports = Array.from({ length: 5 }, (_, i) => ({
    frame: i,
    candidates: Array.from({ length: i === 0 ? 8 : 0 }, () => ({
      boundary: { hitElement: true, status: "BOUNDARY_FOUND" },
    })),
  }));
  kv.setItem(LEGACY_FEED_VISUAL_TEMPLATES_KEY, JSON.stringify(templates));
  kv.setItem(
    LEGACY_FEED_VISUAL_RUN_KEY,
    JSON.stringify({
      reports,
      summaryStats: { totalActionRows: 8, domHitSuccess: 8, boundaryFound: 8 },
      currentRunId: "run_legacy_1",
    }),
  );
  return { templates, reports };
}

test("inventory: legacy peek exposes templates + 5 samples / 8 rows before adoption", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const peek = peekLegacyVisualFeedData(kv);
  assert.equal(peek.hasTemplates, true);
  assert.equal(peek.sampleCount, 5);
  assert.equal(peek.actionRowCount, 8);
  assert.equal(peek.domHitCount, 8);
  assert.equal(peek.boundaryFoundCount, 8);
});

test("reuses previously imported Part (e.g. test) by fingerprint — not by name", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const before = legacyVisualFeedRawSnapshot(kv);
  const repo = new PartLibraryRepository(kv);
  const legacy = peekLegacyVisualFeedData(kv);
  const built = buildVisualFeedConfigFromLegacy(legacy);
  assert.ok(built.ok);
  if (!built.ok) return;

  // Simulate PO Part named "test" that already received a prior manual import.
  const testPart = repo.createVisualFeedItemPart("test");
  repo.updatePartConfig(testPart.partId, built.config);

  const first = repo.adoptExistingVisualFeed(kv);
  assert.equal(first.status, "reused_existing_owner");
  assert.equal(first.partId, testPart.partId);
  assert.equal(first.partName, "test");
  assert.equal(first.created, false);
  assert.equal(first.inventory.matchingOwnerCount, 1);

  const second = repo.adoptExistingVisualFeed(kv);
  assert.equal(second.status, "already_adopted");
  assert.equal(second.partId, testPart.partId);
  assert.equal(repo.listParts().filter((p) => p.editor === "feed-item-visual").length, 1);
  assert.deepEqual(legacyVisualFeedRawSnapshot(kv), before);
});

test("creates exactly one Part when none owns the legacy fingerprint; reload does not duplicate", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const before = legacyVisualFeedRawSnapshot(kv);
  const repo = new PartLibraryRepository(kv);
  // Empty decoy must not be treated as owner.
  repo.createVisualFeedItemPart("empty-decoy");

  const first = repo.adoptExistingVisualFeed(kv);
  assert.equal(first.status, "created_initial_part");
  assert.equal(first.created, true);
  assert.ok(first.partId);

  const second = repo.adoptExistingVisualFeed(kv);
  assert.equal(second.status, "already_adopted");
  assert.equal(second.partId, first.partId);

  const visualParts = repo.listParts().filter((p) => p.editor === "feed-item-visual");
  // empty-decoy + one adopted
  assert.equal(visualParts.length, 2);
  const adopted = repo.getPart(first.partId!);
  assert.ok(adopted && adopted.config.kind === "visual_feed_item");
  if (adopted?.config.kind === "visual_feed_item") {
    assert.equal(adopted.config.reports?.length, 5);
    assert.equal(adopted.config.currentRunId, "run_legacy_1");
  }
  assert.deepEqual(legacyVisualFeedRawSnapshot(kv), before);
});

test("Part A/B isolation remains intact after adoption", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const repo = new PartLibraryRepository(kv);
  const adoption = repo.adoptExistingVisualFeed(kv);
  assert.ok(adoption.partId);

  const partB = repo.createVisualFeedItemPart("Part B");
  assert.ok(partB.config.kind === "visual_feed_item");
  assert.equal(isCompleteVisualFeedConfig(partB.config), false);

  const adopted = repo.getPart(adoption.partId!)?.config as VisualFeedItemPartConfig;
  assert.equal(adopted.reports?.length, 5);
  assert.equal((repo.getPart(partB.partId)?.config as VisualFeedItemPartConfig).reports?.length ?? 0, 0);
});

test("Collector Script refs remain valid after adoption reuses Part id", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const repo = new PartLibraryRepository(kv);
  const legacy = peekLegacyVisualFeedData(kv);
  const built = buildVisualFeedConfigFromLegacy(legacy);
  assert.ok(built.ok);
  if (!built.ok) return;
  const testPart = repo.createVisualFeedItemPart("test");
  repo.updatePartConfig(testPart.partId, built.config);
  const script = repo.createCollectorScript("Script for test", [
    { partId: testPart.partId, partVersion: testPart.version },
  ]);

  const adoption = repo.adoptExistingVisualFeed(kv);
  assert.equal(adoption.partId, testPart.partId);
  const reloaded = repo.getScript(script.scriptId);
  assert.ok(reloaded);
  assert.equal(reloaded!.partRefs[0]?.partId, testPart.partId);
  assert.ok(repo.getPart(reloaded!.partRefs[0]!.partId));
});

test("debug sidebar labels remain for Feed Visual Counter and Post Detail Extractor", () => {
  const shell = fs.readFileSync(new URL("../src/renderer/app-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /page: "feed-item-collector", label: "Feed Visual Counter"/);
  assert.match(shell, /page: "post-detail-collector", label: "Post Detail Extractor"/);
  assert.match(shell, /page: "collectors", label: "Collectors"/);
});

test("ownership is fingerprint-based; name alone does not claim ownership", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const legacy = peekLegacyVisualFeedData(kv);
  const fp = visualFeedContentFingerprint({
    templates: legacy.templates,
    reports: legacy.reports,
    currentRunId: legacy.currentRunId,
    summaryStats: legacy.summaryStats,
  });
  const repo = new PartLibraryRepository(kv);
  const namedTest = repo.createVisualFeedItemPart("test"); // empty — must not own
  const owners = findVisualFeedOwnersByFingerprint(repo.listParts(), fp);
  assert.equal(owners.length, 0);
  assert.equal(namedTest.name, "test");

  const result = adoptExistingVisualFeedData({
    loadEnvelope: () => repo.load(),
    saveEnvelope: (e) => repo.save(e),
    legacyStorage: kv,
  });
  assert.equal(result.status, "created_initial_part");
  assert.notEqual(result.partId, namedTest.partId);
});
