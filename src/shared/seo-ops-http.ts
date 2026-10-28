export const SEO_OPS_REQUEST_TIMEOUT_MS = 30_000;

/** Suggested production API origin for RPA Admin Settings (user still saves explicitly). */
export const SEO_OPS_PRODUCTION_BASE_URL = "https://seo-ops.duckdns.org";

/** Local Valet-style default when the user has never saved an endpoint. */
export const SEO_OPS_DEFAULT_BASE_URL = "http://seo-ops.test";

export type SeoOpsHttpCategory =
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "validation"
  | "rate_limited"
  | "server_error"
  | "service_unavailable"
  | "redirect"
  | "timeout"
  | "unexpected_response";

export class SeoOpsHttpError extends Error {
  constructor(readonly diagnostic: {
    method: string;
    endpoint: string;
    status: number;
    contentType: string;
    location?: string;
    retryAfterSeconds?: number;
    category: SeoOpsHttpCategory;
  }) {
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

export function categorizeSeoOpsStatus(status: number): SeoOpsHttpCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "server_error";
  if (status >= 300 && status < 400) return "redirect";
  return "unexpected_response";
}

/** fetch with AbortController timeout; does not retry. Caller owns idempotency. */
export async function seoOpsFetch(
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SEO_OPS_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const external = init?.signal;
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: init?.redirect ?? "manual" });
  } catch (error) {
    const aborted = controller.signal.aborted && !(external?.aborted);
    if (aborted || /aborted|aborterror|timed?\s*out/i.test(String((error as Error)?.name || "") + String((error as Error)?.message || ""))) {
      const endpoint = (() => { try { return new URL(url).pathname; } catch { return "/"; } })();
      throw new SeoOpsHttpError({
        method: String(init?.method ?? "GET").toUpperCase(),
        endpoint,
        status: 0,
        contentType: "",
        category: "timeout",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

export async function readSeoOpsJson(response: Response, method: string, url: string): Promise<Record<string, unknown>> {
  const endpoint = new URL(url).pathname;
  const contentType = response.headers.get("content-type") ?? "";
  const locationRaw = response.headers.get("location") ?? undefined;
  const location = locationRaw ? (() => { try { return new URL(locationRaw, url).pathname; } catch { return "[invalid redirect]"; } })() : undefined;
  const retryRaw = response.headers.get("retry-after");
  const retryAfter = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
  const category = categorizeSeoOpsStatus(response.status);
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

/** Map publish/sync API error codes to safe Vietnamese UI copy. */
export function mapSeoOpsApiError(codeOrMessage: string): string {
  const raw = String(codeOrMessage || "").trim();
  const code = raw.split(/[,\s/:]+/)[0]?.toLowerCase() || "";
  switch (code) {
    case "version_digest_conflict":
      return "Xung đột phiên bản: cùng version nhưng nội dung khác trên SEO-OPS.";
    case "script_version_sequence_conflict":
      return "Thứ tự version không hợp lệ. Publish đúng version kế tiếp theo contract.";
    case "script_content_unchanged":
      return "Nội dung Script không đổi so với bản đã publish — không tạo version mới.";
    case "package_kind_conflict":
      return "package_key đã tồn tại với loại khác (không phải Script).";
    case "removed_on_server":
      return "Script đã bị gỡ trên SEO-OPS.";
    case "content_digest_mismatch":
      return "Digest Script không khớp với manifest đã gửi.";
    case "unauthenticated":
    case "unauthorized":
    case "session_expired":
    case "token_expired":
      return "Phiên SEO-OPS đã hết hạn. Mở Settings để đăng nhập lại.";
    case "forbidden":
    case "role_staff_forbidden":
      return "Tài khoản không có quyền sử dụng RPA Admin.";
    case "not_found":
    case "script_not_found":
    case "package_not_found":
      return "Không tìm thấy Script/release trên SEO-OPS.";
    case "schema_unavailable":
    case "package_registry_unavailable":
      return "SEO-OPS chưa hoàn tất thiết lập database Social Automation.";
    case "network_error":
    case "fetch_failed":
      return "Không kết nối được SEO-OPS.";
    case "timeout":
      return "SEO-OPS không phản hồi kịp (timeout). Thử lại thủ công.";
    default:
      if (/fetch failed|failed to fetch|networkerror|econnrefused|enotfound|econnreset/i.test(raw)) {
        return "Không kết nối được SEO-OPS.";
      }
      if (/category=timeout|timed?\s*out/i.test(raw)) return "SEO-OPS không phản hồi kịp (timeout). Thử lại thủ công.";
      if (/category=validation|\b422\b/i.test(raw)) return "Dữ liệu Script không hợp lệ (validation). Kiểm tra Steps/Variables/Demo.";
      if (/category=conflict|\b409\b/i.test(raw)) return "Xung đột version/digest với SEO-OPS.";
      if (/category=not_found|\b404\b/i.test(raw)) return "Không tìm thấy tài nguyên trên SEO-OPS.";
      if (/category=service_unavailable|\b503\b/i.test(raw)) return "SEO-OPS tạm thời không khả dụng. Vui lòng thử lại sau.";
      if (/category=rate_limited|\b429\b/i.test(raw)) return "SEO-OPS đang giới hạn yêu cầu. Vui lòng thử lại sau.";
      if (/category=server_error|\b5\d\d\b/i.test(raw)) return "SEO-OPS gặp lỗi máy chủ. Vui lòng thử lại sau.";
      if (/bearer\s+[a-z0-9_-]{20,}|select\s+.+\s+from|sqlstate/i.test(raw)) return "Thao tác SEO-OPS thất bại.";
      return raw || "Thao tác SEO-OPS thất bại.";
  }
}

export function mapSeoOpsApiErrors(errors: string[] | undefined, fallback = "Thao tác SEO-OPS thất bại."): string {
  if (!errors?.length) return fallback;
  return mapSeoOpsApiError(errors[0]);
}
