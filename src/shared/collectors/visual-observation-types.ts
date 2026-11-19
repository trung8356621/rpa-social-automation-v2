/**
 * Visual observation evidence for a shared Collector Capture Session.
 * Filesystem artifacts live under scratch/collector-capture-sessions/<id>/visual/.
 * Renderer may keep an in-memory copy until main-process IPC is wired.
 */

export const VISUAL_OBSERVATION_SCHEMA_VERSION = 1;

export type VisualBoundaryBucket = "BOUNDARY_FOUND" | "BOUNDARY_AMBIGUOUS" | "BOUNDARY_NOT_FOUND";

export type VisualObservationCandidateSummary = {
  candidateId: string;
  boundaryStatus: VisualBoundaryBucket | string;
  dedupeStatus: "NEW_ITEM" | "DUPLICATE" | "POSSIBLE_DUPLICATE" | string;
  iconCount: number;
  matchScore: number;
  postId?: string;
  canonicalUrl?: string;
  docY?: number;
  containerTag?: string;
  containerRole?: string | null;
  /** Relative path under the capture session dir when HTML was persisted. */
  htmlArtifactRef?: string;
  htmlSkippedReason?: string;
  evidenceRef?: string;
};

export type VisualObservationRecord = {
  schemaVersion: number;
  observationId: string;
  captureSessionId: string;
  browserSessionId?: string;
  visualPartId: string;
  visualPartVersion: number;
  visualPartName?: string;
  observedAt: string;
  sourceUrl?: string;
  status: "success" | "partial" | "failed";
  actionRowsDetected: number;
  rawIconMatches: number;
  candidateCount: number;
  boundaryFound: number;
  boundaryAmbiguous: number;
  boundaryNotFound: number;
  /** Estimated unique feed items after in-session dedupe (UI observation, not Network uniqueness). */
  estimatedUniqueItemCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  candidates: VisualObservationCandidateSummary[];
  diagnostics: string[];
  /** Optional relative path to observation JSON under session/visual/. */
  observationArtifactRef?: string;
};

export type VisualObservationList = {
  captureSessionId: string;
  total: number;
  items: VisualObservationRecord[];
};

export function emptyVisualObservationStats(): {
  observations: number;
  estimatedUniqueItemCount: number;
  boundaryFound: number;
} {
  return { observations: 0, estimatedUniqueItemCount: 0, boundaryFound: 0 };
}
