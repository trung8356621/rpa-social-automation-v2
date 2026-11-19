/**
 * Non-destructive import of pre-C1 Feed Visual Counter data into a Part-scoped config.
 * Reads legacy keys via KeyValueStorage; never deletes or rewrites them.
 */

import type { KeyValueStorage } from "./part-library-repository.js";
import type {
  VisualFeedItemPartConfig,
  VisualIconTemplatesBlob,
} from "./part-library-types.js";

/** Same string as Feed Visual Counter run store — duplicated here so shared code does not import renderer. */
export const LEGACY_FEED_VISUAL_RUN_KEY = "rpa:feed-item-collector:run";
/** Same string as Visual Match Lab / Feed Visual Counter templates. */
export const LEGACY_FEED_VISUAL_TEMPLATES_KEY = "visual_match_lab_live_templates_v1";

export type LegacyVisualFeedSnapshot = {
  templates: VisualIconTemplatesBlob;
  reports: unknown[];
  summaryStats: unknown;
  currentRunId: string | null;
  hasTemplates: boolean;
  hasRun: boolean;
  sampleCount: number;
  actionRowCount: number;
  domHitCount: number;
  boundaryFoundCount: number;
};

export type ImportLegacyVisualFeedResult =
  | { ok: true; config: VisualFeedItemPartConfig }
  | { ok: false; reason: "no_legacy_data" | "part_not_empty" | "invalid_target" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countTemplateKinds(templates: VisualIconTemplatesBlob): number {
  let n = 0;
  if (templates.like) n += 1;
  if (templates.comment) n += 1;
  if (templates.share) n += 1;
  return n;
}

function summarizeReports(reports: unknown[]): {
  actionRowCount: number;
  domHitCount: number;
  boundaryFoundCount: number;
} {
  let actionRowCount = 0;
  let domHitCount = 0;
  let boundaryFoundCount = 0;
  for (const report of reports) {
    if (!isObject(report) || !Array.isArray(report.candidates)) continue;
    actionRowCount += report.candidates.length;
    for (const cand of report.candidates) {
      if (!isObject(cand)) continue;
      if (isObject(cand.boundary) && cand.boundary.hitElement) domHitCount += 1;
      if (isObject(cand.boundary) && cand.boundary.status === "BOUNDARY_FOUND") {
        boundaryFoundCount += 1;
      }
    }
  }
  return { actionRowCount, domHitCount, boundaryFoundCount };
}

/** Read-only peek of legacy Feed Visual Counter keys. */
export function peekLegacyVisualFeedData(storage: KeyValueStorage): LegacyVisualFeedSnapshot {
  let templates: VisualIconTemplatesBlob = {};
  try {
    const raw = storage.getItem(LEGACY_FEED_VISUAL_TEMPLATES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed)) templates = parsed as VisualIconTemplatesBlob;
    }
  } catch {
    templates = {};
  }

  let reports: unknown[] = [];
  let summaryStats: unknown = null;
  let currentRunId: string | null = null;
  try {
    const raw = storage.getItem(LEGACY_FEED_VISUAL_RUN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed)) {
        reports = Array.isArray(parsed.reports) ? parsed.reports : [];
        summaryStats = parsed.summaryStats ?? null;
        currentRunId = typeof parsed.currentRunId === "string" ? parsed.currentRunId : null;
      }
    }
  } catch {
    reports = [];
  }

  const counts = summarizeReports(reports);
  const hasTemplates = countTemplateKinds(templates) > 0;
  const hasRun = reports.length > 0 || Boolean(currentRunId);
  return {
    templates,
    reports,
    summaryStats,
    currentRunId,
    hasTemplates,
    hasRun,
    sampleCount: reports.length,
    actionRowCount: counts.actionRowCount,
    domHitCount: counts.domHitCount,
    boundaryFoundCount: counts.boundaryFoundCount,
  };
}

export function isVisualFeedPartConfigEmpty(config: VisualFeedItemPartConfig): boolean {
  const hasTemplates = countTemplateKinds(config.templates ?? {}) > 0;
  const hasReports = Array.isArray(config.reports) && config.reports.length > 0;
  const hasRunId = typeof config.currentRunId === "string" && config.currentRunId.length > 0;
  return !hasTemplates && !hasReports && !hasRunId;
}

/**
 * Build a Part-owned config by copying legacy snapshot.
 * Does not write to storage — caller persists via PartLibraryRepository.
 * Never mutates legacy keys.
 */
export function buildVisualFeedConfigFromLegacy(
  legacy: LegacyVisualFeedSnapshot,
  options?: { overwrite?: boolean },
  existing?: VisualFeedItemPartConfig,
): ImportLegacyVisualFeedResult {
  if (!legacy.hasTemplates && !legacy.hasRun) {
    return { ok: false, reason: "no_legacy_data" };
  }
  if (existing && !isVisualFeedPartConfigEmpty(existing) && !options?.overwrite) {
    return { ok: false, reason: "part_not_empty" };
  }
  const config: VisualFeedItemPartConfig = {
    kind: "visual_feed_item",
    templates: { ...legacy.templates },
    step: legacy.hasRun ? 2 : 1,
    reports: Array.isArray(legacy.reports) ? [...legacy.reports] : [],
    summaryStats: legacy.summaryStats ?? null,
    currentRunId: legacy.currentRunId,
    selectedFrameIndex: 0,
    selectedCandidateIndex: 0,
  };
  return { ok: true, config };
}

/** Assert legacy keys were not rewritten (same raw strings). */
export function legacyVisualFeedRawSnapshot(storage: KeyValueStorage): {
  templatesRaw: string | null;
  runRaw: string | null;
} {
  return {
    templatesRaw: storage.getItem(LEGACY_FEED_VISUAL_TEMPLATES_KEY),
    runRaw: storage.getItem(LEGACY_FEED_VISUAL_RUN_KEY),
  };
}
