import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTOR_SCHEMA_VERSION,
  COLLECTOR_STORAGE_KEY,
} from "../src/shared/collectors/types.js";
import {
  MemoryStorage,
  loadCollectorStore,
  migrateWizardStep,
  parseEnvelope,
  saveCollectorStore,
  upsertCollector,
  removeCollector,
} from "../src/shared/collectors/store.js";
import {
  WIZARD_STEPS,
  addCaptureItem,
  applyAuditActionAndAdvance,
  applyCapturedSample,
  auditForCapture,
  auditStatusCounts,
  captureLibraryCount,
  captureHasConfirmedAudit,
  confirmCaptureAudit,
  deleteCaptureItem,
  duplicateCollector,
  excludeCaptureItem,
  filterCollectors,
  filledSampleCount,
  getMapping,
  nextPendingReviewCaptureId,
  nextReviewCaptureId,
  normalizeRoi,
  proposeMappingsForCapture,
  restoreExcludedCapture,
  saveAsVersion,
  setCaptureAuditStatus,
  setCaptureMapping,
  slotMockSampleId,
  stepValidationErrors,
  applyValidationSimulation,
  attachVersion,
  markVersionActive,
  revertDraftToVersion,
  recomputeParentRange,
  upsertAuditAction,
  createVariantPattern,
  auditRecordKey,
} from "../src/shared/collectors/ops.js";
import { isRealCapture } from "../src/shared/collectors/types.js";
import {
  createEmptyDraft,
  DEFAULT_CAPTURE_SCENE,
  resolveCaptureLinkedSample,
} from "../src/shared/collectors/fixtures.js";

function captureN(draft: ReturnType<typeof createEmptyDraft>, n: number) {
  let next = draft;
  for (let i = 0; i < n; i++) {
    const y0 = 40 + (i % 3) * 220;
    const roi = normalizeRoi({ x: 40, y: y0 }, { x: 500, y: y0 + 140 }, 640, 720);
    next = addCaptureItem(next, {
      linkedMockSampleId: resolveCaptureLinkedSample(DEFAULT_CAPTURE_SCENE, roi, 640, 720),
      captureSceneId: DEFAULT_CAPTURE_SCENE.id,
      captureUrl: DEFAULT_CAPTURE_SCENE.defaultUrl,
      roi,
      previewAssetId: "preview.normal",
    });
  }
  return next;
}

test("collector localStorage namespace is isolated from scripts", () => {
  assert.equal(COLLECTOR_STORAGE_KEY, "rpa.collectors.prototype.v1");
  assert.equal(COLLECTOR_SCHEMA_VERSION, 7);
});

test("five-step wizard replaces four-step wizard with Match Test", () => {
  assert.deepEqual(WIZARD_STEPS.map((s) => s.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(WIZARD_STEPS.map((s) => s.short), ["Capture", "Review", "Match", "Discovery", "Validation"]);
});

test("creates Collector without Strategy or classification", () => {
  const draft = createEmptyDraft({ name: "Capture First" });
  assert.equal(draft.strategy, "");
  assert.equal(draft.classification, "");
  assert.equal(draft.wizardStep, 1);
  assert.deepEqual(draft.captures, []);
  assert.deepEqual(draft.captureAudits, []);
  assert.equal(draft.schemaRevision, 1);
  assert.ok(stepValidationErrors(draft, 3).some((e) => /Match Test/i.test(e)));
  assert.ok(stepValidationErrors(draft, 4).some((e) => /Strategy/i.test(e)));
});

test("malformed localStorage is recovered without silent delete", () => {
  const broken = parseEnvelope("{not-json");
  assert.ok(broken.parseWarnings?.length);
  assert.ok(broken.rawBackup?.includes("{not-json"));
  assert.deepEqual(broken.collectors, []);
});

test("existing v1 localStorage records migrate into capture audits without data loss", () => {
  const legacy = {
    schemaVersion: 1,
    updatedAt: "2026-11-01T00:00:00.000Z",
    classifications: ["facebook.group.normal_post"],
    testCases: [],
    collectors: [
      {
        id: "legacy-1",
        name: "Legacy Feed",
        description: "from C1",
        strategy: "FEED_NETWORK_JSON",
        platformLabel: "facebook",
        classification: "facebook.group.normal_post",
        status: "draft",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        wizardStep: 3,
        samples: [
          { slot: "A", sampleId: "sample.normal.1" },
          { slot: "B", sampleId: "sample.normal.2" },
          { slot: "C", sampleId: "sample.normal.3" },
        ],
        variables: [],
        parentRange: {
          sampleLevels: { A: 3, B: 3, C: 3 },
          observedMin: 3,
          observedMax: 3,
          suggestedTolerance: 1,
          parentUp: 0,
          childDown: 0,
          highlightedLevel: 3,
          multiPostWarning: false,
          excessiveUiWarning: false,
        },
        candidates: [],
        versions: [],
        dirty: false,
      },
    ],
  };
  const migrated = parseEnvelope(JSON.stringify(legacy));
  assert.equal(migrated.schemaVersion, 7);
  assert.equal(migrated.collectors.length, 1);
  const c = migrated.collectors[0]!;
  assert.equal(c.wizardStep, 2); // old C1 step 3 → (+1)=4 → Review
  assert.equal(c.captures.length, 3);
  assert.equal(c.captureAudits.length, 3);
  assert.equal(filledSampleCount(c), 3);
  assert.equal(slotMockSampleId(c, "A"), "sample.normal.1");
  assert.equal(migrateWizardStep(1, 1), 2);
  assert.equal(migrateWizardStep(6, 1), 5); // C1 step6 → +1 →7 → Validation
  assert.equal(migrateWizardStep(7, 4), 5);
  assert.equal(migrateWizardStep(2, 4), 2);
});

test("C1.6 capture library + audit-driven review (10 items)", () => {
  let draft = captureN(createEmptyDraft({ name: "Library10" }), 10);
  assert.equal(captureLibraryCount(draft), 10);
  assert.equal(draft.captureAudits.length, 10);
  assert.deepEqual(stepValidationErrors(draft, 1), []);
  assert.ok(stepValidationErrors(draft, 2).some((e) => /Confirm audit/i.test(e)));

  const teachingId = draft.captures[0]!.id;
  // Map required vars on teaching item
  const teachingSample = draft.captures[0]!;
  for (const variable of draft.variables.filter((v) => v.required)) {
    const sample = resolveCaptureLinkedSample(
      DEFAULT_CAPTURE_SCENE,
      teachingSample.roi!,
      640,
      720,
    );
    // use linked fixture observed values via propose then confirm for teaching manually
    draft = setCaptureMapping(draft, teachingId, variable.id, "mapped", undefined, false);
  }
  // Teaching: map using propose on teaching then confirm
  draft = proposeMappingsForCapture(draft, teachingId);
  draft = confirmCaptureAudit(draft, teachingId);
  assert.equal(auditForCapture(draft, teachingId).status, "confirmed");
  assert.equal(draft.teachingCaptureId, teachingId);

  // Subsequent items auto-proposed
  const countsAfterTeach = auditStatusCounts(draft);
  assert.ok(countsAfterTeach.proposed + countsAfterTeach.needs_attention >= 9);

  const item4 = draft.captures[3]!.id;
  const var0 = draft.variables[0]!;
  draft = setCaptureMapping(draft, item4, var0.id, "mapped", getMapping(var0, draft.captures[3]!)?.observedValueId, false);
  draft = confirmCaptureAudit(draft, item4);
  assert.equal(auditForCapture(draft, item4).status, "confirmed");

  // Navigate conceptually: teaching mapping preserved
  assert.equal(auditForCapture(draft, teachingId).status, "confirmed");
  const teachMap = getMapping(draft.variables[0]!, draft.captures[0]!);
  assert.ok(teachMap?.confirmed);

  const item8 = draft.captures[7]!.id;
  draft = setCaptureAuditStatus(draft, item8, "needs_attention", "isolated");
  assert.equal(auditForCapture(draft, item8).status, "needs_attention");
  assert.equal(auditForCapture(draft, teachingId).status, "confirmed");
  assert.equal(auditForCapture(draft, item4).status, "confirmed");

  assert.deepEqual(stepValidationErrors(draft, 2), []);
});

test("Save creates a version snapshot without mandatory label; no invented cap", () => {
  let draft = captureN(createEmptyDraft({ name: "Versions" }), 2);
  assert.equal(draft.versions.length, 0);
  draft = saveAsVersion(draft);
  assert.equal(draft.versions.length, 1);
  assert.equal(draft.versions[0]!.label, "v1");
  assert.equal(draft.versions[0]!.active, true);
  assert.equal(draft.dirty, false);
  draft = { ...draft, name: "Versions renamed", dirty: true };
  draft = saveAsVersion(draft);
  assert.equal(draft.versions.length, 2);
  assert.equal(draft.versions[1]!.label, "v2");
  assert.ok(draft.versions[0]!.immutable);
  // unbounded — 5 saves keep 5 (plus prior)
  for (let i = 0; i < 3; i++) draft = saveAsVersion({ ...draft, dirty: true });
  assert.equal(draft.versions.length, 5);
});

test("capture workflow ROI helpers still work", () => {
  let draft = createEmptyDraft({ name: "ROI" });
  const slots = ["A", "B", "C"] as const;
  for (const slot of slots) {
    const roi = normalizeRoi(
      { x: 40, y: slot === "A" ? 40 : slot === "B" ? 280 : 520 },
      { x: 500, y: slot === "A" ? 180 : slot === "B" ? 460 : 680 },
      640,
      720,
    );
    draft = applyCapturedSample(draft, slot, {
      sampleId: resolveCaptureLinkedSample(DEFAULT_CAPTURE_SCENE, roi, 640, 720),
      captureSceneId: DEFAULT_CAPTURE_SCENE.id,
      captureUrl: DEFAULT_CAPTURE_SCENE.defaultUrl,
      roi,
      previewAssetId: "preview.normal",
    });
  }
  assert.equal(captureLibraryCount(draft), 3);
  assert.equal(filledSampleCount(draft), 3);
  draft = deleteCaptureItem(draft, draft.captures[1]!.id);
  assert.equal(captureLibraryCount(draft), 2);
});

test("discovery and validation consume confirmed audits, not fixed A/B/C", () => {
  let draft = captureN(createEmptyDraft({ name: "Val" }), 4);
  const teachingId = draft.captures[0]!.id;
  draft = proposeMappingsForCapture(draft, teachingId);
  draft = confirmCaptureAudit(draft, teachingId);
  draft = confirmCaptureAudit(draft, draft.captures[1]!.id);
  draft = setCaptureAuditStatus(draft, draft.captures[2]!.id, "needs_attention");
  draft = setCaptureAuditStatus(draft, draft.captures[3]!.id, "excluded");
  draft = {
    ...draft,
    strategy: "FEED_NETWORK_JSON",
    candidates: [
      {
        id: "c1",
        strategy: "FEED_NETWORK_JSON",
        title: "t",
        confidence: 0.9,
        evidence: "e",
        matchedVariableKeys: ["post_id"],
        decision: "accepted",
        detail: {},
      },
    ],
  };
  assert.deepEqual(stepValidationErrors(draft, 4), []);
  draft = applyValidationSimulation(draft, "all_pass");
  assert.ok(draft.validation);
  assert.equal(draft.validation!.rawJson && (draft.validation!.rawJson as { needsAttention: number }).needsAttention, 1);
  assert.equal((draft.validation!.rawJson as { excluded: number }).excluded, 1);
  assert.ok(draft.validation!.records.every((r) => r.role === "holdout" || r.auditStatus === "confirmed"));
});

test("versions remain isolated after audit fields", () => {
  let draft = captureN(createEmptyDraft({ name: "Snap" }), 2);
  draft = proposeMappingsForCapture(draft, draft.captures[0]!.id);
  draft = confirmCaptureAudit(draft, draft.captures[0]!.id);
  draft = attachVersion(draft, "checkpoint");
  const versionId = draft.versions[0]!.id;
  draft = markVersionActive(draft, versionId);
  draft = setCaptureAuditStatus(draft, draft.captures[1]!.id, "excluded");
  const reverted = revertDraftToVersion(draft, versionId);
  assert.ok(reverted);
  assert.equal(auditForCapture(reverted!, draft.captures[0]!.id).status, "confirmed");
});

test("filter / duplicate / store roundtrip", () => {
  const storage = new MemoryStorage();
  let env = loadCollectorStore(storage);
  let draft = createEmptyDraft({ name: "Alpha", strategy: "FEED_NETWORK_JSON" });
  draft = captureN(draft, 2);
  env = upsertCollector(env, draft);
  saveCollectorStore(storage, env);
  const loaded = loadCollectorStore(storage);
  assert.equal(loaded.schemaVersion, 7);
  assert.equal(loaded.collectors[0]!.captures.length, 2);
  assert.equal(loaded.collectors[0]!.captureAudits.length, 2);
  const copy = duplicateCollector(loaded.collectors[0]!);
  assert.equal(copy.versions.length, 0);
  assert.equal(filterCollectors(loaded.collectors, { query: "alp", strategy: "", status: "" }).length, 1);
  env = removeCollector(loaded, draft.id);
  assert.equal(env.collectors.length, 0);
});

test("parent range and variant helpers still callable", () => {
  let draft = captureN(createEmptyDraft({ name: "Helpers" }), 1);
  draft = { ...draft, parentRange: recomputeParentRange(draft) };
  draft = upsertAuditAction(draft, "training:-:x", { state: "failed" });
  draft = createVariantPattern(draft, {
    label: "V",
    sourceRecordKeys: ["training:-:x"],
  });
  assert.ok(draft.variants.length);
  assert.ok(auditRecordKey({ sampleId: "s", role: "training", slot: "A" }).includes("training"));
});

test("C2 audit actions always advance to next capture (wrap), ignoring status", () => {
  let draft = captureN(createEmptyDraft({ name: "AutoNav" }), 3);
  const [a, b, c] = draft.captures.map((x) => x.id);
  draft = proposeMappingsForCapture(draft, a!);
  draft = confirmCaptureAudit(draft, a!);
  assert.equal(auditForCapture(draft, a!).status, "confirmed");

  // From confirmed teaching → always next in order
  assert.equal(nextReviewCaptureId(draft, a!), b!);

  let result = applyAuditActionAndAdvance(draft, b!, "needs_attention");
  assert.equal(result.advanced, true);
  assert.equal(auditForCapture(result.draft, b!).status, "needs_attention");
  assert.equal(result.draft.activeReviewCaptureId, c!);
  assert.equal(auditForCapture(result.draft, a!).status, "confirmed");
  draft = result.draft;

  result = applyAuditActionAndAdvance(draft, c!, "exclude", {
    tags: ["recruitment"],
    reason: "odd",
  });
  assert.equal(result.advanced, true);
  assert.equal(auditForCapture(result.draft, c!).status, "excluded");
  // wrap to first
  assert.equal(result.draft.activeReviewCaptureId, a!);
  assert.equal(auditForCapture(result.draft, a!).status, "confirmed");
  draft = result.draft;

  // Confirm again on teaching (already confirmed path via re-confirm) then wrap to b
  result = applyAuditActionAndAdvance(draft, a!, "confirm");
  assert.equal(result.advanced, true);
  assert.equal(result.draft.activeReviewCaptureId, b!);
  assert.equal(auditForCapture(result.draft, a!).status, "confirmed");

  // Single-item library stays put
  let solo = captureN(createEmptyDraft({ name: "Solo" }), 1);
  const only = solo.captures[0]!.id;
  solo = proposeMappingsForCapture(solo, only);
  solo = confirmCaptureAudit(solo, only);
  result = applyAuditActionAndAdvance(solo, only, "needs_attention");
  assert.equal(result.advanced, false);
  assert.equal(result.draft.activeReviewCaptureId, only);
  assert.equal(auditForCapture(result.draft, only).status, "needs_attention");
});

test("C2 real capture contract stores imageAsset without invented extraction", () => {
  let draft = createEmptyDraft({ name: "Real" });
  const roi = normalizeRoi({ x: 10, y: 10 }, { x: 200, y: 120 }, 1024, 560);
  draft = addCaptureItem(draft, {
    captureUrl: "https://facebook.example/groups/x",
    roi,
    imageAsset: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png",
    browserSessionId: "session-1",
    simulatedCapture: false,
  });
  const item = draft.captures[0]!;
  assert.equal(isRealCapture(item), true);
  assert.equal(item.simulatedCapture, false);
  assert.equal(item.linkedMockSampleId, undefined);
  assert.equal(item.browserSessionId, "session-1");
  assert.equal(item.imageAsset, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png");

  assert.throws(
    () =>
      addCaptureItem(draft, {
        captureUrl: "https://x",
        roi: normalizeRoi({ x: 0, y: 0 }, { x: 2, y: 2 }, 1024, 560),
        imageAsset: "bad.png",
        simulatedCapture: false,
      }),
    /Invalid capture ROI|Invalid capture imageAsset/,
  );
  assert.throws(
    () =>
      addCaptureItem(draft, {
        captureUrl: "https://x",
        roi,
        imageAsset: "not-a-uuid.png",
        simulatedCapture: false,
      }),
    /Invalid capture imageAsset/,
  );

  // Round-trip persistence
  const storage = new MemoryStorage();
  let env = loadCollectorStore(storage);
  env = upsertCollector(env, draft);
  saveCollectorStore(storage, env);
  const loaded = loadCollectorStore(storage);
  const again = loaded.collectors[0]!.captures[0]!;
  assert.equal(isRealCapture(again), true);
  assert.equal(again.imageAsset, item.imageAsset);
  assert.equal(again.browserSessionId, "session-1");
});

test("C1.8 exclude quarantine is recoverable and preserves capture identity", () => {
  let draft = captureN(createEmptyDraft({ name: "Quarantine" }), 2);
  const id = draft.captures[1]!.id;
  const sourceId = draft.captures[1]!.linkedMockSampleId;
  draft = excludeCaptureItem(draft, id, { tags: ["unknown-structure"], reason: "odd card" });
  assert.equal(auditForCapture(draft, id).status, "excluded");
  assert.ok(draft.captures.some((c) => c.id === id));
  assert.equal(draft.captures.find((c) => c.id === id)!.linkedMockSampleId, sourceId);
  draft = restoreExcludedCapture(draft, id);
  assert.equal(auditForCapture(draft, id).status, "unreviewed");
  assert.equal(draft.activeReviewCaptureId, id);
  assert.equal(captureHasConfirmedAudit(draft, id), false);
});

test("C1.8 confirm failure does not advance", () => {
  let draft = captureN(createEmptyDraft({ name: "Block" }), 2);
  // Clear variables to force empty required set — use required unmapped without propose path:
  // confirmCaptureAudit auto-proposes; create a required var with no observed values match by emptying observed via custom capture?
  // Instead: confirm when variables require mapping but propose can't map — simulate by wiping variables mappings after propose block.
  draft = {
    ...draft,
    variables: draft.variables.map((v) => ({
      ...v,
      required: true,
      mappings: [],
    })),
  };
  // Remove linked sample so propose cannot fill — keep capture but break observed by using unknown mock
  draft = {
    ...draft,
    captures: draft.captures.map((c, i) =>
      i === 0 ? { ...c, linkedMockSampleId: "missing-fixture" } : c,
    ),
  };
  const id = draft.captures[0]!.id;
  const result = applyAuditActionAndAdvance(draft, id, "confirm");
  assert.equal(result.advanced, false);
  assert.equal(result.completed, false);
  assert.notEqual(auditForCapture(result.draft, id).status, "confirmed");
});
