import { useEffect, useState } from "react";
import {
  DEFAULT_POST_DETAIL_FIXTURE_URL,
  type PostDetailOcrFrame,
  type VisualReferenceSample,
} from "../../shared/post-detail-collector/types";
import type { PostDetailCollectorState } from "./types";

export const POST_DETAIL_STATE_KEY = "rpa:post-detail-collector:run";

function loadPersisted(): Partial<PostDetailCollectorState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(POST_DETAIL_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PostDetailCollectorState>;
    return {
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
    };
  } catch {
    return {};
  }
}

const persisted = loadPersisted();

const INITIAL: PostDetailCollectorState = {
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

export function setPostDetailCollectorState(patch: Partial<PostDetailCollectorState>) {
  globalState = { ...globalState, ...patch };
  persistLightweight(globalState);
  listeners.forEach((fn) => fn(globalState));
}

export function usePostDetailCollectorStore(): [
  PostDetailCollectorState,
  (patch: Partial<PostDetailCollectorState>) => void,
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
