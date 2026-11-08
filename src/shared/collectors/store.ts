import {
  COLLECTOR_SCHEMA_VERSION,
  COLLECTOR_STORAGE_KEY,
  type CaptureAudit,
  type CaptureItem,
  type CollectorDraft,
  type CollectorSampleSelection,
  type CollectorStoreEnvelope,
  type CollectorStrategy,
  type CollectorTestCase,
  type CollectorVariable,
  type SampleAssignment,
  type SampleRoi,
  type WizardStepId,
} from "./types.js";
import { DEFAULT_CLASSIFICATIONS } from "./fixtures.js";

function newCaptureId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `cap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

export function emptyEnvelope(): CollectorStoreEnvelope {
  return {
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    collectors: [],
    classifications: [...DEFAULT_CLASSIFICATIONS],
    testCases: [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStrategy(raw: unknown): CollectorStrategy | "" {
  if (raw === "FEED_NETWORK_JSON" || raw === "POST_DETAIL_VISUAL") return raw;
  if (raw === "" || raw === null || raw === undefined) return "";
  return "";
}

/**
 * Normalize persisted wizard steps into C2.10 five-step space.
 * C1: 1..6 → (+1) C1.1–C1.5 seven-step → C1.6: Capture / Review / Discovery / Validation → C2.10: Capture / Review / Match Test / Discovery / Validation.
 */
export function migrateWizardStep(rawStep: unknown, fromSchema: number): WizardStepId {
  let n = Number(rawStep);
  if (!Number.isFinite(n)) return 1;
  // C1 → C1.1 seven-step: insert Capture at 1
  if (fromSchema < 2 && n >= 1 && n <= 6) n = n + 1;
  // Already on C2.10 five-step space
  if (fromSchema >= 7) {
    if (n >= 1 && n <= 5) return n as WizardStepId;
    return 1;
  }
  // Migrating from C1.6 four-step (schema 5 or 6)
  if (fromSchema >= 5) {
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n === 3) return 4; // Discovery moved to 4
    if (n === 4) return 5; // Validation moved to 5
    return 1;
  }
  // Seven-step → five-step
  if (n <= 1) return 1;
  if (n <= 5) return 2; // Review / Assign / A / B / C → Review & Mapping
  if (n === 6) return 4;
  return 5;
}

function parseCaptureAudit(raw: unknown): CaptureAudit | null {
  if (!isObject(raw) || typeof raw.captureItemId !== "string") return null;
  const status = raw.status;
  const allowed = ["unreviewed", "proposed", "confirmed", "needs_attention", "excluded"];
  if (typeof status !== "string" || !allowed.includes(status)) return null;
  return {
    captureItemId: raw.captureItemId,
    status: status as CaptureAudit["status"],
    schemaRevisionAtConfirm:
      typeof raw.schemaRevisionAtConfirm === "number" ? raw.schemaRevisionAtConfirm : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
    isolated: Boolean(raw.isolated),
    excludeTags: Array.isArray(raw.excludeTags)
      ? raw.excludeTags.filter((t): t is string => typeof t === "string")
      : undefined,
    excludeReason: typeof raw.excludeReason === "string" ? raw.excludeReason : undefined,
  };
}

/** Build captureAudits + remap legacy mock-keyed mappings onto CaptureItem ids. */
export function migrateCaptureAudits(
  raw: Record<string, unknown>,
  captures: CaptureItem[],
  samples: SampleAssignment[],
  variables: CollectorVariable[],
  fromSchema: number,
  warnings: string[],
): { captureAudits: CaptureAudit[]; variables: CollectorVariable[]; teachingCaptureId?: string } {
  const existing = Array.isArray(raw.captureAudits)
    ? raw.captureAudits.map(parseCaptureAudit).filter((a): a is CaptureAudit => Boolean(a))
    : [];
  const byId = new Map(existing.map((a) => [a.captureItemId, a]));

  // Promote legacy A/B/C assignments that had confirmed mappings into confirmed audits.
  const assignedIds = samples.map((s) => s.captureItemId).filter((id): id is string => Boolean(id));
  for (const capture of captures) {
    if (byId.has(capture.id)) continue;
    const wasAssigned = assignedIds.includes(capture.id);
    const legacyMapped = variables.some((v) =>
      v.mappings.some(
        (m) =>
          (m.sampleId === capture.id || m.sampleId === capture.linkedMockSampleId) &&
          m.confirmed,
      ),
    );
    byId.set(capture.id, {
      captureItemId: capture.id,
      status: wasAssigned && legacyMapped ? "confirmed" : wasAssigned ? "proposed" : "unreviewed",
      note:
        fromSchema < 5 && wasAssigned
          ? "Migrated from legacy Sample A/B/C assignment"
          : undefined,
    });
  }

  const captureAudits = captures.map(
    (c) => byId.get(c.id) ?? { captureItemId: c.id, status: "unreviewed" as const },
  );

  // Remap mappings keyed by linked mock sample id → capture item id (preserve duplicates as capture-scoped).
  const mockToCaptures = new Map<string, CaptureItem[]>();
  for (const c of captures) {
    if (!c.linkedMockSampleId) continue;
    const list = mockToCaptures.get(c.linkedMockSampleId) ?? [];
    list.push(c);
    mockToCaptures.set(c.linkedMockSampleId, list);
  }

  let remapped = 0;
  const nextVariables = variables.map((variable) => {
    const nextMappings = [];
    const seenCapture = new Set<string>();
    for (const mapping of variable.mappings) {
      if (captures.some((c) => c.id === mapping.sampleId)) {
        if (!seenCapture.has(mapping.sampleId)) {
          nextMappings.push(mapping);
          seenCapture.add(mapping.sampleId);
        }
        continue;
      }
      const linked = mockToCaptures.get(mapping.sampleId);
      if (linked?.length) {
        for (const cap of linked) {
          if (seenCapture.has(cap.id)) continue;
          nextMappings.push({ ...mapping, sampleId: cap.id });
          seenCapture.add(cap.id);
          remapped += 1;
        }
      } else {
        nextMappings.push(mapping); // retain orphan legacy mapping — never silent-delete
      }
    }
    return { ...variable, mappings: nextMappings };
  });
  if (remapped && fromSchema < 5) {
    warnings.push(`Remapped ${remapped} variable mapping(s) onto CaptureItem ids`);
  }

  const teachingCaptureId =
    typeof raw.teachingCaptureId === "string"
      ? raw.teachingCaptureId
      : captureAudits.find((a) => a.status === "confirmed")?.captureItemId ??
        assignedIds[0] ??
        captures[0]?.id;

  return { captureAudits, variables: nextVariables, teachingCaptureId };
}

function migrateLegacySample(raw: unknown): CollectorSampleSelection | null {
  if (!isObject(raw) || (raw.slot !== "A" && raw.slot !== "B" && raw.slot !== "C")) return null;
  const sampleId = typeof raw.sampleId === "string" ? raw.sampleId : null;
  return {
    slot: raw.slot,
    sampleId,
    captureItemId: typeof raw.captureItemId === "string" ? raw.captureItemId : null,
    captureSceneId: typeof raw.captureSceneId === "string" ? raw.captureSceneId : undefined,
    captureUrl: typeof raw.captureUrl === "string" ? raw.captureUrl : undefined,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : undefined,
    previewAssetId: typeof raw.previewAssetId === "string" ? raw.previewAssetId : undefined,
    simulatedCapture: sampleId ? true : Boolean(raw.simulatedCapture),
    roi: isObject(raw.roi)
      ? {
          x: Number(raw.roi.x) || 0,
          y: Number(raw.roi.y) || 0,
          width: Number(raw.roi.width) || 0,
          height: Number(raw.roi.height) || 0,
          containerWidth: Number(raw.roi.containerWidth) || 0,
          containerHeight: Number(raw.roi.containerHeight) || 0,
        }
      : undefined,
  };
}

function parseRoi(raw: unknown): SampleRoi | undefined {
  if (!isObject(raw)) return undefined;
  return {
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    containerWidth: Number(raw.containerWidth) || 0,
    containerHeight: Number(raw.containerHeight) || 0,
  };
}

function parseCaptureItem(raw: unknown): CaptureItem | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const linked =
    typeof raw.linkedMockSampleId === "string"
      ? raw.linkedMockSampleId
      : typeof raw.sampleId === "string"
        ? raw.sampleId
        : undefined;
  const imageAsset = typeof raw.imageAsset === "string" ? raw.imageAsset : undefined;
  const previewAssetId = typeof raw.previewAssetId === "string" ? raw.previewAssetId : undefined;
  if (!linked && !imageAsset && !previewAssetId) return null;
  const simulated =
    raw.simulatedCapture === true || (!imageAsset && Boolean(previewAssetId || linked));
  return {
    id: raw.id,
    linkedMockSampleId: linked,
    captureSceneId: typeof raw.captureSceneId === "string" ? raw.captureSceneId : undefined,
    captureUrl: typeof raw.captureUrl === "string" ? raw.captureUrl : undefined,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
    previewAssetId: simulated ? previewAssetId : undefined,
    imageAsset,
    browserSessionId: typeof raw.browserSessionId === "string" ? raw.browserSessionId : undefined,
    simulatedCapture: simulated,
    roi: parseRoi(raw.roi),
  };
}

/** Promote pre-C1.5 A/B/C selections into CaptureItem library + assignments. */
export function migrateCapturesAndAssignments(
  raw: Record<string, unknown>,
  fromSchema: number,
  warnings: string[],
): { captures: CaptureItem[]; samples: SampleAssignment[] } {
  const emptyAssignments: SampleAssignment[] = [
    { slot: "A", captureItemId: null },
    { slot: "B", captureItemId: null },
    { slot: "C", captureItemId: null },
  ];

  const existingCaptures = Array.isArray(raw.captures)
    ? raw.captures.map(parseCaptureItem).filter((c): c is CaptureItem => Boolean(c))
    : [];

  const legacySamples = Array.isArray(raw.samples)
    ? raw.samples.map(migrateLegacySample).filter((s): s is CollectorSampleSelection => Boolean(s))
    : [];

  if (existingCaptures.length || legacySamples.some((s) => typeof s.captureItemId === "string")) {
    const captures = [...existingCaptures];
    const byId = new Map(captures.map((c) => [c.id, c]));
    const samples: SampleAssignment[] = emptyAssignments.map((slot) => {
      const legacy = legacySamples.find((s) => s.slot === slot.slot);
      if (legacy?.captureItemId && byId.has(legacy.captureItemId)) {
        return { slot: slot.slot, captureItemId: legacy.captureItemId };
      }
      return slot;
    });
    return { captures, samples };
  }

  // Legacy C1–C1.4: samples held mock sampleId + ROI directly.
  const captures: CaptureItem[] = [];
  const samples = emptyAssignments.map((slot) => {
    const legacy = legacySamples.find((s) => s.slot === slot.slot);
    if (!legacy?.sampleId) return slot;
    const item: CaptureItem = {
      id: newCaptureId(),
      linkedMockSampleId: legacy.sampleId,
      captureSceneId: legacy.captureSceneId,
      captureUrl: legacy.captureUrl,
      capturedAt: legacy.capturedAt ?? new Date().toISOString(),
      previewAssetId: legacy.previewAssetId,
      simulatedCapture: true,
      roi: legacy.roi,
    };
    captures.push(item);
    return { slot: slot.slot, captureItemId: item.id };
  });

  if (captures.length && fromSchema < 4) {
    warnings.push(
      `Promoted ${captures.length} legacy Sample A/B/C selection(s) into Capture Library + assignments`,
    );
  }

  return { captures, samples };
}

function sanitizeCollector(
  raw: unknown,
  warnings: string[],
  fromSchema: number,
): CollectorDraft | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
    warnings.push("Skipped collector with missing id/name");
    return null;
  }
  const strategy = parseStrategy(raw.strategy);
  // Preserve legacy forced defaults when migrating old records; do not invent for blank C1.1 drafts.
  const classification =
    typeof raw.classification === "string"
      ? raw.classification
      : fromSchema < 2
        ? "facebook.group.normal_post"
        : "";
  if (fromSchema < 2) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (wizard step +1)`);
  } else if (fromSchema < 3) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (variants/audit)`);
  } else if (fromSchema < 4) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (capture library)`);
  } else if (fromSchema < 5) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (audit-driven review)`);
  } else if (fromSchema < 6) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (real browser captures)`);
  } else if (fromSchema < 7) {
    warnings.push(`Migrated collector "${raw.name}" from schema v${fromSchema} → v${COLLECTOR_SCHEMA_VERSION} (Match Test step)`);
  }
  const status =
    raw.status === "ready" || raw.status === "outdated_validation" ? raw.status : "draft";
  const { captures, samples } = migrateCapturesAndAssignments(raw, fromSchema, warnings);
  const rawVariables = Array.isArray(raw.variables)
    ? (raw.variables as CollectorDraft["variables"])
    : [];
  const { captureAudits, variables, teachingCaptureId } = migrateCaptureAudits(
    raw,
    captures,
    samples,
    rawVariables,
    fromSchema,
    warnings,
  );

  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    strategy: fromSchema < 2 && !strategy ? "FEED_NETWORK_JSON" : strategy,
    platformLabel: typeof raw.platformLabel === "string" ? raw.platformLabel : fromSchema < 2 ? "facebook" : "",
    classification,
    status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    wizardStep: migrateWizardStep(raw.wizardStep, fromSchema),
    captures,
    captureAudits,
    schemaRevision: typeof raw.schemaRevision === "number" ? raw.schemaRevision : 1,
    samples,
    samplesCompatible:
      typeof raw.samplesCompatible === "boolean"
        ? raw.samplesCompatible
        : samples.every((s) => s.captureItemId) && fromSchema < 2,
    activeReviewCaptureId:
      typeof raw.activeReviewCaptureId === "string"
        ? raw.activeReviewCaptureId
        : captures[0]?.id,
    teachingCaptureId,
    variables,
    parentRange: isObject(raw.parentRange)
      ? (raw.parentRange as CollectorDraft["parentRange"])
      : {
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
    candidates: Array.isArray(raw.candidates) ? (raw.candidates as CollectorDraft["candidates"]) : [],
    validation: isObject(raw.validation) ? (raw.validation as CollectorDraft["validation"]) : undefined,
    variants: Array.isArray(raw.variants) ? (raw.variants as CollectorDraft["variants"]) : [],
    auditActions: Array.isArray(raw.auditActions)
      ? (raw.auditActions as CollectorDraft["auditActions"])
      : [],
    regions: Array.isArray(raw.regions) ? (raw.regions as CollectorDraft["regions"]) : [],
    layoutContext: raw.layoutContext === "POST_DETAIL" ? "POST_DETAIL" : "FEED_ITEM",
    matchTest: isObject(raw.matchTest) ? (raw.matchTest as CollectorDraft["matchTest"]) : undefined,
    versions: Array.isArray(raw.versions) ? (raw.versions as CollectorDraft["versions"]) : [],
    activeVersionId: typeof raw.activeVersionId === "string" ? raw.activeVersionId : undefined,
    dirty: Boolean(raw.dirty),
    recaptureItemId: typeof raw.recaptureItemId === "string" ? raw.recaptureItemId : undefined,
  };
}

/** Safe parse — malformed data is retained via rawBackup + parseWarnings; never silently deleted. */
export function parseEnvelope(raw: string | null): CollectorStoreEnvelope {
  if (!raw) return emptyEnvelope();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const envelope = emptyEnvelope();
    envelope.parseWarnings = ["JSON parse failed; original payload retained in rawBackup"];
    envelope.rawBackup = raw;
    return envelope;
  }
  if (!isObject(parsed)) {
    const envelope = emptyEnvelope();
    envelope.parseWarnings = ["Root value was not an object; original payload retained"];
    envelope.rawBackup = raw;
    return envelope;
  }
  const warnings: string[] = [];
  const fromSchema = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
  if (fromSchema > COLLECTOR_SCHEMA_VERSION) {
    warnings.push(
      `Stored schemaVersion ${fromSchema} is newer than runtime ${COLLECTOR_SCHEMA_VERSION}`,
    );
  }
  const collectors = Array.isArray(parsed.collectors)
    ? parsed.collectors
        .map((item) => sanitizeCollector(item, warnings, fromSchema))
        .filter((item): item is CollectorDraft => Boolean(item))
    : [];
  if (!Array.isArray(parsed.collectors)) warnings.push("collectors missing or invalid — recovered as []");

  const classifications = Array.isArray(parsed.classifications)
    ? [...new Set([...DEFAULT_CLASSIFICATIONS, ...parsed.classifications.filter((x): x is string => typeof x === "string")])]
    : [...DEFAULT_CLASSIFICATIONS];

  const testCases = Array.isArray(parsed.testCases)
    ? (parsed.testCases.filter((item) => isObject(item) && typeof item.id === "string") as CollectorTestCase[])
    : [];

  return {
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    collectors,
    classifications,
    testCases,
    parseWarnings: warnings.length ? warnings : undefined,
    rawBackup: warnings.length ? raw : undefined,
  };
}

export function serializeEnvelope(envelope: CollectorStoreEnvelope): string {
  const next: CollectorStoreEnvelope = {
    ...envelope,
    schemaVersion: COLLECTOR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(next);
}

export function loadCollectorStore(storage: StorageLike): CollectorStoreEnvelope {
  return parseEnvelope(storage.getItem(COLLECTOR_STORAGE_KEY));
}

export function saveCollectorStore(storage: StorageLike, envelope: CollectorStoreEnvelope): void {
  storage.setItem(COLLECTOR_STORAGE_KEY, serializeEnvelope(envelope));
}

export function upsertCollector(
  envelope: CollectorStoreEnvelope,
  collector: CollectorDraft,
): CollectorStoreEnvelope {
  const others = envelope.collectors.filter((c) => c.id !== collector.id);
  const classifications =
    collector.classification && !envelope.classifications.includes(collector.classification)
      ? [...envelope.classifications, collector.classification]
      : envelope.classifications;
  return {
    ...envelope,
    collectors: [...others, { ...collector, updatedAt: new Date().toISOString() }],
    classifications,
  };
}

export function removeCollector(
  envelope: CollectorStoreEnvelope,
  collectorId: string,
): CollectorStoreEnvelope {
  return {
    ...envelope,
    collectors: envelope.collectors.filter((c) => c.id !== collectorId),
    testCases: envelope.testCases.filter((t) => t.collectorId !== collectorId),
  };
}
