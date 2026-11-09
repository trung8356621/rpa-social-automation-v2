/**
 * Collector ↔ Browser Core adapter.
 * Reuses existing navigate / capture / crop / browserVisible / targetImage IPC.
 * Does not create a second browser engine or session store.
 */
import type { Capture, Command, OcrResult, Rect } from "../../shared/contracts";
import type {
  CollectorDomSnapshot,
  LayoutContextKind,
  MatchedPostItem,
  SampleRoi,
  EndVisualCandidate,
  EndVisualMatchResult,
  BeginLayoutCandidate,
  BeginLayoutMatchResult,
  BeginLayoutInspectionReport,
  BeginBlockCandidate,
  BeginBlockMatchResult,
  BeginBlockInspectionReport,
  NormalizedRegionGeometry,
} from "../../shared/collectors/types";
import { WEB_HEIGHT, WEB_WIDTH } from "../../shared/geometry";

declare global {
  interface Window {
    __RPA_WEB_DEV__?: boolean;
  }
}

export type CollectorInvoke = <T>(command: Command) => Promise<T>;

export function isElectronBrowserCoreAvailable(): boolean {
  return Boolean(window.creator) && window.__RPA_WEB_DEV__ !== true;
}

export const BROWSER_CORE_UNAVAILABLE =
  "Real Browser Core is unavailable in this preview. Use the Electron RPA Creator app to open a Browser Session, navigate, and capture. Web-dev does not embed authenticated webContents.";

export async function collectorNavigate(invoke: CollectorInvoke, url: string): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("URL must be http:// or https://");
  await invoke({ type: "navigate", url: trimmed });
  await invoke({ type: "browserVisible", visible: true });
}

export async function collectorSetBrowserVisible(
  invoke: CollectorInvoke,
  visible: boolean,
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "browserVisible", visible });
}

export async function collectorReportBrowserHost(
  invoke: CollectorInvoke,
  host: null | { x: number; y: number; width: number; height: number; active: boolean },
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorBrowserHost", host });
}

export async function collectorFreezeFrame(invoke: CollectorInvoke): Promise<Capture> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  const image = await invoke<Capture>({ type: "capture" });
  await invoke({ type: "browserVisible", visible: false });
  return image;
}

export async function collectorCropRoi(
  invoke: CollectorInvoke,
  captureId: string,
  roi: Rect,
): Promise<{ asset: string; roi: Rect; dataUrl: string }> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  if (roi.width < 4 || roi.height < 4) throw new Error("ROI too small (min 4×4 DIP).");
  return invoke({ type: "crop", captureId, roi });
}

export type ScrollCaptureSession = {
  sessionId: string;
  phase: string;
  width: number;
  height: number;
  frameCount: number;
  dataUrl: string;
  lastAlignScore?: number;
  error?: string;
  browserSessionId?: string;
  url: string;
  lastDiagnostics?: {
    failureKind: string;
    message: string;
    strategy?: string;
    score?: number;
    scrollBefore?: number;
    scrollAfter?: number;
    scrollDeltaCss?: number;
    accepted?: boolean;
    stages?: Array<{ stage: string; ms: number }>;
    totalMs?: number;
    timeoutStage?: string;
    singleFlight?: string;
  };
};

export async function collectorScrollCaptureBegin(
  invoke: CollectorInvoke,
  captureId: string,
): Promise<ScrollCaptureSession> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  return invoke({ type: "collectorScrollCaptureBegin", captureId });
}

export async function collectorScrollCaptureExtend(
  invoke: CollectorInvoke,
  sessionId: string,
  deltaY?: number,
): Promise<ScrollCaptureSession> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  return invoke({ type: "collectorScrollCaptureExtend", sessionId, deltaY });
}

export async function collectorScrollCaptureMarkRoi(
  invoke: CollectorInvoke,
  sessionId: string,
): Promise<ScrollCaptureSession> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  return invoke({ type: "collectorScrollCaptureMarkRoi", sessionId });
}

export async function collectorScrollCaptureConfirm(
  invoke: CollectorInvoke,
  sessionId: string,
  roi: Rect,
): Promise<{ asset: string; roi: Rect; dataUrl: string; environment: { width: number; height: number; zoom: number } }> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  if (roi.width < 4 || roi.height < 4) throw new Error("ROI too small (min 4×4 DIP).");
  return invoke({ type: "collectorScrollCaptureConfirm", sessionId, roi });
}

export async function collectorScrollCaptureCancel(
  invoke: CollectorInvoke,
  sessionId: string,
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorScrollCaptureCancel", sessionId });
}

export async function collectorLoadImageAsset(
  invoke: CollectorInvoke,
  asset: string,
): Promise<string> {
  if (!isElectronBrowserCoreAvailable()) {
    throw new Error(BROWSER_CORE_UNAVAILABLE);
  }
  if (!/^[a-f0-9-]+\.png$/i.test(asset)) throw new Error("Invalid image asset id.");
  return invoke<string>({ type: "targetImage", asset });
}

export function roiToSampleRoi(
  roi: Rect,
  containerW: number = WEB_WIDTH,
  containerH: number = WEB_HEIGHT,
): SampleRoi {
  return {
    x: roi.x,
    y: roi.y,
    width: roi.width,
    height: roi.height,
    containerWidth: containerW,
    containerHeight: containerH,
  };
}

export async function collectorOcrAsset(
  invoke: CollectorInvoke,
  asset: string,
  crop?: Rect,
): Promise<OcrResult> {
  if (!isElectronBrowserCoreAvailable()) {
    throw new Error(BROWSER_CORE_UNAVAILABLE);
  }
  const cleanAsset = asset.trim();
  if (!/^[a-f0-9-]+\.png$/i.test(cleanAsset)) {
    throw new Error("Invalid image asset filename for OCR.");
  }
  return invoke<OcrResult>({ type: "ocrTarget", asset: cleanAsset, crop });
}

export async function collectorInspectDom(
  invoke: CollectorInvoke,
  url?: string,
  layoutContext?: LayoutContextKind,
): Promise<CollectorDomSnapshot> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      url: url || "",
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
      elements: [],
      isStale: false,
    };
  }
  return invoke<CollectorDomSnapshot>({ type: "collectorInspectDom", url, layoutContext });
}

export async function collectorHighlightMatches(
  invoke: CollectorInvoke,
  matches: MatchedPostItem[],
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorHighlightMatches", matches });
}

export async function collectorClearHighlights(
  invoke: CollectorInvoke,
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorClearHighlights" });
}

export async function collectorLogMatchDiagnostic(
  invoke: CollectorInvoke,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorLogMatchDiagnostic", payload });
}

export async function collectorMatchEndVisual(
  invoke: CollectorInvoke,
  references: Array<{ sampleId?: string; referenceImage?: string; assetId?: string; originalRoi?: Rect }>,
  options?: { scaleVariants?: number[]; minConfidence?: number },
): Promise<EndVisualMatchResult> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      testedAt: new Date().toISOString(),
      technique: "Tripartite Multi-Cluster Visual Template Correlation (Sharp)",
      screenshotDimensions: { width: 1280, height: 800 },
      scale: 1.0,
      referenceEndCount: references.length,
      referenceSampleIds: references.map((r) => r.sampleId || "").filter(Boolean),
      status: "NO_MATCH",
      matchedFooters: [],
      rejectedCandidates: [],
      diagnostics: {
        referenceCropDimensions: [],
        totalEvaluated: 0,
        durationMs: 0,
        summary: "Electron Browser Core unavailable in preview mode.",
      },
    };
  }
  return invoke<EndVisualMatchResult>({
    type: "collectorMatchEndVisual",
    references,
    options,
  });
}

export async function collectorHighlightEndVisual(
  invoke: CollectorInvoke,
  matches: EndVisualCandidate[],
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorHighlightEndVisual", matches });
}

export async function collectorMatchBeginLayout(
  invoke: CollectorInvoke,
  references: Array<{
    sampleId?: string;
    regionId?: string;
    groupTag?: string;
    referenceImage?: string;
    assetId?: string;
    captureId?: string;
    originalRoi?: Rect;
    geometry?: NormalizedRegionGeometry;
  }>,
  options?: { scaleVariants?: number[]; minConfidence?: number },
): Promise<BeginLayoutMatchResult> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      testedAt: new Date().toISOString(),
      technique: "Structural Geometry & Relative Layout Correlation (Sharp)",
      screenshotDimensions: { width: 1280, height: 800 },
      scale: 1.0,
      referenceBeginCount: references.length,
      referenceSampleIds: references.map((r) => r.sampleId || "").filter(Boolean),
      status: "NO_MATCH",
      matchedHeaders: [],
      rejectedCandidates: [],
      diagnostics: {
        referenceCropDimensions: [],
        totalEvaluated: 0,
        durationMs: 0,
        summary: "Electron Browser Core unavailable in preview mode.",
      },
    };
  }
  return invoke<BeginLayoutMatchResult>({
    type: "collectorMatchBeginLayout",
    references,
    options,
  });
}

export async function collectorHighlightBeginLayout(
  invoke: CollectorInvoke,
  matches: BeginLayoutCandidate[],
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorHighlightBeginLayout", matches });
}

export async function collectorInspectBeginTemplate(
  invoke: CollectorInvoke,
  references: Array<{
    sampleId?: string;
    regionId?: string;
    groupTag?: string;
    referenceImage?: string;
    assetId?: string;
    captureId?: string;
    originalRoi?: Rect;
    geometry?: NormalizedRegionGeometry;
  }>,
  groupTag?: string,
): Promise<BeginLayoutInspectionReport> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      generatedAt: new Date().toISOString(),
      canonicalDimensions: { width: 240, height: 48 },
      groups: {},
      allGroupTags: [],
    };
  }
  return invoke<BeginLayoutInspectionReport>({
    type: "collectorInspectBeginTemplate",
    references,
    groupTag,
  });
}

// C2.11.15: B3 V2 Block-Level Layout Matching IPC Wrappers
export async function collectorMatchBeginBlockLayout(
  invoke: CollectorInvoke,
  references: Array<{
    sampleId?: string;
    regionId?: string;
    groupTag?: string;
    referenceImage?: string;
    assetId?: string;
    captureId?: string;
    originalRoi?: Rect;
    geometry?: NormalizedRegionGeometry;
  }>,
  options?: { scaleVariants?: number[]; minConfidence?: number },
): Promise<BeginBlockMatchResult> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      testedAt: new Date().toISOString(),
      technique: "B3_V2_BLOCK_LEVEL_MATCHING",
      referenceSampleIds: references.map((r) => r.sampleId || "").filter(Boolean),
      referenceBeginCount: references.length,
      variantCount: 0,
      status: "NO_MATCH",
      screenshotDimensions: { width: 1280, height: 800 },
      scale: 1.0,
      matchedCandidates: [],
      rejectedCandidates: [],
      diagnostics: {
        decodeTimeMs: 0,
        preprocessTimeMs: 0,
        candidateGenerationTimeMs: 0,
        candidateComparisonTimeMs: 0,
        totalDurationMs: 0,
        evaluatedWindowsCount: 0,
        variants: [],
      },
    };
  }
  return invoke<BeginBlockMatchResult>({
    type: "collectorMatchBeginBlockLayout",
    references,
    options,
  });
}

export async function collectorHighlightBeginBlockLayout(
  invoke: CollectorInvoke,
  matches: BeginBlockCandidate[],
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorHighlightBeginBlockLayout", matches });
}

export async function collectorInspectBeginBlockTemplate(
  invoke: CollectorInvoke,
  references: Array<{
    sampleId?: string;
    regionId?: string;
    groupTag?: string;
    referenceImage?: string;
    assetId?: string;
    captureId?: string;
    originalRoi?: Rect;
    geometry?: NormalizedRegionGeometry;
  }>,
  groupTag?: string,
): Promise<BeginBlockInspectionReport> {
  if (!isElectronBrowserCoreAvailable()) {
    return {
      generatedAt: new Date().toISOString(),
      canonicalDimensions: { width: 240, height: 48 },
      groups: {},
      allGroupTags: [],
    };
  }
  return invoke<BeginBlockInspectionReport>({
    type: "collectorInspectBeginBlockTemplate",
    references,
    groupTag,
  });
}

