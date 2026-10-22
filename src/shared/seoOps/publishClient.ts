/**
 * Social Automation registry HTTP client.
 * Auth: Bearer service_api_credential — never OPS service_key.
 *
 * Current server packages/publish accepts kind widget|workflow only.
 * Script Registry publish URL/shape is provisional until server contract extends.
 */

export const SEO_OPS_SCOPES = {
  packageRead: "social-automation:package:read",
  packagePublish: "social-automation:package:publish",
} as const;

export type PublishClientResult = {
  ok: boolean;
  http_status: number;
  outcome: string;
  errors: string[];
  release?: unknown;
  existing_digest?: string | null;
  raw?: unknown;
  message?: string;
};

export function buildPackagePublishUrl(options: {
  baseUrl: string;
  serviceSlug?: string;
}): string {
  const root = String(options.baseUrl || "").replace(/\/+$/, "");
  const service = String(options.serviceSlug || "social-automation").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!root) throw new Error("seo_ops_base_url_required");
  return `${root}/api/v1/services/${service}/social-automation/packages/publish`;
}

export async function publishToPackageRegistry(options: {
  baseUrl: string;
  serviceSlug?: string;
  credential: string;
  body: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PublishClientResult> {
  const credential = String(options.credential || "").trim();
  if (!credential) {
    return {
      ok: false,
      http_status: 401,
      errors: ["unauthorized"],
      outcome: "unauthorized",
    };
  }

  let url: string;
  try {
    url = buildPackagePublishUrl(options);
  } catch {
    return {
      ok: false,
      http_status: 422,
      errors: ["seo_ops_base_url_required"],
      outcome: "validation_failed",
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!json) {
      return {
        ok: false,
        http_status: response.status || 503,
        errors: ["invalid_server_response"],
        outcome: "unavailable",
      };
    }
    const outcome = String(
      json.outcome || (json.ok ? "created" : "validation_failed"),
    );
    const errors = Array.isArray(json.errors)
      ? json.errors.map(String)
      : [];
    if (response.status === 401) {
      return {
        ok: false,
        http_status: 401,
        errors: errors.length ? errors : ["unauthorized"],
        outcome: "unauthorized",
        raw: json,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        http_status: 403,
        errors: errors.length ? errors : ["forbidden"],
        outcome: "forbidden",
        raw: json,
      };
    }
    if (response.status === 409) {
      return {
        ok: false,
        http_status: 409,
        errors: errors.length ? errors : ["version_digest_conflict"],
        outcome: "conflict",
        existing_digest: (json.existing_digest as string) || null,
        raw: json,
      };
    }
    if (response.status === 503) {
      return {
        ok: false,
        http_status: 503,
        errors: errors.length ? errors : ["schema_unavailable"],
        outcome: "unavailable",
        raw: json,
      };
    }
    const ok =
      Boolean(json.ok) && (outcome === "created" || outcome === "idempotent");
    return {
      ok,
      http_status: response.status,
      outcome,
      errors,
      release: json.release,
      raw: json,
    };
  } catch (error) {
    const aborted =
      error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      http_status: 0,
      errors: [aborted ? "timeout" : "network_unavailable"],
      outcome: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
