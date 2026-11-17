import { useEffect, useState } from "react";
import {
  DEFAULT_POST_DETAIL_FIXTURE_URL,
  type PostDetailOcrFrame,
  type VisualReferenceSample,
} from "../../shared/post-detail-collector/types";
import type { PostDetailCollectorState } from "./types";
import { extractWorkspaceIdentity, legacyStrategies, mergeUrlWorkspace } from "./url-workspace";

export const POST_DETAIL_STATE_KEY = "rpa:post-detail-collector:run";

export function migratePostDetailState(parsed: Partial<PostDetailCollectorState>): Partial<PostDetailCollectorState> {
  const parentConfigs = parsed.parentConfigs ?? {};
  const batchUrlsText = typeof parsed.batchUrlsText === "string" ? parsed.batchUrlsText : "";
  const rawUrlItems = Array.isArray(parsed.urlItems) ? parsed.urlItems.map(item => {
    const identity = extractWorkspaceIdentity(item.originalUrl);
    const normalizedStatus = item.status === "PROCESSING" ? "NEEDS_ATTENTION" : item.status;
    const diagnostics = item.status === "PROCESSING" && (!item.diagnostics || item.diagnostics.length === 0)
      ? ["Previous Auto Match was interrupted by app restart."]
      : item.diagnostics;
    return { ...item, status: normalizedStatus, diagnostics, groupSlug: item.groupSlug ?? identity.groupSlug, groupId: item.groupId ?? identity.groupId };
  }) : mergeUrlWorkspace(batchUrlsText, []);
  const savedParentResolution = parsed.savedParentResolution?.status === "RESOLVING"
    ? {
        ...parsed.savedParentResolution,
        status: "BROWSER_NOT_READY" as const,
        failureCode: parsed.savedParentResolution.failureCode ?? ("BROWSER_NOT_READY" as const),
        diagnostics: [...(parsed.savedParentResolution.diagnostics || []), "Previous Auto Match was interrupted by app restart."],
      }
    : parsed.savedParentResolution;
  return {
    ...parsed,
    schemaVersion: 2,
    majorStep: parsed.majorStep ?? 1,
    processingSubstep: parsed.processingSubstep ?? 3,
    urlItems: rawUrlItems,
    selectedUrlId: typeof parsed.selectedUrlId === "string" ? parsed.selectedUrlId : null,
    strategies: Array.isArray(parsed.strategies) ? parsed.strategies : legacyStrategies(parentConfigs),
    parentConfigs,
    savedParentResolution,
    batchUrlsText,
  };
}

function loadPersisted(): Partial<PostDetailCollectorState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(POST_DETAIL_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PostDetailCollectorState>;
    return migratePostDetailState({
      runId: parsed.runId ?? null,
      sourceUrl: parsed.sourceUrl,
      browserUrl: typeof parsed.browserUrl === "string" ? parsed.browserUrl : "",
      frames: parsed.frames ?? [],
      visualReferences: (parsed.visualReferences ?? []).map((s: VisualReferenceSample) => ({
        ...s,
        // Keep lightweight refs in localStorage; full PNGs live in evidence runs.
        dataUrl: s.dataUrl && s.dataUrl.length < 200_000 ? s.dataUrl : "",
      })),
      contentRoi: parsed.contentRoi ?? null,
      selectedFrameIndex: parsed.selectedFrameIndex ?? 0,
      parentConfigs: parsed.parentConfigs ?? {},
      variableMappings: parsed.variableMappings ?? [],
      hiddenExtractedData: parsed.hiddenExtractedData ?? {},
      engagementResults: parsed.engagementResults ?? {},
      batchUrlsText: typeof parsed.batchUrlsText === "string" ? parsed.batchUrlsText : "",
      batchResults: Array.isArray(parsed.batchResults) ? parsed.batchResults : [],
      batchConfigVersion: typeof parsed.batchConfigVersion === "number" ? parsed.batchConfigVersion : 1,
      batchValidatedVersion: typeof parsed.batchValidatedVersion === "number" ? parsed.batchValidatedVersion : null,
      schemaVersion: parsed.schemaVersion,
      majorStep: parsed.majorStep,
      processingSubstep: parsed.processingSubstep,
      urlItems: parsed.urlItems,
      selectedUrlId: parsed.selectedUrlId,
      strategies: parsed.strategies,
    });
  } catch {
    return {};
  }
}

const persisted = loadPersisted();

const INITIAL: PostDetailCollectorState = {
  schemaVersion: 2,
  majorStep: persisted.majorStep ?? 1,
  processingSubstep: persisted.processingSubstep ?? 3,
  urlItems: persisted.urlItems ?? [],
  selectedUrlId: persisted.selectedUrlId ?? null,
  strategies: persisted.strategies ?? [],
  step: 1,
  sourceUrl: persisted.sourceUrl || DEFAULT_POST_DETAIL_FIXTURE_URL,
  browserUrl: persisted.browserUrl || "",
  runId: persisted.runId ?? null,
  visualReferences: persisted.visualReferences ?? [],
  contentRoi: persisted.contentRoi ?? null,
  containerResult: null,
  scanFrames: [],
  lastMatch: null,
  lastScreenshot: null,
  frames: persisted.frames ?? [],
  selectedFrameIndex: persisted.selectedFrameIndex ?? 0,
  viewMode: "text",
  htmlExtraction: null,
  parentConfigs: persisted.parentConfigs ?? {},
  savedParentResolution: null,
  variableMappings: persisted.variableMappings ?? [],
  hiddenExtractedData: persisted.hiddenExtractedData ?? {},
  engagementResults: persisted.engagementResults ?? {},
  batchUrlsText: persisted.batchUrlsText ?? "",
  batchResults: persisted.batchResults ?? [],
  batchConfigVersion: persisted.batchConfigVersion ?? 1,
  batchValidatedVersion: persisted.batchValidatedVersion ?? null,
};

let globalState: PostDetailCollectorState = { ...INITIAL };
const listeners = new Set<(state: PostDetailCollectorState) => void>();

function persistLightweight(state: PostDetailCollectorState) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      POST_DETAIL_STATE_KEY,
      JSON.stringify({
        runId: state.runId,
        sourceUrl: state.sourceUrl,
        browserUrl: state.browserUrl,
        contentRoi: state.contentRoi,
        selectedFrameIndex: state.selectedFrameIndex,
        parentConfigs: state.parentConfigs,
        variableMappings: state.variableMappings,
        hiddenExtractedData: state.hiddenExtractedData,
        engagementResults: Object.fromEntries(Object.entries(state.engagementResults).map(([postId, result]) => [postId, { ...result, previewDataUrl: undefined }])),
        batchUrlsText: state.batchUrlsText,
        batchResults: state.batchResults,
        batchConfigVersion: state.batchConfigVersion,
        batchValidatedVersion: state.batchValidatedVersion,
        schemaVersion: state.schemaVersion,
        majorStep: state.majorStep,
        processingSubstep: state.processingSubstep,
        urlItems: state.urlItems,
        selectedUrlId: state.selectedUrlId,
        strategies: state.strategies,
        // Persist OCR text + metadata; strip huge screenshots from localStorage.
        frames: state.frames.map((f: PostDetailOcrFrame) => ({
          ...f,
          screenshotDataUrl: undefined,
          cropDataUrl: f.cropDataUrl && f.cropDataUrl.length < 200_000 ? f.cropDataUrl : undefined,
        })),
        visualReferences: state.visualReferences.map((s) => ({
          ...s,
          dataUrl: s.dataUrl && s.dataUrl.length < 200_000 ? s.dataUrl : "",
        })),
      }),
    );
  } catch {
    /* quota */
  }
}

export function getPostDetailCollectorState(): PostDetailCollectorState {
  return globalState;
}

export function setPostDetailCollectorState(
  patch: Partial<PostDetailCollectorState> | ((prev: PostDetailCollectorState) => Partial<PostDetailCollectorState>),
) {
  const resolved = typeof patch === "function" ? patch(globalState) : patch;
  globalState = { ...globalState, ...resolved };
  persistLightweight(globalState);
  listeners.forEach((fn) => fn(globalState));
}

export function usePostDetailCollectorStore(): [
  PostDetailCollectorState,
  (patch: Partial<PostDetailCollectorState> | ((prev: PostDetailCollectorState) => Partial<PostDetailCollectorState>)) => void,
] {
  const [state, setState] = useState(globalState);
  useEffect(() => {
    const listener = (next: PostDetailCollectorState) => setState(next);
    listeners.add(listener);
    setState(globalState);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [state, setPostDetailCollectorState];
}
