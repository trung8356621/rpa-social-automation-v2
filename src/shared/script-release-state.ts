import {
  isLegacyPublishedScriptVersion,
  nextPublishedScriptVersion,
  parsePublishedScriptVersion,
} from "./script-version.js";

export type StoredScriptRelease = {
  version?: string;
  contentDigest?: string;
  executionDigest?: string;
  pendingVersion?: string;
  pendingContentDigest?: string;
  pendingExecutionDigest?: string;
};

export type RemoteScriptRelease = {
  version: string;
  content_digest: string;
  execution_digest?: string;
};

export type VerifiedLegacyRelease = {
  executionDigest: string;
  contentDigest?: string;
};

/**
 * High-trust publish versioning: SEO-OPS remote is the baseline.
 * No conflict blocks — adopt remote when present, bump next integer when content changed.
 */
export function resolveScriptReleaseState(input: {
  local: StoredScriptRelease;
  remote?: RemoteScriptRelease;
  currentExecutionDigest: string;
  verifiedLegacy?: VerifiedLegacyRelease;
}) {
  const local = { ...input.local };
  let adoptedRemote = false;

  if (input.remote) {
    parsePublishedScriptVersion(input.remote.version);
    const remoteChanged =
      !local.version ||
      parsePublishedScriptVersion(local.version).ordinal !==
        parsePublishedScriptVersion(input.remote.version).ordinal ||
      (Boolean(local.contentDigest) && local.contentDigest !== input.remote.content_digest) ||
      (Boolean(local.executionDigest) &&
        Boolean(input.remote.execution_digest) &&
        local.executionDigest !== input.remote.execution_digest);
    if (remoteChanged) adoptedRemote = true;
    local.version = input.remote.version;
    local.contentDigest = input.remote.content_digest;
    if (input.remote.execution_digest) local.executionDigest = input.remote.execution_digest;
  }

  if (local.version && !local.executionDigest) {
    if (
      input.verifiedLegacy &&
      isLegacyPublishedScriptVersion(local.version) &&
      input.verifiedLegacy.executionDigest === input.currentExecutionDigest
    ) {
      const parsed = parsePublishedScriptVersion(local.version);
      local.executionDigest = input.verifiedLegacy.executionDigest;
      if (input.verifiedLegacy.contentDigest) {
        local.contentDigest = input.verifiedLegacy.contentDigest;
      }
      if (!input.remote) local.version = String(parsed.ordinal);
    } else if (isLegacyPublishedScriptVersion(local.version)) {
      // Soft recover: normalize legacy label; missing digest means "changed" → bump.
      local.version = String(parsePublishedScriptVersion(local.version).ordinal);
    }
    // Missing digest is not a hard block — treat as needing a fresh publish when syncing.
  }

  const publishedExec = local.executionDigest;
  const changed = Boolean(
    local.version && (!publishedExec || publishedExec !== input.currentExecutionDigest),
  );
  const expectedNext = !local.version
    ? "1"
    : changed
      ? nextPublishedScriptVersion(local.version)
      : local.version;
  // Reuse pending only when it already matches the simple next version.
  const pendingMatches = Boolean(
    local.pendingVersion &&
      local.pendingExecutionDigest === input.currentExecutionDigest &&
      local.pendingVersion === expectedNext,
  );
  const targetVersion = pendingMatches ? local.pendingVersion! : expectedNext;
  const ordinal = local.version ? parsePublishedScriptVersion(local.version).ordinal : undefined;

  return {
    ok: true as const,
    local,
    adoptedRemote,
    changed,
    targetVersion,
    draftStatus: !local.version ? ("new" as const) : changed ? ("changed" as const) : ("unchanged" as const),
    draftVersion: changed && ordinal ? `${ordinal}.1` : undefined,
  };
}
