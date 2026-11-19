import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
} from "../src/shared/collectors/part-library-repository.js";
import type { VisualFeedItemPartConfig } from "../src/shared/collectors/part-library-types.js";
import {
  LEGACY_FEED_VISUAL_RUN_KEY,
  LEGACY_FEED_VISUAL_TEMPLATES_KEY,
  buildVisualFeedConfigFromLegacy,
  isVisualFeedPartConfigEmpty,
  legacyVisualFeedRawSnapshot,
  peekLegacyVisualFeedData,
} from "../src/shared/collectors/visual-feed-legacy-import.js";
import { LIVE_TEMPLATE_KEY } from "../src/renderer/experiments/visual-match-lab/LiveTemplateCalibration.js";
import { setPartLibraryRepositoryForTests } from "../src/renderer/collectors/active-part-session.js";
import {
  FEED_COLLECTOR_STATE_KEY,
  bindFeedCollectorToPart,
  getFeedCollectorState,
  importLegacyVisualFeedIntoBoundPart,
  unbindFeedCollectorFromPart,
} from "../src/renderer/feed-item-collector/store.js";

function memoryLocalStorage(backing: MemoryKeyValueStorage): Storage {
  return {
    get length() {
      return 0;
    },
    clear() {},
    getItem(key: string) {
      return backing.getItem(key);
    },
    setItem(key: string, value: string) {
      backing.setItem(key, value);
    },
    removeItem(key: string) {
      backing.removeItem(key);
    },
    key() {
      return null;
    },
  } as Storage;
}

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

test("legacy peek reports samples and counters without mutating keys", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const before = legacyVisualFeedRawSnapshot(kv);
  const peek = peekLegacyVisualFeedData(kv);
  assert.equal(peek.sampleCount, 5);
  assert.equal(peek.actionRowCount, 8);
  assert.equal(peek.domHitCount, 8);
  assert.equal(peek.boundaryFoundCount, 8);
  assert.equal(peek.hasTemplates, true);
  assert.equal(peek.hasRun, true);
  assert.deepEqual(legacyVisualFeedRawSnapshot(kv), before);
});

test("new empty Parts stay empty by default; empty Part can import legacy copy", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const before = legacyVisualFeedRawSnapshot(kv);
  const repo = new PartLibraryRepository(kv);
  const part = repo.createVisualFeedItemPart("Empty Part");
  assert.ok(part.config.kind === "visual_feed_item");
  assert.equal(isVisualFeedPartConfigEmpty(part.config), true);

  const built = buildVisualFeedConfigFromLegacy(peekLegacyVisualFeedData(kv), {}, part.config);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  repo.updatePartConfig(part.partId, built.config);
  const reloaded = repo.getPart(part.partId)?.config as VisualFeedItemPartConfig;
  assert.equal(reloaded.reports?.length, 5);
  assert.equal(reloaded.templates.like?.dataUrl, "data:legacy-like");
  assert.deepEqual(legacyVisualFeedRawSnapshot(kv), before);
});

test("Part A import does not populate Part B; A→B→A and reopen preserve A", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const before = legacyVisualFeedRawSnapshot(kv);
  const repo = new PartLibraryRepository(kv);
  const partA = repo.createVisualFeedItemPart("Part A");
  const partB = repo.createVisualFeedItemPart("Part B");
  const legacy = peekLegacyVisualFeedData(kv);
  const imported = buildVisualFeedConfigFromLegacy(legacy, {}, partA.config);
  assert.ok(imported.ok);
  if (!imported.ok) return;
  repo.updatePartConfig(partA.partId, imported.config);

  const cfgB = repo.getPart(partB.partId)?.config as VisualFeedItemPartConfig;
  assert.equal(isVisualFeedPartConfigEmpty(cfgB), true);

  const cfgA1 = repo.getPart(partA.partId)?.config as VisualFeedItemPartConfig;
  assert.equal(cfgA1.currentRunId, "run_legacy_1");

  // Simulate switch B then back to A via repository (isolation of configs).
  const cfgA2 = repo.getPart(partA.partId)?.config as VisualFeedItemPartConfig;
  assert.equal(cfgA2.reports?.length, 5);
  assert.equal((repo.getPart(partB.partId)?.config as VisualFeedItemPartConfig).reports?.length ?? 0, 0);
  assert.deepEqual(legacyVisualFeedRawSnapshot(kv), before);
});

test("import refuses to overwrite non-empty Part without explicit overwrite", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  const existing: VisualFeedItemPartConfig = {
    kind: "visual_feed_item",
    templates: {
      like: {
        kind: "like",
        dataUrl: "data:part-owned",
        width: 1,
        height: 1,
        sourceFrameId: "p",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
      },
    },
    reports: [{ frame: 0, candidates: [] }],
    summaryStats: null,
    currentRunId: "run_part",
  };
  const refused = buildVisualFeedConfigFromLegacy(peekLegacyVisualFeedData(kv), {}, existing);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, "part_not_empty");
});

test("store import into bound Part leaves legacy LIVE_TEMPLATE and run keys unchanged", () => {
  const kv = new MemoryKeyValueStorage();
  seedLegacy(kv);
  // Mirror keys used by store helpers.
  assert.equal(LEGACY_FEED_VISUAL_TEMPLATES_KEY, LIVE_TEMPLATE_KEY);
  assert.equal(LEGACY_FEED_VISUAL_RUN_KEY, FEED_COLLECTOR_STATE_KEY);

  const sessionKv = new MemoryKeyValueStorage();
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  Object.defineProperty(globalThis, "localStorage", { value: memoryLocalStorage(kv), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: memoryLocalStorage(sessionKv),
    configurable: true,
  });

  const repo = new PartLibraryRepository(kv);
  setPartLibraryRepositoryForTests(repo);

  try {
    const before = {
      templates: kv.getItem(LIVE_TEMPLATE_KEY),
      run: kv.getItem(FEED_COLLECTOR_STATE_KEY),
    };
    const partA = repo.createVisualFeedItemPart("Import Target");
    const partB = repo.createVisualFeedItemPart("Other Part");
    bindFeedCollectorToPart(partA.partId);
    assert.equal(getFeedCollectorState().reports.length, 0);

    const result = importLegacyVisualFeedIntoBoundPart();
    assert.equal(result.ok, true);
    assert.equal(getFeedCollectorState().reports.length, 5);
    assert.equal(getFeedCollectorState().templates.like?.dataUrl, "data:legacy-like");
    assert.equal(kv.getItem(LIVE_TEMPLATE_KEY), before.templates);
    assert.equal(kv.getItem(FEED_COLLECTOR_STATE_KEY), before.run);

    bindFeedCollectorToPart(partB.partId);
    assert.equal(getFeedCollectorState().reports.length, 0);

    bindFeedCollectorToPart(partA.partId);
    assert.equal(getFeedCollectorState().reports.length, 5);
    assert.equal(getFeedCollectorState().currentRunId, "run_legacy_1");

    // Non-empty Part refuses second import without overwrite.
    const refused = importLegacyVisualFeedIntoBoundPart();
    assert.equal(refused.ok, false);

    unbindFeedCollectorFromPart();
    assert.equal(kv.getItem(LIVE_TEMPLATE_KEY), before.templates);
    assert.equal(kv.getItem(FEED_COLLECTOR_STATE_KEY), before.run);
  } finally {
    setPartLibraryRepositoryForTests(null);
    Object.defineProperty(globalThis, "localStorage", { value: previousLocal, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: previousSession, configurable: true });
  }
});

test("Feed Visual Counter page exposes Import Existing Visual Data affordance", () => {
  const page = fs.readFileSync(
    new URL("../src/renderer/feed-item-collector/FeedItemCollectorPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /Import Existing Visual Data/);
  assert.match(page, /importLegacyVisualFeedIntoBoundPart/);
  assert.match(page, /inspectLegacyVisualFeedData/);
});
