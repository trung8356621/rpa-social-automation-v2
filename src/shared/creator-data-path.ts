/**
 * Resolve the mutable Creator userData directory name under `.local/`.
 * `--qa-profile=<name>` is stable across restarts; `--qa-isolated` stays PID-scoped.
 */
export function sanitizeQaProfileName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!cleaned) {
    throw new Error("QA profile name is empty after sanitization.");
  }
  if (cleaned === "creator" || cleaned.startsWith("qa-isolated-")) {
    throw new Error(`QA profile name reserved: ${cleaned}`);
  }
  return cleaned;
}

export function parseQaProfileArg(argv: readonly string[]): string | undefined {
  const prefixed = argv.find((a) => a.startsWith("--qa-profile="));
  if (prefixed) {
    return sanitizeQaProfileName(prefixed.slice("--qa-profile=".length));
  }
  const idx = argv.indexOf("--qa-profile");
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1]!.startsWith("--")) {
    return sanitizeQaProfileName(argv[idx + 1]!);
  }
  return undefined;
}

export function resolveCreatorDataDirName(input: {
  argv?: readonly string[];
  pid?: number;
  selfTest?: boolean;
  phase?: string;
  postDetailBrowserCheck?: boolean;
  creatorWorkspaceRestoreCheck?: boolean;
  engagementCaptureCheck?: boolean;
  engagementOcrReplay?: boolean;
  qaIsolated?: boolean;
}): string {
  const argv = input.argv ?? [];
  const pid = input.pid ?? process.pid;
  const phase =
    input.phase ??
    argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ??
    "first";
  const selfTest = input.selfTest ?? argv.includes("--self-test");
  const postDetailBrowserCheck =
    input.postDetailBrowserCheck ?? argv.includes("--post-detail-browser-check");
  const creatorWorkspaceRestoreCheck =
    input.creatorWorkspaceRestoreCheck ??
    argv.includes("--creator-workspace-restore-check");
  const engagementCaptureCheck =
    input.engagementCaptureCheck ?? argv.includes("--engagement-capture-check");
  const engagementOcrReplay =
    input.engagementOcrReplay ?? argv.includes("--engagement-ocr-replay");
  const qaIsolated = input.qaIsolated ?? argv.includes("--qa-isolated");
  const qaProfile = parseQaProfileArg(argv);

  if (selfTest) {
    return [
      "creator-ui",
      "creator-native",
      "playback-ui",
      "overlay",
      "ux",
      "ocr",
      "typing",
      "upload",
      "address",
    ].includes(phase)
      ? `test-${phase}-${pid}`
      : "test-session";
  }
  if (postDetailBrowserCheck) return `post-detail-check-${pid}`;
  if (creatorWorkspaceRestoreCheck) return `creator-workspace-restore-check-${pid}`;
  if (engagementCaptureCheck || engagementOcrReplay) {
    return `engagement-capture-check-${pid}`;
  }
  // Stable QA profile wins over PID-scoped --qa-isolated when both are present.
  if (qaProfile) return `qa-profile-${qaProfile}`;
  if (qaIsolated) return `qa-isolated-${pid}`;
  return "creator";
}
