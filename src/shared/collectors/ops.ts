import { buildValidationRun, cryptoRandomId, sampleById } from "./fixtures.js";
import type {
  AuditMatchState,
  AuditRecordAction,
  CaptureAudit,
  CaptureAuditStatus,
  CaptureItem,
  CollectorDraft,
  CollectorListFilters,
  CollectorRegion,
  CollectorValueType,
  CollectorVariable,
  CollectorVersionSnapshot,
  ParentRangeState,
  SampleRoi,
  SampleSlot,
  ValidationOutcome,
  ValidationRecord,
  VariantPattern,
  WizardStepId,
} from "./types.js";

export function parseTypedValue(valType: CollectorValueType, rawText?: string): unknown {
  if (rawText === undefined || rawText === null) return null;
  const trimmed = rawText.trim();
  switch (valType) {
    case "number": {
      const digitsOnly = trimmed.replace(/[^0-9.-]/g, "");
      if (!digitsOnly) return null;
      const num = Number(digitsOnly);
      return Number.isNaN(num) ? null : num;
    }
    case "boolean":
      if (!trimmed) return false;
      return trimmed.toLowerCase() !== "false" && trimmed !== "0";
    case "array":
      if (!trimmed) return [];
      return trimmed.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    case "object":
      return { text: trimmed };
    case "url":
    case "datetime":
    case "text":
    case "string":
    default:
      return trimmed;
  }
}

export const WIZARD_STEPS: Array<{ id: WizardStepId; label: string; short: string }> = [
  { id: 1, label: "Capture", short: "Capture" },
  { id: 2, label: "Review & Mapping", short: "Review" },
  { id: 3, label: "Match Test", short: "Match" },
  { id: 4, label: "Discovery", short: "Discovery" },
  { id: 5, label: "Validation", short: "Validation" },
];

export const CAPTURE_AUDIT_STATUSES: CaptureAuditStatus[] = [
  "unreviewed",
  "proposed",
  "confirmed",
  "needs_attention",
  "excluded",
];

export function filterCollectors(collectors: CollectorDraft[], filters: CollectorListFilters): CollectorDraft[] {
  const q = filters.query.trim().toLowerCase();
  return collectors
    .filter((c) => {
      if (filters.strategy && c.strategy !== filters.strategy) return false;
      if (filters.status && c.status !== filters.status) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.classification.toLowerCase().includes(q) ||
        c.platformLabel.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function duplicateCollector(source: CollectorDraft): CollectorDraft {
  const now = new Date().toISOString();
  return {
    ...structuredClone(source),
    id: cryptoRandomId(),
    name: `${source.name} (copy)`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    versions: [],
    activeVersionId: undefined,
    validation: source.validation
      ? { ...structuredClone(source.validation), id: cryptoRandomId(), outdated: true }
      : undefined,
    dirty: true,
  };
}

export function captureItemById(draft: CollectorDraft, id: string | null | undefined): CaptureItem | undefined {
  if (!id) return undefined;
  return (draft.captures ?? []).find((c) => c.id === id);
}

/** Mock fixture id used by Teach/Mapping for an assigned training slot. */
export function slotMockSampleId(draft: CollectorDraft, slot: SampleSlot): string | null {
  const assignment = draft.samples.find((s) => s.slot === slot);
  const item = captureItemById(draft, assignment?.captureItemId);
  return item?.linkedMockSampleId ?? null;
}

export function slotCaptureItem(draft: CollectorDraft, slot: SampleSlot): CaptureItem | undefined {
  const assignment = draft.samples.find((s) => s.slot === slot);
  return captureItemById(draft, assignment?.captureItemId);
}

export function filledSampleCount(draft: CollectorDraft): number {
  return draft.samples.filter((s) => Boolean(s.captureItemId)).length;
}

export function captureLibraryCount(draft: CollectorDraft): number {
  return (draft.captures ?? []).length;
}

export function ensureCaptureAudits(draft: CollectorDraft): CaptureAudit[] {
  const existing = draft.captureAudits ?? [];
  const byId = new Map(existing.map((a) => [a.captureItemId, a]));
  return (draft.captures ?? []).map((c) => {
    const prior = byId.get(c.id);
    return prior ?? { captureItemId: c.id, status: "unreviewed" as const };
  });
}

export function auditForCapture(draft: CollectorDraft, captureItemId: string): CaptureAudit {
  return (
    ensureCaptureAudits(draft).find((a) => a.captureItemId === captureItemId) ?? {
      captureItemId,
      status: "unreviewed",
    }
  );
}

export function mappingKeyForCapture(capture: CaptureItem): string {
  return capture.id;
}

export function getMapping(
  variable: CollectorVariable,
  capture: CaptureItem,
): CollectorVariable["mappings"][number] | undefined {
  const byCapture = variable.mappings.find((m) => m.sampleId === capture.id);
  if (byCapture) return byCapture;
  // Legacy: mappings keyed by linked mock sample id
  if (!capture.linkedMockSampleId) return undefined;
  return variable.mappings.find((m) => m.sampleId === capture.linkedMockSampleId);
}

export function confirmedCaptureIds(draft: CollectorDraft): string[] {
  return ensureCaptureAudits(draft)
    .filter((a) => a.status === "confirmed")
    .map((a) => a.captureItemId);
}

export function auditStatusCounts(draft: CollectorDraft): Record<CaptureAuditStatus, number> {
  const counts: Record<CaptureAuditStatus, number> = {
    unreviewed: 0,
    proposed: 0,
    confirmed: 0,
    needs_attention: 0,
    excluded: 0,
  };
  for (const a of ensureCaptureAudits(draft)) counts[a.status] += 1;
  return counts;
}

export function stepValidationErrors(draft: CollectorDraft, step: WizardStepId): string[] {
  const errors: string[] = [];
  if (step === 1) {
    if (captureLibraryCount(draft) < 1) {
      errors.push("Capture at least one Feed Item before continuing.");
    }
  }
  if (step === 2) {
    if (captureLibraryCount(draft) < 1) {
      errors.push("Capture at least one Feed Item before reviewing.");
    }
    if (!draft.variables.length) errors.push("Add at least one Variable on the teaching item.");
    if (draft.variables.some((v) => !v.key.trim())) errors.push("Every Variable needs a stable key.");
    const keys = draft.variables.map((v) => v.key.trim());
    if (new Set(keys).size !== keys.length) errors.push("Variable keys must be unique.");
    if (!confirmedCaptureIds(draft).length) {
      errors.push("Confirm audit on at least one Capture Item (teaching reference) before continuing.");
    }
  }
  if (step === 3) {
    if (!draft.matchTest || draft.matchTest.status === "NOT TESTED") {
      errors.push("Run a Live Browser Match Test before continuing to Discovery.");
    } else if (draft.matchTest.status === "FAILED") {
      errors.push(`Match Test failed: ${draft.matchTest.error || "Anchors could not be verified in live browser."}`);
    }
  }
  if (step === 4) {
    if (!draft.strategy) {
      errors.push("Select a Strategy (FEED_NETWORK_JSON or POST_DETAIL_VISUAL) before discovery.");
    }
    const accepted = draft.candidates.filter((c) => c.decision === "accepted");
    if (draft.strategy && !accepted.length) {
      errors.push("Accept at least one discovery candidate (simulated).");
    }
  }
  if (step === 5) {
    if (!draft.validation || draft.validation.outdated) {
      errors.push("Run a simulated validation (or re-run after mapping changes).");
    }
  }
  return errors;
}

export function markValidationOutdated(draft: CollectorDraft): CollectorDraft {
  if (!draft.validation) {
    return {
      ...draft,
      dirty: true,
      status: draft.status === "ready" ? "outdated_validation" : draft.status,
    };
  }
  return {
    ...draft,
    dirty: true,
    status: "outdated_validation",
    validation: { ...draft.validation, outdated: true },
  };
}

export function recomputeParentRange(draft: CollectorDraft): ParentRangeState {
  const levels: Record<SampleSlot, number> = { A: 3, B: 3, C: 3 };
  for (const slot of ["A", "B", "C"] as SampleSlot[]) {
    const mockId = slotMockSampleId(draft, slot);
    if (!mockId) continue;
    const sample = sampleById(mockId);
    if (sample) levels[slot] = sample.parentLevels;
  }
  const values = Object.values(levels);
  const observedMin = Math.min(...values);
  const observedMax = Math.max(...values);
  const highlighted = Math.max(
    1,
    Math.min(10, observedMin - draft.parentRange.parentUp + draft.parentRange.childDown),
  );
  const span = observedMax - observedMin + draft.parentRange.parentUp + draft.parentRange.childDown;
  return {
    ...draft.parentRange,
    sampleLevels: levels,
    observedMin,
    observedMax,
    suggestedTolerance: Math.max(1, observedMax - observedMin + 1),
    highlightedLevel: highlighted,
    multiPostWarning: span >= 4 || draft.parentRange.parentUp >= 2,
    excessiveUiWarning: draft.parentRange.childDown >= 3 || highlighted <= 1,
  };
}

export function applyValidationSimulation(
  draft: CollectorDraft,
  outcome: ValidationOutcome,
): CollectorDraft {
  const audits = ensureCaptureAudits(draft);
  const confirmed = audits
    .filter((a) => a.status === "confirmed")
    .map((a) => {
      const item = captureItemById(draft, a.captureItemId);
      return item ? { captureItemId: item.id, mockSampleId: item.linkedMockSampleId, auditStatus: a.status } : null;
    })
    .filter((x): x is { captureItemId: string; mockSampleId: string; auditStatus: CaptureAuditStatus } => Boolean(x));
  const pending = audits.filter((a) => a.status === "unreviewed" || a.status === "proposed");
  const needsAttention = audits.filter((a) => a.status === "needs_attention");
  const excluded = audits.filter((a) => a.status === "excluded");
  const trainingIds = confirmed.map((c) => c.mockSampleId);
  const validation = buildValidationRun(outcome, trainingIds, draft.variables, {
    captureRefs: confirmed.map((c) => ({
      captureItemId: c.captureItemId,
      mockSampleId: c.mockSampleId,
      auditStatus: c.auditStatus,
    })),
    pendingCount: pending.length,
    needsAttentionCount: needsAttention.length,
    excludedCount: excluded.length,
  });
  // Unresolved exceptions must not wipe confirmed mappings / ready status from confirmed set.
  const ready = outcome === "all_pass" && needsAttention.length === 0 && pending.length === 0;
  return {
    ...draft,
    captureAudits: audits,
    validation,
    status: ready ? "ready" : draft.status === "ready" && confirmed.length ? "outdated_validation" : "draft",
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function auditRecordKey(record: Pick<ValidationRecord, "sampleId" | "role" | "slot">): string {
  return `${record.role}:${record.slot ?? "-"}:${record.sampleId}`;
}

export function defaultAuditStateForResult(result: ValidationRecord["result"]): AuditMatchState {
  if (result === "valid") return "matched";
  if (result === "partial") return "partial";
  return "failed";
}

export function upsertAuditAction(
  draft: CollectorDraft,
  recordKey: string,
  patch: Partial<Omit<AuditRecordAction, "recordKey">>,
): CollectorDraft {
  const current = draft.auditActions ?? [];
  const existing = current.find((a) => a.recordKey === recordKey);
  const nextAction: AuditRecordAction = {
    recordKey,
    state: patch.state ?? existing?.state ?? "unresolved",
    mappingIssue: patch.mappingIssue ?? existing?.mappingIssue,
    variantId: "variantId" in patch ? patch.variantId : existing?.variantId,
    note: "note" in patch ? patch.note : existing?.note,
  };
  const auditActions = existing
    ? current.map((a) => (a.recordKey === recordKey ? nextAction : a))
    : [...current, nextAction];
  return { ...draft, auditActions, dirty: true, updatedAt: new Date().toISOString() };
}

/** Create an optional Variant Pattern from audited records — never auto from confidence. */
export function createVariantPattern(
  draft: CollectorDraft,
  input: {
    label: string;
    tag?: string;
    notes?: string;
    sourceRecordKeys: string[];
    variableKeys?: string[];
  },
): CollectorDraft {
  const variant: VariantPattern = {
    id: cryptoRandomId(),
    label: input.label.trim() || "Variant pattern",
    tag: (input.tag ?? "").trim(),
    createdAt: new Date().toISOString(),
    notes: (input.notes ?? "").trim(),
    variableKeys: input.variableKeys?.length
      ? [...input.variableKeys]
      : draft.variables.map((v) => v.key).filter(Boolean),
    sourceRecordKeys: [...input.sourceRecordKeys],
  };
  let next: CollectorDraft = {
    ...draft,
    variants: [...(draft.variants ?? []), variant],
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
  for (const key of input.sourceRecordKeys) {
    next = upsertAuditAction(next, key, { variantId: variant.id, state: "unresolved" });
  }
  return next;
}

export function createVersionSnapshot(draft: CollectorDraft, label?: string): CollectorVersionSnapshot {
  const version = (draft.versions.reduce((max, v) => Math.max(max, v.version), 0) || 0) + 1;
  return {
    id: cryptoRandomId(),
    version,
    label: label?.trim() || `v${version}`,
    createdAt: new Date().toISOString(),
    active: false,
    immutable: true,
    strategy: draft.strategy,
    classification: draft.classification,
    variables: structuredClone(draft.variables),
    captures: structuredClone(draft.captures ?? []),
    captureAudits: structuredClone(ensureCaptureAudits(draft)),
    schemaRevision: draft.schemaRevision ?? 1,
    samples: structuredClone(draft.samples),
    parentRange: structuredClone(draft.parentRange),
    candidates: structuredClone(draft.candidates),
    wizardStep: draft.wizardStep,
    samplesCompatible: draft.samplesCompatible,
    activeReviewCaptureId: draft.activeReviewCaptureId,
    teachingCaptureId: draft.teachingCaptureId,
    validation: draft.validation ? structuredClone(draft.validation) : undefined,
    variants: structuredClone(draft.variants),
    auditActions: structuredClone(draft.auditActions),
    regions: structuredClone(draft.regions ?? []),
    layoutContext: draft.layoutContext ?? "FEED_ITEM",
    matchTest: draft.matchTest ? structuredClone(draft.matchTest) : undefined,
  };
}

/**
 * Append an immutable version snapshot.
 * No max stack size exists in this prototype — do not invent a retention cap.
 */
export function attachVersion(draft: CollectorDraft, label?: string): CollectorDraft {
  const snapshot = createVersionSnapshot(draft, label);
  return {
    ...draft,
    versions: [...draft.versions, snapshot],
    dirty: false,
    status: draft.validation && !draft.validation.outdated && draft.validation.outcome === "all_pass"
      ? "ready"
      : draft.status,
    updatedAt: new Date().toISOString(),
  };
}

/** Save = create version snapshot (auto label vN) + mark active. Does not purge older versions. */
export function saveAsVersion(draft: CollectorDraft, label?: string): CollectorDraft {
  const attached = attachVersion(draft, label);
  const newest = attached.versions[attached.versions.length - 1]!;
  return {
    ...markVersionActive(attached, newest.id),
    dirty: false,
  };
}

export function markVersionActive(draft: CollectorDraft, versionId: string): CollectorDraft {
  return {
    ...draft,
    activeVersionId: versionId,
    versions: draft.versions.map((v) => ({ ...v, active: v.id === versionId, immutable: true as const })),
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function revertDraftToVersion(draft: CollectorDraft, versionId: string): CollectorDraft | null {
  const snapshot = draft.versions.find((v) => v.id === versionId);
  if (!snapshot) return null;
  const captures = structuredClone(snapshot.captures ?? draft.captures ?? []);
  return {
    ...draft,
    strategy: snapshot.strategy,
    classification: snapshot.classification,
    variables: structuredClone(snapshot.variables),
    captures,
    captureAudits: structuredClone(snapshot.captureAudits ?? ensureCaptureAudits({ ...draft, captures })),
    schemaRevision: snapshot.schemaRevision ?? draft.schemaRevision ?? 1,
    samples: structuredClone(snapshot.samples),
    parentRange: structuredClone(snapshot.parentRange),
    candidates: structuredClone(snapshot.candidates),
    wizardStep: snapshot.wizardStep,
    samplesCompatible: snapshot.samplesCompatible ?? false,
    activeReviewCaptureId: snapshot.activeReviewCaptureId,
    teachingCaptureId: snapshot.teachingCaptureId,
    validation: snapshot.validation
      ? { ...structuredClone(snapshot.validation), outdated: true }
      : undefined,
    variants: structuredClone(snapshot.variants ?? []),
    auditActions: structuredClone(snapshot.auditActions ?? []),
    regions: structuredClone(snapshot.regions ?? []),
    layoutContext: snapshot.layoutContext ?? "FEED_ITEM",
    matchTest: snapshot.matchTest ? structuredClone(snapshot.matchTest) : undefined,
    status: "outdated_validation",
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function activeRuleVersionLabel(draft: CollectorDraft): string {
  const active = draft.versions.find((v) => v.id === draft.activeVersionId) ?? draft.versions.find((v) => v.active);
  if (active) return active.label;
  if (draft.versions.length) return `draft (latest ${draft.versions[draft.versions.length - 1]!.label})`;
  return "draft";
}

/** Pure helpers for Capture ROI tests (no DOM). */
export function normalizeRoi(
  start: { x: number; y: number },
  end: { x: number; y: number },
  containerWidth: number,
  containerHeight: number,
) {
  const x = Math.max(0, Math.min(start.x, end.x));
  const y = Math.max(0, Math.min(start.y, end.y));
  const width = Math.min(containerWidth - x, Math.abs(end.x - start.x));
  const height = Math.min(containerHeight - y, Math.abs(end.y - start.y));
  return { x, y, width, height, containerWidth, containerHeight };
}

export function addCaptureItem(
  draft: CollectorDraft,
  payload: {
    linkedMockSampleId?: string;
    captureSceneId?: string;
    captureUrl: string;
    roi: SampleRoi;
    previewAssetId?: string;
    imageAsset?: string;
    browserSessionId?: string;
    simulatedCapture?: boolean;
  },
): CollectorDraft {
  const simulated = payload.simulatedCapture === true || (!payload.imageAsset && Boolean(payload.previewAssetId));
  if (!payload.imageAsset && !payload.previewAssetId) {
    throw new Error("Capture requires imageAsset (real) or previewAssetId (legacy mock).");
  }
  if (payload.imageAsset && !/^[a-f0-9-]+\.png$/i.test(payload.imageAsset)) {
    throw new Error("Invalid capture imageAsset.");
  }
  if (
    payload.roi.width < 4 ||
    payload.roi.height < 4 ||
    payload.roi.x < 0 ||
    payload.roi.y < 0
  ) {
    throw new Error("Invalid capture ROI.");
  }
  const item: CaptureItem = {
    id: cryptoRandomId(),
    linkedMockSampleId: simulated ? payload.linkedMockSampleId : undefined,
    captureSceneId: payload.captureSceneId,
    captureUrl: payload.captureUrl,
    capturedAt: new Date().toISOString(),
    roi: payload.roi,
    previewAssetId: simulated ? payload.previewAssetId : undefined,
    imageAsset: payload.imageAsset,
    browserSessionId: payload.browserSessionId,
    simulatedCapture: simulated,
  };
  const replaceId = draft.recaptureItemId;
  if (replaceId) {
    const captures = (draft.captures ?? []).map((c) =>
      c.id === replaceId ? { ...item, id: replaceId } : c,
    );
    const captureAudits = ensureCaptureAudits({ ...draft, captures }).map((a) =>
      a.captureItemId === replaceId
        ? { captureItemId: replaceId, status: "unreviewed" as const }
        : a,
    );
    return markValidationOutdated({
      ...draft,
      captures,
      captureAudits,
      samplesCompatible: false,
      recaptureItemId: undefined,
      dirty: true,
    });
  }
  const captures = [...(draft.captures ?? []), item];
  return markValidationOutdated({
    ...draft,
    captures,
    captureAudits: [
      ...ensureCaptureAudits(draft),
      { captureItemId: item.id, status: "unreviewed" },
    ],
    samplesCompatible: false,
    dirty: true,
  });
}

/** Deterministic simulated auto-match — labeled, never silent confirm. */
export function proposeMappingsForCapture(
  draft: CollectorDraft,
  captureItemId: string,
): CollectorDraft {
  const capture = captureItemById(draft, captureItemId);
  if (!capture) return draft;
  const sample = sampleById(capture.linkedMockSampleId);
  if (!sample) return draft;
  const teachingId = draft.teachingCaptureId ?? draft.captures[0]?.id;
  const teaching = teachingId ? captureItemById(draft, teachingId) : undefined;
  const teachingSample = teaching ? sampleById(teaching.linkedMockSampleId) : undefined;
  const kindMismatch = Boolean(
    teachingSample && teachingSample.kind !== sample.kind && teachingId !== captureItemId,
  );

  const variables = draft.variables.map((variable) => {
    const observed =
      sample.observedValues.find((o) => o.label === variable.key) ??
      sample.observedValues.find((o) => o.label.startsWith(variable.key));
    const others = variable.mappings.filter(
      (m) => m.sampleId !== capture.id && m.sampleId !== capture.linkedMockSampleId,
    );
    if (!observed) {
      return {
        ...variable,
        mappings: [
          ...others,
          {
            sampleId: capture.id,
            presence: "unmapped" as const,
            confirmed: false,
            simulatedProposal: true,
          },
        ],
      };
    }
    return {
      ...variable,
      mappings: [
        ...others,
        {
          sampleId: capture.id,
          presence: "mapped" as const,
          observedValueId: observed.id,
          confirmed: false,
          simulatedProposal: true,
        },
      ],
    };
  });

  const mappedCount = variables.filter((v) =>
    getMapping(v, capture)?.presence === "mapped",
  ).length;
  const requiredMissing = draft.variables.filter((v) => {
    if (!v.required) return false;
    return getMapping(
      variables.find((x) => x.id === v.id) ?? v,
      capture,
    )?.presence !== "mapped";
  }).length;

  let status: CaptureAuditStatus = "proposed";
  if (kindMismatch || requiredMissing > 0) status = "needs_attention";
  if (mappedCount === 0) status = "needs_attention";

  const captureAudits = ensureCaptureAudits(draft).map((a) => {
    if (a.captureItemId !== captureItemId) return a;
    if (a.status === "confirmed") return a; // never silently overwrite confirmed
    return {
      ...a,
      status,
      note: kindMismatch
        ? "Simulated match: fixture kind differs from teaching item — Needs Attention."
        : "Simulated proposal — not live Network/DOM/OCR extraction.",
    };
  });

  return markValidationOutdated({
    ...draft,
    variables,
    captureAudits,
    dirty: true,
  });
}

export function confirmCaptureAudit(
  draft: CollectorDraft,
  captureItemId: string,
): CollectorDraft {
  const capture = captureItemById(draft, captureItemId);
  if (!capture) return draft;
  const isTeaching =
    !draft.teachingCaptureId ||
    draft.teachingCaptureId === captureItemId ||
    draft.captures[0]?.id === captureItemId;

  // Fill any still-unmapped required fields with deterministic simulated proposals before confirm.
  let working = draft;
  const needsPropose = draft.variables.some((v) => {
    if (!v.required) return false;
    const m = getMapping(v, capture);
    return !m || m.presence === "unmapped";
  });
  if (needsPropose) working = proposeMappingsForCapture(working, captureItemId);

  const variables = working.variables.map((variable) => {
    const mapping = getMapping(variable, capture);
    if (!mapping) return variable;
    const others = variable.mappings.filter(
      (m) => m.sampleId !== capture.id && m.sampleId !== capture.linkedMockSampleId,
    );
    const confirmable = mapping.presence === "mapped" || mapping.presence === "not_present";
    return {
      ...variable,
      mappings: [
        ...others,
        {
          ...mapping,
          sampleId: capture.id,
          confirmed: confirmable,
          simulatedProposal: false,
        },
      ],
    };
  });

  const requiredBad = variables.filter((v) => {
    if (!v.required) return false;
    const m = getMapping(v, capture);
    return !m || (m.presence !== "mapped" && m.presence !== "not_present");
  });
  if (requiredBad.length) return working;

  const schemaRevision = working.schemaRevision ?? 1;
  const captureAudits = ensureCaptureAudits(working).map((a) =>
    a.captureItemId === captureItemId
      ? {
          ...a,
          status: "confirmed" as const,
          schemaRevisionAtConfirm: schemaRevision,
          note: a.note,
          isolated: false,
        }
      : a,
  );

  let next: CollectorDraft = markValidationOutdated({
    ...working,
    variables,
    captureAudits,
    teachingCaptureId: working.teachingCaptureId ?? (isTeaching ? captureItemId : working.teachingCaptureId),
    dirty: true,
  });

  // Auto-propose subsequent unreviewed items after teaching confirm
  if (!working.teachingCaptureId || working.teachingCaptureId === captureItemId || isTeaching) {
    next = { ...next, teachingCaptureId: captureItemId };
    for (const item of next.captures) {
      if (item.id === captureItemId) continue;
      const st = auditForCapture(next, item.id).status;
      if (st === "unreviewed") {
        next = proposeMappingsForCapture(next, item.id);
      }
    }
  }
  return next;
}

export function setCaptureAuditStatus(
  draft: CollectorDraft,
  captureItemId: string,
  status: CaptureAuditStatus,
  note?: string,
): CollectorDraft {
  const captureAudits = ensureCaptureAudits(draft).map((a) => {
    if (a.captureItemId !== captureItemId) return a;
    return {
      ...a,
      status,
      isolated: status === "needs_attention" || status === "excluded" ? true : a.isolated,
      note: note ?? a.note,
    };
  });
  return markValidationOutdated({ ...draft, captureAudits, dirty: true });
}

/** Items that still require a Confirm / Needs Attention / Exclude decision. */
/** Items still awaiting Confirm / Needs Attention / Exclude (informational). */
const PENDING_AUDIT: CaptureAuditStatus[] = ["unreviewed", "proposed"];

/** Next capture in library order after `afterCaptureId`, wrapping; ignores audit status. */
export function nextReviewCaptureId(
  draft: CollectorDraft,
  afterCaptureId?: string | null,
): string | null {
  const captures = draft.captures ?? [];
  if (!captures.length) return null;
  if (captures.length === 1) return captures[0]!.id;
  const afterIdx = afterCaptureId
    ? captures.findIndex((c) => c.id === afterCaptureId)
    : -1;
  if (afterIdx < 0) return captures[0]!.id;
  return captures[(afterIdx + 1) % captures.length]!.id;
}

/** @deprecated Prefer nextReviewCaptureId — kept for completion summaries. */
export function nextPendingReviewCaptureId(
  draft: CollectorDraft,
  afterCaptureId?: string | null,
): string | null {
  const captures = draft.captures ?? [];
  if (!captures.length) return null;
  const afterIdx = afterCaptureId
    ? captures.findIndex((c) => c.id === afterCaptureId)
    : -1;
  for (let offset = 1; offset <= captures.length; offset++) {
    const idx =
      afterIdx < 0 ? offset - 1 : (afterIdx + offset) % captures.length;
    const item = captures[idx]!;
    if (afterCaptureId && item.id === afterCaptureId) continue;
    const st = auditForCapture(draft, item.id).status;
    if (PENDING_AUDIT.includes(st)) return item.id;
  }
  return null;
}

export function advanceToNextReviewCapture(
  draft: CollectorDraft,
  fromCaptureId: string,
): CollectorDraft {
  const nextId = nextReviewCaptureId(draft, fromCaptureId);
  if (!nextId || nextId === fromCaptureId) {
    return { ...draft, activeReviewCaptureId: fromCaptureId };
  }
  return { ...draft, activeReviewCaptureId: nextId, dirty: true };
}

/** @deprecated Prefer advanceToNextReviewCapture */
export function advanceToNextPendingReview(
  draft: CollectorDraft,
  fromCaptureId: string,
): CollectorDraft {
  return advanceToNextReviewCapture(draft, fromCaptureId);
}

export function excludeCaptureItem(
  draft: CollectorDraft,
  captureItemId: string,
  opts?: { tags?: string[]; reason?: string },
): CollectorDraft {
  const tags = (opts?.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const reason = (opts?.reason ?? "").trim();
  const captureAudits = ensureCaptureAudits(draft).map((a) => {
    if (a.captureItemId !== captureItemId) return a;
    return {
      ...a,
      status: "excluded" as const,
      isolated: true,
      excludeTags: tags.length ? tags : a.excludeTags,
      excludeReason: reason || a.excludeReason,
      note: reason || a.note || "Excluded from current Collector matching set.",
    };
  });
  return markValidationOutdated({ ...draft, captureAudits, dirty: true });
}

export function restoreExcludedCapture(
  draft: CollectorDraft,
  captureItemId: string,
): CollectorDraft {
  const captureAudits = ensureCaptureAudits(draft).map((a) => {
    if (a.captureItemId !== captureItemId) return a;
    return {
      ...a,
      status: "unreviewed" as const,
      isolated: false,
      note: a.excludeReason
        ? `Restored from quarantine (was: ${a.excludeReason})`
        : "Restored from quarantine",
    };
  });
  return markValidationOutdated({
    ...draft,
    captureAudits,
    activeReviewCaptureId: captureItemId,
    dirty: true,
  });
}

export function captureHasConfirmedAudit(draft: CollectorDraft, captureItemId: string): boolean {
  return auditForCapture(draft, captureItemId).status === "confirmed";
}

/** Apply audit action then advance to next pending review item when successful. */
export function applyAuditActionAndAdvance(
  draft: CollectorDraft,
  captureItemId: string,
  action: "confirm" | "needs_attention" | "exclude",
  excludeOpts?: { tags?: string[]; reason?: string },
): { draft: CollectorDraft; advanced: boolean; completed: boolean } {
  let next =
    action === "confirm"
      ? confirmCaptureAudit(draft, captureItemId)
      : action === "exclude"
        ? excludeCaptureItem(draft, captureItemId, excludeOpts)
        : setCaptureAuditStatus(
            draft,
            captureItemId,
            "needs_attention",
            "Isolated — differs from teaching schema (user marked).",
          );
  // confirm may no-op if validation fails — detect unchanged status
  if (action === "confirm" && auditForCapture(next, captureItemId).status !== "confirmed") {
    return { draft: next, advanced: false, completed: false };
  }
  const completed = nextPendingReviewCaptureId(next, null) == null;
  const nextId = nextReviewCaptureId(next, captureItemId);
  if (!nextId || nextId === captureItemId) {
    return {
      draft: { ...next, activeReviewCaptureId: captureItemId },
      advanced: false,
      completed,
    };
  }
  next = advanceToNextReviewCapture(next, captureItemId);
  return { draft: next, advanced: true, completed };
}

/** Explicit shared-schema bump — does not mutate historical confirmed mapping payloads. */
export function bumpSharedSchemaRevision(draft: CollectorDraft): CollectorDraft {
  return {
    ...draft,
    schemaRevision: (draft.schemaRevision ?? 1) + 1,
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function setCaptureMapping(
  draft: CollectorDraft,
  captureItemId: string,
  variableId: string,
  presence: "mapped" | "not_present" | "unmapped",
  observedValueId?: string,
  confirmed = false,
): CollectorDraft {
  const capture = captureItemById(draft, captureItemId);
  if (!capture) return draft;
  const sample = sampleById(capture.linkedMockSampleId);
  const variables = draft.variables.map((v) => {
    if (v.id !== variableId) return v;
    const others = v.mappings.filter(
      (m) => m.sampleId !== capture.id && m.sampleId !== capture.linkedMockSampleId,
    );
    const observed = observedValueId
      ? sample?.observedValues.find((o) => o.id === observedValueId)
      : undefined;
    return {
      ...v,
      source: observed?.source ?? v.source,
      expectedValue:
        presence === "mapped" && observed && draft.teachingCaptureId === captureItemId
          ? observed.value
          : v.expectedValue,
      mappings: [
        ...others,
        {
          sampleId: capture.id,
          presence,
          observedValueId,
          confirmed,
          simulatedProposal: false,
        },
      ],
    };
  });
  // Editing mappings on a confirmed item drops it back to proposed until re-confirm
  const captureAudits = ensureCaptureAudits(draft).map((a) => {
    if (a.captureItemId !== captureItemId) return a;
    if (a.status === "confirmed" && !confirmed) {
      return { ...a, status: "proposed" as const };
    }
    return a;
  });
  return markValidationOutdated({ ...draft, variables, captureAudits, dirty: true });
}

/** @deprecated Prefer addCaptureItem — kept for older tests that assigned during capture. */
export function applyCapturedSample(
  draft: CollectorDraft,
  slot: SampleSlot,
  payload: {
    sampleId: string;
    captureSceneId: string;
    captureUrl: string;
    roi: SampleRoi;
    previewAssetId: string;
  },
): CollectorDraft {
  const withItem = addCaptureItem(draft, {
    linkedMockSampleId: payload.sampleId,
    captureSceneId: payload.captureSceneId,
    captureUrl: payload.captureUrl,
    roi: payload.roi,
    previewAssetId: payload.previewAssetId,
  });
  const newest = withItem.captures[withItem.captures.length - 1];
  if (!newest) return withItem;
  return assignSampleSlot(withItem, slot, newest.id);
}

export function deleteCaptureItem(draft: CollectorDraft, captureItemId: string): CollectorDraft {
  const captures = (draft.captures ?? []).filter((c) => c.id !== captureItemId);
  const samples = draft.samples.map((s) =>
    s.captureItemId === captureItemId ? { slot: s.slot, captureItemId: null } : s,
  );
  const captureAudits = ensureCaptureAudits(draft).filter((a) => a.captureItemId !== captureItemId);
  const variables = draft.variables.map((v) => ({
    ...v,
    mappings: v.mappings.filter((m) => m.sampleId !== captureItemId),
  }));
  return markValidationOutdated({
    ...draft,
    captures,
    captureAudits,
    samples,
    variables,
    samplesCompatible: false,
    teachingCaptureId:
      draft.teachingCaptureId === captureItemId ? captures[0]?.id : draft.teachingCaptureId,
    activeReviewCaptureId:
      draft.activeReviewCaptureId === captureItemId
        ? captures[0]?.id
        : draft.activeReviewCaptureId,
    recaptureItemId: draft.recaptureItemId === captureItemId ? undefined : draft.recaptureItemId,
    dirty: true,
  });
}

export function assignSampleSlot(
  draft: CollectorDraft,
  slot: SampleSlot,
  captureItemId: string | null,
): CollectorDraft {
  if (captureItemId && !captureItemById(draft, captureItemId)) return draft;
  // A Capture Item may be assigned to at most one training slot.
  const samples = draft.samples.map((s) => {
    if (s.slot === slot) return { slot, captureItemId };
    if (captureItemId && s.captureItemId === captureItemId) return { slot: s.slot, captureItemId: null };
    return s;
  });
  return markValidationOutdated({
    ...draft,
    samples,
    samplesCompatible: false,
    dirty: true,
  });
}

export function clearSampleSlot(draft: CollectorDraft, slot: SampleSlot): CollectorDraft {
  return assignSampleSlot(draft, slot, null);
}

// ---------------------------------------------------------------------------
// Region Management Operations (C2.8)
// ---------------------------------------------------------------------------

export function ensureDraftRegions(draft: CollectorDraft): CollectorRegion[] {
  return draft.regions ?? [];
}

export function regionsForCapture(draft: CollectorDraft, captureId: string): CollectorRegion[] {
  const all = ensureDraftRegions(draft);
  return all.filter((r) => r.captureItemId === captureId);
}

export function addRegionToDraft(draft: CollectorDraft, region: CollectorRegion): CollectorDraft {
  const current = ensureDraftRegions(draft);
  const regions = [...current, region];
  const captures = (draft.captures ?? []).map((c) =>
    c.id === region.captureItemId
      ? { ...c, regions: [...(c.regions ?? []).filter((r) => r.id !== region.id), region] }
      : c,
  );
  return markValidationOutdated({
    ...draft,
    regions,
    captures,
    dirty: true,
  });
}

export function updateRegionInDraft(
  draft: CollectorDraft,
  regionId: string,
  patch: Partial<CollectorRegion>,
): CollectorDraft {
  const current = ensureDraftRegions(draft);
  const now = new Date().toISOString();
  let targetCaptureId: string | undefined;
  const regions = current.map((r) => {
    if (r.id !== regionId) return r;
    targetCaptureId = r.captureItemId;
    return { ...r, ...patch, updatedAt: now };
  });

  const captures = (draft.captures ?? []).map((c) => {
    if (c.id !== targetCaptureId && !c.regions?.some((r) => r.id === regionId)) return c;
    const cRegions = (c.regions ?? []).map((r) => (r.id === regionId ? { ...r, ...patch, updatedAt: now } : r));
    return { ...c, regions: cRegions };
  });

  return markValidationOutdated({
    ...draft,
    regions,
    captures,
    dirty: true,
  });
}

export function deleteRegionFromDraft(draft: CollectorDraft, regionId: string): CollectorDraft {
  const current = ensureDraftRegions(draft);
  const regions = current.filter((r) => r.id !== regionId);
  const captures = (draft.captures ?? []).map((c) => ({
    ...c,
    regions: (c.regions ?? []).filter((r) => r.id !== regionId),
  }));
  return markValidationOutdated({
    ...draft,
    regions,
    captures,
    dirty: true,
  });
}

export function confirmRegionInDraft(draft: CollectorDraft, regionId: string): CollectorDraft {
  return updateRegionInDraft(draft, regionId, {
    confirmed: true,
    simulatedProposal: false,
  });
}

