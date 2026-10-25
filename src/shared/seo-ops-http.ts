export class SeoOpsHttpError extends Error {
  constructor(readonly diagnostic: { method: string; endpoint: string; status: number; contentType: string; location?: string; category: "authentication" | "redirect" | "unexpected_response" }) {
    super(`SEO_OPS_HTTP: ${diagnostic.method} ${diagnostic.endpoint} status=${diagnostic.status} content-type=${diagnostic.contentType || "missing"}`
      + (diagnostic.location ? ` redirect=${diagnostic.location}` : "") + ` category=${diagnostic.category}`);
  }
}

export async function readSeoOpsJson(response: Response, method: string, url: string): Promise<Record<string, unknown>> {
  const endpoint = new URL(url).pathname;
  const contentType = response.headers.get("content-type") ?? "";
  const locationRaw = response.headers.get("location") ?? undefined;
  const location = locationRaw ? (() => { try { return new URL(locationRaw, url).pathname; } catch { return "[invalid redirect]"; } })() : undefined;
  const category = response.status === 401 || response.status === 403 ? "authentication" : response.status >= 300 && response.status < 400 ? "redirect" : "unexpected_response";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    await response.text();
    throw new SeoOpsHttpError({ method, endpoint, status: response.status, contentType, location, category });
  }
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new SeoOpsHttpError({ method, endpoint, status: response.status, contentType, location, category: "unexpected_response" }); }
}
