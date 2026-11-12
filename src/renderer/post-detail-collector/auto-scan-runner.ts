import {
  detectPostDetailContainer,
  inferAnchorTypeFromLabel,
  viewportWheelPoint,
} from "../../shared/post-detail-collector/auto-scan";
import { createPostDetailFrameId, createPostDetailRunId } from "../../shared/post-detail-collector/match-status";
import {
  POST_DETAIL_AUTO_SCAN_DEFAULTS,
  type PostDetailContainerResult,
  type PostDetailScanFrame,
  type PostDetailVisualAnchor,
  type VisualReferenceSample,
} from "../../shared/post-detail-collector/types";
import { WEB_HEIGHT, WEB_WIDTH } from "../../shared/geometry";
import {
  collectorFreezeFrame,
  collectorPostDetailWheel,
  collectorSetBrowserVisible,
  type CollectorInvoke,
} from "../collectors/browser-capture";
import { TemplateMatcher } from "../experiments/visual-match-lab/template-matcher";
import { imageToCanvas } from "./image-utils";

export type AutoScanProgress = {
  phase: "idle" | "running" | "stopped" | "done" | "error";
  frameIndex: number;
  maxFrames: number;
  message: string;
};

export type AutoScanDeps = {
  invoke: CollectorInvoke;
  sourceUrl: string;
  visualReferences: VisualReferenceSample[];
  maxFrames?: number;
  deltaY?: number;
  settleMs?: number;
  matchThreshold?: number;
  isCancelled: () => boolean;
  onProgress: (p: AutoScanProgress) => void;
  onFrame: (frame: PostDetailScanFrame, frames: PostDetailScanFrame[]) => void;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function matchFrameAnchors(
  image: { dataUrl: string; width: number; height: number },
  frameId: string,
  frameIndex: number,
  refs: VisualReferenceSample[],
  threshold: number,
): Promise<PostDetailVisualAnchor[]> {
  const target = await imageToCanvas(image.dataUrl);
  const anchors: PostDetailVisualAnchor[] = [];
  const bestByType = new Map<string, PostDetailVisualAnchor>();

  for (const sample of refs) {
    if (!sample.dataUrl) continue;
    const type = inferAnchorTypeFromLabel(sample.label);
    if (!type) continue;
    const tpl = await imageToCanvas(sample.dataUrl);
    const result = await TemplateMatcher.match(tpl, target, "grayscale", threshold);
    const best = result.matches[0];
    if (!best) continue;
    const next: PostDetailVisualAnchor = {
      type,
      frameId,
      frameIndex,
      bbox: best.bbox,
      score: best.score,
      templateId: sample.sampleId,
    };
    const prev = bestByType.get(type);
    if (!prev || next.score > prev.score) bestByType.set(type, next);
  }

  for (const a of bestByType.values()) anchors.push(a);
  return anchors;
}

/**
 * Auto Scan: capture frame 0 first, then wheel → settle → capture → match.
 * Does not navigate; uses current BrowserCore page.
 */
export async function runPostDetailAutoScan(deps: AutoScanDeps): Promise<{
  runId: string;
  frames: PostDetailScanFrame[];
  container: PostDetailContainerResult;
}> {
  const maxFrames = Math.max(1, Math.min(20, deps.maxFrames ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.maxFrames));
  const deltaY = deps.deltaY ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.deltaY;
  const settleMs = deps.settleMs ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.settleMs;
  const matchThreshold = deps.matchThreshold ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.matchThreshold;
  const runId = createPostDetailRunId();
  const frames: PostDetailScanFrame[] = [];
  let scrollApplied = 0;
  let wheelPoint = viewportWheelPoint({ width: WEB_WIDTH, height: WEB_HEIGHT });
  let stoppedReason = "completed";

  if (!deps.visualReferences.length) {
    throw new Error("AUTO_SCAN_NO_REFERENCES: Cần ≥1 visual reference từ Step 1.");
  }

  deps.onProgress({ phase: "running", frameIndex: 0, maxFrames, message: "Bắt đầu Auto Scan…" });
  await collectorSetBrowserVisible(deps.invoke, true);

  for (let i = 1; i <= maxFrames; i++) {
    if (deps.isCancelled()) {
      stoppedReason = "cancelled";
      deps.onProgress({ phase: "stopped", frameIndex: i - 1, maxFrames, message: "Đã Stop Auto Scan." });
      break;
    }

    // Frame 1: capture before any wheel. Later frames: wheel then settle then capture.
    if (i > 1) {
      deps.onProgress({
        phase: "running",
        frameIndex: i - 1,
        maxFrames,
        message: `Wheel Δy=${deltaY} tại tâm viewport…`,
      });
      const wheel = await collectorPostDetailWheel(deps.invoke, deltaY);
      wheelPoint = wheel.wheelPoint;
      scrollApplied += deltaY;
      await sleep(settleMs);
    }

    if (deps.isCancelled()) {
      stoppedReason = "cancelled";
      break;
    }

    deps.onProgress({
      phase: "running",
      frameIndex: i,
      maxFrames,
      message: `Capture & Match frame ${i}/${maxFrames}…`,
    });

    const image = await collectorFreezeFrame(deps.invoke);
    await collectorSetBrowserVisible(deps.invoke, true);

    const frameId = createPostDetailFrameId(i);
    const anchors = await matchFrameAnchors(image, frameId, i, deps.visualReferences, matchThreshold);
    const frame: PostDetailScanFrame = {
      frameId,
      frameIndex: i,
      scrollDeltaApplied: scrollApplied,
      screenshotDataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
      anchors,
      notes: [
        TemplateMatcher.isOpenCvReady() ? "OpenCV matcher" : "NCC fallback",
        `anchors=${anchors.map((a) => `${a.type}:${a.score.toFixed(3)}`).join(",") || "none"}`,
      ],
    };
    frames.push(frame);
    deps.onFrame(frame, [...frames]);

    // Early stop when we already have a FOUND-quality co-occurrence.
    const preview = detectPostDetailContainer({
      runId,
      sourceUrl: deps.sourceUrl,
      frames,
      wheelPoint,
      deltaY,
      settleMs,
      maxFrames,
      stoppedReason: "early-found",
    });
    if (preview.status === "FOUND" && i >= 2) {
      stoppedReason = "found-container";
      break;
    }
  }

  if (stoppedReason === "completed" && frames.length >= maxFrames) {
    stoppedReason = "max-frames";
  }

  const container = detectPostDetailContainer({
    runId,
    sourceUrl: deps.sourceUrl,
    frames,
    wheelPoint,
    deltaY,
    settleMs,
    maxFrames,
    stoppedReason,
  });

  deps.onProgress({
    phase: deps.isCancelled() ? "stopped" : "done",
    frameIndex: frames.length,
    maxFrames,
    message: `Auto Scan xong · status=${container.status} · frames=${frames.length}`,
  });

  return { runId, frames, container };
}
