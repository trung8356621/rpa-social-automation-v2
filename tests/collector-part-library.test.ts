import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PART_LIBRARY_DEFAULT_STORAGE_KEY,
  PART_LIBRARY_SCHEMA_VERSION,
  type VisualFeedItemPartConfig,
} from "../src/shared/collectors/part-library-types.js";
import {
  MemoryKeyValueStorage,
  PartLibraryRepository,
  parsePartLibraryEnvelope,
} from "../src/shared/collectors/part-library-repository.js";
import { LIVE_TEMPLATE_KEY } from "../src/renderer/experiments/visual-match-lab/LiveTemplateCalibration.js";
import { setPartLibraryRepositoryForTests } from "../src/renderer/collectors/active-part-session.js";
import {
  bindFeedCollectorToPart,
  getBoundFeedItemPartId,
  getFeedCollectorState,
  setFeedCollectorState,
  unbindFeedCollectorFromPart,
} from "../src/renderer/feed-item-collector/store.js";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function memoryLocalStorage(backing: MemoryKeyValueStorage): Storage {
  return {
    get length() {
      return 0;
    },
    clear() {
      /* no-op for tests */
    },
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

test("part library repository persists parts and scripts without touching legacy collector key", () => {
  const storage = new MemoryKeyValueStorage();
  const repo = new PartLibraryRepository(storage);
  const part = repo.createVisualFeedItemPart("Visual A");
  const script = repo.createCollectorScript("Script 1", [
    { partId: part.partId, partVersion: part.version },
  ]);

  assert.equal(part.partType, "visual");
  assert.equal(part.editor, "feed-item-visual");
  assert.equal(part.config.kind, "visual_feed_item");
  assert.equal(script.partRefs[0]?.partId, part.partId);

  const reloaded = repo.getScript(script.scriptId);
  assert.ok(reloaded);
  assert.deepEqual(reloaded!.partRefs, [{ partId: part.partId, partVersion: 1 }]);

  assert.equal(storage.getItem("rpa.collectors.prototype.v1"), null);
  assert.ok(storage.getItem(PART_LIBRARY_DEFAULT_STORAGE_KEY));
  assert.equal(PART_LIBRARY_SCHEMA_VERSION, 1);
});

test("network part is draft-only and not marked ready", () => {
  const repo = new PartLibraryRepository(new MemoryKeyValueStorage());
  const part = repo.createNetworkDraftPart("Network Draft");
  assert.equal(part.partType, "network");
  assert.equal(part.status, "draft");
  assert.equal(part.editor, "none");
  assert.equal(part.config.kind, "network_draft");
  if (part.config.kind === "network_draft") {
    assert.equal(part.config.readiness, "not_implemented");
  }
});

test("malformed envelope retains rawBackup", () => {
  const envelope = parsePartLibraryEnvelope("{not-json");
  assert.ok(envelope.parseWarnings?.length);
  assert.equal(envelope.rawBackup, "{not-json");
  assert.equal(envelope.parts.length, 0);
});

test("Part A/B visual config isolation and reopen; legacy LIVE_TEMPLATE_KEY untouched", () => {
  const kv = new MemoryKeyValueStorage();
  const legacyMarker = JSON.stringify({ like: { kind: "like", dataUrl: "legacy", width: 1, height: 1, sourceFrameId: "x", bbox: { x: 0, y: 0, width: 1, height: 1 } } });
  kv.setItem(LIVE_TEMPLATE_KEY, legacyMarker);

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
    const partA = repo.createVisualFeedItemPart("Part A");
    const partB = repo.createVisualFeedItemPart("Part B");

    bindFeedCollectorToPart(partA.partId);
    assert.equal(getBoundFeedItemPartId(), partA.partId);
    setFeedCollectorState({
      templates: {
        like: {
          kind: "like",
          dataUrl: "data:a-like",
          width: 10,
          height: 10,
          sourceFrameId: "a",
          bbox: { x: 0, y: 0, width: 10, height: 10 },
        },
      },
    });

    bindFeedCollectorToPart(partB.partId);
    assert.equal(getBoundFeedItemPartId(), partB.partId);
    assert.equal(getFeedCollectorState().templates.like, undefined);
    setFeedCollectorState({
      templates: {
        like: {
          kind: "like",
          dataUrl: "data:b-like",
          width: 12,
          height: 12,
          sourceFrameId: "b",
          bbox: { x: 1, y: 1, width: 12, height: 12 },
        },
      },
    });

    bindFeedCollectorToPart(partA.partId);
    assert.equal(getFeedCollectorState().templates.like?.dataUrl, "data:a-like");

    bindFeedCollectorToPart(partB.partId);
    assert.equal(getFeedCollectorState().templates.like?.dataUrl, "data:b-like");

    const persistedA = repo.getPart(partA.partId)?.config as VisualFeedItemPartConfig;
    const persistedB = repo.getPart(partB.partId)?.config as VisualFeedItemPartConfig;
    assert.equal(persistedA.templates.like?.dataUrl, "data:a-like");
    assert.equal(persistedB.templates.like?.dataUrl, "data:b-like");

    // Legacy shared Visual Match Lab key must remain the original marker.
    assert.equal(kv.getItem(LIVE_TEMPLATE_KEY), legacyMarker);

    unbindFeedCollectorFromPart();
    assert.equal(getBoundFeedItemPartId(), null);
    assert.equal(kv.getItem(LIVE_TEMPLATE_KEY), legacyMarker);
  } finally {
    setPartLibraryRepositoryForTests(null);
    Object.defineProperty(globalThis, "localStorage", { value: previousLocal, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: previousSession, configurable: true });
  }
});

test("Collector Library navigation: menus restored; Legacy Collector V1 not surfaced", () => {
  const shell = read("src/renderer/app-shell.tsx");
  const home = read("src/renderer/collectors/CollectorsHome.tsx");
  const page = read("src/renderer/collectors/CollectorsPage.tsx");

  assert.match(shell, /page: "collectors", label: "Collectors"/);
  assert.match(shell, /page: "feed-item-collector", label: "Feed Visual Counter"/);
  assert.match(shell, /page: "post-detail-collector", label: "Post Detail Extractor"/);
  assert.match(shell, /page: "scenarios", label: "Scripts"/);
  assert.match(shell, /page: "browser-sessions", label: "Browser Sessions"/);

  assert.match(home, /Part Library/);
  assert.match(home, /Collector Scripts/);
  assert.match(home, /Create Part/);
  assert.match(home, /bindFeedCollectorToPart/);
  assert.match(home, /Feed Visual Counter/);
  assert.match(page, /CollectorsHome/);
  assert.match(page, /Collector Library/);
  // Abandoned five-stage wizard must not be mounted from normal Collectors UI.
  assert.doesNotMatch(page, /<CollectorEditor\b/);
  assert.doesNotMatch(page, /from "\.\/CollectorList"|from '\.\/CollectorList'/);
  assert.doesNotMatch(page, /legacySlot|Legacy Collector Wizard/);
  assert.doesNotMatch(home, /<CollectorEditor\b|WIZARD_STEPS|legacySlot/);
});
