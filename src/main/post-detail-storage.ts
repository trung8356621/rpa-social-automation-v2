import path from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { writeFileAtomic } from "./visual-match-lab-storage.js";
import {
  assertSafeRunId,
  getPostDetailCropPath,
  getPostDetailFrameMetaPath,
  getPostDetailOcrTextPath,
  getPostDetailRelativeFrameDir,
  getPostDetailScreenshotPath,
  getPostDetailTemplatePath,
} from "../shared/post-detail-collector/storage-paths.js";
import {
  POST_DETAIL_SCHEMA_VERSION,
  type PostDetailLoadRunResult,
  type PostDetailHtmlExtractionResult,
  type PostDetailOcrFrame,
  type PostDetailRunManifest,
  type PostDetailSaveAutoScanInput,
  type PostDetailSaveAutoScanResult,
  type PostDetailSaveRunInput,
  type PostDetailSaveRunResult,
  type PostDetailSavedRunSummary,
  type VisualReferenceSample,
} from "../shared/post-detail-collector/types.js";

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

function toDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export class PostDetailRunStorage {
  constructor(private readonly projectDir: string = process.cwd()) {}

  getRunsDir(): string {
    return path.join(this.projectDir, "scratch", "post-detail-runs");
  }

  getRunDir(runId: string): string {
    return path.join(this.getRunsDir(), assertSafeRunId(runId));
  }

  async saveHtmlExtraction(result: PostDetailHtmlExtractionResult): Promise<Record<string, string>> {
    const runDir = this.getRunDir(result.runId);
    const dir = path.join(runDir, "html-extraction");
    await mkdir(dir, { recursive: true });
    const paths = {
      rawHtml: path.join(dir, "raw-ancestor.html"),
      extractedHtml: path.join(dir, "post-detail.html"),
      boundary: path.join(dir, "boundary.json"),
      result: path.join(dir, "result.json"),
    };
    await writeFileAtomic(paths.rawHtml, result.rawHtml);
    await writeFileAtomic(paths.extractedHtml, result.extractedHtml);
    await writeFileAtomic(paths.boundary, JSON.stringify(result.boundary, null, 2));
    await writeFileAtomic(paths.result, JSON.stringify({
      status: result.status,
      parsed: result.parsed,
      diagnostics: result.diagnostics,
    }, null, 2));
    return paths;
  }

  /**
   * Persist Step 2 Auto Scan evidence without writing final OCR `manifest.json`.
   * Never overwrites an existing auto-scan-manifest for the same runId.
   */
  async saveAutoScan(input: PostDetailSaveAutoScanInput): Promise<PostDetailSaveAutoScanResult> {
    const runId = assertSafeRunId(input.runId);
    const runDir = this.getRunDir(runId);
    const autoScanManifestPath = path.join(runDir, "auto-scan-manifest.json");
    const containerPath = path.join(runDir, "container-result.json");

    try {
      const existing = await stat(autoScanManifestPath);
      if (existing.isFile() && existing.size > 0) {
        throw new Error(`POST_DETAIL_AUTO_SCAN_EXISTS: runId "${runId}" already has auto-scan evidence.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("POST_DETAIL_AUTO_SCAN_EXISTS")) throw err;
    }

    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "frames"), { recursive: true });
    await mkdir(path.join(runDir, "templates"), { recursive: true });
    await mkdir(path.join(runDir, "logs"), { recursive: true });

    const nowIso = new Date().toISOString();
    const visualReferences: Array<Record<string, unknown>> = [];
    for (const sample of input.visualReferences ?? []) {
      const rel = getPostDetailTemplatePath(sample.sampleId);
      const abs = path.join(runDir, rel);
      const buf = decodeDataUrlPng(sample.dataUrl);
      if (buf) await writeFileAtomic(abs, buf);
      visualReferences.push({
        sampleId: sample.sampleId,
        label: sample.label,
        width: sample.width,
        height: sample.height,
        sourceCaptureId: sample.sourceCaptureId,
        bbox: sample.bbox,
        createdAt: sample.createdAt,
        templatePath: rel,
      });
    }

    const framesMeta: Array<Record<string, unknown>> = [];
    for (const frame of input.frames ?? []) {
      const idx = Math.max(1, frame.frameIndex);
      const shotRel = getPostDetailScreenshotPath(idx);
      const metaRel = getPostDetailFrameMetaPath(idx);
      await mkdir(path.join(runDir, getPostDetailRelativeFrameDir(idx)), { recursive: true });

      const shotBuf = decodeDataUrlPng(frame.screenshotDataUrl);
      if (shotBuf) await writeFileAtomic(path.join(runDir, shotRel), shotBuf);

      const meta = {
        runId,
        frameId: frame.frameId,
        frameIndex: idx,
        scrollDeltaApplied: frame.scrollDeltaApplied,
        observedScrollPx: frame.observedScrollPx,
        width: frame.width,
        height: frame.height,
        anchors: frame.anchors,
        anchorCandidates: frame.anchorCandidates,
        diagnostics: frame.diagnostics
          ? {
              ...frame.diagnostics,
              // Drop bulky per-pixel data; keep scores/bboxes only.
              matchLogs: frame.diagnostics.matchLogs,
            }
          : undefined,
        notes: frame.notes,
        screenshotPath: shotBuf ? shotRel : undefined,
        phase: "auto-scan",
        createdAt: nowIso,
      };
      await writeFileAtomic(path.join(runDir, metaRel), JSON.stringify(meta, null, 2));
      framesMeta.push(meta);
    }

    const containerWithoutSecrets = {
      ...input.container,
      // Never persist credentials — sourceUrl only.
      notes: [...(input.container.notes || []), `failureOrStop=${input.container.scrollMetadata.stoppedReason}`],
    };
    await writeFileAtomic(containerPath, JSON.stringify(containerWithoutSecrets, null, 2));
    await writeFileAtomic(
      path.join(runDir, "scroll-metadata.json"),
      JSON.stringify(input.container.scrollMetadata, null, 2),
    );

    const autoScanManifest = {
      schemaVersion: POST_DETAIL_SCHEMA_VERSION,
      kind: "POST_DETAIL_AUTO_SCAN",
      runId,
      sourceUrl: input.sourceUrl || "",
      createdAt: nowIso,
      frameCount: framesMeta.length,
      visualReferenceCount: visualReferences.length,
      containerStatus: input.container.status,
      confidence: input.container.confidence,
      containerBounds: input.container.containerBounds,
      scrollMetadata: input.container.scrollMetadata,
      visualReferences,
      frames: framesMeta,
      evidenceRefs: input.container.evidenceRefs,
      notes: input.container.notes,
    };
    await writeFileAtomic(autoScanManifestPath, JSON.stringify(autoScanManifest, null, 2));

    return {
      ok: true,
      runId,
      runDir,
      autoScanManifestPath,
      frameCount: framesMeta.length,
    };
  }

  async saveRun(input: PostDetailSaveRunInput): Promise<PostDetailSaveRunResult> {
    const runId = assertSafeRunId(input.runId);
    const runDir = this.getRunDir(runId);
    const manifestPath = path.join(runDir, "manifest.json");

    // Never overwrite an existing completed run — caller must use a new runId.
    try {
      const existing = await stat(manifestPath);
      if (existing.isFile() && existing.size > 0) {
        throw new Error(`POST_DETAIL_RUN_EXISTS: runId "${runId}" already saved. Create a new run.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("POST_DETAIL_RUN_EXISTS")) throw err;
    }

    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "frames"), { recursive: true });
    await mkdir(path.join(runDir, "templates"), { recursive: true });
    await mkdir(path.join(runDir, "logs"), { recursive: true });

    const nowIso = new Date().toISOString();
    const visualReferences: Array<Omit<VisualReferenceSample, "dataUrl"> & { templatePath?: string }> = [];

    for (const sample of input.visualReferences ?? []) {
      const rel = getPostDetailTemplatePath(sample.sampleId);
      const abs = path.join(runDir, rel);
      const buf = decodeDataUrlPng(sample.dataUrl);
      if (buf) await writeFileAtomic(abs, buf);
      visualReferences.push({
        sampleId: sample.sampleId,
        label: sample.label,
        width: sample.width,
        height: sample.height,
        sourceCaptureId: sample.sourceCaptureId,
        bbox: sample.bbox,
        createdAt: sample.createdAt,
        templatePath: rel,
      });
    }

    const framesMeta: Array<Record<string, unknown>> = [];
    for (const frame of input.frames ?? []) {
      const idx = Math.max(1, frame.frameIndex);
      const shotRel = getPostDetailScreenshotPath(idx);
      const cropRel = getPostDetailCropPath(idx);
      const textRel = getPostDetailOcrTextPath(idx);
      const metaRel = getPostDetailFrameMetaPath(idx);

      const shotBuf = decodeDataUrlPng(frame.screenshotDataUrl);
      if (shotBuf) await writeFileAtomic(path.join(runDir, shotRel), shotBuf);
      const cropBuf = decodeDataUrlPng(frame.cropDataUrl);
      if (cropBuf) await writeFileAtomic(path.join(runDir, cropRel), cropBuf);
      await writeFileAtomic(path.join(runDir, textRel), frame.ocrText ?? "");

      const meta = {
        runId,
        frameId: frame.frameId,
        frameIndex: idx,
        scrollY: frame.scrollY,
        roi: frame.roi,
        screenshotPath: shotBuf ? shotRel : frame.screenshotPath,
        cropPath: cropBuf ? cropRel : frame.cropPath,
        ocrTextPath: textRel,
        ocrText: frame.ocrText,
        ocrConfidence: frame.ocrConfidence,
        ocrSegments: frame.ocrSegments,
        matchStatus: frame.matchStatus,
        matchScore: frame.matchScore,
        matchTemplateId: frame.matchTemplateId,
        processingStatus: frame.processingStatus,
        diagnostics: frame.diagnostics,
        createdAt: frame.createdAt,
      };
      await writeFileAtomic(path.join(runDir, metaRel), JSON.stringify(meta, null, 2));
      framesMeta.push(meta);
    }

    const manifest: PostDetailRunManifest & {
      visualReferences: typeof visualReferences;
      frames: typeof framesMeta;
    } = {
      schemaVersion: POST_DETAIL_SCHEMA_VERSION,
      kind: "POST_DETAIL",
      runId,
      sourceUrl: input.sourceUrl || "",
      platform: input.platform || "Facebook",
      createdAt: input.createdAt || nowIso,
      completedAt: nowIso,
      frameCount: framesMeta.length,
      visualReferenceCount: visualReferences.length,
      viewport: input.viewport,
      visualReferences,
      frames: framesMeta,
    };

    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFileAtomic(
      path.join(runDir, "result.json"),
      JSON.stringify(
        {
          runId,
          sourceUrl: manifest.sourceUrl,
          frameCount: framesMeta.length,
          visualReferenceCount: visualReferences.length,
          completedAt: nowIso,
        },
        null,
        2,
      ),
    );

    return {
      ok: true,
      runId,
      runDir,
      manifestPath,
      frameCount: framesMeta.length,
    };
  }

  async listRuns(): Promise<PostDetailSavedRunSummary[]> {
    const root = this.getRunsDir();
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const out: PostDetailSavedRunSummary[] = [];
    for (const name of entries) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(root, name, "manifest.json"), "utf8"),
        ) as PostDetailRunManifest;
        if (manifest.kind !== "POST_DETAIL") continue;
        out.push({
          runId: manifest.runId,
          sourceUrl: manifest.sourceUrl,
          createdAt: manifest.createdAt,
          frameCount: manifest.frameCount,
          platform: manifest.platform,
        });
      } catch {
        // skip incomplete dirs
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  async loadRun(runId: string): Promise<PostDetailLoadRunResult> {
    const safeId = assertSafeRunId(runId);
    const runDir = this.getRunDir(safeId);
    const raw = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as PostDetailRunManifest & {
      visualReferences?: Array<VisualReferenceSample & { templatePath?: string; dataUrl?: string }>;
      frames?: Array<PostDetailOcrFrame & { ocrTextPath?: string }>;
    };

    const visualReferences: VisualReferenceSample[] = [];
    for (const sample of raw.visualReferences ?? []) {
      let dataUrl = sample.dataUrl || "";
      if (!dataUrl && sample.templatePath) {
        try {
          dataUrl = toDataUrl(await readFile(path.join(runDir, sample.templatePath)));
        } catch {
          dataUrl = "";
        }
      }
      visualReferences.push({
        sampleId: sample.sampleId,
        label: sample.label,
        dataUrl,
        width: sample.width,
        height: sample.height,
        sourceCaptureId: sample.sourceCaptureId,
        bbox: sample.bbox,
        createdAt: sample.createdAt,
      });
    }

    const frames: PostDetailOcrFrame[] = [];
    for (const frame of raw.frames ?? []) {
      let screenshotDataUrl = frame.screenshotDataUrl;
      let cropDataUrl = frame.cropDataUrl;
      if (!screenshotDataUrl && frame.screenshotPath) {
        try {
          screenshotDataUrl = toDataUrl(await readFile(path.join(runDir, frame.screenshotPath)));
        } catch {
          /* missing */
        }
      }
      if (!cropDataUrl && frame.cropPath) {
        try {
          cropDataUrl = toDataUrl(await readFile(path.join(runDir, frame.cropPath)));
        } catch {
          /* missing */
        }
      }
      let ocrText = frame.ocrText ?? "";
      if (!ocrText && (frame as { ocrTextPath?: string }).ocrTextPath) {
        try {
          ocrText = await readFile(
            path.join(runDir, (frame as { ocrTextPath?: string }).ocrTextPath!),
            "utf8",
          );
        } catch {
          /* missing */
        }
      }
      frames.push({
        ...frame,
        ocrText,
        screenshotDataUrl,
        cropDataUrl,
      });
    }

    frames.sort((a, b) => a.frameIndex - b.frameIndex);

    return {
      ok: true,
      runId: safeId,
      manifest: {
        schemaVersion: raw.schemaVersion || POST_DETAIL_SCHEMA_VERSION,
        kind: "POST_DETAIL",
        runId: raw.runId,
        sourceUrl: raw.sourceUrl,
        platform: raw.platform,
        createdAt: raw.createdAt,
        completedAt: raw.completedAt,
        frameCount: frames.length,
        visualReferenceCount: visualReferences.length,
        viewport: raw.viewport,
      },
      visualReferences,
      frames,
    };
  }
}
