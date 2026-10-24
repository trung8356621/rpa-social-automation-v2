import type { ScriptPublishBody } from "./script-release.js";
import {
  assertScriptPublishBody,
  matchToRequiresMissingOcr,
} from "./script-release.js";

export type LocalScriptRow = {
  script_id: string;
  package_key: string;
  version: string;
  content_digest: string;
  execution_digest?: string;
  lineage?: string[];
  assets_complete?: boolean;
  demo_status?: "ready" | "missing" | "outdated" | "error";
  /** Full publish body when pushing — required for usable import. */
  publish_body?: ScriptPublishBody;
};

export type SyncPlan = {
  push_to_remote: LocalScriptRow[];
  pull_to_local: LocalScriptRow[];
  skip: Array<{ script_id: string; reason: string }>;
  conflicts: Array<{
    script_id: string;
    local: LocalScriptRow;
    remote: LocalScriptRow;
    reason: string;
  }>;
};

export type PullResult = {
  ok: boolean;
  release?: Record<string, unknown>;
  assets_complete?: boolean;
  ready_to_execute?: boolean;
  errors?: string[];
};

export type ImportScriptResult = {
  script_id: string;
  package_key: string;
  version: string;
  incomplete: boolean;
  incomplete_reasons: string[];
  ready_to_execute: boolean;
  flowPayload: Record<string, unknown> | null;
};

/**
 * Pure planner mirror (client-side) — same rules as SEO-OPS ScriptSyncPlanner.
 * Server plan endpoint is authoritative when online.
 */
export function planScriptSync(local: LocalScriptRow[], remote: LocalScriptRow[]): SyncPlan {
  const localBy = index(local);
  const remoteBy = index(remote);
  const push: LocalScriptRow[] = [];
  const pull: LocalScriptRow[] = [];
  const skip: SyncPlan["skip"] = [];
  const conflicts: SyncPlan["conflicts"] = [];
  const ids = [...new Set([...Object.keys(localBy), ...Object.keys(remoteBy)])].sort();

  for (const id of ids) {
    const l = localBy[id];
    const r = remoteBy[id];
    if (l && !r) {
      push.push(l);
      continue;
    }
    if (!l && r) {
      pull.push(r);
      continue;
    }
    if (!l || !r) continue;
    if (l.content_digest.toLowerCase() === r.content_digest.toLowerCase()) {
      skip.push({ script_id: id, reason: "same_digest" });
      continue;
    }
    const lineage = resolveLineage(l, r);
    if (lineage === "local_ahead") {
      push.push(l);
      continue;
    }
    if (lineage === "remote_ahead") {
      pull.push(r);
      continue;
    }
    conflicts.push({ script_id: id, local: l, remote: r, reason: "divergent_edits" });
  }

  return { push_to_remote: push, pull_to_local: pull, skip, conflicts };
}

function index(rows: LocalScriptRow[]): Record<string, LocalScriptRow> {
  const out: Record<string, LocalScriptRow> = {};
  for (const row of rows) {
    if (row.script_id) out[row.script_id] = row;
  }
  return out;
}

function resolveLineage(local: LocalScriptRow, remote: LocalScriptRow): string {
  const remoteDigest = remote.content_digest.toLowerCase();
  const localDigest = local.content_digest.toLowerCase();
  for (const a of local.lineage ?? []) {
    if (a.toLowerCase() === remoteDigest) return "local_ahead";
  }
  for (const a of remote.lineage ?? []) {
    if (a.toLowerCase() === localDigest) return "remote_ahead";
  }
  return "conflict";
}

/** Build a usable local Script draft from a pulled SEO-OPS release (not JSON-only stub). */
export function importScriptRelease(release: Record<string, unknown>): ImportScriptResult {
  const manifest = (release.manifest ?? {}) as Record<string, unknown>;
  const scriptId = String(manifest.script_id ?? release.package_key ?? "");
  const packageKey = String(release.package_key ?? "");
  const version = String(release.version ?? "");
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  let assetsComplete = true;
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") {
      assetsComplete = false;
      break;
    }
    const a = asset as Record<string, unknown>;
    if (!String(a.path ?? "") || !/^[a-f0-9]{64}$/i.test(String(a.sha256 ?? ""))) {
      assetsComplete = false;
      break;
    }
  }

  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  const variables = Array.isArray(manifest.variables) ? manifest.variables : [];
  const incomplete_reasons: string[] = [];
  if (!scriptId) incomplete_reasons.push("missing_script_id");
  if (steps.length === 0) incomplete_reasons.push("steps_required");
  if (!assetsComplete) incomplete_reasons.push("incomplete_assets");
  for (const raw of variables) {
    if (!raw || typeof raw !== "object") {
      incomplete_reasons.push("invalid_payload");
      break;
    }
    const v = raw as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id.trim() || typeof v.key !== "string" || !v.key.trim()) {
      incomplete_reasons.push("missing_variable_id");
      break;
    }
  }
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const target = (raw as { target?: unknown }).target;
    if (target && typeof target === "object" && matchToRequiresMissingOcr(target as Record<string, unknown>)) {
      incomplete_reasons.push("invalid_payload");
      break;
    }
  }
  const incomplete = incomplete_reasons.length > 0;

  const flowPayload = incomplete
    ? null
    : {
        id: scriptId,
        name: String(release.name ?? scriptId),
        version,
        package_key: packageKey,
        variables,
        steps,
        outputs: Array.isArray(manifest.outputs) ? manifest.outputs : [],
        assets,
        runtime_requirements: manifest.runtime_requirements ?? {},
        content_digest: String(release.content_digest ?? ""),
        source: "seo_ops_pull",
        zoom: manifest.zoom,
        default_pattern: manifest.default_pattern ?? manifest.defaultPattern,
        groups: manifest.groups,
      };

  return {
    script_id: scriptId,
    package_key: packageKey,
    version,
    incomplete,
    incomplete_reasons: [...new Set(incomplete_reasons)],
    ready_to_execute: !incomplete && assetsComplete,
    flowPayload,
  };
}

export function createHttpScriptSyncClient(options: {
  baseUrl: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = `${options.baseUrl.replace(/\/$/, "")}/api/v1/social-automation/rpa-admin`;

  async function authed(path: string, init?: RequestInit) {
    const token = options.getToken();
    if (!token) throw new Error("SEO_OPS_SYNC: unauthenticated");
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, json };
  }

  return {
    async catalog() {
      const { response, json } = await authed("/scripts");
      if (!response.ok || !json.ok) throw new Error("SEO_OPS_SYNC: catalog failed");
      return (json.scripts as LocalScriptRow[]) ?? [];
    },
    async plan(localScripts: LocalScriptRow[]) {
      const { response, json } = await authed("/scripts/sync/plan", {
        method: "POST",
        body: JSON.stringify({ local_scripts: localScripts }),
      });
      if (!response.ok || !json.ok) throw new Error("SEO_OPS_SYNC: plan failed");
      return json.plan as SyncPlan;
    },
    async publish(body: ScriptPublishBody) {
      assertScriptPublishBody(body);
      const { response, json } = await authed("/scripts/publish", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { httpStatus: response.status, ...json };
    },
    async uploadVideoDemo(input: {
      packageKey: string;
      version: string;
      binary: Buffer | Uint8Array;
      mime?: string;
      sha256?: string;
    }): Promise<{ ok: boolean; errors?: string[] }> {
      const token = options.getToken();
      if (!token) throw new Error("SEO_OPS_SYNC: unauthenticated");
      const { response, json } = await (async () => {
        const res = await fetchImpl(`${root}/scripts/video-demo`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            package_key: input.packageKey,
            version: input.version,
            mime: input.mime ?? "video/webm",
            sha256: input.sha256,
            video_base64: Buffer.from(input.binary).toString("base64"),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { response: res, json: body };
      })();
      return {
        ok: response.ok && json.ok === true,
        errors: Array.isArray(json.errors) ? (json.errors as string[]) : undefined,
      };
    },
    async pull(packageKey: string, version: string): Promise<PullResult> {
      const { response, json } = await authed("/scripts/pull", {
        method: "POST",
        body: JSON.stringify({ package_key: packageKey, version }),
      });
      if (!response.ok || !json.ok) {
        return {
          ok: false,
          errors: Array.isArray(json.errors) ? (json.errors as string[]) : ["pull_failed"],
        };
      }
      return {
        ok: true,
        release: json.release as Record<string, unknown>,
        assets_complete: Boolean(json.assets_complete),
        ready_to_execute: Boolean(json.ready_to_execute),
      };
    },
  };
}
