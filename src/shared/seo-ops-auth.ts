/** SEO-OPS RPA Admin user session (admin|owner). Distinct from Runner service credentials. */

export type RpaAdminUser = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "owner" | string;
};

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
      const response = await fetchImpl(`${root}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(clientLabel ? { client_label: clientLabel } : {}),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
      const response = await fetchImpl(`${root}/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
      const response = await fetchImpl(`${root}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      options.tokenStore.setToken(null);
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
