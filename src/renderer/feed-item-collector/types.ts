import type { Command, Rect } from "../../shared/contracts";
import type { UserPermalinkRule } from "../../shared/permalink-rules";
import type { BoundaryStatus, BoundaryProbeResult, AncestorStep } from "../../shared/boundary-probe";
import type { LiveCapture, DomElement } from "../experiments/visual-match-lab/types";
import type {
  CandidateStatus,
  FrameReport as BaseFrameReport,
} from "../experiments/visual-match-lab/LiveScrollTest";
import type {
  LiveIconKind,
  LiveIconTemplate,
  LiveIconTemplates,
} from "../experiments/visual-match-lab/LiveTemplateCalibration";

export type CandidateDedupeStatus = "NEW_ITEM" | "DUPLICATE" | "POSSIBLE_DUPLICATE";

export interface CandidatePostIdentity {
  platform: string;
  postId: string;
  scope?: string;
  canonicalUrl?: string;
  rawUrl?: string;
}

export type CandidateDisplayStatus = "FOUND" | "NEEDS_ATTENTION" | "DUPLICATE";

export type VerificationType = "NAVIGATION_SUCCESS" | "URL_VERIFIED" | "BOUNDARY_CONFIRMED";

export interface CandidateEvaluationRevision {
  revisionId: string;
  timestamp: string;
  source: "USER_CONFIRMATION" | "RULE_SAVED" | "OFFLINE_REEVALUATION";
  confirmedUrl?: string;
  ruleId?: string;
  beforeStatus: BoundaryStatus;
  afterStatus: BoundaryStatus;
  beforeCandidateStatus: CandidateDisplayStatus;
  afterCandidateStatus: CandidateDisplayStatus;
  beforeRiskReason?: string | null;
  afterRiskReason?: string | null;
  beforeContainerSummary?: string;
  afterContainerSummary?: string;
  matchedPostIdentity?: CandidatePostIdentity;
  notes?: string[];
}

export interface LiveCandidate {
  candidateId: string;
  frameId: number;
  bbox: Rect;
  score: number;
  matchScore: number;
  iconCount: number;
  status: CandidateStatus;
  boundaryStatus: BoundaryStatus;
  dedupeStatus: CandidateDedupeStatus;
  postIdentity?: CandidatePostIdentity;
  evidenceRef?: string;
  evidenceSavedPath?: string;
  highlightedEvidenceUrl?: string;
  context: string;
  fingerprint: string;
  docY: number;
  boundary?: BoundaryProbeResult;
  duplicateOfCandidateId?: string;
  dedupeReason?: string;
  verificationTypes?: VerificationType[];
  confirmedUrl?: string;
  latestRevision?: CandidateEvaluationRevision;
  evaluationRevisions?: CandidateEvaluationRevision[];
  rawEvidence?: {
    ancestorSteps: AncestorStep[];
    initialBoundary: BoundaryProbeResult;
  };
}

export interface FrameCandidateCounts {
  found: number;
  needsAttention: number;
  duplicate: number;
  total: number;
}

export type FrameReport = Omit<BaseFrameReport, "candidates"> & {
  candidates: LiveCandidate[];
};

export type {
  LiveCapture,
  DomElement,
  CandidateStatus,
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
