/**
 * Collector Script Workspace — one-shot Visual Feed observation.
 * Reuses Feed Visual Counter matching helpers; does not fork thresholds or the 5-sample authoring loop.
 */

import { runRecognitionPipeline } from "../../../experiments/visual-match-lab/src/cv/recognition-pipeline";
import type { FixtureItem } from "../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { BoundaryProbeResult } from "../../shared/boundary-probe";
import type { VisualObservationRecord } from "../../shared/collectors/visual-observation-types";
import { VISUAL_OBSERVATION_SCHEMA_VERSION } from "../../shared/collectors/visual-observation-types";
import type { VisualPartOption } from "../../shared/collectors/visual-part-binding";
import {
  detectActionRows,
  imageCanvas,
  fingerprint,
  loadSavedRules,
  wait,
} from "../experiments/visual-match-lab/LiveScrollTest";
import {
  dedupeCandidates,
  computeFrameCandidateCounts,
  extractCandidatePostIdentity,
} from "../feed-item-collector/scroll-sampling";
import type {
  Invoke,
  LiveCapture,
  LiveCandidate,
  LiveIconTemplates,
  UserPermalinkRule,
} from "../feed-item-collector/types";
import type { CollectorInvoke } from "./browser-capture";

const MATCH_METHOD = "grayscale" as const;
const MATCH_THRESHOLD = 0.72;

export type VisualRuntimeSeenState = {
  candidates: LiveCandidate[];
};

export function createVisualRuntimeSeenState(): VisualRuntimeSeenState {
  return { candidates: [] };
}

function newObservationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `vobs_${crypto.randomUUID()}`;
  }
  return `vobs_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function processViewportCapture(input: {
  capture: LiveCapture;
  observationId: string;
  templateCanvases: HTMLCanvasElement[];
  rules: UserPermalinkRule[];
  invoke: Invoke;
}): Promise<{
  candidates: LiveCandidate[];
  rawIconMatches: number;
  detectedRowCount: number;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const fixture: FixtureItem = {
    id: `${input.capture.id}_runtime`,
    name: `Runtime observe`,
    description: input.capture.viewport.url,
    width: input.capture.width,
    height: input.capture.height,
    isRealFixture: true,
    dataUrl: input.capture.dataUrl,
  };
  const pipeline = await runRecognitionPipeline(fixture);
  const target = await imageCanvas(input.capture.dataUrl, input.capture.width, input.capture.height);

  const detected = await detectActionRows(
    target,
    input.templateCanvases,
    MATCH_METHOD,
    MATCH_THRESHOLD,
    pipeline.candidates.filter((c) => c.type === "icon").map((c) => c.bbox),
  );

  const candidates: LiveCandidate[] = [];

  for (let rowIdx = 0; rowIdx < detected.rows.length; rowIdx++) {
    const row = detected.rows[rowIdx]!;
    const targetIcon = row.items[0];
    const iconCenterX = targetIcon
      ? targetIcon.bbox.x + targetIcon.bbox.width / 2
      : row.bbox.x + Math.min(24, row.bbox.width / 2);
    const iconCenterY = targetIcon
      ? targetIcon.bbox.y + targetIcon.bbox.height / 2
      : row.bbox.y + row.bbox.height / 2;

    const point = {
      x: Math.round((iconCenterX * input.capture.viewport.width) / input.capture.width),
      y: Math.round((iconCenterY * input.capture.viewport.height) / input.capture.height),
    };
    const actionRowCssBbox = {
      x: Math.round((row.bbox.x * input.capture.viewport.width) / input.capture.width),
      y: Math.round((row.bbox.y * input.capture.viewport.height) / input.capture.height),
      width: Math.round((row.bbox.width * input.capture.viewport.width) / input.capture.width),
      height: Math.round((row.bbox.height * input.capture.viewport.height) / input.capture.height),
    };

    let boundary: (BoundaryProbeResult & { evidenceDataUrl?: string }) | undefined;
    let context = "unknown";

    try {
      boundary = await input.invoke<BoundaryProbeResult & { evidenceDataUrl?: string }>({
        type: "visualMatchLabProbeBoundary",
        captureId: input.capture.id,
        webContentsId: input.capture.webContentsId,
        point,
        actionRowBbox: actionRowCssBbox,
        options: { highlight: true, captureEvidence: true, customRules: input.rules },
      });
      if (boundary.candidateContainer?.role === "article" || boundary.status === "BOUNDARY_FOUND") {
        context = "post";
      }
    } catch (probeError) {
      diagnostics.push(`probe_error_row_${rowIdx}:${String(probeError)}`);
      context = "unknown";
    }

    const hash = fingerprint(target, row.bbox);
    const docY = input.capture.viewport.scrollY + row.bbox.y;
    const boundaryStatus = boundary?.status ?? "BOUNDARY_NOT_FOUND";
    const postIdentity = extractCandidatePostIdentity(boundary);
    const candidateId = `cand_${input.observationId}_r${rowIdx}`;

    candidates.push({
      candidateId,
      frameId: 1,
      bbox: row.bbox,
      score: row.score,
      matchScore: row.score,
      iconCount: row.items.length,
      status: boundaryStatus === "BOUNDARY_FOUND" && row.items.length >= 2 ? "NEW_ITEM" : "NEEDS_ATTENTION",
      boundaryStatus,
      dedupeStatus: "NEW_ITEM",
      postIdentity,
      evidenceRef: boundary?.evidenceDataUrl ? `inline:evidence` : undefined,
      context,
      fingerprint: hash,
      docY,
      boundary,
      highlightedEvidenceUrl: boundary?.evidenceDataUrl,
    });
  }

  return {
    candidates,
    rawIconMatches: detected.rawIconMatches,
    detectedRowCount: detected.rows.length,
    diagnostics,
  };
}

export type ObserveVisualFeedInput = {
  invoke: CollectorInvoke;
  captureSessionId: string;
  browserSessionId?: string;
  visualPart: VisualPartOption;
  sourceUrl?: string;
  seen: VisualRuntimeSeenState;
  /** Optional permalink rules; defaults to Feed Visual Counter saved rules. */
  rules?: UserPermalinkRule[];
};

export type ObserveVisualFeedResult =
  | { ok: true; observation: VisualObservationRecord; seen: VisualRuntimeSeenState }
  | { ok: false; error: string; observation?: VisualObservationRecord };

/**
 * Capture the current BrowserCore viewport once and run existing Visual matching.
 * Does not scroll and does not require the five-sample authoring loop.
 */
export async function observeVisualFeedOnce(
  input: ObserveVisualFeedInput,
): Promise<ObserveVisualFeedResult> {
  const observationId = newObservationId();
  const observedAt = new Date().toISOString();
  const diagnostics: string[] = [];
  const templates = input.visualPart.templates as LiveIconTemplates;

  if (!input.visualPart.templatesComplete) {
    return {
      ok: false,
      error: `Visual Part templates incomplete (${input.visualPart.templateKindsReady}/3).`,
    };
  }

  if (!input.captureSessionId?.trim()) {
    return { ok: false, error: "captureSessionId is required for Visual observation." };
  }

  try {
    const rules = input.rules ?? loadSavedRules();
    const templateCanvases = await Promise.all(
      (["like", "comment", "share"] as const).map((kind) =>
        imageCanvas(templates[kind]!.dataUrl, templates[kind]!.width, templates[kind]!.height),
      ),
    );

    let capture: LiveCapture;
    try {
      capture = await input.invoke<LiveCapture>({ type: "visualMatchLabCapture" });
    } catch (err) {
      return {
        ok: false,
        error: `Viewport capture failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Brief settle so probe DOM matches the captured frame.
    await wait(50);

    const processed = await processViewportCapture({
      capture,
      observationId,
      templateCanvases,
      rules,
      invoke: input.invoke as Invoke,
    });
    diagnostics.push(...processed.diagnostics);

    const { merged, duplicateCount, possibleDuplicateCount } = dedupeCandidates(
      processed.candidates,
      [],
      input.seen.candidates,
    );

    const nextSeen = [...input.seen.candidates];
    for (const cand of merged) {
      if (cand.dedupeStatus !== "DUPLICATE") nextSeen.push(cand);
    }

    const counts = computeFrameCandidateCounts(merged);
    const boundaryFound = merged.filter((c) => c.boundaryStatus === "BOUNDARY_FOUND").length;
    const boundaryAmbiguous = merged.filter((c) => c.boundaryStatus === "BOUNDARY_AMBIGUOUS").length;
    const boundaryNotFound = merged.filter(
      (c) => c.boundaryStatus === "BOUNDARY_NOT_FOUND" || !c.boundaryStatus,
    ).length;

    const estimatedUniqueItemCount = merged.filter(
      (c) => c.dedupeStatus !== "DUPLICATE" && c.boundaryStatus === "BOUNDARY_FOUND",
    ).length;

    diagnostics.push(
      "html_snapshot:skipped — live BOUNDARY_FOUND exposes candidateContainer rect/tag/role only; outerHTML needs boundary-probe.ts + IPC approval",
    );

    const observation: VisualObservationRecord = {
      schemaVersion: VISUAL_OBSERVATION_SCHEMA_VERSION,
      observationId,
      captureSessionId: input.captureSessionId,
      browserSessionId: input.browserSessionId,
      visualPartId: input.visualPart.partId,
      visualPartVersion: input.visualPart.partVersion,
      visualPartName: input.visualPart.name,
      observedAt,
      sourceUrl: input.sourceUrl ?? capture.viewport.url,
      status: processed.detectedRowCount > 0 ? (boundaryFound > 0 ? "success" : "partial") : "partial",
      actionRowsDetected: processed.detectedRowCount,
      rawIconMatches: processed.rawIconMatches,
      candidateCount: merged.length,
      boundaryFound,
      boundaryAmbiguous,
      boundaryNotFound,
      estimatedUniqueItemCount,
      duplicateCount,
      possibleDuplicateCount,
      candidates: merged.map((c) => ({
        candidateId: c.candidateId,
        boundaryStatus: c.boundaryStatus,
        dedupeStatus: c.dedupeStatus,
        iconCount: c.iconCount,
        matchScore: c.matchScore,
        postId: c.postIdentity?.postId,
        canonicalUrl: c.postIdentity?.canonicalUrl,
        docY: c.docY,
        containerTag: c.boundary?.candidateContainer?.tag,
        containerRole: c.boundary?.candidateContainer?.role ?? null,
        htmlSkippedReason:
          c.boundaryStatus === "BOUNDARY_FOUND"
            ? "html_snapshot_requires_boundary_probe_outerHTML_approval"
            : c.boundaryStatus === "BOUNDARY_AMBIGUOUS"
              ? "skipped_ambiguous_container"
              : "skipped_no_boundary",
        evidenceRef: c.evidenceRef,
      })),
      diagnostics,
    };

    void counts;

    return {
      ok: true,
      observation: {
        ...observation,
        diagnostics: [
          ...observation.diagnostics,
          `session_unique_seen:${nextSeen.filter((c) => c.boundaryStatus === "BOUNDARY_FOUND").length}`,
          `frame_counts:${counts.found}/${counts.needsAttention}/${counts.duplicate}`,
        ],
      },
      seen: { candidates: nextSeen },
    };
  } catch (err) {
    const observation: VisualObservationRecord = {
      schemaVersion: VISUAL_OBSERVATION_SCHEMA_VERSION,
      observationId,
      captureSessionId: input.captureSessionId,
      browserSessionId: input.browserSessionId,
      visualPartId: input.visualPart.partId,
      visualPartVersion: input.visualPart.partVersion,
      visualPartName: input.visualPart.name,
      observedAt,
      sourceUrl: input.sourceUrl,
      status: "failed",
      actionRowsDetected: 0,
      rawIconMatches: 0,
      candidateCount: 0,
      boundaryFound: 0,
      boundaryAmbiguous: 0,
      boundaryNotFound: 0,
      estimatedUniqueItemCount: 0,
      duplicateCount: 0,
      possibleDuplicateCount: 0,
      candidates: [],
      diagnostics: [...diagnostics, err instanceof Error ? err.message : String(err)],
    };
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      observation,
    };
  }
}
