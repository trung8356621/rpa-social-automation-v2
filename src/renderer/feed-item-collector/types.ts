import type { Command } from "../../shared/contracts";
import type { UserPermalinkRule } from "../../shared/permalink-rules";
import type { LiveCapture, DomElement } from "../experiments/visual-match-lab/types";
import type { LiveCandidate, FrameReport } from "../experiments/visual-match-lab/LiveScrollTest";
import type {
  LiveIconKind,
  LiveIconTemplate,
  LiveIconTemplates,
} from "../experiments/visual-match-lab/LiveTemplateCalibration";

export type {
  LiveCapture,
  DomElement,
  LiveCandidate,
  FrameReport,
  LiveIconKind,
  LiveIconTemplate,
  LiveIconTemplates,
  UserPermalinkRule,
};

export type Invoke = <T>(command: Command) => Promise<T>;

export type FeedCollectorStep = 1 | 2 | 3;

export type RunSummaryStats = {
  totalActionRows: number;
  domHitSuccess: number;
  boundaryFound: number;
  boundaryNotFound: number;
  boundaryAmbiguous: number;
  attentionFrames: number[];
};

export type FeedCollectorState = {
  step: FeedCollectorStep;
  templates: LiveIconTemplates;
  calibrationCapture: LiveCapture | null;
  reports: FrameReport[];
  currentRunId: string | null;
  selectedFrameIndex: number;
  selectedCandidateIndex: number;
  rules: UserPermalinkRule[];
  summaryStats: RunSummaryStats | null;
};
