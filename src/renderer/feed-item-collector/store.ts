import { useState, useEffect } from "react";
import { loadLiveTemplates, LIVE_TEMPLATE_KEY } from "../experiments/visual-match-lab/LiveTemplateCalibration";
import { loadSavedRules } from "../experiments/visual-match-lab/LiveScrollTest";
import type { FeedCollectorState, RunSummaryStats } from "./types";

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

export function getFeedCollectorState(): FeedCollectorState {
  return globalState;
}

export function hydrateFeedCollectorFromStorage(): FeedCollectorState {
  const loaded = loadSavedRun();
  globalState = {
    ...globalState,
    reports: loaded.reports ?? globalState.reports,
    summaryStats: loaded.summaryStats ?? globalState.summaryStats,
    currentRunId: loaded.currentRunId ?? globalState.currentRunId,
  };
  listeners.forEach(fn => fn(globalState));
  return globalState;
}

export function setFeedCollectorState(patch: Partial<FeedCollectorState>) {
  globalState = { ...globalState, ...patch };
  if (typeof localStorage !== "undefined") {
    if (patch.templates) {
      try {
        localStorage.setItem(LIVE_TEMPLATE_KEY, JSON.stringify(globalState.templates));
      } catch {}
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
      } catch {}
    }
  }
  listeners.forEach(fn => fn(globalState));
}

export function resetFeedCollectorRun() {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(FEED_COLLECTOR_STATE_KEY);
    } catch {}
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
