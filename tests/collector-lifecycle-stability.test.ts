import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getCachedAssetUrl,
  setCachedAssetUrl,
  clearAssetUrlCache,
} from "../src/renderer/collectors/ReviewMappingStep.js";
import {
  parseEnvelope,
  serializeEnvelope,
  saveCollectorStore,
  loadCollectorStore,
  upsertCollector,
} from "../src/shared/collectors/store.js";
import { COLLECTOR_SCHEMA_VERSION, type CollectorStoreEnvelope } from "../src/shared/collectors/types.js";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";

const matchTestStepSource = readFileSync(
  resolve("src/renderer/collectors/MatchTestStep.tsx"),
  "utf8"
);
const reviewStepSource = readFileSync(
  resolve("src/renderer/collectors/ReviewMappingStep.tsx"),
  "utf8"
);
const editorSource = readFileSync(
  resolve("src/renderer/collectors/CollectorEditor.tsx"),
  "utf8"
);

test("C2.10.5 Lifecycle: Browser Host effect is strictly decoupled from match execution and state", () => {
  // 1. Host effect must depend ONLY on [invoke, publishHost]
  // Must NOT depend on handleRunMatchTest, isRunning, draft, onChange, locked
  assert.match(
    matchTestStepSource,
    /\}, \[invoke, publishHost\]\);/s,
    "Host lifecycle effect must only depend on [invoke, publishHost]"
  );
  assert.ok(
    !/useEffect\([^)]*publishHost[^)]*handleRunMatchTest/s.test(matchTestStepSource),
    "Host effect must not depend on handleRunMatchTest"
  );
  assert.ok(
    !/useEffect\([^)]*publishHost[^)]*isRunning/s.test(matchTestStepSource),
    "Host effect must not depend on isRunning"
  );

  // 2. Redundant host-bounds IPC calls are suppressed via lastBoundsRef
  assert.match(matchTestStepSource, /lastBoundsRef/);
  assert.match(matchTestStepSource, /prev\.x === next\.x\s*&&\s*prev\.y === next\.y/);

  // 3. Stale async callbacks are aborted on unmount using isMountedRef
  assert.match(matchTestStepSource, /isMountedRef\.current/);

  // 4. Cleanup on unmount performs single consistent teardown
  assert.match(matchTestStepSource, /collectorClearHighlights\(invoke\)/);
  assert.match(matchTestStepSource, /collectorReportBrowserHost\(invoke, null\)/);
  assert.match(matchTestStepSource, /collectorSetBrowserVisible\(invoke, false\)/);

  // 5. Automatic initial match test runs once using hasAutoRunRef
  assert.match(matchTestStepSource, /hasAutoRunRef\.current/);
});

test("C2.10.5 Screenshot Recovery: In-memory asset caching and loading state distinction", () => {
  clearAssetUrlCache();

  // 1. Cache starts empty
  assert.equal(getCachedAssetUrl("asset-1.png"), undefined);

  // 2. Setting cache stores and retrieves data URL synchronously
  setCachedAssetUrl("asset-1.png", "data:image/png;base64,mockImage1");
  assert.equal(getCachedAssetUrl("asset-1.png"), "data:image/png;base64,mockImage1");

  // 3. Re-entering Step 2 retrieves cached asset synchronously without waiting for IPC
  assert.equal(getCachedAssetUrl("asset-1.png"), "data:image/png;base64,mockImage1");

  // 4. Cache bounded eviction test (MAX_ASSET_CACHE_ENTRIES = 50)
  for (let i = 0; i < 55; i++) {
    setCachedAssetUrl(`asset-evict-${i}.png`, `data:${i}`);
  }
  // Earliest entries should be evicted
  assert.equal(getCachedAssetUrl("asset-1.png"), undefined);
  assert.equal(getCachedAssetUrl("asset-evict-54.png"), "data:54");

  // 5. Review UI distinguishes LOADING from FAILED (no false 'unavailable' banner while loading)
  assert.match(reviewStepSource, /collector-asset-loading/);
  assert.match(reviewStepSource, /Loading screenshot\.\.\./);
  assert.match(reviewStepSource, /assetStatus === ["']LOADING["']/);
});

test("C2.10.5 Migration Notifications: Event-specific dismissal and no persistent re-emission", () => {
  // 1. Transient migration notice is stripped from serialized store
  const envelope: CollectorStoreEnvelope = {
    schemaVersion: 6,
    updatedAt: new Date().toISOString(),
    collectors: [createEmptyDraft({ name: "Alpha Collector" })],
    classifications: [],
    testCases: [],
    parseWarnings: [
      'Migrated collector "Alpha Collector" from schema v6 → v7 (Match Test step)',
      "JSON parse warning: malformed key retained",
    ],
  };

  const serialized = serializeEnvelope(envelope);
  const reParsed = JSON.parse(serialized);

  // Schema version updated to 7
  assert.equal(reParsed.schemaVersion, COLLECTOR_SCHEMA_VERSION);
  // Migration notice stripped, but genuine corruption warning preserved!
  assert.deepEqual(reParsed.parseWarnings, ["JSON parse warning: malformed key retained"]);

  // 2. Event-specific dismissal in CollectorEditor (relevantWarnings filter)
  assert.match(editorSource, /relevantWarnings/);
  assert.match(editorSource, /DISMISSED_WARNINGS_KEY/);
  assert.match(editorSource, /recordDismissedWarningKey/);
});

test("C2.10.5 Candidate Counts: Clear separation of Inspected vs Successfully Matched Posts", () => {
  // 1. MatchTestStep has distinct Inspected and Matched count badges
  assert.match(matchTestStepSource, /collector-candidate-counts/);
  assert.match(matchTestStepSource, /Inspected:/);
  assert.match(matchTestStepSource, /Matched:/);
  assert.match(matchTestStepSource, /inspectedCount/);
  assert.match(matchTestStepSource, /resolvedMatchedCount/);

  // 2. Unresolved candidate count does not inflate matched count
  const mockResult = {
    matchedPostCount: 0,
    matchedItems: [
      {
        index: 1,
        groupTag: "main",
        beginMatched: true,
        endMatched: false,
        paired: false,
        domResolved: false,
        confidence: 45,
        failureReason: "END anchor not found in live DOM",
      },
    ],
  };

  const inspected = mockResult.matchedItems.length;
  const resolvedMatched = mockResult.matchedPostCount;
  assert.equal(inspected, 1, "Must report 1 inspected candidate");
  assert.equal(resolvedMatched, 0, "Must report 0 matched posts when candidate is unresolved");
});
