import {
  detectPostDetailContainer,
  inferAnchorTypeFromLabel,
  selectPrimaryActionRow,
  viewportWheelPoint,
} from "../../shared/post-detail-collector/auto-scan";
import { createPostDetailFrameId, createPostDetailRunId } from "../../shared/post-detail-collector/match-status";
import {
  defaultScrollCompareRoi,
  isVisualScrollConfirmed,
  measureVisualMotionScore,
} from "../../shared/post-detail-collector/scroll-motion";
import {
  POST_DETAIL_AUTO_SCAN_DEFAULTS,
  type PostDetailAnchorType,
  type PostDetailContainerResult,
  type PostDetailFrameDiagnostics,
  type PostDetailScanFrame,
  type PostDetailVisualAnchor,
  type VisualReferenceSample,
} from "../../shared/post-detail-collector/types";
import { WEB_HEIGHT, WEB_WIDTH } from "../../shared/geometry";
import {
  collectorCaptureKeepVisible,
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
  motionThreshold?: number;
  isCancelled: () => boolean;
  onProgress: (p: AutoScanProgress) => void;
  onFrame: (frame: PostDetailScanFrame, frames: PostDetailScanFrame[]) => void;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

type MatchBundle = {
  anchors: PostDetailVisualAnchor[];
  candidates: PostDetailVisualAnchor[];
  logs: PostDetailFrameDiagnostics["matchLogs"];
};

async function matchFrameAnchors(
  image: { dataUrl: string; width: number; height: number },
  frameId: string,
  frameIndex: number,
  refs: VisualReferenceSample[],
  threshold: number,
): Promise<MatchBundle> {
  const target = await imageToCanvas(image.dataUrl);
  const logs: PostDetailFrameDiagnostics["matchLogs"] = [];
  const candidates: PostDetailVisualAnchor[] = [];
  const bestByType = new Map<PostDetailAnchorType, PostDetailVisualAnchor>();

  for (const sample of refs) {
    if (!sample.dataUrl) {
      continue;
    }
    const type = inferAnchorTypeFromLabel(sample.label);
    if (!type) {
      logs.push({
        type: "LIKE",
        templateId: sample.sampleId,
        score: 0,
        threshold,
        bbox: null,
        accepted: false,
        rejectionReason: `Label "${sample.label}" is not LIKE/COMMENT/SHARE`,
        candidateRank: -1,
      });
      continue;
    }
    const tpl = await imageToCanvas(sample.dataUrl);
    if (tpl.width < 4 || tpl.height < 4) {
      logs.push({
        type,
        templateId: sample.sampleId,
        score: 0,
        threshold,
        bbox: null,
        accepted: false,
        rejectionReason: `Template too small ${tpl.width}×${tpl.height}`,
        candidateRank: -1,
      });
      continue;
    }
    if (tpl.width > target.width || tpl.height > target.height) {
      logs.push({
        type,
        templateId: sample.sampleId,
        score: 0,
        threshold,
        bbox: null,
        accepted: false,
        rejectionReason: `Template ${tpl.width}×${tpl.height} larger than frame ${target.width}×${target.height}`,
        candidateRank: -1,
      });
      continue;
    }

    const result = await TemplateMatcher.match(tpl, target, "grayscale", threshold);
    if (!result.matches.length) {
      logs.push({
        type,
        templateId: sample.sampleId,
        score: 0,
        threshold,
        bbox: null,
        accepted: false,
        rejectionReason: `No candidate ≥ threshold ${threshold}`,
        candidateRank: -1,
      });
      continue;
    }

    // Keep top candidates (not only best) for main vs comment action-row disambiguation.
    result.matches.slice(0, 5).forEach((m, rank) => {
      const entry: PostDetailVisualAnchor = {
        type,
        frameId,
        frameIndex,
        bbox: m.bbox,
        score: m.score,
        templateId: sample.sampleId,
        candidateRank: rank,
        rejectionReason: null,
      };
      candidates.push(entry);
      logs.push({
        type,
        templateId: sample.sampleId,
        score: m.score,
        threshold,
        bbox: m.bbox,
        accepted: rank === 0,
        rejectionReason: rank === 0 ? null : "Secondary candidate retained for row disambiguation",
        candidateRank: rank,
      });
      if (rank === 0) {
        const prev = bestByType.get(type);
        if (!prev || entry.score > prev.score) bestByType.set(type, entry);
      }
    });
  }

  return { anchors: [...bestByType.values()], candidates, logs };
}

async function rgbaFromDataUrl(dataUrl: string): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const canvas = await imageToCanvas(dataUrl);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas context unavailable for scroll motion.");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: canvas.width, height: canvas.height };
}

/** Column mean luma for horizontal card-edge inference. */
async function columnLumaProfile(dataUrl: string): Promise<Float64Array> {
  const { data, width, height } = await rgbaFromDataUrl(dataUrl);
  const cols = new Float64Array(width);
  const y0 = Math.round(height * 0.15);
  const y1 = Math.round(height * 0.75);
  const rows = Math.max(1, y1 - y0);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    }
    cols[x] = sum / rows;
  }
  return cols;
}

/**
 * Auto Scan: capture frame 1 first (before any wheel), then
 * wheel → settle → capture → visual confirm → match.
 * Does not navigate; uses current BrowserCore page.
 * Observed scroll increments only on VISUAL_SCROLL_CONFIRMED.
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
  const motionThreshold = deps.motionThreshold ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.motionThreshold;
  const maxStale = POST_DETAIL_AUTO_SCAN_DEFAULTS.maxStaleWheels;
  const runId = createPostDetailRunId();
  const frames: PostDetailScanFrame[] = [];
  const horizontalProfiles: Array<{ frameId: string; columns: Float64Array }> = [];
  let requestedScrollPx = 0;
  let observedScrollPx = 0;
  let wheelPoint = viewportWheelPoint({ width: WEB_WIDTH, height: WEB_HEIGHT });
  let stoppedReason = "completed";
  let staleWheels = 0;
  let prevRgba: { data: Uint8ClampedArray; width: number; height: number } | null = null;

  if (!deps.visualReferences.length) {
    throw new Error("AUTO_SCAN_NO_REFERENCES: Cần ≥1 visual reference từ Step 1.");
  }

  deps.onProgress({
    phase: "running",
    frameIndex: 0,
    maxFrames,
    message: `Bắt đầu Auto Scan · Δy=${deltaY} (signed wheel) · refs=${deps.visualReferences.length}`,
  });
  await collectorSetBrowserVisible(deps.invoke, true);

  for (let i = 1; i <= maxFrames; i++) {
    if (deps.isCancelled()) {
      stoppedReason = "cancelled";
      deps.onProgress({ phase: "stopped", frameIndex: i - 1, maxFrames, message: "Đã Stop Auto Scan." });
      break;
    }

    let wheelOutcome: PostDetailFrameDiagnostics["wheelOutcome"] = i === 1 ? "NONE" : "WHEEL_SKIPPED";
    let wheelReason: string | undefined;
    let visualMotionScore: number | null = null;
    let scrollConfirmed: boolean | null = i === 1 ? null : false;
    let scrollConfirmLabel: PostDetailFrameDiagnostics["scrollConfirmLabel"] = i === 1 ? "N/A" : "PENDING";
    let screenshotBeforeRef: string | undefined;
    const requestedThisWheel = i > 1 ? deltaY : null;

    // Frame 1: capture before any wheel. Later frames: wheel then settle then capture.
    if (i > 1) {
      screenshotBeforeRef = frames[frames.length - 1]?.frameId;
      deps.onProgress({
        phase: "running",
        frameIndex: i - 1,
        maxFrames,
        message: `Wheel Δy=${deltaY} tại tâm viewport (mouseMove+wheel)…`,
      });
      const wheel = await collectorPostDetailWheel(deps.invoke, deltaY);
      wheelPoint = wheel.wheelPoint;
      wheelOutcome = wheel.outcome;
      wheelReason = wheel.reason;
      requestedScrollPx += Math.abs(deltaY);

      if (!wheel.ok || wheel.outcome !== "WHEEL_SENT") {
        stoppedReason = "WHEEL_BLOCKED";
        deps.onProgress({
          phase: "error",
          frameIndex: i - 1,
          maxFrames,
          message: `Wheel blocked: ${wheel.reason || wheel.outcome}`,
        });
        break;
      }

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

    // Keep BrowserCore visible during Auto Scan so subsequent wheels keep focus.
    const image = await collectorCaptureKeepVisible(deps.invoke);
    const frameId = createPostDetailFrameId(i);
    const rgba = await rgbaFromDataUrl(image.dataUrl);

    if (i > 1 && prevRgba) {
      const roi = defaultScrollCompareRoi(image.width, image.height);
      const motion = measureVisualMotionScore(prevRgba, rgba, roi);
      visualMotionScore = motion.score;
      scrollConfirmed = isVisualScrollConfirmed(motion.score, motionThreshold);
      scrollConfirmLabel = scrollConfirmed ? "VISUAL_SCROLL_CONFIRMED" : "SCROLL_NOT_MOVING";
      if (scrollConfirmed) {
        observedScrollPx += Math.abs(deltaY);
        staleWheels = 0;
      } else {
        staleWheels += 1;
      }
    }

    prevRgba = rgba;

    const { anchors, candidates, logs } = await matchFrameAnchors(
      image,
      frameId,
      i,
      deps.visualReferences,
      matchThreshold,
    );
    const primaryRow = selectPrimaryActionRow(anchors, candidates);
    const containerCandidate = primaryRow
      ? {
          x: Math.round(Math.min(...primaryRow.map((a) => a.bbox.x)) - 8),
          y: Math.max(0, Math.round(Math.min(...primaryRow.map((a) => a.bbox.y)) - image.height * 0.4)),
          width: Math.round(
            Math.max(...primaryRow.map((a) => a.bbox.x + a.bbox.width)) -
              Math.min(...primaryRow.map((a) => a.bbox.x)) +
              16,
          ),
          height: Math.round(image.height * 0.45),
        }
      : null;

    const columns = await columnLumaProfile(image.dataUrl);
    horizontalProfiles.push({ frameId, columns });

    const diagnostics: PostDetailFrameDiagnostics = {
      frameIndex: i,
      wheelTarget: i > 1 ? wheelPoint : null,
      requestedDeltaY: requestedThisWheel,
      wheelOutcome,
      wheelReason,
      screenshotBeforeRef,
      screenshotAfterRef: frameId,
      visualMotionScore,
      scrollConfirmed,
      scrollConfirmLabel,
      observedScrollPx,
      matchLogs: logs,
      containerCandidate,
      stopOrRejectReason: undefined,
    };

    const frame: PostDetailScanFrame = {
      frameId,
      frameIndex: i,
      scrollDeltaApplied: requestedScrollPx,
      observedScrollPx,
      screenshotDataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
      anchors,
      anchorCandidates: candidates,
      diagnostics,
      notes: [
        TemplateMatcher.isOpenCvReady() ? "OpenCV matcher" : "NCC fallback",
        `capture=${image.width}×${image.height}`,
        `scrollConfirm=${scrollConfirmLabel}`,
        `motion=${visualMotionScore ?? "n/a"}`,
        `anchors=${anchors.map((a) => `${a.type}:${a.score.toFixed(3)}`).join(",") || "none"}`,
        `candidates=${candidates.length}`,
      ],
    };
    frames.push(frame);
    deps.onFrame(frame, [...frames]);

    if (i > 1 && staleWheels >= maxStale) {
      stoppedReason = "SCROLL_NOT_MOVING";
      diagnostics.stopOrRejectReason = `SCROLL_NOT_MOVING after ${staleWheels} consecutive wheels without content-band change (threshold=${motionThreshold}).`;
      deps.onProgress({
        phase: "stopped",
        frameIndex: i,
        maxFrames,
        message: diagnostics.stopOrRejectReason,
      });
      break;
    }

    const preview = detectPostDetailContainer({
      runId,
      sourceUrl: deps.sourceUrl,
      frames,
      wheelPoint,
      deltaY,
      settleMs,
      maxFrames,
      stoppedReason: "early-found",
      requestedScrollPx,
      observedScrollPx,
      horizontalProfiles,
    });
    if (preview.status === "FOUND" && i >= 2 && observedScrollPx > 0) {
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
    requestedScrollPx,
    observedScrollPx,
    horizontalProfiles,
  });

  deps.onProgress({
    phase: deps.isCancelled() ? "stopped" : stoppedReason === "SCROLL_NOT_MOVING" ? "stopped" : "done",
    frameIndex: frames.length,
    maxFrames,
    message: `Auto Scan xong · status=${container.status} · frames=${frames.length} · requested=${requestedScrollPx} · observed=${observedScrollPx} · stop=${stoppedReason}`,
  });

  await collectorSetBrowserVisible(deps.invoke, true);

  return { runId, frames, container };
}
