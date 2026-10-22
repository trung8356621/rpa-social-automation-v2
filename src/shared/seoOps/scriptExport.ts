import type { Flow, Override, Step } from "../contracts.js";
import { clonePlain } from "./canonicalJson.js";
import {
  buildCanonicalPayload,
  digestsEqual,
  sha256OfCanonicalPayload,
  type CanonicalPackagePayload,
} from "./contentDigest.js";
import { stripSecrets } from "./secretStrip.js";

/**
 * Local Script Registry export for SEO-OPS.
 *
 * IMPORTANT: Current Social Automation Package Registry only accepts
 * kind = widget | workflow. kind = "script" is PROVISIONAL until the
 * server contract is extended. Do not publish to production registry yet.
 */

export type ScriptExportOptions = {
  script_key?: string;
  version?: string;
  schema_version?: number;
  runtime_compatibility?: Record<string, unknown>;
  last_publish?: {
    content_digest?: string;
    version?: string;
    script_key?: string;
  } | null;
};

export type ScriptExportResult =
  | {
      ok: true;
      body: CanonicalPackagePayload & { content_digest: string };
      content_digest: string;
      asset_refs: string[];
      stripped_paths: string[];
      unchanged_since_publish: boolean;
      server_publish_ready: false;
      blockers: string[];
    }
  | {
      ok: false;
      errors: string[];
      blockers: string[];
    };

const SCRIPT_KEY_RE = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/;

export function slugifyScriptKey(name: string): string {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  if (base.length >= 3 && SCRIPT_KEY_RE.test(base)) return base;
  const padded = `script.${base || "untitled"}`.replace(/\.{2,}/g, ".").slice(0, 128);
  return SCRIPT_KEY_RE.test(padded) ? padded : "script.untitled.flow";
}

/**
 * Build a deterministic Script export from RPA v2 Flow + Step versions.
 * Does not include cookies, browser sessions, credentials, or Test Lab runs.
 */
export function buildScriptExport(
  flow: Flow,
  steps: Step[],
  overrides: Override[] = [],
  options: ScriptExportOptions = {},
): ScriptExportResult {
  const blockers: string[] = [
    "server_kind_script_unsupported",
    "script_registry_endpoint_pending",
  ];
  const errors: string[] = [];

  if (!flow?.id) errors.push("flow_id_required");
  if (!Array.isArray(flow?.steps) || flow.steps.length === 0)
    errors.push("flow_steps_empty");

  const scriptKey = String(
    options.script_key || slugifyScriptKey(flow?.name || ""),
  ).trim();
  if (!SCRIPT_KEY_RE.test(scriptKey)) errors.push("script_key_invalid");

  const version = String(options.version || "1.0.0").trim();
  if (!VERSION_RE.test(version)) errors.push("version_invalid");

  const schemaVersion = Number(options.schema_version || 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1)
    errors.push("schema_version_invalid");

  if (errors.length) {
    return { ok: false, errors, blockers };
  }

  const stepByKey = new Map(
    steps.map((s) => [`${s.id}@${s.version}`, s] as const),
  );
  const ordered: Step[] = [];
  for (const ref of flow.steps) {
    const hit = stepByKey.get(`${ref.id}@${ref.version}`);
    if (!hit) {
      return {
        ok: false,
        errors: [`step_version_missing:${ref.id}@${ref.version}`],
        blockers,
      };
    }
    ordered.push(hit);
  }

  const strippedPaths: string[] = [];
  const assetRefs = new Set<string>();
  const exportSteps = ordered.map((step, index) => {
    const clean = stripSecrets({
      id: step.id,
      version: step.version,
      name: step.name,
      createdAt: step.createdAt,
      payload: step.payload,
    });
    strippedPaths.push(
      ...clean.stripped.map((p) => `steps[${index}].${p}`),
    );
    const value = clean.value as {
      id: string;
      version: number;
      name: string;
      createdAt: string;
      payload: Record<string, unknown>;
    };
    const target = value.payload?.target as { asset?: string } | undefined;
    if (target?.asset) assetRefs.add(String(target.asset));
    // Absolute local file paths in UPLOAD_FILE must not leave the machine.
    if (Array.isArray(value.payload?.files)) {
      value.payload.files = (value.payload.files as unknown[]).map((f) =>
        typeof f === "string" ? basenameSafe(f) : f,
      );
      strippedPaths.push(`steps[${index}].payload.files_absolutepath`);
    }
    return value;
  });

  const exportOverrides = overrides
    .filter((o) => flow.steps.some((s) => s.id === o.stepId))
    .map((o, index) => {
      const clean = stripSecrets(o);
      strippedPaths.push(
        ...clean.stripped.map((p) => `overrides[${index}].${p}`),
      );
      return clean.value;
    });

  const manifest = {
    script_id: flow.id,
    name: flow.name,
    zoom: flow.zoom,
    steps: exportSteps,
    overrides: exportOverrides,
    assets: [...assetRefs].sort().map((asset) => ({
      asset,
      kind: "roi_png",
    })),
    variables_schema: {
      // RPA v2 POC: inputs are embedded in step payloads (text/files).
      // Explicit variables schema for SEO-OPS Widget Form Builder is PENDING.
      note: "embedded_in_step_payloads",
      inputs: collectInputHints(exportSteps),
    },
    rpa: {
      source: "rpa-creator-v2",
      model: "flow+step_versions",
    },
  };

  const runtime = clonePlain(
    options.runtime_compatibility || { creator_min: "0.1.0", runner_min: "0.1.0" },
  );

  const canonical = buildCanonicalPayload({
    package_key: scriptKey,
    kind: "script",
    version,
    schema_version: schemaVersion,
    manifest: manifest as unknown as Record<string, unknown>,
    dependencies: [],
    runtime_compatibility: runtime || {},
  });
  const contentDigest = sha256OfCanonicalPayload(canonical);
  const last = options.last_publish || null;
  const unchanged = Boolean(
    last &&
      digestsEqual(last.content_digest, contentDigest) &&
      String(last.version || "") === version &&
      String(last.script_key || "") === scriptKey,
  );

  return {
    ok: true,
    body: { ...canonical, content_digest: contentDigest },
    content_digest: contentDigest,
    asset_refs: [...assetRefs].sort(),
    stripped_paths: strippedPaths,
    unchanged_since_publish: unchanged,
    server_publish_ready: false,
    blockers,
  };
}

function basenameSafe(filePath: string): string {
  const parts = String(filePath).split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function collectInputHints(
  steps: Array<{ payload: Record<string, unknown> }>,
): Array<{ step_index: number; fields: string[] }> {
  return steps.map((step, step_index) => {
    const fields: string[] = [];
    if (typeof step.payload.text === "string") fields.push("text");
    if (Array.isArray(step.payload.files)) fields.push("files");
    return { step_index, fields };
  });
}
