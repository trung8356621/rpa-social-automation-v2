export type PublishedScriptVersion = {
  raw: string;
  ordinal: number;
  kind: "integer" | "legacy-semver";
};

/**
 * Integer releases are canonical. Historical X.0.0 releases remain readable and
 * map to ordinal X; other SemVer values are ambiguous and must be resolved rather
 * than silently truncated.
 */
export function parsePublishedScriptVersion(raw: string): PublishedScriptVersion {
  const value = raw.trim();
  if (/^[1-9][0-9]*$/.test(value)) return { raw: value, ordinal: Number(value), kind: "integer" };
  const legacy = /^([1-9][0-9]*)\.0\.0$/.exec(value);
  if (legacy) return { raw: value, ordinal: Number(legacy[1]), kind: "legacy-semver" };
  throw new Error(`SCRIPT_VERSION_UNSUPPORTED: ${value || "empty"}; expected an integer or legacy X.0.0`);
}

export function nextPublishedScriptVersion(current?: string): string {
  if (!current) return "1";
  const parsed = parsePublishedScriptVersion(current);
  if (!Number.isSafeInteger(parsed.ordinal) || parsed.ordinal >= Number.MAX_SAFE_INTEGER)
    throw new Error(`SCRIPT_VERSION_UNSUPPORTED: ${current}`);
  return String(parsed.ordinal + 1);
}

export function isLegacyPublishedScriptVersion(current?: string): boolean {
  return Boolean(current && parsePublishedScriptVersion(current).kind === "legacy-semver");
}
