/** SEO-OPS RPA Admin user session (admin|owner). Distinct from Runner service credentials. */
import { readSeoOpsJson } from "./seo-ops-http.js";

export type RpaAdminUser = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "owner" | string;
};

/** Map API/network error codes to safe Vietnamese UI copy (never tokens/SQL/exceptions). */
export function mapSeoOpsAuthError(codeOrMessage: string): string {
  const raw = String(codeOrMessage || "").trim();
  const code = raw.split(/[,\s]+/)[0]?.toLowerCase() || "";
  switch (code) {
    case "schema_unavailable":
    case "package_registry_unavailable":
      return "SEO-OPS chưa hoàn tất thiết lập database Social Automation.";
    case "invalid_credentials":
    case "credentials_required":
      return "Email hoặc mật khẩu không đúng.";
    case "unauthenticated":
    case "session_expired":
    case "token_expired":
      return "Phiên SEO-OPS đã hết hạn. Mở Settings để đăng nhập lại.";
    case "forbidden":
    case "role_staff_forbidden":
    case "role_forbidden":
    case "system_user_forbidden":
    case "user_blocked":
      return "Tài khoản không có quyền sử dụng RPA Admin.";
    case "network_error":
    case "fetch_failed":
      return "Không kết nối được SEO-OPS.";
    default:
      if (/failed to fetch|networkerror|econnrefused|enotfound|timed?\s*out/i.test(raw)) {
        return "Không kết nối được SEO-OPS.";
      }
      if (!raw || raw === "login_failed") return "Đăng nhập SEO-OPS thất bại.";
      // Strip anything that looks like a token/SQL before surfacing.
      if (/bearer\s+[a-z0-9_-]{20,}|select\s+.+\s+from|sqlstate/i.test(raw)) {
        return "Đăng nhập SEO-OPS thất bại.";
      }
      return raw;
  }
}

export function mapSeoOpsAuthErrors(errors: string[] | undefined): string {
  if (!errors?.length) return mapSeoOpsAuthError("login_failed");
  return mapSeoOpsAuthError(errors[0]);
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: string; user: RpaAdminUser }
  | { ok: false; errors: string[] };

export type SessionResult =
  | { ok: true; user: RpaAdminUser; expiresAt: string }
  | { ok: false; errors: string[] };

export interface SeoOpsAuthClient {
  login(email: string, password: string, clientLabel?: string): Promise<LoginResult>;
  session(): Promise<SessionResult>;
  logout(): Promise<{ ok: boolean; errors?: string[] }>;
}

/** In-memory token holder — never write plaintext password; token only via secure store callback. */
export type TokenStore = {
  getToken(): string | null;
  setToken(token: string | null): void;
};

export function createHttpSeoOpsAuthClient(options: {
  baseUrl: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
}): SeoOpsAuthClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = `${options.baseUrl.replace(/\/$/, "")}/api/v1/social-automation/rpa-admin`;

  return {
    async login(email, password, clientLabel) {
      // Never send or persist client-side user_id — server derives identity.
      let response: Response;
      try {
        response = await fetchImpl(`${root}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            ...(clientLabel ? { client_label: clientLabel } : {}),
          }),
        });
      } catch {
        return { ok: false, errors: ["network_error"] };
      }
      let json: Record<string, unknown>;
      try { json = await readSeoOpsJson(response, "POST", `${root}/login`); }
      catch (error) { return { ok: false, errors: [String((error as Error).message || error)] }; }
      if (!response.ok || !json.ok) {
        return {
          ok: false,
          errors: Array.isArray(json.errors) ? (json.errors as string[]) : ["login_failed"],
        };
      }
      const token = String(json.token ?? "");
      if (!token) return { ok: false, errors: ["token_missing"] };
      options.tokenStore.setToken(token);
      return {
        ok: true,
        token,
        expiresAt: String(json.expires_at ?? ""),
        user: json.user as RpaAdminUser,
      };
    },

    async session() {
      const token = options.tokenStore.getToken();
      if (!token) return { ok: false, errors: ["unauthenticated"] };
      let response: Response;
      try {
        response = await fetchImpl(`${root}/session`, {
          redirect: "manual",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        return { ok: false, errors: ["network_error"] };
      }
      let json: Record<string, unknown>;
      try { json = await readSeoOpsJson(response, "GET", `${root}/session`); }
      catch (error) { return { ok: false, errors: [String((error as Error).message || error)] }; }
      if (!response.ok || !json.ok) {
        return {
          ok: false,
          errors: Array.isArray(json.errors) ? (json.errors as string[]) : ["unauthenticated"],
        };
      }
      return {
        ok: true,
        user: json.user as RpaAdminUser,
        expiresAt: String(json.expires_at ?? ""),
      };
    },

    async logout() {
      const token = options.tokenStore.getToken();
      if (!token) {
        options.tokenStore.setToken(null);
        return { ok: true };
      }
      let response: Response;
      try {
        response = await fetchImpl(`${root}/logout`, {
          method: "POST",
          redirect: "manual",
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        options.tokenStore.setToken(null);
        return { ok: false, errors: ["network_error"] };
      }
      options.tokenStore.setToken(null);
      let json: Record<string, unknown>;
      try { json = await readSeoOpsJson(response, "POST", `${root}/logout`); }
      catch (error) { return { ok: false, errors: [String((error as Error).message || error)] }; }
      return {
        ok: Boolean(json.ok) || response.ok,
        errors: Array.isArray(json.errors) ? (json.errors as string[]) : undefined,
      };
    },
  };
}

/** Reject staff / unknown roles client-side (server remains authoritative). */
export function assertRpaAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}
