/**
 * One-time, idempotent adoption of existing Feed Visual Counter data into Part Library.
 * Ownership is content-fingerprint based (not Part name). Never deletes/overwrites legacy keys
 * or existing non-empty Part configs.
 */

import type { KeyValueStorage } from "./part-library-repository.js";
import type {
  CollectorPart,
  PartLibraryEnvelope,
  VisualFeedAdoptionRecord,
  VisualFeedItemPartConfig,
} from "./part-library-types.js";
import {
  buildVisualFeedConfigFromLegacy,
  isVisualFeedPartConfigEmpty,
  peekLegacyVisualFeedData,
  type LegacyVisualFeedSnapshot,
} from "./visual-feed-legacy-import.js";

export type VisualFeedAdoptionStatus =
  | "reused_existing_owner"
  | "created_initial_part"
  | "already_adopted"
  | "nothing_to_adopt"
  | "skipped_no_complete_source";

export type VisualFeedAdoptionResult = {
  status: VisualFeedAdoptionStatus;
  partId?: string;
  partName?: string;
  fingerprint?: string;
  created: boolean;
  inventory: {
    legacyHasTemplates: boolean;
    legacyHasRun: boolean;
    legacySampleCount: number;
    legacyActionRowCount: number;
    visualFeedPartCount: number;
    completeVisualPartCount: number;
    matchingOwnerCount: number;
  };
};

function countTemplateKinds(templates: VisualFeedItemPartConfig["templates"]): number {
  let n = 0;
  if (templates.like) n += 1;
  if (templates.comment) n += 1;
  if (templates.share) n += 1;
  return n;
}

/** Stable content fingerprint — ownership is not inferred from Part name. */
export function visualFeedContentFingerprint(input: {
  templates: VisualFeedItemPartConfig["templates"];
  reports?: unknown[];
  currentRunId?: string | null;
  summaryStats?: unknown;
}): string {
  const reports = Array.isArray(input.reports) ? input.reports : [];
  let actionRows = 0;
  let domHits = 0;
  let boundaries = 0;
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const candidates = (report as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) continue;
    actionRows += candidates.length;
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      const boundary = (cand as { boundary?: { hitElement?: unknown; status?: unknown } }).boundary;
      if (boundary?.hitElement) domHits += 1;
      if (boundary?.status === "BOUNDARY_FOUND") boundaries += 1;
    }
  }
  const tpl = (kind: "like" | "comment" | "share") => {
    const t = input.templates?.[kind];
    if (!t) return `${kind}:0`;
    return `${kind}:${t.width}x${t.height}:len${t.dataUrl?.length ?? 0}:src${t.sourceFrameId ?? ""}`;
  };
  const stats =
    input.summaryStats && typeof input.summaryStats === "object"
      ? JSON.stringify(input.summaryStats)
      : "";
  return [
    `run:${input.currentRunId ?? ""}`,
    tpl("like"),
    tpl("comment"),
    tpl("share"),
    `samples:${reports.length}`,
    `rows:${actionRows}`,
    `dom:${domHits}`,
    `bound:${boundaries}`,
    `stats:${stats}`,
  ].join("|");
}

export function isCompleteVisualFeedConfig(config: VisualFeedItemPartConfig): boolean {
  if (isVisualFeedPartConfigEmpty(config)) return false;
  const hasTemplates = countTemplateKinds(config.templates) > 0;
  const hasRun =
    (Array.isArray(config.reports) && config.reports.length > 0) ||
    (typeof config.currentRunId === "string" && config.currentRunId.length > 0);
  return hasTemplates && hasRun;
}

function fingerprintFromLegacy(legacy: LegacyVisualFeedSnapshot): string {
  return visualFeedContentFingerprint({
    templates: legacy.templates,
    reports: legacy.reports,
    currentRunId: legacy.currentRunId,
    summaryStats: legacy.summaryStats,
  });
}

function fingerprintFromPartConfig(config: VisualFeedItemPartConfig): string {
  return visualFeedContentFingerprint({
    templates: config.templates,
    reports: config.reports,
    currentRunId: config.currentRunId,
    summaryStats: config.summaryStats,
  });
}

/** Parts that own the legacy snapshot by content fingerprint (stable oldest-first). */
export function findVisualFeedOwnersByFingerprint(
  parts: CollectorPart[],
  fingerprint: string,
): CollectorPart[] {
  return parts
    .filter((p) => p.editor === "feed-item-visual" && p.config.kind === "visual_feed_item")
    .filter((p) => {
      if (p.config.kind !== "visual_feed_item") return false;
      if (!isCompleteVisualFeedConfig(p.config)) return false;
      return fingerprintFromPartConfig(p.config) === fingerprint;
    })
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.partId.localeCompare(b.partId));
}

function newPartId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `part_${crypto.randomUUID()}`;
  return `part_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export type AdoptionDeps = {
  loadEnvelope: () => PartLibraryEnvelope;
  saveEnvelope: (envelope: PartLibraryEnvelope) => void;
  legacyStorage: KeyValueStorage;
};

/**
 * Idempotent adoption:
 * 1) If adoption record points at an existing owner → reuse.
 * 2) Else if any Part fingerprint-matches legacy → reuse that Part (e.g. previously imported "test").
 * 3) Else if legacy has complete data → create exactly one Part.
 * Never overwrites Part configs. Never mutates legacy keys.
 */
export function adoptExistingVisualFeedData(deps: AdoptionDeps): VisualFeedAdoptionResult {
  const legacy = peekLegacyVisualFeedData(deps.legacyStorage);
  const envelope = deps.loadEnvelope();
  const visualParts = envelope.parts.filter(
    (p) => p.editor === "feed-item-visual" && p.config.kind === "visual_feed_item",
  );
  const completeParts = visualParts.filter(
    (p) => p.config.kind === "visual_feed_item" && isCompleteVisualFeedConfig(p.config),
  );

  const inventoryBase = {
    legacyHasTemplates: legacy.hasTemplates,
    legacyHasRun: legacy.hasRun,
    legacySampleCount: legacy.sampleCount,
    legacyActionRowCount: legacy.actionRowCount,
    visualFeedPartCount: visualParts.length,
    completeVisualPartCount: completeParts.length,
    matchingOwnerCount: 0,
  };

  const legacyComplete = legacy.hasTemplates && legacy.hasRun;
  if (!legacyComplete && completeParts.length === 0) {
    return {
      status: legacy.hasTemplates || legacy.hasRun ? "skipped_no_complete_source" : "nothing_to_adopt",
      created: false,
      inventory: inventoryBase,
    };
  }

  // Prefer fingerprint of legacy when present; otherwise fingerprint of the only complete Part.
  const fingerprint = legacyComplete
    ? fingerprintFromLegacy(legacy)
    : fingerprintFromPartConfig(completeParts[0]!.config as VisualFeedItemPartConfig);

  const owners = legacyComplete
    ? findVisualFeedOwnersByFingerprint(envelope.parts, fingerprint)
    : completeParts
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.partId.localeCompare(b.partId));

  inventoryBase.matchingOwnerCount = owners.length;

  const existingRecord = envelope.visualFeedAdoption;
  if (existingRecord?.adoptedPartId) {
    const marked = envelope.parts.find((p) => p.partId === existingRecord.adoptedPartId);
    if (
      marked &&
      marked.config.kind === "visual_feed_item" &&
      isCompleteVisualFeedConfig(marked.config) &&
      (existingRecord.contentFingerprint === fingerprint ||
        fingerprintFromPartConfig(marked.config) === fingerprint)
    ) {
      return {
        status: "already_adopted",
        partId: marked.partId,
        partName: marked.name,
        fingerprint,
        created: false,
        inventory: inventoryBase,
      };
    }
  }

  if (owners.length > 0) {
    const owner = owners[0]!;
    const record: VisualFeedAdoptionRecord = {
      schemaVersion: 1,
      adoptedPartId: owner.partId,
      contentFingerprint: fingerprint,
      adoptedAt: new Date().toISOString(),
    };
    deps.saveEnvelope({ ...envelope, visualFeedAdoption: record });
    return {
      status: "reused_existing_owner",
      partId: owner.partId,
      partName: owner.name,
      fingerprint,
      created: false,
      inventory: inventoryBase,
    };
  }

  if (!legacyComplete) {
    return {
      status: "skipped_no_complete_source",
      created: false,
      fingerprint,
      inventory: inventoryBase,
    };
  }

  const built = buildVisualFeedConfigFromLegacy(legacy);
  if (!built.ok) {
    return {
      status: "skipped_no_complete_source",
      created: false,
      fingerprint,
      inventory: inventoryBase,
    };
  }

  const now = new Date().toISOString();
  const created: CollectorPart = {
    partId: newPartId(),
    name: "Feed Visual Counter",
    partType: "visual",
    version: 1,
    status: "draft",
    editor: "feed-item-visual",
    inputContract: {
      schemaVersion: 1,
      required: ["browserSession"],
      optional: ["sourceUrl"],
    },
    outputContract: {
      schemaVersion: 1,
      payloadKind: "visual_observations",
    },
    config: built.config,
    createdAt: now,
    updatedAt: now,
  };

  const record: VisualFeedAdoptionRecord = {
    schemaVersion: 1,
    adoptedPartId: created.partId,
    contentFingerprint: fingerprint,
    adoptedAt: now,
  };

  deps.saveEnvelope({
    ...envelope,
    parts: [...envelope.parts, created],
    visualFeedAdoption: record,
  });

  return {
    status: "created_initial_part",
    partId: created.partId,
    partName: created.name,
    fingerprint,
    created: true,
    inventory: { ...inventoryBase, visualFeedPartCount: inventoryBase.visualFeedPartCount + 1, completeVisualPartCount: inventoryBase.completeVisualPartCount + 1, matchingOwnerCount: 1 },
  };
}
