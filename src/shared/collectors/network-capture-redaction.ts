/** Sensitive header names (case-insensitive). */
const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-access-token",
  "x-auth-token",
  "x-api-key",
  "api-key",
  "apikey",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "id_token",
  "auth",
  "authorization",
  "password",
  "passwd",
  "secret",
  "api_key",
  "apiKey",
  "apikey",
  "session",
  "sessionid",
  "sid",
  "sig",
  "signature",
]);

export function isSensitiveHeaderName(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(key)) return true;
  if (key.startsWith("x-") && /(auth|token|secret|cookie|csrf|session)/i.test(key))
    return true;
  return false;
}

export function redactHeaders(
  headers: Record<string, unknown> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [name, value] of Object.entries(headers)) {
    if (isSensitiveHeaderName(name)) {
      out[name] = "[REDACTED]";
      continue;
    }
    out[name] = typeof value === "string" ? value : String(value ?? "");
  }
  return out;
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (
        SENSITIVE_QUERY_KEYS.has(key) ||
        /token|secret|auth|password|session|sig/i.test(key)
      ) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl.replace(
      /([?&](?:token|access_token|auth|password|secret|api_key|session)=)[^&]*/gi,
      "$1[REDACTED]",
    );
  }
}

/**
 * Response bodies may contain personal content, tokens embedded in JSON, or PII.
 * They are operator-local evidence only — never treat as safe to sync externally.
 * This helper only redacts common secret-looking leaf strings for optional previews.
 */
export function redactPreviewText(text: string, maxLen = 400): string {
  const clipped = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  return clipped
    .replace(/("(access_token|refresh_token|password|secret|authorization)"\s*:\s*")([^"]*)(")/gi, "$1[REDACTED]$4")
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]");
}
