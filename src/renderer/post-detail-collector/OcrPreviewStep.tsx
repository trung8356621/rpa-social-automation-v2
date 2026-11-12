import React, { useEffect, useState } from "react";
import type { OcrResult, Rect } from "../../shared/contracts";
import {
  createPostDetailFrameId,
  createPostDetailRunId,
} from "../../shared/post-detail-collector/match-status";
import type {
  PostDetailLoadRunResult,
  PostDetailSaveRunResult,
  PostDetailSavedRunSummary,
} from "../../shared/post-detail-collector/types";
import { assertCaptureFromSocialPage } from "../../shared/post-detail-collector/social-url";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import { cropDataUrl } from "./image-utils";
import type { BrowserProbe, Invoke, PostDetailMatchResult, PostDetailOcrFrame, VisualReferenceSample } from "./types";

type Props = {
  invoke: Invoke;
  sourceUrl: string;
  runId: string | null;
  contentRoi: Rect | null;
  lastMatch: PostDetailMatchResult | null;
  lastScreenshot: { id: string; dataUrl: string; width: number; height: number } | null;
  visualReferences: VisualReferenceSample[];
  frames: PostDetailOcrFrame[];
  selectedFrameIndex: number;
  viewMode: "original" | "crop" | "text";
  onRunId: (id: string) => void;
  onFrames: (frames: PostDetailOcrFrame[]) => void;
  onSelectFrame: (index: number) => void;
  onViewMode: (mode: "original" | "crop" | "text") => void;
  onScreenshot: (shot: { id: string; dataUrl: string; width: number; height: number } | null) => void;
  onProbeRefresh: () => Promise<BrowserProbe | null>;
  onBack: () => void;
};

export function OcrPreviewStep({
  invoke,
  sourceUrl,
  runId,
  contentRoi,
  lastMatch,
  lastScreenshot,
  visualReferences,
  frames,
  selectedFrameIndex,
  viewMode,
  onRunId,
  onFrames,
  onSelectFrame,
  onViewMode,
  onScreenshot,
  onProbeRefresh,
  onBack,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("Chạy OCR thật qua localOcr (visualMatchLabOcr IPC) — không mock.");
  const [savedRuns, setSavedRuns] = useState<PostDetailSavedRunSummary[]>([]);
  const [scrollY, setScrollY] = useState<number | null>(null);

  const active = frames[selectedFrameIndex];

  useEffect(() => {
    if (!electron) return;
    void invoke<PostDetailSavedRunSummary[]>({ type: "postDetailListRuns" })
      .then(setSavedRuns)
      .catch(() => setSavedRuns([]));
  }, [electron, invoke, frames.length]);

  async function ensureScreenshot() {
    if (lastScreenshot?.dataUrl) return lastScreenshot;
    const probe = await onProbeRefresh();
    assertCaptureFromSocialPage(probe?.url || sourceUrl || "");
    const image = await collectorFreezeFrame(invoke);
    onScreenshot(image);
    return image;
  }

  async function runOcrOnCurrentRoi() {
    if (!invoke || busy) return;
    if (!contentRoi) {
      setError("Thiếu OCR content ROI — quay lại Step 2 để Confirm OCR ROI (không dùng visual reference ROI).");
      return;
    }
    if (!lastScreenshot?.dataUrl && !isElectronBrowserCoreAvailable()) {
      setError("Thiếu screenshot evidence.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("Đang OCR vùng nội dung (content ROI) bằng Tesseract local — không mock...");
    try {
      const shot = await ensureScreenshot();
      const cropped = await cropDataUrl(shot.dataUrl, contentRoi);
      const ocr = await invoke<OcrResult>({ type: "visualMatchLabOcr", dataUrl: cropped.dataUrl });
      const activeRunId = runId || createPostDetailRunId();
      if (!runId) onRunId(activeRunId);
      const frameIndex = frames.length + 1;
      const lowConf = (ocr.segments || []).filter((s) => s.confidence < 60);
      const frame: PostDetailOcrFrame = {
        runId: activeRunId,
        frameId: createPostDetailFrameId(frameIndex),
        frameIndex,
        scrollY,
        roi: contentRoi,
        screenshotDataUrl: shot.dataUrl,
        cropDataUrl: cropped.dataUrl,
        ocrText: ocr.text || "",
        ocrConfidence: ocr.confidence ?? null,
        ocrSegments: ocr.segments,
        matchStatus: lastMatch?.status ?? null,
        matchScore: lastMatch?.score ?? null,
        matchTemplateId: lastMatch?.templateId ?? null,
        processingStatus: !ocr.text?.trim()
          ? "NEEDS_REVIEW"
          : lowConf.length > 0
            ? "NEEDS_REVIEW"
            : "OCR_DONE",
        diagnostics: {
          errors: !ocr.text?.trim() ? ["OCR returned empty text"] : [],
          warnings: lowConf.length
            ? [`${lowConf.length} segment(s) confidence < 60 — cần user kiểm tra`]
            : [],
          notes: [
            `language=${ocr.language || "vie+eng"}`,
            `crop=${cropped.width}×${cropped.height}`,
            `confidence=${ocr.confidence?.toFixed?.(1) ?? ocr.confidence}`,
          ],
        },
        createdAt: new Date().toISOString(),
      };
      const next = [...frames, frame];
      onFrames(next);
      onSelectFrame(next.length - 1);
      onViewMode("text");
      setMessage(
        `OCR frame #${frameIndex} xong · ${ocr.text?.trim() ? `${ocr.text.trim().slice(0, 80)}…` : "(empty)"}`,
      );
      await collectorSetBrowserVisible(invoke, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        await collectorSetBrowserVisible(invoke, true);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRun() {
    if (!invoke || busy) return;
    if (!frames.length) {
      setError("Chưa có OCR frame để lưu.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const id = runId || createPostDetailRunId();
      if (!runId) onRunId(id);
      // New runId if this id was already persisted — storage refuses overwrite.
      let saveId = id;
      const result = await invoke<PostDetailSaveRunResult>({
        type: "postDetailSaveRun",
        input: {
          runId: saveId,
          sourceUrl,
          platform: "Facebook",
          visualReferences,
          frames: frames.map((f) => ({ ...f, runId: saveId })),
          viewport: lastScreenshot
            ? { width: lastScreenshot.width, height: lastScreenshot.height }
            : undefined,
        },
      }).catch(async (err) => {
        if (String(err).includes("POST_DETAIL_RUN_EXISTS")) {
          saveId = createPostDetailRunId();
          onRunId(saveId);
          return invoke<PostDetailSaveRunResult>({
            type: "postDetailSaveRun",
            input: {
              runId: saveId,
              sourceUrl,
              platform: "Facebook",
              visualReferences,
              frames: frames.map((f) => ({ ...f, runId: saveId })),
              viewport: lastScreenshot
                ? { width: lastScreenshot.width, height: lastScreenshot.height }
                : undefined,
            },
          });
        }
        throw err;
      });
      setMessage(`Saved run ${result.runId} · ${result.frameCount} frame(s) → scratch/post-detail-runs/`);
      const list = await invoke<PostDetailSavedRunSummary[]>({ type: "postDetailListRuns" });
      setSavedRuns(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadRun(id: string) {
    if (!invoke || busy) return;
    setBusy(true);
    setError("");
    try {
      const loaded = await invoke<PostDetailLoadRunResult>({ type: "postDetailLoadRun", runId: id });
      onRunId(loaded.runId);
      onFrames(loaded.frames);
      onSelectFrame(0);
      setMessage(`Loaded run ${loaded.runId} · ${loaded.frames.length} frame(s)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!electron) {
    return <div className="pdc-alert pdc-alert-warn">{BROWSER_CORE_UNAVAILABLE}</div>;
  }

  return (
    <div className="pdc-step">
      <div className="pdc-section-header">
        <div>
          <h2>Step 3 — OCR Preview POC</h2>
          <p className="pdc-subtitle">
            Engine: localOcr (Tesseract vie+eng) · multi-frame độc lập · chưa merge/dedup nâng cao.
          </p>
        </div>
        <div className="pdc-btn-row">
          <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy} onClick={onBack}>
            ← Back
          </button>
          <button type="button" className="pdc-btn pdc-btn-primary" disabled={busy || !contentRoi} onClick={() => void runOcrOnCurrentRoi()}>
            Run OCR on ROI
          </button>
          <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy || !frames.length} onClick={() => void saveRun()}>
            Save Run
          </button>
        </div>
      </div>

      {error && <div className="pdc-alert pdc-alert-error">{error}</div>}
      {message && <div className="pdc-alert pdc-alert-info">{message}</div>}

      <div className="pdc-workspace">
        <div className="pdc-browser-pane pdc-ocr-preview">
          <div className="pdc-view-tabs">
            {(["original", "crop", "text"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`pdc-chip ${viewMode === mode ? "active" : ""}`}
                onClick={() => onViewMode(mode)}
              >
                {mode === "original" ? "Original" : mode === "crop" ? "OCR Crop" : "OCR Text"}
              </button>
            ))}
            <div className="pdc-frame-nav">
              <button
                type="button"
                className="pdc-btn pdc-btn-tiny"
                disabled={selectedFrameIndex <= 0}
                onClick={() => onSelectFrame(selectedFrameIndex - 1)}
              >
                Previous
              </button>
              <span>
                Frame {frames.length ? selectedFrameIndex + 1 : 0}/{frames.length}
              </span>
              <button
                type="button"
                className="pdc-btn pdc-btn-tiny"
                disabled={selectedFrameIndex >= frames.length - 1}
                onClick={() => onSelectFrame(selectedFrameIndex + 1)}
              >
                Next
              </button>
            </div>
          </div>

          <div className="pdc-preview-surface">
            {viewMode === "original" && (active?.screenshotDataUrl || lastScreenshot?.dataUrl) && (
              <img src={active?.screenshotDataUrl || lastScreenshot?.dataUrl} alt="Original screenshot" />
            )}
            {viewMode === "crop" && active?.cropDataUrl && <img src={active.cropDataUrl} alt="OCR crop" />}
            {viewMode === "text" && (
              <pre className="pdc-ocr-text" aria-label="OCR text">
                {active?.ocrText || "(Chưa có OCR text — bấm Run OCR on ROI)"}
              </pre>
            )}
            {!active && viewMode !== "original" && !lastScreenshot && (
              <div className="pdc-muted">Chưa có frame. Capture ROI rồi Run OCR.</div>
            )}
          </div>
        </div>

        <div className="pdc-side-panel">
          <h3>OCR diagnostics</h3>
          {active ? (
            <dl className="pdc-dl">
              <dt>frameId</dt>
              <dd>{active.frameId}</dd>
              <dt>status</dt>
              <dd>{active.processingStatus}</dd>
              <dt>confidence</dt>
              <dd>{active.ocrConfidence ?? "—"}</dd>
              <dt>match</dt>
              <dd>
                {active.matchStatus || "—"}
                {active.matchScore != null ? ` · ${active.matchScore.toFixed(3)}` : ""}
              </dd>
              <dt>ROI</dt>
              <dd>
                {active.roi.width}×{active.roi.height} @ ({active.roi.x},{active.roi.y})
              </dd>
              <dt>scrollY</dt>
              <dd>
                <input
                  type="number"
                  value={scrollY ?? ""}
                  placeholder="optional"
                  onChange={(e) => setScrollY(e.target.value === "" ? null : Number(e.target.value))}
                />
              </dd>
              <dt>warnings</dt>
              <dd>{active.diagnostics.warnings.join("; ") || "—"}</dd>
              <dt>notes</dt>
              <dd>{active.diagnostics.notes.join("; ") || "—"}</dd>
            </dl>
          ) : (
            <p className="pdc-muted">Chưa có frame.</p>
          )}

          <h3>Saved Runs</h3>
          <ul className="pdc-sample-list">
            {savedRuns.map((r) => (
              <li key={r.runId}>
                <span>
                  {r.runId} · {r.frameCount}f · {new Date(r.createdAt).toLocaleString()}
                </span>
                <button type="button" className="pdc-btn pdc-btn-tiny" disabled={busy} onClick={() => void loadRun(r.runId)}>
                  Open
                </button>
              </li>
            ))}
            {!savedRuns.length && <li className="pdc-muted">Chưa có run đã lưu.</li>}
          </ul>
          <p className="pdc-panel-desc">
            Evidence: <code>scratch/post-detail-runs/&#123;runId&#125;/</code> — không ghi đè run cũ · không lưu cookie/token.
          </p>
        </div>
      </div>
    </div>
  );
}
