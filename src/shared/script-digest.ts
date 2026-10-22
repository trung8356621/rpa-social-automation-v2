import { createHash } from "node:crypto";
import type { ScriptPublishBody } from "./script-release.js";

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
    .update(JSON.stringify(canonical))
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
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
