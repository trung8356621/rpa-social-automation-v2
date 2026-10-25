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

export function resolveScriptReleaseState(input: {
  local: StoredScriptRelease;
  remote?: RemoteScriptRelease;
  currentExecutionDigest: string;
  verifiedLegacy?: VerifiedLegacyRelease;
}) {
  const local = { ...input.local };
  let adoptedRemote = false;
  if (!local.version && input.remote) {
    parsePublishedScriptVersion(input.remote.version);
    local.version = input.remote.version;
    local.contentDigest = input.remote.content_digest;
    local.executionDigest = input.remote.execution_digest;
    adoptedRemote = true;
  } else if (local.version && input.remote) {
    const localOrdinal = parsePublishedScriptVersion(local.version).ordinal;
    const remoteOrdinal = parsePublishedScriptVersion(input.remote.version).ordinal;
    if (localOrdinal !== remoteOrdinal || (local.contentDigest && local.contentDigest !== input.remote.content_digest)) {
      return { ok: false as const, error: "SCRIPT_VERSION_CONFLICT", local, adoptedRemote: false };
    }
    local.contentDigest ||= input.remote.content_digest;
    local.executionDigest ||= input.remote.execution_digest;
    adoptedRemote = local.contentDigest !== input.local.contentDigest || local.executionDigest !== input.local.executionDigest;
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
      if (!input.remote) {
        local.version = String(parsed.ordinal);
      }
    } else {
      return { ok: false as const, error: "SCRIPT_VERSION_METADATA_INCOMPLETE", local, adoptedRemote };
    }
  }

  const changed = Boolean(local.version && local.executionDigest !== input.currentExecutionDigest);
  const pendingMatches = Boolean(local.pendingVersion && local.pendingExecutionDigest === input.currentExecutionDigest);
  const targetVersion = pendingMatches
    ? local.pendingVersion!
    : !local.version
      ? "1"
      : changed
        ? nextPublishedScriptVersion(local.version)
        : local.version;
  const ordinal = local.version ? parsePublishedScriptVersion(local.version).ordinal : undefined;

  return {
    ok: true as const,
    local,
    adoptedRemote,
    changed,
    targetVersion,
    draftStatus: !local.version ? "new" as const : changed ? "changed" as const : "unchanged" as const,
    draftVersion: changed && ordinal ? `${ordinal}.1` : undefined,
  };
}
