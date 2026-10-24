import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function copyStable(source: string, target: string) {
  try { if ((await stat(target)).size > 0) return; } catch { /* Copy a new immutable demo. */ }
  const temporary = `${target}.tmp-${randomUUID()}`;
  try { await copyFile(source, temporary); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Copy selected evidence outside Test Run retention; returns portable relative refs. */
export async function promoteScriptDemoFiles(input: {
  testRunsDir: string;
  flowId: string;
  runId: string;
  videoSource: string;
  thumbnailSource: string;
}) {
  const safeSegment = (value: string) => value !== "." && value !== ".." && /^[a-z0-9._-]{1,128}$/i.test(value);
  if (!safeSegment(input.flowId) || !safeSegment(input.runId))
    throw new Error("VIDEO_DEMO: invalid Scenario or Test Run association");
  const relativeDirectory = `demos/${input.flowId}/${input.runId}`;
  const directory = path.join(input.testRunsDir, "demos", input.flowId, input.runId);
  await mkdir(directory, { recursive: true });
  await copyStable(input.videoSource, path.join(directory, "recording.webm"));
  await copyStable(input.thumbnailSource, path.join(directory, "recording-thumb.jpg"));
  return {
    artifactRef: `${relativeDirectory}/recording.webm`,
    thumbnailRef: `${relativeDirectory}/recording-thumb.jpg`,
  };
}
