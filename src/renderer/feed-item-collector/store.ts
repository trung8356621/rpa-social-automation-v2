import { useState, useEffect } from "react";
import { loadLiveTemplates, LIVE_TEMPLATE_KEY } from "../experiments/visual-match-lab/LiveTemplateCalibration";
import { loadSavedRules } from "../experiments/visual-match-lab/LiveScrollTest";
import {
  clearActiveCollectorPart,
  getActiveCollectorPartId,
  getPartLibraryRepository,
  setActiveCollectorPartId,
} from "../collectors/active-part-session";
import type { VisualFeedItemPartConfig, VisualIconTemplatesBlob } from "../../shared/collectors/part-library-types";
import {
  buildVisualFeedConfigFromLegacy,
  isVisualFeedPartConfigEmpty,
  peekLegacyVisualFeedData,
  type LegacyVisualFeedSnapshot,
} from "../../shared/collectors/visual-feed-legacy-import";
import type { FeedCollectorState, LiveIconTemplates, RunSummaryStats } from "./types";

export const FEED_COLLECTOR_STATE_KEY = "rpa:feed-item-collector:run";

function loadSavedRun(): Partial<FeedCollectorState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(FEED_COLLECTOR_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      reports: parsed.reports ?? [],
      summaryStats: parsed.summaryStats ?? null,
      currentRunId: parsed.currentRunId ?? null,
    };
  } catch {
    return {};
  }
}

const savedRun = loadSavedRun();

const INITIAL_STATE: FeedCollectorState = {
  step: 1,
  templates: loadLiveTemplates(),
  calibrationCapture: null,
  reports: savedRun.reports ?? [],
  currentRunId: savedRun.currentRunId ?? null,
  selectedFrameIndex: 0,
  selectedCandidateIndex: 0,
  rules: loadSavedRules(),
  summaryStats: savedRun.summaryStats ?? null,
};

let globalState: FeedCollectorState = { ...INITIAL_STATE };
const listeners = new Set<(state: FeedCollectorState) => void>();

/** Bound Part id for in-memory editor session (mirrors sessionStorage when set via bind). */
let boundPartId: string | null = getActiveCollectorPartId();

function notify() {
  listeners.forEach((fn) => fn(globalState));
}

function asTemplatesBlob(templates: LiveIconTemplates): VisualIconTemplatesBlob {
  return templates as VisualIconTemplatesBlob;
}

function fromTemplatesBlob(blob: VisualIconTemplatesBlob | undefined): LiveIconTemplates {
  return (blob ?? {}) as LiveIconTemplates;
}

function persistPartScopedConfig(): void {
  if (!boundPartId) return;
  const repo = getPartLibraryRepository();
  const part = repo.getPart(boundPartId);
  if (!part || part.config.kind !== "visual_feed_item") return;
  const config: VisualFeedItemPartConfig = {
    kind: "visual_feed_item",
    templates: asTemplatesBlob(globalState.templates),
    step: globalState.step,
    reports: globalState.reports,
    summaryStats: globalState.summaryStats,
    currentRunId: globalState.currentRunId,
    selectedFrameIndex: globalState.selectedFrameIndex,
    selectedCandidateIndex: globalState.selectedCandidateIndex,
  };
  repo.updatePartConfig(boundPartId, config);
}

function persistLegacyGlobal(patch: Partial<FeedCollectorState>): void {
  if (typeof localStorage === "undefined") return;
  if (patch.templates) {
    try {
      localStorage.setItem(LIVE_TEMPLATE_KEY, JSON.stringify(globalState.templates));
    } catch {
      /* quota */
    }
  }
  if (patch.reports !== undefined || patch.summaryStats !== undefined || patch.currentRunId !== undefined) {
    try {
      localStorage.setItem(
        FEED_COLLECTOR_STATE_KEY,
        JSON.stringify({
          reports: globalState.reports,
          summaryStats: globalState.summaryStats,
          currentRunId: globalState.currentRunId,
        }),
      );
    } catch {
      /* quota */
    }
  }
}

export function getFeedCollectorState(): FeedCollectorState {
  return globalState;
}

export function getBoundFeedItemPartId(): string | null {
  return boundPartId;
}

function legacyStorage(): Storage | { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => undefined };
}

/** Read-only summary of pre-C1 Feed Visual Counter data still in legacy keys. */
export function inspectLegacyVisualFeedData(): LegacyVisualFeedSnapshot {
  return peekLegacyVisualFeedData(legacyStorage());
}

export function isBoundVisualFeedPartEmpty(): boolean {
  if (!boundPartId) return false;
  const part = getPartLibraryRepository().getPart(boundPartId);
  if (!part || part.config.kind !== "visual_feed_item") return false;
  return isVisualFeedPartConfigEmpty(part.config);
}

/**
 * Copy legacy Feed Visual Counter snapshot into the active Part config only.
 * Never moves/deletes/overwrites legacy keys. Refuses non-empty Parts unless overwrite=true.
 */
export function importLegacyVisualFeedIntoBoundPart(options?: {
  overwrite?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!boundPartId) return { ok: false, reason: "invalid_target" };
  const repo = getPartLibraryRepository();
  const part = repo.getPart(boundPartId);
  if (!part || part.config.kind !== "visual_feed_item") {
    return { ok: false, reason: "invalid_target" };
  }
  const legacy = peekLegacyVisualFeedData(legacyStorage());
  const built = buildVisualFeedConfigFromLegacy(legacy, options, part.config);
  if (!built.ok) return built;

  const beforeTemplates = typeof localStorage !== "undefined" ? localStorage.getItem(LIVE_TEMPLATE_KEY) : null;
  const beforeRun =
    typeof localStorage !== "undefined" ? localStorage.getItem(FEED_COLLECTOR_STATE_KEY) : null;

  repo.updatePartConfig(boundPartId, built.config);
  globalState = {
    ...globalState,
    step: built.config.step === 2 || built.config.step === 3 ? built.config.step : 1,
    templates: fromTemplatesBlob(built.config.templates),
    reports: (built.config.reports as FeedCollectorState["reports"]) ?? [],
    summaryStats: (built.config.summaryStats as FeedCollectorState["summaryStats"]) ?? null,
    currentRunId: built.config.currentRunId ?? null,
    selectedFrameIndex: 0,
    selectedCandidateIndex: 0,
    calibrationCapture: null,
  };
  notify();

  if (typeof localStorage !== "undefined") {
    const afterTemplates = localStorage.getItem(LIVE_TEMPLATE_KEY);
    const afterRun = localStorage.getItem(FEED_COLLECTOR_STATE_KEY);
    if (afterTemplates !== beforeTemplates || afterRun !== beforeRun) {
      // Defensive: import path must never rewrite legacy keys.
      if (beforeTemplates !== null) localStorage.setItem(LIVE_TEMPLATE_KEY, beforeTemplates);
      else localStorage.removeItem(LIVE_TEMPLATE_KEY);
      if (beforeRun !== null) localStorage.setItem(FEED_COLLECTOR_STATE_KEY, beforeRun);
      else localStorage.removeItem(FEED_COLLECTOR_STATE_KEY);
    }
  }
  return { ok: true };
}

/**
 * Bind the Feed Item editor to an independent Part config.
 * Does not read or write `visual_match_lab_live_templates_v1`.
 */
export function bindFeedCollectorToPart(partId: string): FeedCollectorState {
  if (boundPartId && boundPartId !== partId) {
    persistPartScopedConfig();
  }
  const repo = getPartLibraryRepository();
  const part = repo.getPart(partId);
  if (!part || part.config.kind !== "visual_feed_item") {
    throw new Error(`Part ${partId} is not a visual feed-item Part`);
  }
  const cfg = part.config;
  boundPartId = partId;
  setActiveCollectorPartId(partId);
  globalState = {
    ...globalState,
    step: cfg.step === 2 || cfg.step === 3 ? cfg.step : 1,
    templates: fromTemplatesBlob(cfg.templates),
    reports: (cfg.reports as FeedCollectorState["reports"]) ?? [],
    summaryStats: (cfg.summaryStats as FeedCollectorState["summaryStats"]) ?? null,
    currentRunId: cfg.currentRunId ?? null,
    selectedFrameIndex: cfg.selectedFrameIndex ?? 0,
    selectedCandidateIndex: cfg.selectedCandidateIndex ?? 0,
    calibrationCapture: null,
  };
  notify();
  return globalState;
}

/**
 * Leave Part-bound mode and restore legacy global templates into memory only
 * (does not mutate Part configs).
 */
export function unbindFeedCollectorFromPart(): void {
  if (boundPartId) persistPartScopedConfig();
  boundPartId = null;
  clearActiveCollectorPart();
  const loaded = loadSavedRun();
  globalState = {
    ...globalState,
    templates: loadLiveTemplates(),
    reports: loaded.reports ?? [],
    summaryStats: loaded.summaryStats ?? null,
    currentRunId: loaded.currentRunId ?? null,
    step: 1,
    selectedFrameIndex: 0,
    selectedCandidateIndex: 0,
    calibrationCapture: null,
  };
  notify();
}

export function hydrateFeedCollectorFromStorage(): FeedCollectorState {
  const activeId = getActiveCollectorPartId();
  if (activeId) {
    const part = getPartLibraryRepository().getPart(activeId);
    if (part?.config.kind === "visual_feed_item") {
      return bindFeedCollectorToPart(activeId);
    }
  }
  const loaded = loadSavedRun();
  globalState = {
    ...globalState,
    reports: loaded.reports ?? globalState.reports,
    summaryStats: loaded.summaryStats ?? globalState.summaryStats,
    currentRunId: loaded.currentRunId ?? globalState.currentRunId,
  };
  notify();
  return globalState;
}

export function setFeedCollectorState(patch: Partial<FeedCollectorState>) {
  globalState = { ...globalState, ...patch };
  if (boundPartId) {
    // Part-scoped: never touch legacy shared keys.
    persistPartScopedConfig();
  } else {
    persistLegacyGlobal(patch);
  }
  notify();
}

export function resetFeedCollectorRun() {
  if (boundPartId) {
    globalState = {
      ...globalState,
      reports: [],
      currentRunId: null,
      selectedFrameIndex: 0,
      selectedCandidateIndex: 0,
      summaryStats: null,
    };
    persistPartScopedConfig();
    notify();
    return;
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(FEED_COLLECTOR_STATE_KEY);
    } catch {
      /* ignore */
    }
  }
  setFeedCollectorState({
    reports: [],
    currentRunId: null,
    selectedFrameIndex: 0,
    selectedCandidateIndex: 0,
    summaryStats: null,
  });
}

export function useFeedCollectorStore(): [FeedCollectorState, (patch: Partial<FeedCollectorState>) => void] {
  const [state, setState] = useState<FeedCollectorState>(globalState);

  useEffect(() => {
    const handler = (next: FeedCollectorState) => setState(next);
    listeners.add(handler);
    setState(globalState);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return [state, setFeedCollectorState];
}

export function computeRunSummaryStats(reports: FeedCollectorState["reports"]): RunSummaryStats {
  let totalActionRows = 0;
  let domHitSuccess = 0;
  let boundaryFound = 0;
  let boundaryNotFound = 0;
  let boundaryAmbiguous = 0;
  const attentionFrames: number[] = [];

  for (const report of reports) {
    totalActionRows += report.candidates.length;
    let frameHasIssue = false;

    if (report.candidates.length === 0) {
      frameHasIssue = true;
    }

    for (const cand of report.candidates) {
      if (cand.boundary?.hitElement) {
        domHitSuccess++;
      }
      const bStatus = cand.boundary?.status;
      if (bStatus === "BOUNDARY_FOUND") {
        boundaryFound++;
      } else if (bStatus === "BOUNDARY_AMBIGUOUS") {
        boundaryAmbiguous++;
        frameHasIssue = true;
      } else {
        boundaryNotFound++;
        frameHasIssue = true;
      }
    }

    if (frameHasIssue && !attentionFrames.includes(report.frame)) {
      attentionFrames.push(report.frame);
    }
  }

  return {
    totalActionRows,
    domHitSuccess,
    boundaryFound,
    boundaryNotFound,
    boundaryAmbiguous,
    attentionFrames,
  };
}
