import React, { useEffect, useState } from "react";
import type { Command } from "../../../shared/contracts";
import { TemplateMatcher } from "../../../../experiments/visual-match-lab/src/cv/template-matcher";
import { runRecognitionPipeline } from "../../../../experiments/visual-match-lab/src/cv/recognition-pipeline";
import type { FixtureItem } from "../../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { MatchCandidate, MatchMethod, RecognizedGroup, Rect } from "../../../../experiments/visual-match-lab/src/types";
import type { LiveCapture } from "./types";
import { LiveTemplateCalibration, loadLiveTemplates, type LiveIconTemplates } from "./LiveTemplateCalibration";
import type { BoundaryProbeResult, BoundaryStatus } from "../../../shared/boundary-probe";

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
type FrameReport = {
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
const LIVE_FRAMES_KEY = "visual_match_lab_live_frames_v1";

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
  const [captureFailures, setCaptureFailures] = useState(0);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready — no public Facebook action is performed.");

  useEffect(() => {
    try {
      localStorage.setItem(LIVE_FRAMES_KEY, JSON.stringify(frames));
    } catch {
      setStatus("PARTIAL PASS: evidence is visible, but browser storage could not persist every frame.");
    }
  }, [frames]);

  const run = async () => {
    setRunning(true);
    setFrames([]);
    setCaptureFailures(0);
    const reports: FrameReport[] = [];
    const seen: LiveCandidate[] = [];
    let failedCaptures = 0;

    try {
      const missing = (["like", "comment", "share"] as const).filter(kind => !templates[kind]);
      const templateError = missing.length ? `TEMPLATE_NOT_READY: missing confirmed Facebook ${missing.join(", ")} crop(s). Create them from an evidence frame below.` : null;
      const templateCanvases = templateError ? [] : await Promise.all((["like", "comment", "share"] as const).map(kind => imageCanvas(templates[kind]!.dataUrl, templates[kind]!.width, templates[kind]!.height)));
      let priorScrollY: number | null = null;
      let browserWebContentsId: number | null = null;

      for (let frame = 1; frame <= 10; frame++) {
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
            const point = {
              x: Math.round((row.bbox.x + row.bbox.width / 2) * capture.viewport.width / capture.width),
              y: Math.round((row.bbox.y + row.bbox.height / 2) * capture.viewport.height / capture.height),
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
                options: { highlight: true, captureEvidence: true },
              });
              if (boundary.candidateContainer?.role === "article" || boundary.status === "BOUNDARY_FOUND") {
                context = "post";
              }
            } catch {
              try {
                const inspected = await invoke<{ element: { context?: string } | null }>({
                  type: "visualMatchLabInspect",
                  captureId: capture.id,
                  webContentsId: capture.webContentsId,
                  point,
                });
                context = inspected.element?.context ?? "unknown";
              } catch {}
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

        if (frame < 10) {
          try {
            await invoke({ type: "visualMatchLabScroll", webContentsId: capture.webContentsId, deltaY: Math.round(capture.viewport.height * 0.65) });
            await wait(1400);
          } catch (error) {
            throw new Error(`SCROLL_STOPPED_AFTER_FRAME_${frame}: ${String(error)}`);
          }
        }
      }

      setStatus(`PARTIAL PASS: ${reports.length}/10 frames captured and processed on BrowserCore webContents.id=${reports[0].capture.webContentsId}.${templateError ? ` ${templateError}` : ""}`);
    } catch (error) {
      setStatus(reports.length > 0 ? `PARTIAL PASS: stopped safely after ${reports.length} frames; evidence retained. ${String(error)}` : `FAIL: ${String(error)}`);
    } finally {
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
            context: "unknown (saved evidence - DOM boundary requires live synchronization)",
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
  const possible = frames.filter(frame => frame.actionClusters > 0).length;
  const rawCandidates = frames.reduce((sum, frame) => sum + frame.rawIconMatches, 0);
  const provisionalGroups = frames.reduce((sum, frame) => sum + frame.actionClusters, 0);
  const boundaryFound = all.filter(item => item.boundary?.status === "BOUNDARY_FOUND").length;
  const boundaryAmbiguous = all.filter(item => item.boundary?.status === "BOUNDARY_AMBIGUOUS").length;
  const boundaryNotFound = all.filter(item => !item.boundary || item.boundary.status === "BOUNDARY_NOT_FOUND").length;

  return (
    <section className="live-scroll-test">
      <h2>Live Scroll &amp; Permalink Boundary POC</h2>
      <p>BrowserCore 1024×560 · 65% overlap scroll · maximum 10 frames · OpenCV Action Row → DOM hit-test → parentNode traversal → Permalink Filter → Boundary</p>
      <button onClick={() => void run()} disabled={running}>{running ? "Running Live Scroll & Boundary Test…" : "Run Live Scroll Test"}</button>
      <div role="status">{status}</div>
      <LiveTemplateCalibration captures={frames.map(frame => frame.capture)} templates={templates} onChange={setTemplates} onRerun={() => void rerunExisting()} running={running} />
      <div className="live-scroll-summary">
        <b>Capture: {frames.length} pass / {captureFailures} fail</b>
        <b>Action rows: {provisionalGroups}</b>
        <b>Raw icon matches: {rawCandidates}</b>
        <b>Boundary Found: {boundaryFound}</b>
        <span>Boundary Ambiguous: {boundaryAmbiguous}</span>
        <span>Boundary Not Found: {boundaryNotFound}</span>
        <b>Confirmed posts: {confirmed}</b>
        <span>Duplicates: {all.filter(item => item.status === "DUPLICATE").length}</span>
        <span>Needs Attention: {all.filter(item => item.status === "NEEDS_ATTENTION").length}</span>
        <span>Comment actions: {all.filter(item => item.status === "COMMENT_ACTION").length}</span>
      </div>
      {frames.length > 0 && (
        <div className="live-scroll-table">
          <table>
            <thead>
              <tr>
                <th>Frame</th>
                <th>Capture</th>
                <th>Pipeline</th>
                <th>Template</th>
                <th>Detection</th>
                <th>Boundary Probe</th>
                <th>Raw icon matches</th>
                <th>Action clusters</th>
                <th>New</th>
                <th>Duplicate</th>
                <th>Needs Attention</th>
              </tr>
            </thead>
            <tbody>
              {frames.map(frame => (
                <tr key={frame.capture.id}>
                  <td>{frame.frame}</td>
                  <td>{frame.captureStatus}</td>
                  <td>{frame.pipelineStatus}</td>
                  <td>{frame.templateStatus}</td>
                  <td>{frame.detectionStatus}</td>
                  <td>
                    <span className={`badge-boundary ${frame.boundaryStatus}`}>
                      {frame.boundaryStatus}
                    </span>
                  </td>
                  <td>{frame.rawIconMatches}</td>
                  <td>{frame.actionClusters}</td>
                  <td>{frame.candidates.filter(item => item.status === "NEW_ITEM").length}</td>
                  <td>{frame.candidates.filter(item => item.status === "DUPLICATE").length}</td>
                  <td>{frame.candidates.filter(item => item.status === "NEEDS_ATTENTION" || item.status === "COMMENT_ACTION").length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="live-scroll-evidence">
        {frames.map(frame => {
          const highlightedImg = frame.candidates.find(c => c.highlightedEvidenceUrl)?.highlightedEvidenceUrl || frame.capture.dataUrl;
          return (
            <article key={frame.capture.id}>
              <h3>Frame {frame.frame} · scrollY={frame.capture.viewport.scrollY} · Boundary: {frame.boundaryStatus}</h3>
              <p>{frame.captureStatus}</p>
              <p>{frame.pipelineStatus}</p>
              <p>{frame.templateStatus}</p>
              <div className="evidence-image">
                <img src={highlightedImg} alt={`Frame ${frame.frame} evidence`} />
                {frame.candidates.map((item, index) => (
                  <span
                    key={index}
                    data-status={item.status}
                    style={{
                      left: `${item.bbox.x / frame.capture.width * 100}%`,
                      top: `${item.bbox.y / frame.capture.height * 100}%`,
                      width: `${item.bbox.width / frame.capture.width * 100}%`,
                      height: `${item.bbox.height / frame.capture.height * 100}%`,
                    }}
                    title={`${item.status} score=${item.score.toFixed(3)} boundary=${item.boundary?.status ?? "NONE"}`}
                  />
                ))}
              </div>
              <ul>
                {frame.candidates.map((item, index) => (
                  <li key={index}>
                    <b>{item.status}</b> · bbox {item.bbox.x},{item.bbox.y},{item.bbox.width}×{item.bbox.height} · score {(item.score * 100).toFixed(1)}% · DOM {item.context}
                    {item.boundary && (
                      <div className="boundary-detail">
                        <span className={`badge-boundary ${item.boundary.status}`}>{item.boundary.status}</span>
                        <span>Ancestors: {item.boundary.ancestorsChecked} · </span>
                        <span>First: {item.boundary.firstPermalinkLevel !== null ? `L${item.boundary.firstPermalinkLevel}` : "None"} · </span>
                        <span>Second (Crossed): {item.boundary.secondPermalinkLevel !== null ? `L${item.boundary.secondPermalinkLevel}` : "None"}</span>
                        {item.boundary.candidateContainer && (
                          <div>
                            Candidate Container: &lt;{item.boundary.candidateContainer.tag}
                            {item.boundary.candidateContainer.role ? ` role="${item.boundary.candidateContainer.role}"` : ""}
                            &gt; L{item.boundary.candidateContainer.level} ({Math.round(item.boundary.candidateContainer.rect.width)}×{Math.round(item.boundary.candidateContainer.rect.height)})
                          </div>
                        )}
                        {item.boundary.postIdentities.length > 0 && (
                          <div>Post identities: {item.boundary.postIdentities.map(p => `${p.platform}:${p.postId}`).join(", ")}</div>
                        )}
                        {item.boundary.hasQuoteOrSharedPostRisk && (
                          <div className="boundary-warning">⚠ Quote/Shared post risk: {item.boundary.riskReason}</div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}
