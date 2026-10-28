import { createHash } from "node:crypto";
import type { ScriptPublishBody } from "./script-release.js";

/** Match Laravel's json_decode(..., true) + json_encode(): empty JSON objects become []. */
export function phpCompatibleJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) return null;
    if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0) return [];
    return item;
  });
}

/** Canonical content digest matching SEO-OPS PackagePublishValidator. */
export function computeScriptContentDigest(body: ScriptPublishBody): string {
  const canonical = {
    package_key: body.package_key,
    kind: body.kind,
    version: body.version,
    schema_version: body.schema_version,
    manifest: body.manifest,
    dependencies: body.dependencies ?? [],
    runtime_compatibility: body.runtime_compatibility ?? {},
  };
  return createHash("sha256")
    .update(phpCompatibleJsonStringify(canonical))
    .digest("hex");
}

export function computeExecutionDigest(manifest: ScriptPublishBody["manifest"]): string {
  const payload = {
    script_id: manifest.script_id,
    variables: manifest.variables ?? [],
    outputs: manifest.outputs ?? [],
    steps: manifest.steps ?? [],
    runtime_requirements: manifest.runtime_requirements ?? {},
    assets: manifest.assets ?? [],
    // Keep aligned with SEO-OPS ScriptExecutionDigest (Default Pattern / layout bindings).
    default_pattern: manifest.default_pattern ?? null,
    zoom: manifest.zoom ?? null,
    groups: manifest.groups ?? null,
  };
  return createHash("sha256").update(phpCompatibleJsonStringify(payload)).digest("hex");
}
