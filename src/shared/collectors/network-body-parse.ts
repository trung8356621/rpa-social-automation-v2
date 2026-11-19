import type { NetworkBodyParseStatus } from "./capture-session-types.js";

export type NetworkBodyParseResult = {
  status: NetworkBodyParseStatus;
  objectCount: number;
  objects?: unknown[];
  error?: string;
};

/**
 * Strip common XSSI / JSON hijacking prefixes used by many sites
 * (e.g. `for (;;);`, `while(1);`, `)]}'`). Not endpoint-specific.
 */
export function stripJsonDefensePrefix(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/i, "")
    .replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/i, "")
    .replace(/^\s*while\s*\(\s*true\s*\)\s*;\s*/i, "")
    .replace(/^\s*\)\s*\]\s*\}\s*',?\s*/i, "")
    .trim();
}

/** Parse response text as NDJSON lines, whole JSON object/array, or raw. */
export function parseNetworkResponseText(text: string): NetworkBodyParseResult {
  const trimmed = stripJsonDefensePrefix(text);
  if (!trimmed) {
    return { status: "empty", objectCount: 0 };
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const objects: unknown[] = [];
    let failed = 0;
    for (const line of lines) {
      try {
        objects.push(JSON.parse(line));
      } catch {
        failed += 1;
      }
    }
    if (objects.length && !failed) {
      return { status: "ndjson_ok", objectCount: objects.length, objects };
    }
    if (objects.length && failed) {
      return {
        status: "ndjson_partial",
        objectCount: objects.length,
        objects,
        error: `${failed} NDJSON line(s) failed to parse`,
      };
    }
  }

  try {
    const value = JSON.parse(trimmed);
    const objectCount = Array.isArray(value) ? value.length : 1;
    return { status: "json_ok", objectCount, objects: Array.isArray(value) ? value : [value] };
  } catch (error) {
    if (lines.length === 1) {
      try {
        const value = JSON.parse(lines[0]!);
        return {
          status: "json_ok",
          objectCount: Array.isArray(value) ? value.length : 1,
          objects: Array.isArray(value) ? value : [value],
        };
      } catch {
        /* fall through */
      }
    }
    return {
      status: "json_invalid",
      objectCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function safeRequestFileId(requestId: string): string {
  return requestId.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 180) || "unknown";
}
