import {
  detectPostDetailContainer,
  inferAnchorTypeFromLabel,
  selectPrimaryActionRow,
  shouldStopForActionRow,
  updateBestActionRow,
  viewportWheelPoint,
} from "../../shared/post-detail-collector/auto-scan";
import { clusterActionRows } from "../../shared/post-detail-collector/action-row";
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
  /** Lightweight per-frame UI update (avoid pushing full history every frame). */
  onFrame: (frame: PostDetailScanFrame, frames: PostDetailScanFrame[]) => void;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

type MatchBundle = {
  anchors: PostDetailVisualAnchor[];
  candidates: PostDetailVisualAnchor[];
  logs: PostDetailFrameDiagnostics["matchLogs"];
  matchMs: number;
};

type PreparedRef = {
  sample: VisualReferenceSample;
  type: PostDetailAnchorType;
  canvas: HTMLCanvasElement;
};

async function prepareRefs(refs: VisualReferenceSample[]): Promise<PreparedRef[]> {
  const out: PreparedRef[] = [];
  for (const sample of refs) {
    if (!sample.dataUrl) continue;
    const type = inferAnchorTypeFromLabel(sample.label);
    if (!type) continue;
    const canvas = await imageToCanvas(sample.dataUrl);
    if (canvas.width < 4 || canvas.height < 4) continue;
    out.push({ sample, type, canvas });
  }
  return out;
}

/** One TemplateMatcher pass per template — diagnostics use `best` when below threshold. */
async function matchFrameAnchors(
  target: HTMLCanvasElement,
  frameId: string,
  frameIndex: number,
  refs: PreparedRef[],
  threshold: number,
): Promise<MatchBundle> {
  const logs: PostDetailFrameDiagnostics["matchLogs"] = [];
  const candidates: PostDetailVisualAnchor[] = [];
  const bestByType = new Map<PostDetailAnchorType, PostDetailVisualAnchor>();
  let matchMs = 0;

  for (const { sample, type, canvas: tpl } of refs) {
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
    matchMs += result.timeMs;

    if (!result.matches.length) {
      const soft = result.best;
      logs.push({
        type,
        templateId: sample.sampleId,
        score: soft?.score ?? 0,
        threshold,
        bbox: soft
          ? { x: soft.x, y: soft.y, width: tpl.width, height: tpl.height }
          : null,
        accepted: false,
        rejectionReason: soft
          ? `Best ${soft.score.toFixed(3)} < threshold ${threshold} (single-pass)`
          : `No candidate ≥ threshold ${threshold}`,
        candidateRank: -1,
      });
      continue;
    }

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

  return { anchors: [...bestByType.values()], candidates, logs, matchMs };
}

function columnLumaFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float64Array {
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

function isFocusWheelBlock(outcome: string | undefined): boolean {
  return outcome === "WHEEL_BLOCKED" || outcome === "WHEEL_BLOCKED_FOCUS";
}

function isWheelDispatched(outcome: string | undefined): boolean {
  return outcome === "WHEEL_SENT" || outcome === "WHEEL_SENT_UNFOCUSED";
}

/**
 * Auto Scan: Frame 1: capture before any wheel, then
 * wheel → adaptive settle → capture → visual confirm → match.
 */
export async function runPostDetailAutoScan(deps: AutoScanDeps): Promise<{
  runId: string;
  frames: PostDetailScanFrame[];
  container: PostDetailContainerResult;
}> {
  const maxFrames = Math.max(1, Math.min(30, deps.maxFrames ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.maxFrames));
  const deltaY = deps.deltaY ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.deltaY;
  const settleCap = deps.settleMs ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.settleMs;
  const settleInitial = Math.min(settleCap, POST_DETAIL_AUTO_SCAN_DEFAULTS.settleMsInitial);
  const settleRetry = Math.min(
    settleCap - settleInitial,
    POST_DETAIL_AUTO_SCAN_DEFAULTS.settleMsRetry,
  );
  const matchThreshold = deps.matchThreshold ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.matchThreshold;
  const motionThreshold = deps.motionThreshold ?? POST_DETAIL_AUTO_SCAN_DEFAULTS.motionThreshold;
  const maxStale = POST_DETAIL_AUTO_SCAN_DEFAULTS.maxStaleWheels;
  const maxFocusRetries = POST_DETAIL_AUTO_SCAN_DEFAULTS.maxFocusWheelRetries;
  const runId = createPostDetailRunId();
  const frames: PostDetailScanFrame[] = [];
  const horizontalProfiles: Array<{ frameId: string; columns: Float64Array }> = [];
  let requestedScrollPx = 0;
  let observedScrollPx = 0;
  let wheelPoint = viewportWheelPoint({ width: WEB_WIDTH, height: WEB_HEIGHT });
  let stoppedReason = "completed";
  let staleWheels = 0;
  let prevRgba: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  let bestActionRow: ReturnType<typeof updateBestActionRow> = null;

  if (!deps.visualReferences.length) {
    throw new Error("AUTO_SCAN_NO_REFERENCES: Cần ≥1 visual reference từ Step 1.");
  }

  const preparedRefs = await prepareRefs(deps.visualReferences);
  if (!preparedRefs.length) {
    throw new Error("AUTO_SCAN_NO_REFERENCES: Không load được template Like/Comment/Share.");
  }

  deps.onProgress({
    phase: "running",
    frameIndex: 0,
    maxFrames,
    message: `Bắt đầu Auto Scan · Δy=${deltaY} · refs=${preparedRefs.length} · settle≤${settleCap}ms`,
  });
  await collectorSetBrowserVisible(deps.invoke, true);

  for (let i = 1; i <= maxFrames; i++) {
    const frameT0 = performance.now();
    const timings: NonNullable<PostDetailFrameDiagnostics["timingsMs"]> = {};

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

    if (i > 1) {
      screenshotBeforeRef = frames[frames.length - 1]?.frameId;
      deps.onProgress({
        phase: "running",
        frameIndex: i - 1,
        maxFrames,
        message: `Wheel Δy=${deltaY} tại tâm viewport…`,
      });

      let wheelOk = false;
      for (let attempt = 0; attempt <= maxFocusRetries; attempt++) {
        const tw0 = performance.now();
        const wheel = await collectorPostDetailWheel(deps.invoke, deltaY);
        timings.wheelIpc = (timings.wheelIpc || 0) + (performance.now() - tw0);
        wheelPoint = wheel.wheelPoint;
        wheelOutcome = wheel.outcome as PostDetailFrameDiagnostics["wheelOutcome"];
        wheelReason = [
          wheel.reason,
          wheel.focusAttempts != null ? `focusAttempts=${wheel.focusAttempts}` : null,
          attempt > 0 ? `retry=${attempt}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        if (isWheelDispatched(wheel.outcome)) {
          wheelOk = true;
          break;
        }
        // Visibility / focus flaps mid-scan are recoverable — do not abort on first failure.
        if (
          (wheel.outcome === "WHEEL_BLOCKED_NOT_VISIBLE" || isFocusWheelBlock(wheel.outcome)) &&
          attempt < maxFocusRetries
        ) {
          await collectorSetBrowserVisible(deps.invoke, true);
          await sleep(100);
          continue;
        }
        break;
      }

      requestedScrollPx += Math.abs(deltaY);

      if (!wheelOk) {
        stoppedReason = String(wheelOutcome || "WHEEL_BLOCKED");
        deps.onProgress({
          phase: "error",
          frameIndex: i - 1,
          maxFrames,
          message: `Wheel failed: ${wheelReason || wheelOutcome}`,
        });
        break;
      }

      // Adaptive settle: short wait, then motion check after capture; optional extra wait if still.
      const ts0 = performance.now();
      await sleep(settleInitial);
      timings.settle = performance.now() - ts0;
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

    const frameId = createPostDetailFrameId(i);

    async function captureDecode() {
      const tsShot = performance.now();
      const shot = await collectorCaptureKeepVisible(deps.invoke);
      const shotMs = performance.now() - tsShot;
      const td0 = performance.now();
      const canvas = await imageToCanvas(shot.dataUrl);
      const c = canvas.getContext("2d", { willReadFrequently: true });
      if (!c) throw new Error("Canvas context unavailable for scroll motion.");
      const img = c.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = { data: img.data, width: canvas.width, height: canvas.height };
      return { shot, canvas, rgba: decoded, shotMs, decodeMs: performance.now() - td0 };
    }

    let captured = await captureDecode();
    timings.screenshot = captured.shotMs;
    timings.decode = captured.decodeMs;

    if (i > 1 && prevRgba) {
      const roi = defaultScrollCompareRoi(captured.shot.width, captured.shot.height);
      let motion = measureVisualMotionScore(prevRgba, captured.rgba, roi);
      visualMotionScore = motion.score;
      scrollConfirmed = isVisualScrollConfirmed(motion.score, motionThreshold);

      // If wheel was sent but content not yet painted, wait once more and re-capture.
      if (!scrollConfirmed && settleRetry > 0) {
        const ts1 = performance.now();
        await sleep(settleRetry);
        timings.settle = (timings.settle || 0) + (performance.now() - ts1);
        captured = await captureDecode();
        timings.screenshot = (timings.screenshot || 0) + captured.shotMs;
        timings.decode = (timings.decode || 0) + captured.decodeMs;
        motion = measureVisualMotionScore(prevRgba, captured.rgba, roi);
        visualMotionScore = motion.score;
        scrollConfirmed = isVisualScrollConfirmed(motion.score, motionThreshold);
      }

      scrollConfirmLabel = scrollConfirmed ? "VISUAL_SCROLL_CONFIRMED" : "SCROLL_NOT_MOVING";
      if (scrollConfirmed) {
        observedScrollPx += Math.abs(deltaY);
        staleWheels = 0;
      } else {
        staleWheels += 1;
      }
    }

    const image = captured.shot;
    const rgba = captured.rgba;
    prevRgba = { data: new Uint8ClampedArray(rgba.data), width: rgba.width, height: rgba.height };

    const tm0 = performance.now();
    const { anchors, candidates, logs, matchMs } = await matchFrameAnchors(
      captured.canvas,
      frameId,
      i,
      preparedRefs,
      matchThreshold,
    );
    timings.match = matchMs || performance.now() - tm0;

    const clusters = clusterActionRows(anchors, candidates);
    const primaryRow = selectPrimaryActionRow(anchors, candidates, {
      frameHeight: image.height,
      observedScrollPx,
    });
    const topCluster = clusters[0] || null;
    const containerCandidate = topCluster?.bbox ?? (primaryRow
      ? {
          x: Math.round(Math.min(...primaryRow.map((a) => a.bbox.x)) - 8),
          y: Math.round(Math.min(...primaryRow.map((a) => a.bbox.y)) - 8),
          width: Math.round(
            Math.max(...primaryRow.map((a) => a.bbox.x + a.bbox.width)) -
              Math.min(...primaryRow.map((a) => a.bbox.x)) +
              16,
          ),
          height: Math.round(Math.max(...primaryRow.map((a) => a.bbox.height)) + 16),
        }
      : null);

    const tc0 = performance.now();
    const columns = columnLumaFromRgba(rgba.data, rgba.width, rgba.height);
    timings.columnProfile = performance.now() - tc0;
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
      timingsMs: timings,
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
        `clusters=${clusters.length}`,
        topCluster
          ? `row=${topCluster.types.join("+")}:${topCluster.meanScore.toFixed(3)}:${topCluster.strength}`
          : "row=none",
        `t_match=${Math.round(timings.match || 0)}ms`,
      ],
    };
    frames.push(frame);
    bestActionRow = updateBestActionRow(bestActionRow, frame);
    const tf0 = performance.now();
    deps.onFrame(frame, frames);
    timings.onFrame = performance.now() - tf0;
    timings.total = performance.now() - frameT0;
    diagnostics.timingsMs = timings;

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

    if (bestActionRow && shouldStopForActionRow(bestActionRow.cluster)) {
      stoppedReason = "MAIN_ACTION_ROW_CANDIDATE";
      diagnostics.stopOrRejectReason = `MAIN_ACTION_ROW_CANDIDATE on frame ${bestActionRow.frameId} types=${bestActionRow.cluster.types.join(",")} score=${bestActionRow.cluster.meanScore}`;
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
      settleMs: settleCap,
      maxFrames,
      stoppedReason: "early-found",
      requestedScrollPx,
      observedScrollPx,
      horizontalProfiles,
    });
    if (preview.status === "FOUND") {
      stoppedReason = "found-container";
      break;
    }
    if (preview.mainActionRow?.status === "MAIN_ACTION_ROW_CANDIDATE") {
      stoppedReason = "MAIN_ACTION_ROW_CANDIDATE";
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
    settleMs: settleCap,
    maxFrames,
    stoppedReason,
    requestedScrollPx,
    observedScrollPx,
    horizontalProfiles,
  });

  deps.onProgress({
    phase: deps.isCancelled()
      ? "stopped"
      : stoppedReason === "SCROLL_NOT_MOVING" || String(stoppedReason).startsWith("WHEEL_BLOCKED")
        ? "stopped"
        : "done",
    frameIndex: frames.length,
    maxFrames,
    message: `Auto Scan xong · status=${container.status} · frames=${frames.length} · requested=${requestedScrollPx} · observed=${observedScrollPx} · stop=${stoppedReason}`,
  });

  await collectorSetBrowserVisible(deps.invoke, true);

  return { runId, frames, container };
}
