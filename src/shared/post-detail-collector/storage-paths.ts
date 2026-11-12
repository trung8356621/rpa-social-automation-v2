export function formatPostDetailFrameFolder(frameIndex: number): string {
  const safe = Math.max(1, Math.floor(Number(frameIndex) || 1));
  return `frame-${String(safe).padStart(3, "0")}`;
}

export function getPostDetailRelativeFrameDir(frameIndex: number): string {
  return `frames/${formatPostDetailFrameFolder(frameIndex)}`;
}

export function getPostDetailScreenshotPath(frameIndex: number): string {
  return `${getPostDetailRelativeFrameDir(frameIndex)}/screenshot.png`;
}

export function getPostDetailCropPath(frameIndex: number): string {
  return `${getPostDetailRelativeFrameDir(frameIndex)}/ocr-crop.png`;
}

export function getPostDetailOcrTextPath(frameIndex: number): string {
  return `${getPostDetailRelativeFrameDir(frameIndex)}/ocr.txt`;
}

export function getPostDetailFrameMetaPath(frameIndex: number): string {
  return `${getPostDetailRelativeFrameDir(frameIndex)}/meta.json`;
}

export function getPostDetailTemplatePath(sampleId: string): string {
  const safe = sampleId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "template";
  return `templates/${safe}.png`;
}

export function assertSafeRunId(runId: string): string {
  if (!runId || typeof runId !== "string" || /[\\/]/.test(runId) || runId.includes("..")) {
    throw new Error(`INVALID_RUN_ID: "${runId}"`);
  }
  return runId;
}
