import path from "node:path";
import { mkdir, writeFile, readFile, readdir, rename, stat, rm, appendFile } from "node:fs/promises";
import type { SavedRunSummaryItem } from "../shared/contracts.js";
import type { BoundaryDebugRecord, BoundaryDebugReport, BoundaryStatus } from "../shared/boundary-probe.js";
import { BUILTIN_PERMALINK_RULES, type UserPermalinkRule } from "../shared/permalink-rules.js";
import {
  STORAGE_SCHEMA_VERSION,
  classifyAncestorsUrls,
  formatAttemptId,
  formatFrameFolderName,
  formatRowFileName,
  getRelativeAttemptDir,
  getRelativeFrameDir,
  getRelativeHighlightedPath,
  getRelativeRowPath,
  getRelativeScreenshotPath,
  type VisualMatchLogEntry,
  type VisualMatchManifestFrameEntry,
  type VisualMatchRunManifest,
  type VisualMatchRunResult,
  type VisualMatchSaveFrameAttemptInput,
  type VisualMatchStoredAttempt,
  type VisualMatchStoredFrame,
  type VisualMatchStoredRow,
} from "../shared/visual-match-lab-storage.js";

let atomicCounter = 0;

function decodeDataUrlPng(dataUrl: string | undefined): Buffer | null {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl.trim());
  const rawBase64 = match ? match[1] : dataUrl.trim();
  if (!rawBase64) return null;
  try {
    const buf = Buffer.from(rawBase64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${++atomicCounter}`;
  try {
    if (typeof data === "string") {
      await writeFile(tmpPath, data, "utf8");
    } else {
      await writeFile(tmpPath, data);
    }
    await rename(tmpPath, filePath);
    const st = await stat(filePath);
    const expectedMin = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
    if (expectedMin > 0 && st.size === 0) {
      throw new Error(`Zero-byte file after atomic write: ${filePath}`);
    }
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new Error(
      `EVIDENCE_STORAGE_WRITE_FAILED: Cannot write "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function writeImmutableEvidenceFile(
  filePath: string,
  data: Buffer,
): Promise<{ written: boolean; existed: boolean }> {
  try {
    const existing = await stat(filePath);
    if (existing.isFile() && existing.size > 0) {
      return { written: false, existed: true };
    }
  } catch {
    // File does not exist yet — proceed to write
  }
  await writeFileAtomic(filePath, data);
  return { written: true, existed: false };
}

function buildStoredRowFromRecord(
  rec: BoundaryDebugRecord,
  rules: UserPermalinkRule[],
  evidencePaths: { screenshot?: string; highlighted?: string; rowEvidence?: string },
): VisualMatchStoredRow {
  const urls = classifyAncestorsUrls(rec.ancestors ?? [], rec.transitions?.boundaryCrossedLevel ?? null, rules);
  const warnings: string[] = [];
  const errors: string[] = [];
  if (rec.boundaryStatus === "BOUNDARY_NOT_FOUND") {
    errors.push(rec.riskReason || "BOUNDARY_NOT_FOUND");
  } else if (rec.boundaryStatus === "BOUNDARY_AMBIGUOUS") {
    warnings.push(rec.riskReason || "BOUNDARY_AMBIGUOUS");
  }
  if (rec.transitions?.jumpedZeroToTwoPlus && rec.transitions.jumpReason) {
    warnings.push(rec.transitions.jumpReason);
  }
  return {
    rowIndex: rec.rowIndex,
    candidateId: rec.candidateId || `f${String(rec.frameNumber).padStart(3, "0")}_r${String(rec.rowIndex).padStart(3, "0")}`,
    actionRowBbox: rec.actionRowBbox,
    actionRowCssBbox: rec.actionRowBbox,
    matchingScore: rec.matchingScore,
    iconCount: rec.iconCount ?? 3,
    candidateStatus:
      rec.candidateStatus ??
      (rec.boundaryStatus === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION"),
    fingerprint: rec.fingerprint ?? "",
    docY: rec.docY ?? rec.scrollY + rec.actionRowBbox.y,
    hitPoint: rec.hitPoint,
    hitElement: rec.hitElement,
    boundaryStatus: rec.boundaryStatus,
    candidateContainer: rec.candidateContainer,
    crossedContainer: rec.crossedContainer,
    transitions: rec.transitions,
    postIdentities: rec.ancestors?.flatMap(a => a.postIdentities ?? []) ?? [],
    urls,
    ancestors: rec.ancestors ?? [],
    ownershipEvidence: rec.ownershipEvidence,
    riskReason: rec.riskReason,
    evidencePaths,
    diagnostics: rec.diagnostics ?? {
      errors,
      warnings,
      notes: rec.ownershipEvidence?.notes ?? [],
    },
  };
}

export class VisualMatchRunStorage {
  constructor(private readonly projectDir: string = process.cwd()) {}

  getScratchDir(): string {
    return path.join(this.projectDir, "scratch");
  }

  getRunsDir(): string {
    return path.join(this.getScratchDir(), "runs");
  }

  getRunDir(runId: string): string {
    if (!runId || typeof runId !== "string" || /[\\/]/.test(runId) || runId.includes("..")) {
      throw new Error(`INVALID_RUN_ID: "${runId}"`);
    }
    return path.join(this.getRunsDir(), runId);
  }

  async saveRun(report: BoundaryDebugReport): Promise<{
    ok: boolean;
    runId: string;
    runDir: string;
    path: string;
    runPath: string;
    manifestPath: string;
    resultPath: string;
    pipelineLogPath: string;
    errorLogPath: string;
    recordCount: number;
  }> {
    if (!report || !report.runId) {
      throw new Error("EVIDENCE_STORAGE_INVALID_REPORT: Missing runId");
    }

    const runId = report.runId;
    const runDir = this.getRunDir(runId);
    const manifestPath = path.join(runDir, "manifest.json");
    const resultPath = path.join(runDir, "result.json");
    const logsDir = path.join(runDir, "logs");
    const pipelineLogPath = path.join(logsDir, "pipeline.jsonl");
    const errorLogPath = path.join(logsDir, "errors.jsonl");

    // Check if this runId already exists and is completed on disk.
    // If it does, we must NEVER overwrite existing frame evidence files; any repeated frame
    // in the same run is isolated into a new attempt directory (`attempts/attempt-NNN`).
    let existingResult: VisualMatchRunResult | null = null;
    let existingManifest: VisualMatchRunManifest | null = null;
    try {
      existingManifest = JSON.parse(await readFile(manifestPath, "utf8")) as VisualMatchRunManifest;
      existingResult = JSON.parse(await readFile(resultPath, "utf8")) as VisualMatchRunResult;
    } catch {
      existingManifest = null;
      existingResult = null;
    }

    await mkdir(runDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(path.join(runDir, "frames"), { recursive: true });

    const rules: UserPermalinkRule[] =
      (report.configVersion?.rules as UserPermalinkRule[] | undefined) ?? BUILTIN_PERMALINK_RULES;

    const nowIso = new Date().toISOString();
    const createdAt = existingManifest?.createdAt || report.createdAt || report.timestamp || nowIso;
    const completedAt = report.completedAt || nowIso;

    // Group incoming records by (frameNumber, rowIndex).
    // Notice: if report.records contains multiple records for the same (frameNumber, rowIndex),
    // the first one is the initial attempt and subsequent ones are additional attempts!
    const recordsByFrame = new Map<number, BoundaryDebugRecord[]>();
    for (const rec of report.records ?? []) {
      const list = recordsByFrame.get(rec.frameNumber) ?? [];
      list.push(rec);
      recordsByFrame.set(rec.frameNumber, list);
    }

    // Build incoming frame list from report.frames (if provided) + any frames in report.records
    const incomingFrameMap = new Map<number, VisualMatchStoredFrame>();
    if (Array.isArray(report.frames)) {
      for (const f of report.frames) {
        incomingFrameMap.set(f.frameIndex, {
          ...f,
          rows: f.rows ? [...f.rows] : [],
          evidencePaths: f.evidencePaths ? { ...f.evidencePaths, rows: { ...f.evidencePaths.rows } } : { rows: {} },
          diagnostics: f.diagnostics ? { ...f.diagnostics } : { errors: [], warnings: [] },
        });
      }
    }

    for (const [frameNum, recs] of recordsByFrame.entries()) {
      if (!incomingFrameMap.has(frameNum)) {
        const first = recs[0];
        const frameBoundary: BoundaryStatus | "NO_ACTION_ROW" =
          recs.some(r => r.boundaryStatus === "BOUNDARY_FOUND")
            ? "BOUNDARY_FOUND"
            : recs.some(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS")
              ? "BOUNDARY_AMBIGUOUS"
              : "BOUNDARY_NOT_FOUND";
        incomingFrameMap.set(frameNum, {
          frameIndex: frameNum,
          scrollY: first?.scrollY ?? 0,
          viewportUrl: report.sessionRef?.pageUrl || "https://www.facebook.com",
          browserWebContentsId: first?.browserWebContentsId ?? 1,
          captureStatus: "CAPTURE_PASS",
          pipelineStatus: "PIPELINE_PASS",
          templateStatus: report.configVersion?.templateStatus || "TEMPLATE_READY",
          detectionStatus: "DETECTION_PASS",
          boundaryStatus: frameBoundary,
          rawIconMatches: recs.length * 3,
          actionClusters: recs.length,
          rows: [],
          evidencePaths: { rows: {} },
          diagnostics: { errors: [], warnings: [] },
        });
      }
    }

    const existingFramesByIndex = new Map<number, VisualMatchStoredFrame>();
    for (const ef of existingResult?.frames ?? []) {
      existingFramesByIndex.set(ef.frameIndex, ef);
    }

    const pipelineLogs: VisualMatchLogEntry[] = [...(report.pipelineLogs ?? [])];
    const errorLogs: VisualMatchLogEntry[] = [...(report.errorLogs ?? [])];

    const pushLog = (
      level: VisualMatchLogEntry["level"],
      stage: VisualMatchLogEntry["stage"],
      message: string,
      extra?: Partial<VisualMatchLogEntry>,
    ) => {
      const entry: VisualMatchLogEntry = {
        timestamp: new Date().toISOString(),
        runId,
        level,
        stage,
        message,
        ...extra,
      };
      pipelineLogs.push(entry);
      if (level === "ERROR" || level === "WARN") {
        errorLogs.push(entry);
      }
    };

    pushLog("INFO", "RUN", `Persisting run ${runId} (${incomingFrameMap.size} frames, ${report.records.length} row records)`);

    const allFrameIndices = Array.from(
      new Set([...existingFramesByIndex.keys(), ...incomingFrameMap.keys()]),
    ).sort((a, b) => a - b);

    const finalFrames: VisualMatchStoredFrame[] = [];
    const finalRecords: BoundaryDebugRecord[] = [];

    for (const frameIndex of allFrameIndices) {
      const incomingFrame = incomingFrameMap.get(frameIndex);
      const existingFrame = existingFramesByIndex.get(frameIndex);
      const frameRecs = recordsByFrame.get(frameIndex) ?? [];

      if (!incomingFrame && existingFrame) {
        finalFrames.push(existingFrame);
        continue;
      }
      if (!incomingFrame) continue;

      const relFrameDir = getRelativeFrameDir(frameIndex);
      const absFrameDir = path.join(runDir, relFrameDir);
      await mkdir(absFrameDir, { recursive: true });

      // Partition frameRecs into initial attempt (first occurrence of each rowIndex)
      // and subsequent attempts (if the same rowIndex was probed multiple times in frameRecs).
      const attemptBatches: BoundaryDebugRecord[][] = [];
      for (const rec of frameRecs) {
        let placed = false;
        for (const batch of attemptBatches) {
          if (!batch.some(b => b.rowIndex === rec.rowIndex)) {
            batch.push(rec);
            placed = true;
            break;
          }
        }
        if (!placed) {
          attemptBatches.push([rec]);
        }
      }

      const primaryBatch = attemptBatches[0] ?? [];
      const extraBatches = attemptBatches.slice(1);

      // Check if this frame was already persisted on disk in an earlier saveRun call for this runId
      const isRewritingExistingFrame = Boolean(existingFrame);

      if (!isRewritingExistingFrame) {
        // --- Initial write for frame-{NNN} ---
        const rowRelPaths: Record<string, string> = {};
        const rowBuffers = new Map<number, Buffer>();

        for (const rec of primaryBatch) {
          const rowBuf =
            decodeDataUrlPng(incomingFrame.rowBase64Map?.[rec.rowIndex]) ||
            decodeDataUrlPng(rec.evidenceScreenshotBase64);
          if (rowBuf) {
            rowBuffers.set(rec.rowIndex, rowBuf);
            const relRow = getRelativeRowPath(frameIndex, rec.rowIndex);
            const absRow = path.join(runDir, relRow);
            await writeImmutableEvidenceFile(absRow, rowBuf);
            rowRelPaths[String(rec.rowIndex)] = relRow;
          }
        }

        // Write screenshot.png (raw capture if available, else first row evidence if only row evidence was provided)
        const rawScreenshotBuf =
          decodeDataUrlPng(incomingFrame.screenshotBase64) ||
          decodeDataUrlPng(primaryBatch[0]?.originalScreenshotBase64) ||
          (primaryBatch[0] ? rowBuffers.get(primaryBatch[0].rowIndex) ?? null : null);

        let relScreenshot: string | undefined;
        if (rawScreenshotBuf) {
          relScreenshot = getRelativeScreenshotPath(frameIndex);
          await writeImmutableEvidenceFile(path.join(runDir, relScreenshot), rawScreenshotBuf);
        }

        // Write highlighted.png (prefer BOUNDARY_FOUND row, else row 0, else incomingFrame.highlightedBase64)
        const foundRec = primaryBatch.find(r => r.boundaryStatus === "BOUNDARY_FOUND") ?? primaryBatch[0];
        const highlightedBuf =
          decodeDataUrlPng(incomingFrame.highlightedBase64) ||
          (foundRec ? rowBuffers.get(foundRec.rowIndex) ?? null : null);

        let relHighlighted: string | undefined;
        if (highlightedBuf) {
          relHighlighted = getRelativeHighlightedPath(frameIndex);
          await writeImmutableEvidenceFile(path.join(runDir, relHighlighted), highlightedBuf);
        }

        const storedRows: VisualMatchStoredRow[] = primaryBatch.map(rec => {
          const rowEv = rowRelPaths[String(rec.rowIndex)];
          const storedRow = buildStoredRowFromRecord(rec, rules, {
            screenshot: relScreenshot,
            highlighted: relHighlighted,
            rowEvidence: rowEv,
          });
          // Clean base64 and set canonical relative path inside runs/{runId}/
          const cleanRec: BoundaryDebugRecord = {
            ...rec,
            evidenceScreenshotSaved: rowEv ? `scratch/runs/${runId}/${rowEv}` : rec.evidenceScreenshotSaved,
            originalScreenshotSaved: relScreenshot ? `scratch/runs/${runId}/${relScreenshot}` : undefined,
            highlightedScreenshotSaved: relHighlighted ? `scratch/runs/${runId}/${relHighlighted}` : undefined,
          };
          delete cleanRec.evidenceScreenshotBase64;
          delete cleanRec.originalScreenshotBase64;
          finalRecords.push(cleanRec);
          return storedRow;
        });

        // Also record Attempt 1 in attempts/attempt-001 so attempt history is complete
        const attempt1Id = formatAttemptId(1);
        const relAttempt1Dir = getRelativeAttemptDir(frameIndex, attempt1Id);
        const absAttempt1Dir = path.join(runDir, relAttempt1Dir);
        await mkdir(absAttempt1Dir, { recursive: true });
        const attempt1RowPaths: Record<string, string> = {};
        for (const [rIdx, buf] of rowBuffers.entries()) {
          const relAttemptRow = `${relAttempt1Dir}/${formatRowFileName(rIdx)}`;
          await writeImmutableEvidenceFile(path.join(runDir, relAttemptRow), buf);
          attempt1RowPaths[String(rIdx)] = relAttemptRow;
        }
        const attempt1Obj: VisualMatchStoredAttempt = {
          attemptId: attempt1Id,
          timestamp: createdAt,
          reason: "initial-capture",
          boundaryStatus: incomingFrame.boundaryStatus,
          screenshotPath: relScreenshot,
          highlightedPath: relHighlighted,
          rowPaths: attempt1RowPaths,
          rows: storedRows,
        };
        await writeFileAtomic(path.join(absAttempt1Dir, "attempt.json"), JSON.stringify(attempt1Obj, null, 2));

        const attemptsList: VisualMatchStoredAttempt[] = [attempt1Obj];

        // If extraBatches exist in the same saveRun call (same frame probed multiple times),
        // store each extra batch in attempts/attempt-002, attempt-003, etc.
        for (let bIdx = 0; bIdx < extraBatches.length; bIdx++) {
          const batch = extraBatches[bIdx];
          const attemptId = formatAttemptId(attemptsList.length + 1);
          const relAttemptDir = getRelativeAttemptDir(frameIndex, attemptId);
          const absAttemptDir = path.join(runDir, relAttemptDir);
          await mkdir(absAttemptDir, { recursive: true });

          const batchRowPaths: Record<string, string> = {};
          let batchHighlightedPath: string | undefined;

          for (const rec of batch) {
            const buf = decodeDataUrlPng(rec.evidenceScreenshotBase64);
            if (buf) {
              const relRow = `${relAttemptDir}/${formatRowFileName(rec.rowIndex)}`;
              await writeImmutableEvidenceFile(path.join(runDir, relRow), buf);
              batchRowPaths[String(rec.rowIndex)] = relRow;
              if (!batchHighlightedPath || rec.boundaryStatus === "BOUNDARY_FOUND") {
                batchHighlightedPath = relRow;
              }
            }
          }

          const batchRows = batch.map(rec =>
            buildStoredRowFromRecord(rec, rules, {
              screenshot: relScreenshot,
              highlighted: batchHighlightedPath ?? relHighlighted,
              rowEvidence: batchRowPaths[String(rec.rowIndex)],
            }),
          );

          const extraAttempt: VisualMatchStoredAttempt = {
            attemptId,
            timestamp: new Date().toISOString(),
            reason: `reprobe-batch-${bIdx + 2}`,
            boundaryStatus: batch.some(r => r.boundaryStatus === "BOUNDARY_FOUND")
              ? "BOUNDARY_FOUND"
              : batch.some(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS")
                ? "BOUNDARY_AMBIGUOUS"
                : "BOUNDARY_NOT_FOUND",
            screenshotPath: relScreenshot,
            highlightedPath: batchHighlightedPath ?? relHighlighted,
            rowPaths: batchRowPaths,
            rows: batchRows,
          };
          await writeFileAtomic(path.join(absAttemptDir, "attempt.json"), JSON.stringify(extraAttempt, null, 2));
          attemptsList.push(extraAttempt);

          pushLog("INFO", "ATTEMPT", `Recorded extra attempt ${attemptId} for frame #${frameIndex}`, {
            frameIndex,
            attemptId,
          });
        }

        const frameWarnings = storedRows.flatMap(r => r.diagnostics.warnings);
        const frameErrors = storedRows.flatMap(r => r.diagnostics.errors);

        if (frameErrors.length > 0) {
          pushLog("WARN", "BOUNDARY_PROBE", `Frame #${frameIndex}: ${frameErrors.join("; ")}`, {
            frameIndex,
            details: { boundaryStatus: incomingFrame.boundaryStatus },
          });
        } else {
          pushLog("INFO", "BOUNDARY_PROBE", `Frame #${frameIndex} saved (${storedRows.length} rows, status=${incomingFrame.boundaryStatus})`, {
            frameIndex,
          });
        }

        const cleanFrame: VisualMatchStoredFrame = {
          frameIndex,
          scrollY: incomingFrame.scrollY,
          viewportUrl: incomingFrame.viewportUrl,
          captureId: incomingFrame.captureId,
          browserWebContentsId: incomingFrame.browserWebContentsId,
          captureStatus: incomingFrame.captureStatus,
          pipelineStatus: incomingFrame.pipelineStatus,
          templateStatus: incomingFrame.templateStatus,
          detectionStatus: incomingFrame.detectionStatus,
          boundaryStatus: incomingFrame.boundaryStatus,
          rawIconMatches: incomingFrame.rawIconMatches,
          actionClusters: incomingFrame.actionClusters,
          rows: storedRows,
          evidencePaths: {
            screenshot: relScreenshot,
            highlighted: relHighlighted,
            rows: rowRelPaths,
          },
          diagnostics: {
            errors: frameErrors,
            warnings: frameWarnings,
          },
          attempts: attemptsList,
        };
        finalFrames.push(cleanFrame);
      } else {
        // --- Frame already exists on disk for this runId! ---
        // NEVER overwrite primary frame-XXX/screenshot.png, highlighted.png, or row-YYY.png.
        // Instead, isolate the new data into a new attempt directory (`attempts/attempt-NNN`).
        const prevAttempts = existingFrame!.attempts ? [...existingFrame!.attempts] : [];
        const nextAttemptNum = prevAttempts.length + 1;
        const attemptId = formatAttemptId(nextAttemptNum);
        const relAttemptDir = getRelativeAttemptDir(frameIndex, attemptId);
        const absAttemptDir = path.join(runDir, relAttemptDir);
        await mkdir(absAttemptDir, { recursive: true });

        const attemptRowPaths: Record<string, string> = {};
        let attemptScreenshotPath = existingFrame!.evidencePaths.screenshot;
        let attemptHighlightedPath: string | undefined;

        const incomingScreenshotBuf =
          decodeDataUrlPng(incomingFrame.screenshotBase64) ||
          decodeDataUrlPng(primaryBatch[0]?.originalScreenshotBase64);
        if (incomingScreenshotBuf) {
          const relAttScreen = `${relAttemptDir}/screenshot.png`;
          await writeImmutableEvidenceFile(path.join(runDir, relAttScreen), incomingScreenshotBuf);
          attemptScreenshotPath = relAttScreen;
        }

        for (const rec of primaryBatch) {
          const rowBuf =
            decodeDataUrlPng(incomingFrame.rowBase64Map?.[rec.rowIndex]) ||
            decodeDataUrlPng(rec.evidenceScreenshotBase64);
          if (rowBuf) {
            const relAttRow = `${relAttemptDir}/${formatRowFileName(rec.rowIndex)}`;
            await writeImmutableEvidenceFile(path.join(runDir, relAttRow), rowBuf);
            attemptRowPaths[String(rec.rowIndex)] = relAttRow;
            if (!attemptHighlightedPath || rec.boundaryStatus === "BOUNDARY_FOUND") {
              attemptHighlightedPath = relAttRow;
            }
          }
        }

        if (attemptHighlightedPath) {
          const hlBuf = await readFile(path.join(runDir, attemptHighlightedPath)).catch(() => null);
          if (hlBuf) {
            const relAttHl = `${relAttemptDir}/highlighted.png`;
            await writeImmutableEvidenceFile(path.join(runDir, relAttHl), hlBuf);
            attemptHighlightedPath = relAttHl;
          }
        }

        const attemptRows = primaryBatch.map(rec =>
          buildStoredRowFromRecord(rec, rules, {
            screenshot: attemptScreenshotPath,
            highlighted: attemptHighlightedPath,
            rowEvidence: attemptRowPaths[String(rec.rowIndex)],
          }),
        );

        const newAttempt: VisualMatchStoredAttempt = {
          attemptId,
          timestamp: new Date().toISOString(),
          reason: "retest-frame-in-run",
          boundaryStatus: incomingFrame.boundaryStatus,
          screenshotPath: attemptScreenshotPath,
          highlightedPath: attemptHighlightedPath,
          rowPaths: attemptRowPaths,
          rows: attemptRows,
        };
        await writeFileAtomic(path.join(absAttemptDir, "attempt.json"), JSON.stringify(newAttempt, null, 2));
        prevAttempts.push(newAttempt);

        pushLog("INFO", "ATTEMPT", `Preserved existing frame #${frameIndex} and wrote new attempt ${attemptId}`, {
          frameIndex,
          attemptId,
        });

        const mergedFrame: VisualMatchStoredFrame = {
          ...existingFrame!,
          attempts: prevAttempts,
        };
        finalFrames.push(mergedFrame);
      }
    }

    // Include existing records for frames that weren't replaced
    if (existingResult?.records?.length) {
      for (const er of existingResult.records) {
        if (!finalRecords.some(fr => fr.frameNumber === er.frameNumber && fr.rowIndex === er.rowIndex)) {
          finalRecords.push(er);
        }
      }
    }
    finalRecords.sort((a, b) => a.frameNumber - b.frameNumber || a.rowIndex - b.rowIndex);

    const totalFrames = Math.max(report.totalFrames || 0, finalFrames.length);
    const noActionRowCount = finalFrames.filter(f => f.boundaryStatus === "NO_ACTION_ROW" || f.rows.length === 0).length;

    const summary: VisualMatchRunManifest["summary"] = {
      totalFrames,
      totalProbed: finalRecords.length,
      boundaryFoundCount: finalRecords.filter(r => r.boundaryStatus === "BOUNDARY_FOUND").length,
      boundaryAmbiguousCount: finalRecords.filter(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS").length,
      boundaryNotFoundCount: finalRecords.filter(r => r.boundaryStatus === "BOUNDARY_NOT_FOUND").length,
      noActionRowCount,
      jumpedZeroToTwoPlusCount: finalRecords.filter(r => r.transitions?.jumpedZeroToTwoPlus).length,
      jumpedFrames: [...new Set(finalRecords.filter(r => r.transitions?.jumpedZeroToTwoPlus).map(r => r.frameNumber))],
    };

    const manifestFrames: VisualMatchManifestFrameEntry[] = finalFrames.map(f => ({
      frameIndex: f.frameIndex,
      frameFolder: getRelativeFrameDir(f.frameIndex),
      scrollY: f.scrollY,
      boundaryStatus: f.boundaryStatus,
      rowCount: f.rows.length,
      attemptCount: f.attempts?.length ?? 1,
      evidencePaths: {
        screenshot: f.evidencePaths.screenshot,
        highlighted: f.evidencePaths.highlighted,
        rows: Object.values(f.evidencePaths.rows),
        attempts: (f.attempts ?? []).map(a => getRelativeAttemptDir(f.frameIndex, a.attemptId)),
      },
    }));

    const firstWebContentsId =
      report.sessionRef?.webContentsId ??
      finalFrames[0]?.browserWebContentsId ??
      finalRecords[0]?.browserWebContentsId ??
      1;
    const firstPageUrl =
      report.sessionRef?.pageUrl ??
      finalFrames[0]?.viewportUrl ??
      "https://www.facebook.com";

    const manifest: VisualMatchRunManifest = {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      runId,
      createdAt,
      completedAt,
      status: report.status ?? "COMPLETED",
      platform: report.environment?.platform ?? "facebook",
      sessionRef: {
        webContentsId: firstWebContentsId,
        pageUrl: firstPageUrl,
      },
      viewport: {
        width: report.environment?.width ?? 1024,
        height: report.environment?.height ?? 560,
        zoom: report.environment?.zoom ?? 1,
        dpr: report.environment?.dpr ?? 1,
      },
      scrollSettings: report.scrollSettings ?? {
        overlapRatio: 0.65,
        deltaY: Math.round((report.environment?.height ?? 560) * 0.65),
        settleWaitMs: 1400,
      },
      frameLimit: report.frameLimit ?? 50,
      configVersion: {
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        opencvPipelineVersion: report.configVersion?.opencvPipelineVersion ?? "stage-a-e-v1",
        boundaryResolverVersion: report.configVersion?.boundaryResolverVersion ?? "v1",
        matchMethod: report.configVersion?.matchMethod ?? "TM_CCOEFF_NORMED",
        threshold: report.configVersion?.threshold ?? 0.8,
        templateStatus: report.configVersion?.templateStatus ?? "TEMPLATE_READY",
        templatesCalibrated: report.configVersion?.templatesCalibrated ?? {
          like: true,
          comment: true,
          share: true,
        },
        rulesCount: rules.length,
        rules: rules.map(r => ({
          id: r.id,
          name: r.name,
          platform: r.platform,
          template: r.template,
          enabled: r.enabled,
        })),
      },
      summary,
      frames: manifestFrames,
      files: {
        manifest: "manifest.json",
        result: "result.json",
        pipelineLog: "logs/pipeline.jsonl",
        errorLog: "logs/errors.jsonl",
      },
    };

    const runResult: VisualMatchRunResult = {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      runId,
      createdAt,
      completedAt,
      status: manifest.status,
      environment: {
        width: manifest.viewport.width,
        height: manifest.viewport.height,
        zoom: manifest.viewport.zoom,
        dpr: manifest.viewport.dpr,
        platform: manifest.platform,
      },
      totalFrames,
      summary,
      frames: finalFrames,
      records: finalRecords,
    };

    // Append logs to logs/pipeline.jsonl and logs/errors.jsonl
    const pipelineLines = pipelineLogs.map(l => JSON.stringify(l)).join("\n") + (pipelineLogs.length ? "\n" : "");
    const errorLines = errorLogs.map(l => JSON.stringify(l)).join("\n") + (errorLogs.length ? "\n" : "");

    if (existingManifest) {
      if (pipelineLines) await appendFile(pipelineLogPath, pipelineLines, "utf8");
      if (errorLines) await appendFile(errorLogPath, errorLines, "utf8");
    } else {
      await writeFileAtomic(pipelineLogPath, pipelineLines);
      await writeFileAtomic(errorLogPath, errorLines);
    }

    // Write result.json and manifest.json atomically
    await writeFileAtomic(resultPath, JSON.stringify(runResult, null, 2));
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      ok: true,
      runId,
      runDir,
      path: resultPath,
      runPath: resultPath,
      manifestPath,
      resultPath,
      pipelineLogPath,
      errorLogPath,
      recordCount: finalRecords.length,
    };
  }

  async saveFrameAttempt(input: VisualMatchSaveFrameAttemptInput): Promise<{
    ok: boolean;
    runId: string;
    frameIndex: number;
    rowIndex: number;
    attemptId: string;
    attemptDir: string;
    evidencePath: string;
  }> {
    const { runId, frameIndex, rowIndex, reason, ruleTested, record, screenshotBase64, highlightedBase64, customRules } = input;
    const runDir = this.getRunDir(runId);
    const manifestPath = path.join(runDir, "manifest.json");
    const resultPath = path.join(runDir, "result.json");
    const logsDir = path.join(runDir, "logs");
    const pipelineLogPath = path.join(logsDir, "pipeline.jsonl");

    let manifest: VisualMatchRunManifest;
    let result: VisualMatchRunResult;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as VisualMatchRunManifest;
      result = JSON.parse(await readFile(resultPath, "utf8")) as VisualMatchRunResult;
    } catch {
      // If the run hasn't been saved to disk yet, initialize it with this record first
      await this.saveRun({
        runId,
        timestamp: new Date().toISOString(),
        environment: { width: 1024, height: 560, zoom: 1, platform: "facebook" },
        totalFrames: frameIndex,
        records: [
          {
            ...record,
            evidenceScreenshotBase64: highlightedBase64 ?? record.evidenceScreenshotBase64,
            originalScreenshotBase64: screenshotBase64 ?? record.originalScreenshotBase64,
          },
        ],
        summary: {
          totalProbed: 1,
          boundaryFoundCount: record.boundaryStatus === "BOUNDARY_FOUND" ? 1 : 0,
          boundaryAmbiguousCount: record.boundaryStatus === "BOUNDARY_AMBIGUOUS" ? 1 : 0,
          boundaryNotFoundCount: record.boundaryStatus === "BOUNDARY_NOT_FOUND" ? 1 : 0,
          jumpedZeroToTwoPlusCount: record.transitions?.jumpedZeroToTwoPlus ? 1 : 0,
          jumpedFrames: record.transitions?.jumpedZeroToTwoPlus ? [frameIndex] : [],
        },
      });
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as VisualMatchRunManifest;
      result = JSON.parse(await readFile(resultPath, "utf8")) as VisualMatchRunResult;
    }

    const frame = result.frames.find(f => f.frameIndex === frameIndex);
    if (!frame) {
      throw new Error(`FRAME_NOT_FOUND_IN_RUN: Frame #${frameIndex} not found in run ${runId}`);
    }

    const attempts = frame.attempts ? [...frame.attempts] : [];
    const attemptId = formatAttemptId(attempts.length + 1);
    const relAttemptDir = getRelativeAttemptDir(frameIndex, attemptId);
    const absAttemptDir = path.join(runDir, relAttemptDir);
    await mkdir(absAttemptDir, { recursive: true });

    const rules = customRules ?? BUILTIN_PERMALINK_RULES;
    const rowPaths: Record<string, string> = {};
    const relAttemptRow = `${relAttemptDir}/${formatRowFileName(rowIndex)}`;

    const rowBuf =
      decodeDataUrlPng(highlightedBase64) ||
      decodeDataUrlPng(record.evidenceScreenshotBase64);
    if (rowBuf) {
      await writeImmutableEvidenceFile(path.join(runDir, relAttemptRow), rowBuf);
      rowPaths[String(rowIndex)] = relAttemptRow;
    }

    let relAttemptScreenshot = frame.evidencePaths.screenshot;
    const screenBuf = decodeDataUrlPng(screenshotBase64) || decodeDataUrlPng(record.originalScreenshotBase64);
    if (screenBuf) {
      relAttemptScreenshot = `${relAttemptDir}/screenshot.png`;
      await writeImmutableEvidenceFile(path.join(runDir, relAttemptScreenshot), screenBuf);
    }

    const storedRow = buildStoredRowFromRecord(record, rules, {
      screenshot: relAttemptScreenshot,
      highlighted: rowPaths[String(rowIndex)],
      rowEvidence: rowPaths[String(rowIndex)],
    });

    const attemptEntry: VisualMatchStoredAttempt = {
      attemptId,
      timestamp: new Date().toISOString(),
      reason,
      ruleTested,
      boundaryStatus: record.boundaryStatus,
      screenshotPath: relAttemptScreenshot,
      highlightedPath: rowPaths[String(rowIndex)],
      rowPaths,
      rows: [storedRow],
    };

    await writeFileAtomic(path.join(absAttemptDir, "attempt.json"), JSON.stringify(attemptEntry, null, 2));
    attempts.push(attemptEntry);
    frame.attempts = attempts;

    // Update manifest frame entry attempt count & paths
    const mf = manifest.frames.find(f => f.frameIndex === frameIndex);
    if (mf) {
      mf.attemptCount = attempts.length;
      mf.evidencePaths.attempts = attempts.map(a => getRelativeAttemptDir(frameIndex, a.attemptId));
    }

    await writeFileAtomic(resultPath, JSON.stringify(result, null, 2));
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

    const logEntry: VisualMatchLogEntry = {
      timestamp: attemptEntry.timestamp,
      runId,
      level: "INFO",
      stage: "ATTEMPT",
      frameIndex,
      rowIndex,
      attemptId,
      message: `Saved frame #${frameIndex} row #${rowIndex} attempt ${attemptId} (${reason})`,
      details: { boundaryStatus: record.boundaryStatus, ruleTested },
    };
    await mkdir(logsDir, { recursive: true });
    await appendFile(pipelineLogPath, JSON.stringify(logEntry) + "\n", "utf8");

    return {
      ok: true,
      runId,
      frameIndex,
      rowIndex,
      attemptId,
      attemptDir: relAttemptDir,
      evidencePath: rowPaths[String(rowIndex)]
        ? `scratch/runs/${runId}/${rowPaths[String(rowIndex)]}`
        : `scratch/runs/${runId}/${relAttemptDir}`,
    };
  }

  async listRuns(): Promise<SavedRunSummaryItem[]> {
    const scratchDir = this.getScratchDir();
    const runsDir = this.getRunsDir();
    const result: Map<string, SavedRunSummaryItem> = new Map();

    // 1. Read structured runs in scratch/runs/{runId}/manifest.json
    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const runId = ent.name;
        if (runId.startsWith("run_audit_")) continue;
        const manifestPath = path.join(runsDir, runId, "manifest.json");
        try {
          const data = JSON.parse(await readFile(manifestPath, "utf8"));
          const totalFrames = data.summary?.totalFrames ?? data.totalFrames ?? 0;
          const totalProbed = data.summary?.totalProbed ?? 0;
          result.set(runId, {
            runId,
            timestamp: data.createdAt || data.timestamp || new Date().toISOString(),
            platform: data.platform || "facebook",
            totalFrames,
            actionRowsDetected: totalProbed,
            boundaryFoundCount: data.summary?.boundaryFoundCount || 0,
            boundaryAmbiguousCount: data.summary?.boundaryAmbiguousCount || 0,
            boundaryNotFoundCount: data.summary?.boundaryNotFoundCount || 0,
            jumpedZeroToTwoPlusCount: data.summary?.jumpedZeroToTwoPlusCount || 0,
            noActionRowCount:
              data.summary?.noActionRowCount ?? Math.max(0, totalFrames - totalProbed),
            source: "structured",
          });
        } catch {}
      }
    } catch {}

    // 2. Read legacy runs from scratch/visual-match-lab-boundary-debug-*.json (read-only compatibility)
    try {
      const files = await readdir(scratchDir);
      for (const file of files) {
        const match = /^visual-match-lab-boundary-debug-(run_[^.]+)\.json$/.exec(file);
        if (match) {
          const runId = match[1];
          if (runId.startsWith("run_audit_")) continue;
          if (!result.has(runId)) {
            try {
              const fullPath = path.join(scratchDir, file);
              const data = JSON.parse(await readFile(fullPath, "utf8"));
              result.set(runId, {
                runId,
                timestamp: data.timestamp || new Date().toISOString(),
                platform: data.environment?.platform || "facebook",
                totalFrames: data.totalFrames || 0,
                actionRowsDetected: data.summary?.totalProbed || 0,
                boundaryFoundCount: data.summary?.boundaryFoundCount || 0,
                boundaryAmbiguousCount: data.summary?.boundaryAmbiguousCount || 0,
                boundaryNotFoundCount: data.summary?.boundaryNotFoundCount || 0,
                jumpedZeroToTwoPlusCount: data.summary?.jumpedZeroToTwoPlusCount || 0,
                noActionRowCount: Math.max(0, (data.totalFrames || 0) - (data.summary?.totalProbed || 0)),
                source: "legacy",
              });
            } catch {}
          }
        }
      }
    } catch {}

    return Array.from(result.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async loadRun(runId: string): Promise<{
    ok: boolean;
    report: BoundaryDebugReport;
    manifest?: VisualMatchRunManifest;
    runId: string;
  }> {
    const scratchDir = this.getScratchDir();
    const runDir = this.getRunDir(runId);

    // 1. Check V2 isolated run first (runs/{runId}/manifest.json + result.json)
    try {
      const manifestPath = path.join(runDir, "manifest.json");
      const resultPath = path.join(runDir, "result.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as VisualMatchRunManifest;
      const runResult = JSON.parse(await readFile(resultPath, "utf8")) as VisualMatchRunResult;

      const hydratedFrames: VisualMatchStoredFrame[] = [];
      const screenshotByFrame = new Map<number, string>();
      const highlightedByFrame = new Map<number, string>();
      const rowBase64ByFrameRow = new Map<string, { dataUrl: string; savedPath: string }>();

      for (const f of runResult.frames ?? []) {
        let screenshotBase64: string | undefined;
        let highlightedBase64: string | undefined;
        const rowBase64Map: Record<number, string> = {};

        if (f.evidencePaths?.screenshot) {
          const absScreen = path.join(runDir, f.evidencePaths.screenshot);
          try {
            const buf = await readFile(absScreen);
            screenshotBase64 = `data:image/png;base64,${buf.toString("base64")}`;
            screenshotByFrame.set(f.frameIndex, screenshotBase64);
          } catch {}
        }

        if (f.evidencePaths?.highlighted) {
          const absHl = path.join(runDir, f.evidencePaths.highlighted);
          try {
            const buf = await readFile(absHl);
            highlightedBase64 = `data:image/png;base64,${buf.toString("base64")}`;
            highlightedByFrame.set(f.frameIndex, highlightedBase64);
          } catch {}
        }

        for (const [rowKey, relRowPath] of Object.entries(f.evidencePaths?.rows ?? {})) {
          const rIdx = Number(rowKey);
          const absRow = path.join(runDir, relRowPath);
          try {
            const buf = await readFile(absRow);
            const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
            rowBase64Map[rIdx] = dataUrl;
            rowBase64ByFrameRow.set(`${f.frameIndex}:${rIdx}`, {
              dataUrl,
              savedPath: `scratch/runs/${runId}/${relRowPath}`,
            });
          } catch {}
        }

        hydratedFrames.push({
          ...f,
          screenshotBase64,
          highlightedBase64,
          rowBase64Map,
        });
      }

      const hydratedRecords: BoundaryDebugRecord[] = (runResult.records ?? []).map(rec => {
        const rowEntry = rowBase64ByFrameRow.get(`${rec.frameNumber}:${rec.rowIndex}`);
        const origDataUrl = screenshotByFrame.get(rec.frameNumber);
        const hlDataUrl = highlightedByFrame.get(rec.frameNumber);
        const relRow = getRelativeRowPath(rec.frameNumber, rec.rowIndex);
        const relScreen = getRelativeScreenshotPath(rec.frameNumber);
        return {
          ...rec,
          evidenceScreenshotBase64: rowEntry?.dataUrl ?? hlDataUrl ?? origDataUrl,
          evidenceScreenshotSaved: rowEntry?.savedPath ?? `scratch/runs/${runId}/${relRow}`,
          originalScreenshotBase64: origDataUrl,
          originalScreenshotSaved: `scratch/runs/${runId}/${relScreen}`,
        };
      });

      const pipelineLogs: VisualMatchLogEntry[] = [];
      const errorLogs: VisualMatchLogEntry[] = [];
      try {
        const pText = await readFile(path.join(runDir, "logs", "pipeline.jsonl"), "utf8");
        for (const line of pText.split("\n")) {
          if (line.trim()) pipelineLogs.push(JSON.parse(line));
        }
      } catch {}
      try {
        const eText = await readFile(path.join(runDir, "logs", "errors.jsonl"), "utf8");
        for (const line of eText.split("\n")) {
          if (line.trim()) errorLogs.push(JSON.parse(line));
        }
      } catch {}

      const report: BoundaryDebugReport = {
        runId: manifest.runId,
        timestamp: manifest.createdAt,
        createdAt: manifest.createdAt,
        completedAt: manifest.completedAt,
        status: manifest.status,
        environment: runResult.environment,
        sessionRef: manifest.sessionRef,
        scrollSettings: manifest.scrollSettings,
        frameLimit: manifest.frameLimit,
        configVersion: manifest.configVersion,
        totalFrames: runResult.totalFrames,
        records: hydratedRecords,
        frames: hydratedFrames,
        pipelineLogs,
        errorLogs,
        summary: runResult.summary,
      };

      return { ok: true, report, manifest, runId };
    } catch {
      // Fall through to V1 structured run or legacy flat JSON
    }

    // 2. Check V1 structured run (runs/{runId}/manifest.json + frames/001/debug.json)
    try {
      const manifestPath = path.join(runDir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const framesDir = path.join(runDir, "frames");
      const frameEntries = await readdir(framesDir, { withFileTypes: true });
      const records: BoundaryDebugRecord[] = [];
      for (const fe of frameEntries) {
        if (!fe.isDirectory()) continue;
        const debugPath = path.join(framesDir, fe.name, "debug.json");
        try {
          const frameRecords: BoundaryDebugRecord[] = JSON.parse(await readFile(debugPath, "utf8"));
          for (const r of frameRecords) {
            const imgPath = path.join(framesDir, fe.name, `highlighted-r${r.rowIndex}.png`);
            try {
              const imgBuf = await readFile(imgPath);
              r.evidenceScreenshotBase64 = `data:image/png;base64,${imgBuf.toString("base64")}`;
              r.evidenceScreenshotSaved = `scratch/runs/${runId}/frames/${fe.name}/highlighted-r${r.rowIndex}.png`;
            } catch {}
            records.push(r);
          }
        } catch {}
      }
      records.sort((a, b) => a.frameNumber - b.frameNumber || a.rowIndex - b.rowIndex);
      const report: BoundaryDebugReport = {
        runId: manifest.runId,
        timestamp: manifest.timestamp,
        environment: { width: 1024, height: 560, zoom: 1, platform: manifest.platform || "facebook" },
        totalFrames: manifest.totalFrames,
        records,
        summary: manifest.summary,
      };
      return { ok: true, report, runId };
    } catch {
      // Fall through to legacy flat JSON
    }

    // 3. Fallback to legacy flat JSON (scratch/visual-match-lab-boundary-debug-{runId}.json)
    const legacyPath = path.join(scratchDir, `visual-match-lab-boundary-debug-${runId}.json`);
    try {
      const report = JSON.parse(await readFile(legacyPath, "utf8")) as BoundaryDebugReport;
      if (report) {
        const synthetic = report.runId.startsWith("run_audit_");
        for (const r of report.records) {
          if (r.evidenceScreenshotBase64 && r.evidenceScreenshotBase64.startsWith("data:image/")) {
            continue;
          }
          if (synthetic) continue;
          const candidates: string[] = [];
          if (r.evidenceScreenshotSaved) {
            candidates.push(r.evidenceScreenshotSaved);
            candidates.push(path.join(scratchDir, path.basename(r.evidenceScreenshotSaved)));
          }
          candidates.push(path.join(scratchDir, `boundary-evidence-${report.runId}-f${r.frameNumber}-r${r.rowIndex}.png`));
          candidates.push(path.join(scratchDir, `boundary-evidence-f${r.frameNumber}-r${r.rowIndex}.png`));

          for (const p of candidates) {
            try {
              const imgBuf = await readFile(p);
              r.evidenceScreenshotBase64 = `data:image/png;base64,${imgBuf.toString("base64")}`;
              r.evidenceScreenshotSaved = p;
              break;
            } catch {}
          }
        }
        return { ok: true, report, runId };
      }
    } catch {}

    throw new Error(`RUN_NOT_FOUND: Could not load run ${runId}`);
  }
}
