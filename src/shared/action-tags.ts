import type { ActionTag, ScriptRequest } from "./contracts.js";

/** Max age before Scripts/Creator treat cached tags as stale and refresh from API. */
export const ACTION_TAGS_STALE_MS = 60_000;
/** Default cooldown after HTTP 429 before another Action Tags API call. */
export const ACTION_TAGS_RATE_LIMIT_COOLDOWN_MS = 60_000;

export type ActionTagsRefreshResult =
  | {
      ok: true;
      tags: ActionTag[];
      count: number;
      source: "api" | "cache" | "requests";
      fetchedAt?: string;
    }
  | {
      ok: false;
      error: string;
      tags: ActionTag[];
      count: number;
      source: "cache" | "requests";
      authRequired?: boolean;
      rateLimited?: boolean;
      retryAfterSeconds?: number;
    };

/** Stable negative id for in-memory-only tags (never persist — avoids colliding with SEO-OPS ids). */
export function syntheticActionTagId(tagKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < tagKey.length; i++) {
    h ^= tagKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const id = h | 0;
  return id === 0 ? -1 : id > 0 ? -id : id;
}

/** Build ActionTag metadata from Script Requests when /action-tags is unavailable. */
export function actionTagsFromScriptRequests(requests: ScriptRequest[]): ActionTag[] {
  const out: ActionTag[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    const tagKey = String(req.action_tag_key ?? "").trim();
    if (!tagKey || seen.has(tagKey)) continue;
    seen.add(tagKey);
    const id =
      typeof req.action_tag_id === "number" && Number.isFinite(req.action_tag_id)
        ? req.action_tag_id
        : syntheticActionTagId(tagKey);
    const tag = normalizeActionTag({
      id,
      tag_key: tagKey,
      site_key: req.site_key,
      path_key: req.path_key,
      action_key: req.action_key ?? null,
      base_url: req.site_base_url,
      url_pattern: req.url_pattern,
      path_inputs: req.path_inputs,
      name: tagKey,
    });
    if (tag) out.push(tag);
  }
  return out;
}

/** Merge SQLite/API tags with request-derived tags (request fills gaps only). */
export function mergeActionTagsWithRequests(
  cached: ActionTag[],
  requests: ScriptRequest[],
): ActionTag[] {
  const byKey = new Map<string, ActionTag>();
  for (const tag of cached) byKey.set(tag.tag_key, tag);
  for (const tag of actionTagsFromScriptRequests(requests)) {
    if (!byKey.has(tag.tag_key)) byKey.set(tag.tag_key, tag);
  }
  return [...byKey.values()].sort((a, b) =>
    a.platform.localeCompare(b.platform)
    || a.target.localeCompare(b.target)
    || a.action.localeCompare(b.action)
    || a.id - b.id,
  );
}

/**
 * Normalize SEO-OPS Action Tag payloads for two-part keys (e.g. mayhopphat.login)
 * and legacy three-part keys (facebook.group.post). Allows action_key = null.
 */
export function normalizeActionTag(raw: unknown): ActionTag | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : Number(row.id);
  const tagKey = String(row.tag_key ?? "").trim();
  if (!Number.isFinite(id) || !tagKey) return null;

  const parts = tagKey.split(".").filter(Boolean);
  const platform = String(row.platform ?? parts[0] ?? "").trim() || parts[0] || "unknown";
  const target =
    String(row.target ?? (parts.length >= 2 ? parts[1] : "")).trim() ||
    (parts.length >= 2 ? parts[1] : platform);
  const actionFromParts = parts.length >= 3 ? parts.slice(2).join(".") : "";
  const action =
    row.action === null || row.action === undefined
      ? actionFromParts
      : String(row.action);

  const actionKeyRaw = row.action_key;
  const action_key =
    actionKeyRaw === null || actionKeyRaw === undefined || actionKeyRaw === ""
      ? null
      : String(actionKeyRaw);

  const site_key =
    row.site_key === null || row.site_key === undefined || row.site_key === ""
      ? undefined
      : String(row.site_key);
  const path_key =
    row.path_key === null || row.path_key === undefined || row.path_key === ""
      ? undefined
      : String(row.path_key);

  const tag: ActionTag = {
    id,
    tag_key: tagKey,
    platform,
    target,
    action,
    name: String(row.name ?? tagKey),
    action_key,
  };
  if (site_key !== undefined) tag.site_key = site_key;
  if (path_key !== undefined) tag.path_key = path_key;
  if (row.description != null && row.description !== "") tag.description = String(row.description);
  if (typeof row.linked_scripts_count === "number") tag.linked_scripts_count = row.linked_scripts_count;
  if (row.base_url != null && row.base_url !== "") tag.base_url = String(row.base_url);
  if (row.url_pattern != null && row.url_pattern !== "") tag.url_pattern = String(row.url_pattern);
  if (Array.isArray(row.path_inputs)) tag.path_inputs = row.path_inputs as ActionTag["path_inputs"];
  return tag;
}

export function normalizeActionTags(raw: unknown[]): ActionTag[] {
  const out: ActionTag[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const tag = normalizeActionTag(item);
    if (!tag || seen.has(tag.id)) continue;
    seen.add(tag.id);
    out.push(tag);
  }
  return out;
}
