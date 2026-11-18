import type { ActionTag, PathInput } from "./contracts.js";

export type ResolveActionTagUrlInput = {
  baseUrl?: string | null;
  urlPattern?: string | null;
  pathInputs?: PathInput[];
  values?: Record<string, string>;
};

export type ResolveActionTagUrlResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "missing_metadata" | "missing_inputs" | "invalid";
      missingKeys?: string[];
      message: string;
    };

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

export function pathPlaceholders(pattern: string): string[] {
  return [...String(pattern || "").matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Resolve Site Base URL + Path URL Pattern (+ path input values) into a final absolute URL.
 * Does not invent URLs from tag_key alone.
 */
export function resolveActionTagUrl(input: ResolveActionTagUrlInput): ResolveActionTagUrlResult {
  const base = String(input.baseUrl ?? "").trim();
  const pattern = String(input.urlPattern ?? "").trim();
  if (!base || !pattern) {
    return { ok: false, reason: "missing_metadata", message: "URL unavailable" };
  }

  const placeholders = pathPlaceholders(pattern);
  const required = (input.pathInputs ?? [])
    .filter((p) => p.required)
    .map((p) => p.key);
  const needed = [...new Set([...placeholders, ...required])];
  const missing = needed.filter((key) => !String(input.values?.[key] ?? "").trim());
  if (missing.length) {
    return {
      ok: false,
      reason: "missing_inputs",
      missingKeys: missing,
      message: `Thiếu URL input: ${missing.join(", ")}`,
    };
  }

  let filled = pattern;
  for (const key of placeholders) {
    const raw = String(input.values?.[key] ?? "").trim();
    filled = filled.split(`{${key}}`).join(encodeURIComponent(raw));
  }
  if (/\{[a-zA-Z0-9_]+\}/.test(filled)) {
    return {
      ok: false,
      reason: "missing_inputs",
      message: "URL còn placeholder chưa được điền.",
    };
  }

  try {
    if (/^https?:\/\//i.test(filled)) {
      return { ok: true, url: new URL(filled).toString() };
    }
    const origin = new URL(base);
    if (filled.startsWith("/")) {
      return { ok: true, url: new URL(filled, origin.origin).toString() };
    }
    const baseHref = origin.href.endsWith("/") ? origin.href : `${origin.href}/`;
    return { ok: true, url: new URL(filled, baseHref).toString() };
  } catch {
    return { ok: false, reason: "invalid", message: "URL unavailable" };
  }
}

export function resolveUrlFromActionTag(
  tag: ActionTag | null | undefined,
  values?: Record<string, string>,
): ResolveActionTagUrlResult {
  if (!tag) {
    return { ok: false, reason: "missing_metadata", message: "URL unavailable" };
  }
  return resolveActionTagUrl({
    baseUrl: tag.base_url,
    urlPattern: tag.url_pattern,
    pathInputs: tag.path_inputs,
    values,
  });
}
