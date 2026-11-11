import React, { useEffect, useState } from "react";
import type { Command, SavedRunSummaryItem } from "../../../shared/contracts";
import { TemplateMatcher } from "../../../../experiments/visual-match-lab/src/cv/template-matcher";
import { runRecognitionPipeline } from "../../../../experiments/visual-match-lab/src/cv/recognition-pipeline";
import type { FixtureItem } from "../../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { MatchCandidate, MatchMethod, RecognizedGroup, Rect } from "../../../../experiments/visual-match-lab/src/types";
import type { LiveCapture } from "./types";
import { LiveTemplateCalibration, loadLiveTemplates, type LiveIconTemplates } from "./LiveTemplateCalibration";
import type { BoundaryProbeResult, BoundaryStatus, BoundaryDebugRecord, BoundaryDebugReport } from "../../../shared/boundary-probe";
import {
  BUILTIN_PERMALINK_RULES,
  type UserPermalinkRule,
} from "../../../shared/permalink-rules";
import { FrameInspector } from "./FrameInspector";
import { RunSummary } from "./RunSummary";

type Invoke = <T>(command: Command) => Promise<T>;
export type CandidateStatus = "NEW_ITEM" | "DUPLICATE" | "NEEDS_ATTENTION" | "COMMENT_ACTION";
export type LiveCandidate = {
  bbox: Rect;
  score: number;
  iconCount: number;
  status: CandidateStatus;
  context: string;
  fingerprint: string;
  docY: number;
  boundary?: BoundaryProbeResult;
  highlightedEvidenceUrl?: string;
};
export type FrameReport = {
  frame: number;
  capture: LiveCapture;
  captureStatus: "CAPTURE_PASS";
  pipelineStatus: string;
  templateStatus: string;
  detectionStatus: "DETECTION_PASS" | "DETECTION_FAIL" | "DETECTION_BLOCKED";
  boundaryStatus: "BOUNDARY_FOUND" | "BOUNDARY_AMBIGUOUS" | "BOUNDARY_NOT_FOUND" | "NO_ACTION_ROW";
  rawIconMatches: number;
  actionClusters: number;
  candidates: LiveCandidate[];
};
// v2: v1 caches could hold synthetic audit bboxes paired with unrelated screenshots.
const LIVE_FRAMES_KEY = "visual_match_lab_live_frames_v2";
const LIVE_RUN_ID_KEY = "visual_match_lab_live_run_id_v2";
const LIVE_RULES_KEY = "visual_match_lab_permalink_rules_v1";

function loadSavedRules(): UserPermalinkRule[] {
  try {
    const raw = localStorage.getItem(LIVE_RULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return BUILTIN_PERMALINK_RULES;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const imageCanvas = async (dataUrl: string, width?: number, height?: number) => {
  const image = new Image(); image.src = dataUrl;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED")); });
  const canvas = document.createElement("canvas"); canvas.width = width ?? image.width; canvas.height = height ?? image.height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas;
};
const union = (boxes: Rect[]): Rect => { const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y)); const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height)); return { x, y, width: right - x, height: bottom - y }; };
const fingerprint = (canvas: HTMLCanvasElement, bbox: Rect) => {
  const source = document.createElement("canvas"); source.width = 9; source.height = 8;
  const x = Math.max(0, bbox.x - 60), y = Math.max(0, bbox.y - 140), right = Math.min(canvas.width, bbox.x + bbox.width + 60), bottom = Math.min(canvas.height, bbox.y + bbox.height + 20);
  source.getContext("2d")!.drawImage(canvas, x, y, Math.max(1, right - x), Math.max(1, bottom - y), 0, 0, 9, 8);
  const pixels = source.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, 9, 8).data; let bits = "";
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) { const at = (row * 9 + col) * 4, next = at + 4; const a = pixels[at] + pixels[at + 1] + pixels[at + 2], b = pixels[next] + pixels[next + 1] + pixels[next + 2]; bits += a > b ? "1" : "0"; }
  return bits;
};
const distance = (a: string, b: string) => [...a].reduce((sum, bit, index) => sum + Number(bit !== b[index]), 0);

export const classifyLiveCandidate = (
  context: string,
  iconCount: number,
  docY: number,
  hash: string,
  seen: LiveCandidate[],
  boundaryStatus?: BoundaryStatus,
): CandidateStatus => {
  if (context === "comment") return "COMMENT_ACTION";
  if (seen.some(item => Math.abs(item.docY - docY) <= 70 && distance(item.fingerprint, hash) <= 18)) return "DUPLICATE";
  if (boundaryStatus !== undefined) {
    return boundaryStatus === "BOUNDARY_FOUND" && iconCount >= 2 ? "NEW_ITEM" : "NEEDS_ATTENTION";
  }
  return context === "post" && iconCount === 3 ? "NEW_ITEM" : "NEEDS_ATTENTION";
};

async function detectActionRows(target: HTMLCanvasElement, templates: HTMLCanvasElement[], method: MatchMethod, threshold: number, searchRects: Rect[]) {
  const typed: Array<MatchCandidate & { icon: number }> = [];
  for (let icon = 0; icon < templates.length; icon++) {
    for (const rect of searchRects) {
      const padding = 6, x = Math.max(0, rect.x - padding), y = Math.max(0, rect.y - padding), right = Math.min(target.width, rect.x + rect.width + padding), bottom = Math.min(target.height, rect.y + rect.height + padding);
      if (right - x < templates[icon].width || bottom - y < templates[icon].height) continue;
      const roi = document.createElement("canvas"); roi.width = right - x; roi.height = bottom - y; roi.getContext("2d")!.drawImage(target, x, y, roi.width, roi.height, 0, 0, roi.width, roi.height);
      const result = await TemplateMatcher.match(templates[icon], roi, method, threshold);
      typed.push(...result.matches.map(match => ({ ...match, id: `${match.id}_${icon}_${x}_${y}`, bbox: { ...match.bbox, x: match.bbox.x + x, y: match.bbox.y + y }, icon })));
    }
  }
  const rows: Array<Array<MatchCandidate & { icon: number }>> = [];
  for (const match of typed.sort((a, b) => a.bbox.y - b.bbox.y)) {
    const cy = match.bbox.y + match.bbox.height / 2;
    const row = rows.find(items => Math.abs(cy - items.reduce((sum, item) => sum + item.bbox.y + item.bbox.height / 2, 0) / items.length) <= Math.max(18, match.bbox.height));
    if (row) row.push(match); else rows.push([match]);
  }
  const grouped = rows.map(items => {
    const best = [...new Map(items.sort((a, b) => b.score - a.score).map(item => [item.icon, item])).values()].sort((a, b) => a.bbox.x - b.bbox.x);
    return { items: best, bbox: union(best.map(item => item.bbox)), score: best.reduce((sum, item) => sum + item.score, 0) / best.length };
  }).filter(row => row.items.length >= 2);
  return { rawIconMatches: typed.length, rows: grouped };
}

export function LiveScrollTest({ invoke, currentFixture, actionGroups, method, threshold }: { invoke: Invoke; currentFixture: FixtureItem | null; actionGroups: RecognizedGroup[]; method: MatchMethod; threshold: number }) {
  const [frames, setFrames] = useState<FrameReport[]>(() => { try { return JSON.parse(localStorage.getItem(LIVE_FRAMES_KEY) ?? "[]"); } catch { return []; } });
  const [templates, setTemplates] = useState<LiveIconTemplates>(() => loadLiveTemplates());
  const [rules, setRules] = useState<UserPermalinkRule[]>(() => loadSavedRules());
  const [captureFailures, setCaptureFailures] = useState(0);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready — no public Facebook action is performed.");
  const [debugArtifactPath, setDebugArtifactPath] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string>(() => localStorage.getItem(LIVE_RUN_ID_KEY) || "live_session");
  const [savedRuns, setSavedRuns] = useState<SavedRunSummaryItem[]>([]);
  const [loadingRun, setLoadingRun] = useState(false);

  const fetchSavedRuns = async () => {
    try {
      const runs = await invoke<SavedRunSummaryItem[]>({ type: "visualMatchLabListRuns" });
      if (Array.isArray(runs)) {
        setSavedRuns(runs);
        const missingEvidenceImages = frames.some(
          f => f.candidates.length > 0 && !f.capture?.dataUrl && !f.candidates[0]?.highlightedEvidenceUrl
        );
        if (
          runs.length > 0 &&
          (frames.length === 0 || currentRunId.startsWith("run_audit_") || missingEvidenceImages)
        ) {
          const targetRunId = runs.some(r => r.runId === currentRunId)
            ? currentRunId
            : runs[0].runId;
          void handleLoadRun(targetRunId);
        }
      }
    } catch (e) {
      console.warn("Failed to list saved runs:", e);
    }
  };

  useEffect(() => {
    void fetchSavedRuns();
  }, []);

  const handleSaveRule = (newRule: UserPermalinkRule) => {
    setRules(prev => {
      const next = [newRule, ...prev.filter(r => r.id !== newRule.id)];
      try { localStorage.setItem(LIVE_RULES_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const handleUpdateCandidateBoundary = (frameNumber: number, candidateIndex: number, newBoundary: BoundaryProbeResult, evidenceUrl?: string) => {
    setFrames(prev => prev.map(f => {
      if (f.frame !== frameNumber) return f;
      const nextCandidates = f.candidates.map((c, idx) => {
        if (idx !== candidateIndex) return c;
        return {
          ...c,
          boundary: newBoundary,
          highlightedEvidenceUrl: evidenceUrl || c.highlightedEvidenceUrl,
          status: classifyLiveCandidate(c.context, c.iconCount, c.docY, c.fingerprint, [], newBoundary.status),
        };
      });
      const frameBoundary: FrameReport["boundaryStatus"] =
        nextCandidates.some(c => c.boundary?.status === "BOUNDARY_FOUND")
          ? "BOUNDARY_FOUND"
          : nextCandidates.some(c => c.boundary?.status === "BOUNDARY_AMBIGUOUS")
            ? "BOUNDARY_AMBIGUOUS"
            : "BOUNDARY_NOT_FOUND";
      return {
        ...f,
        candidates: nextCandidates,
        boundaryStatus: frameBoundary,
      };
    }));
  };

  const handleLoadRun = async (runId: string) => {
    setLoadingRun(true);
    try {
      const res = await invoke<{ ok: boolean; report: BoundaryDebugReport; runId: string }>({
        type: "visualMatchLabLoadRun",
        runId,
      });
      if (res.ok && res.report) {
        const loadedReports: FrameReport[] = [];
        const recordsByFrame = new Map<number, BoundaryDebugRecord[]>();
        for (const r of res.report.records) {
          const list = recordsByFrame.get(r.frameNumber) || [];
          list.push(r);
          recordsByFrame.set(r.frameNumber, list);
        }

        const sortedFrames = Array.from(recordsByFrame.keys()).sort((a, b) => a - b);
        for (const frameNum of sortedFrames) {
          const frameRecs = recordsByFrame.get(frameNum) || [];
          const firstRec = frameRecs[0];
          const candidates: LiveCandidate[] = frameRecs.map(r => ({
            bbox: r.actionRowBbox,
            score: r.matchingScore,
            iconCount: 3,
            status: r.boundaryStatus === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION",
            context: `Loaded run (${r.boundaryStatus})`,
            fingerprint: "",
            docY: r.scrollY + r.actionRowBbox.y,
            boundary: {
              status: r.boundaryStatus,
              ancestorsChecked: r.ancestorDepth,
              ancestorSteps: r.ancestors.map(a => ({
                level: a.level,
                tag: a.tag,
                role: a.role,
                id: a.id,
                className: a.className,
                rect: a.rect,
                rawUrls: a.rawUrls,
                postIdentities: a.postIdentities,
                uniqueKeys: a.uniqueKeys,
                hasNestedArticle: false,
                hasQuoteOrReplyHint: false,
              })),
              firstPermalinkLevel: r.transitions.firstPermalinkLevel,
              secondPermalinkLevel: r.transitions.secondPermalinkLevel,
              boundaryCrossedLevel: r.transitions.boundaryCrossedLevel,
              jumpedZeroToTwoPlus: r.transitions.jumpedZeroToTwoPlus,
              jumpReason: r.transitions.jumpReason ?? null,
              candidateContainer: r.candidateContainer ?? null,
              crossedContainer: r.crossedContainer ?? null,
              postIdentities: r.ancestors.flatMap(a => a.postIdentities),
              hasQuoteOrSharedPostRisk: false,
              riskReason: r.riskReason ?? null,
              actionPoint: r.hitPoint,
              hitElement: r.hitElement,
              ownershipEvidence: r.ownershipEvidence,
            },
            highlightedEvidenceUrl: r.evidenceScreenshotBase64,
          }));

          const frameBoundary: FrameReport["boundaryStatus"] = frameRecs.length === 0
            ? "NO_ACTION_ROW"
            : frameRecs.some(r => r.boundaryStatus === "BOUNDARY_FOUND")
              ? "BOUNDARY_FOUND"
              : frameRecs.some(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS")
                ? "BOUNDARY_AMBIGUOUS"
                : "BOUNDARY_NOT_FOUND";

          loadedReports.push({
            frame: frameNum,
            capture: {
              id: `capture_${frameNum}_${runId}`,
              webContentsId: firstRec?.browserWebContentsId ?? 1,
              width: 1024,
              height: 560,
              dataUrl: firstRec?.evidenceScreenshotBase64 ?? "",
              url: "https://www.facebook.com",
              viewport: {
                width: 1024,
                height: 560,
                scrollX: 0,
                scrollY: firstRec?.scrollY ?? 0,
                dpr: 1,
                url: "https://www.facebook.com",
              },
            },
            captureStatus: "CAPTURE_PASS",
            pipelineStatus: `PIPELINE_PASS: Loaded evidence from run ${runId}`,
            templateStatus: "TEMPLATE_READY: saved evidence",
            detectionStatus: "DETECTION_PASS",
            boundaryStatus: frameBoundary,
            rawIconMatches: frameRecs.length * 3,
            actionClusters: frameRecs.length,
            candidates,
          });
        }

        setFrames(loadedReports);
        setCurrentRunId(runId);
        setStatus(`Loaded run ${runId} with ${loadedReports.length} frames (${res.report.summary.boundaryFoundCount} boundaries found).${runId.startsWith("run_audit_") ? " SYNTHETIC audit run — no screenshots were captured; bboxes are simulated and are not drawn." : ""}`);
      }
    } catch (e) {
      setStatus(`Failed to load run ${runId}: ${String(e)}`);
    } finally {
      setLoadingRun(false);
    }
  };

  useEffect(() => {
    try {
      localStorage.removeItem("visual_match_lab_live_frames_v1");
      localStorage.setItem(LIVE_RUN_ID_KEY, currentRunId);
    } catch {}
    try {
      localStorage.setItem(LIVE_FRAMES_KEY, JSON.stringify(frames));
    } catch {
      // Evidence images can exceed localStorage quota (~5MB); disk-backed loadRun handles reload.
    }
  }, [frames, currentRunId]);

  const run = async () => {
    setRunning(true);
    setFrames([]);
    setCaptureFailures(0);
    setDebugArtifactPath(null);
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setCurrentRunId(runId);
    const debugRecords: BoundaryDebugRecord[] = [];
    const reports: FrameReport[] = [];
    const seen: LiveCandidate[] = [];
    let failedCaptures = 0;

    try {
      const missing = (["like", "comment", "share"] as const).filter(kind => !templates[kind]);
      const templateError = missing.length ? `TEMPLATE_NOT_READY: missing confirmed Facebook ${missing.join(", ")} crop(s). Create them from an evidence frame below.` : null;
      const templateCanvases = templateError ? [] : await Promise.all((["like", "comment", "share"] as const).map(kind => imageCanvas(templates[kind]!.dataUrl, templates[kind]!.width, templates[kind]!.height)));
      let priorScrollY: number | null = null;
      let browserWebContentsId: number | null = null;

      for (let frame = 1; frame <= 50; frame++) {
        let capture: LiveCapture;
        try { capture = await invoke<LiveCapture>({ type: "visualMatchLabCapture" }); }
        catch (error) { failedCaptures++; setCaptureFailures(failedCaptures); throw new Error(`CAPTURE_STOPPED_AT_FRAME_${frame}: ${String(error)}`); }
        if (capture.width !== 1024 || capture.height !== 560 || capture.viewport.width !== 1024 || capture.viewport.height !== 560) {
          throw new Error(`VIEWPORT_MISMATCH: expected 1024×560, got ${capture.width}×${capture.height} / viewport ${capture.viewport.width}×${capture.viewport.height}`);
        }
        browserWebContentsId ??= capture.webContentsId;
        if (capture.webContentsId !== browserWebContentsId) throw new Error("BROWSER_INSTANCE_CHANGED");
        if (priorScrollY !== null && capture.viewport.scrollY === priorScrollY) throw new Error("SCROLL_DID_NOT_MOVE");

        try {
          const fixture: FixtureItem = { id: capture.id, name: `Live frame ${frame}`, description: capture.viewport.url, width: capture.width, height: capture.height, isRealFixture: true, dataUrl: capture.dataUrl };
          const pipeline = await runRecognitionPipeline(fixture);
          const target = await imageCanvas(capture.dataUrl, capture.width, capture.height);
          const pipelineGroups = pipeline.groups.filter(group => group.isActionGroup);
          const detected = templateError ? {
            rawIconMatches: pipeline.candidates.filter(candidate => candidate.type === "icon").length,
            rows: pipelineGroups.map(group => ({ bbox: group.bbox, score: group.confidence, items: group.items.map((item, icon) => ({ id: item.iconCandidate.id, bbox: item.iconCandidate.bbox, score: item.iconCandidate.confidence, method, isBest: false, icon })) })),
          } : await detectActionRows(target, templateCanvases, method, threshold, pipeline.candidates.filter(candidate => candidate.type === "icon").map(candidate => candidate.bbox));

          const candidates: LiveCandidate[] = [];

          for (const row of detected.rows) {
            const targetIcon = row.items[0];
            const iconCenterX = targetIcon
              ? targetIcon.bbox.x + targetIcon.bbox.width / 2
              : row.bbox.x + Math.min(24, row.bbox.width / 2);
            const iconCenterY = targetIcon
              ? targetIcon.bbox.y + targetIcon.bbox.height / 2
              : row.bbox.y + row.bbox.height / 2;

            const point = {
              x: Math.round(iconCenterX * capture.viewport.width / capture.width),
              y: Math.round(iconCenterY * capture.viewport.height / capture.height),
            };
            const actionRowCssBbox = {
              x: Math.round(row.bbox.x * capture.viewport.width / capture.width),
              y: Math.round(row.bbox.y * capture.viewport.height / capture.height),
              width: Math.round(row.bbox.width * capture.viewport.width / capture.width),
              height: Math.round(row.bbox.height * capture.viewport.height / capture.height),
            };

            let boundary: (BoundaryProbeResult & { evidenceDataUrl?: string }) | undefined;
            let context = "unknown";

            try {
              boundary = await invoke<BoundaryProbeResult & { evidenceDataUrl?: string }>({
                type: "visualMatchLabProbeBoundary",
                captureId: capture.id,
                webContentsId: capture.webContentsId,
                point,
                actionRowBbox: actionRowCssBbox,
                options: { highlight: true, captureEvidence: true, customRules: rules },
              });
              if (boundary.candidateContainer?.role === "article" || boundary.status === "BOUNDARY_FOUND") {
                context = "post";
              }
            } catch (probeError) {
              const probeMsg = probeError instanceof Error ? probeError.message : String(probeError);
              console.warn(`Frame ${frame} boundary probe error:`, probeMsg);
              try {
                const inspected = await invoke<{ element: { context?: string } | null }>({
                  type: "visualMatchLabInspect",
                  captureId: capture.id,
                  webContentsId: capture.webContentsId,
                  point,
                });
                context = inspected.element?.context ?? `unknown (${probeMsg})`;
              } catch {
                context = `unknown (${probeMsg})`;
              }
            }

            const hash = fingerprint(target, row.bbox);
            const docY = capture.viewport.scrollY + row.bbox.y;
            const candidateStatus = classifyLiveCandidate(context, row.items.length, docY, hash, seen, boundary?.status);
            const candidate: LiveCandidate = {
              bbox: row.bbox,
              score: row.score,
              iconCount: row.items.length,
              status: candidateStatus,
              context: boundary?.status ? `${context} (${boundary.status})` : context,
              fingerprint: hash,
              docY,
              boundary,
              highlightedEvidenceUrl: boundary?.evidenceDataUrl,
            };
            candidates.push(candidate);
            if (candidateStatus === "NEW_ITEM") seen.push(candidate);

            debugRecords.push({
              runId,
              frameNumber: frame,
              scrollY: capture.viewport.scrollY,
              browserWebContentsId: capture.webContentsId,
              rowIndex: detected.rows.indexOf(row),
              actionRowBbox: actionRowCssBbox,
              matchingScore: row.score,
              hitPoint: point,
              hitElement: boundary?.hitElement,
              ancestorDepth: boundary?.ancestorsChecked ?? 0,
              ancestors: (boundary?.ancestorSteps ?? []).map(a => ({
                level: a.level,
                tag: a.tag,
                role: a.role,
                id: a.id,
                className: a.className,
                rect: a.rect,
                rawUrls: a.rawUrls ?? [],
                postIdentities: a.postIdentities,
                uniqueKeys: a.uniqueKeys,
                uniqueCount: a.uniqueKeys.length,
              })),
              transitions: {
                firstPermalinkLevel: boundary?.firstPermalinkLevel ?? null,
                secondPermalinkLevel: boundary?.secondPermalinkLevel ?? null,
                boundaryCrossedLevel: boundary?.boundaryCrossedLevel ?? null,
                jumpedZeroToTwoPlus: Boolean(boundary?.jumpedZeroToTwoPlus),
                jumpReason: boundary?.jumpReason ?? null,
              },
              candidateContainer: boundary?.candidateContainer ?? null,
              crossedContainer: boundary?.crossedContainer ?? null,
              boundaryStatus: boundary?.status ?? "BOUNDARY_NOT_FOUND",
              riskReason: boundary?.riskReason ?? null,
              ownershipEvidence: boundary?.ownershipEvidence ?? { isArticle: false, hasDistinctCardLayout: false, containsActionRow: false, notes: [] },
              evidenceScreenshotBase64: boundary?.evidenceDataUrl,
            });
          }

          const frameBoundary: FrameReport["boundaryStatus"] = detected.rows.length === 0
            ? "NO_ACTION_ROW"
            : candidates.some(c => c.boundary?.status === "BOUNDARY_FOUND")
              ? "BOUNDARY_FOUND"
              : candidates.some(c => c.boundary?.status === "BOUNDARY_AMBIGUOUS")
                ? "BOUNDARY_AMBIGUOUS"
                : "BOUNDARY_NOT_FOUND";

          reports.push({
            frame,
            capture,
            captureStatus: "CAPTURE_PASS",
            pipelineStatus: `PIPELINE_PASS: Stage A–D processed ${pipeline.candidates.length} candidates / ${pipelineGroups.length} action groups in ${pipeline.processingTimeMs.toFixed(1)} ms; Stage E ${templateError ? "blocked" : "executed"}.`,
            templateStatus: templateError ?? "TEMPLATE_READY: confirmed Facebook Like / Comment / Share crops",
            detectionStatus: templateError ? "DETECTION_BLOCKED" : detected.rows.length > 0 ? "DETECTION_PASS" : "DETECTION_FAIL",
            boundaryStatus: frameBoundary,
            rawIconMatches: detected.rawIconMatches,
            actionClusters: detected.rows.length,
            candidates,
          });
        } catch (error) {
          reports.push({
            frame,
            capture,
            captureStatus: "CAPTURE_PASS",
            pipelineStatus: `PIPELINE_FAIL: ${String(error)}`,
            templateStatus: templateError ?? "TEMPLATE_READY",
            detectionStatus: "DETECTION_BLOCKED",
            boundaryStatus: "NO_ACTION_ROW",
            rawIconMatches: 0,
            actionClusters: 0,
            candidates: [],
          });
        }

        setFrames([...reports]);
        priorScrollY = capture.viewport.scrollY;

        if (frame < 50) {
          try {
            await invoke({ type: "visualMatchLabScroll", webContentsId: capture.webContentsId, deltaY: Math.round(capture.viewport.height * 0.65) });
            await wait(1400);
          } catch (error) {
            throw new Error(`SCROLL_STOPPED_AFTER_FRAME_${frame}: ${String(error)}`);
          }
        }
      }

      setStatus(`PARTIAL PASS: ${reports.length}/50 frames captured and processed on BrowserCore webContents.id=${reports[0].capture.webContentsId}.${templateError ? ` ${templateError}` : ""}`);
    } catch (error) {
      setStatus(reports.length > 0 ? `PARTIAL PASS: stopped safely after ${reports.length} frames; evidence retained. ${String(error)}` : `FAIL: ${String(error)}`);
    } finally {
      if (debugRecords.length > 0) {
        const debugReport: BoundaryDebugReport = {
          runId,
          timestamp: new Date().toISOString(),
          environment: { width: 1024, height: 560, zoom: 1, platform: "facebook" },
          totalFrames: reports.length,
          records: debugRecords,
          summary: {
            totalProbed: debugRecords.length,
            boundaryFoundCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_FOUND").length,
            boundaryAmbiguousCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS").length,
            boundaryNotFoundCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_NOT_FOUND").length,
            jumpedZeroToTwoPlusCount: debugRecords.filter(r => r.transitions.jumpedZeroToTwoPlus).length,
            jumpedFrames: [...new Set(debugRecords.filter(r => r.transitions.jumpedZeroToTwoPlus).map(r => r.frameNumber))],
          },
        };
        try {
          const res = await invoke<{ ok: boolean; path: string; runPath: string }>({
            type: "visualMatchLabSaveBoundaryDebug",
            report: debugReport,
          });
          setDebugArtifactPath(res.path);
        } catch (e) {
          console.warn("Failed to persist boundary debug report:", e);
        }
        void fetchSavedRuns();
      }
      setRunning(false);
    }
  };

  const rerunExisting = async () => {
    if (!templates.like || !templates.comment || !templates.share || frames.length === 0) return;
    setRunning(true);
    const seen: LiveCandidate[] = [];
    const next: FrameReport[] = [];

    try {
      const templateCanvases = await Promise.all(([templates.like, templates.comment, templates.share]).map(item => imageCanvas(item.dataUrl, item.width, item.height)));
      for (let index = 0; index < frames.length; index++) {
        const capture = frames[index].capture;
        const fixture: FixtureItem = { id: capture.id, name: `Evidence frame ${index + 1}`, description: capture.viewport.url, width: capture.width, height: capture.height, isRealFixture: true, dataUrl: capture.dataUrl };
        const pipeline = await runRecognitionPipeline(fixture);
        const target = await imageCanvas(capture.dataUrl, capture.width, capture.height);
        const detected = await detectActionRows(target, templateCanvases, method, threshold, pipeline.candidates.filter(candidate => candidate.type === "icon").map(candidate => candidate.bbox));
        const candidates: LiveCandidate[] = [];

        for (const row of detected.rows) {
          const hash = fingerprint(target, row.bbox);
          const docY = capture.viewport.scrollY + row.bbox.y;
          const duplicate = seen.some(item => Math.abs(item.docY - docY) <= 70 && distance(item.fingerprint, hash) <= 18);
          const candidate: LiveCandidate = {
            bbox: row.bbox,
            score: row.score,
            iconCount: row.items.length,
            status: duplicate ? "DUPLICATE" : "NEEDS_ATTENTION",
            context: "unverified (offline frame - click 'Run Live Scroll Test' to probe live DOM)",
            fingerprint: hash,
            docY,
          };
          candidates.push(candidate);
          if (!duplicate) seen.push(candidate);
        }

        next.push({
          frame: index + 1,
          capture,
          captureStatus: "CAPTURE_PASS",
          pipelineStatus: `PIPELINE_PASS: shared Stage A–D + Stage E executed on saved evidence.`,
          templateStatus: "TEMPLATE_READY: confirmed Facebook Like / Comment / Share crops",
          detectionStatus: detected.rows.length ? "DETECTION_PASS" : "DETECTION_FAIL",
          boundaryStatus: detected.rows.length ? "BOUNDARY_NOT_FOUND" : "NO_ACTION_ROW",
          rawIconMatches: detected.rawIconMatches,
          actionClusters: detected.rows.length,
          candidates,
        });
        setFrames([...next]);
      }
      setStatus(`PARTIAL PASS: Stage E re-run on ${next.length} saved frames. Detection results are available; item-count remains unconfirmed until context verification.`);
    } catch (error) {
      setStatus(`PARTIAL PASS: saved-frame Stage E stopped after ${next.length} frames. ${String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const all = frames.flatMap(frame => frame.candidates);
  const confirmed = all.filter(item => item.status === "NEW_ITEM").length;
  const rawCandidates = frames.reduce((sum, frame) => sum + frame.rawIconMatches, 0);
  const provisionalGroups = frames.reduce((sum, frame) => sum + frame.actionClusters, 0);
  const boundaryFound = all.filter(item => item.boundary?.status === "BOUNDARY_FOUND").length;
  const boundaryAmbiguous = all.filter(item => item.boundary?.status === "BOUNDARY_AMBIGUOUS").length;
  const boundaryNotFound = all.filter(item => !item.boundary || item.boundary.status === "BOUNDARY_NOT_FOUND").length;

  return (
    <section className="live-scroll-test">
      <h2>Live Scroll &amp; Permalink Boundary POC</h2>
      <p>BrowserCore 1024×560 · 65% overlap scroll · maximum 50 frames · OpenCV Action Row → DOM hit-test → parentNode traversal → Permalink Filter → Boundary</p>
      
      <div style={{ display: "flex", gap: "10px", alignItems: "center", margin: "8px 0" }}>
        <button onClick={() => void run()} disabled={running}>
          {running ? "Running Live Scroll & Boundary Test…" : "Run Live Scroll Test"}
        </button>
      </div>

      <div role="status">{status}</div>

      {debugArtifactPath && (
        <div style={{ margin: "6px 0", fontSize: "12px", color: "#065f46", background: "#d1fae5", padding: "6px 10px", borderRadius: "4px" }}>
          <b>Boundary Debug Log saved:</b> <code>scratch/visual-match-lab-boundary-debug.json</code>
        </div>
      )}

      <LiveTemplateCalibration
        captures={frames.map(frame => frame.capture)}
        templates={templates}
        onChange={setTemplates}
        onRerun={() => void rerunExisting()}
        running={running}
      />

      {frames.length > 0 && frames.some(f => !f.boundaryStatus || (f.boundaryStatus === "BOUNDARY_NOT_FOUND" && f.candidates.some(c => !c.boundary))) && (
        <div className="boundary-warning" style={{ margin: "10px 0", padding: "8px 12px", background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "4px", color: "#92400e" }}>
          ℹ <b>Notice</b>: Current list contains stored frames from an earlier offline run. Click <b>"Run Live Scroll Test"</b> above to execute live DOM hit-test &amp; Permalink Boundary Probe with green/yellow/red container highlights.
        </div>
      )}

      {/* Run Summary Statistics Bar & Saved Runs Selector */}
      <RunSummary
        totalFrames={frames.length}
        capturePassCount={frames.length}
        captureFailCount={captureFailures}
        actionClustersTotal={provisionalGroups}
        rawIconMatchesTotal={rawCandidates}
        boundaryFoundCount={boundaryFound}
        boundaryAmbiguousCount={boundaryAmbiguous}
        boundaryNotFoundCount={boundaryNotFound}
        candidates={all}
        savedRuns={savedRuns}
        currentRunId={currentRunId}
        onLoadRun={handleLoadRun}
        loadingRun={loadingRun}
      />

      {/* Frame Inspector: Single Frame (70% Screenshot / 30% Diagnostics) */}
      {frames.length > 0 && (
        <FrameInspector
          frames={frames}
          currentRunId={currentRunId}
          platform="facebook"
          rules={rules}
          onRuleSaved={handleSaveRule}
          onUpdateBoundary={handleUpdateCandidateBoundary}
          invoke={invoke}
          isLiveRunning={running}
        />
      )}
    </section>
  );
}
