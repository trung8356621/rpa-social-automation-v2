export class SeoOpsHttpError extends Error {
  constructor(readonly diagnostic: { method: string; endpoint: string; status: number; contentType: string; location?: string;
    retryAfterSeconds?: number; category: "authentication" | "authorization" | "rate_limited" | "server_error" | "service_unavailable" | "redirect" | "unexpected_response" }) {
    super(`SEO_OPS_HTTP: ${diagnostic.method} ${diagnostic.endpoint} status=${diagnostic.status} content-type=${diagnostic.contentType || "missing"}`
      + (diagnostic.location ? ` redirect=${diagnostic.location}` : "") + ` category=${diagnostic.category}`
      + (diagnostic.retryAfterSeconds !== undefined ? ` retry-after=${diagnostic.retryAfterSeconds}` : ""));
  }
}

export function retryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof SeoOpsHttpError) return error.diagnostic.retryAfterSeconds;
  const found = /retry-after=(\d+)/i.exec(String((error as Error)?.message || error || ""));
  return found ? Number(found[1]) : undefined;
}

export async function readSeoOpsJson(response: Response, method: string, url: string): Promise<Record<string, unknown>> {
  const endpoint = new URL(url).pathname;
  const contentType = response.headers.get("content-type") ?? "";
  const locationRaw = response.headers.get("location") ?? undefined;
  const location = locationRaw ? (() => { try { return new URL(locationRaw, url).pathname; } catch { return "[invalid redirect]"; } })() : undefined;
  const retryRaw = response.headers.get("retry-after");
  const retryAfter = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
  const category = response.status === 401 ? "authentication"
    : response.status === 403 ? "authorization"
      : response.status === 429 ? "rate_limited"
        : response.status === 503 ? "service_unavailable"
          : response.status >= 500 ? "server_error"
            : response.status >= 300 && response.status < 400 ? "redirect" : "unexpected_response";
  if (response.status === 429) {
    await response.text();
    throw new SeoOpsHttpError({ method, endpoint, status: response.status, contentType, location,
      retryAfterSeconds: retryAfter, category });
  }
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    await response.text();
    throw new SeoOpsHttpError({ method, endpoint, status: response.status, contentType, location, category });
  }
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new SeoOpsHttpError({ method, endpoint, status: response.status, contentType, location, category: "unexpected_response" }); }
}
