import type { Flow, Step, Variable } from "./contracts.js";
import { computeExecutionDigest, computeScriptContentDigest } from "./script-digest.js";
import { MISSING_DEMO_REASON } from "./video-demo-policy.js";

/** SEO-OPS Social Automation Script Registry publish body (kind=script). */
export type ScriptVariable = {
  key: string;
  type: Variable["type"];
  description?: string;
};

export type ScriptVideoDemo = {
  artifact_ref: string;
  mime: "video/webm" | "video/mp4";
  sha256?: string;
  test_run_id: string;
  script_version: string;
  reviewed: boolean;
  audio: false;
  desktop_capture: false;
  execution_digest?: string;
  thumbnail_ref?: string;
  thumbnail_sha256?: string;
};

export type ScriptReleaseManifest = {
  script_id: string;
  variables: ScriptVariable[];
  outputs: { key: string; type: string }[];
  steps: Array<Record<string, unknown>>;
  runtime_requirements: { runner_min: string };
  assets: Array<{ path: string; sha256: string; kind: string }>;
  video_demo?: ScriptVideoDemo;
};

export type ScriptPublishBody = {
  package_key: string;
  kind: "script";
  name: string;
  version: string;
  schema_version: 1;
  description?: string;
  manifest: ScriptReleaseManifest;
  dependencies: [];
  runtime_compatibility: { runner_min: string };
};

export type ScriptExportInput = {
  flow: Flow;
  steps: Step[];
  version: string;
  packageKey?: string;
  runnerMin?: string;
  assets?: ScriptReleaseManifest["assets"];
  videoDemo?: ScriptVideoDemo;
  description?: string;
};

/** Catalog inspection only — never throws for incomplete Scripts; never publishes. */
export type ScriptCatalogSnapshot = {
  package_key: string;
  name: string;
  version: string;
  content_digest: string;
  execution_digest: string;
  incomplete: boolean;
  incomplete_reasons: string[];
  /** Present only when Script is publishable (has steps + valid body). */
  publish_body: ScriptPublishBody | null;
};

const PACKAGE_KEY = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/;

function packageKeyFor(flow: Flow, explicit?: string): string {
  const packageKey =
    explicit ??
    flow.id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
  if (!PACKAGE_KEY.test(packageKey)) throw new Error("SCRIPT_EXPORT: invalid package_key");
  return packageKey;
}

function mapStepPayloads(
  flow: Flow,
  steps: Step[],
): { stepPayloads: Array<Record<string, unknown>>; missing: string[] } {
  const missing: string[] = [];
  const stepPayloads: Array<Record<string, unknown>> = [];
  for (const ref of flow.steps) {
    const step = steps.find((s) => s.id === ref.id && s.version === ref.version);
    if (!step) {
      missing.push(`${ref.id}@${ref.version}`);
      continue;
    }
    const variable = flow.variables?.find((v) => v.id === step.payload.variableId);
    stepPayloads.push({
      id: step.id,
      version: step.version,
      name: step.name,
      action: step.payload.action,
      ...(variable ? { variable_key: variable.key } : {}),
      ...(step.payload.target
        ? {
            target: {
              matchTo: step.payload.target.matchTo,
              environment: step.payload.target.environment,
              asset: step.payload.target.asset,
              roi: step.payload.target.roi,
            },
          }
        : {}),
    });
  }
  return { stepPayloads, missing };
}

function assembleBody(
  input: ScriptExportInput,
  stepPayloads: Array<Record<string, unknown>>,
): ScriptPublishBody {
  const runnerMin = input.runnerMin ?? "2.0.0";
  const packageKey = packageKeyFor(input.flow, input.packageKey);
  const variables: ScriptVariable[] = (input.flow.variables ?? []).map((v) => ({
    key: v.key,
    type: v.type,
    ...(v.description ? { description: v.description } : {}),
  }));
  const manifest: ScriptReleaseManifest = {
    script_id: input.flow.id,
    variables,
    outputs: [
      { key: "status", type: "text" },
      { key: "message", type: "text" },
      { key: "runId", type: "text" },
      { key: "scenarioId", type: "text" },
    ],
    steps: stepPayloads,
    runtime_requirements: { runner_min: runnerMin },
    assets: input.assets ?? [],
    ...(input.videoDemo ? { video_demo: input.videoDemo } : {}),
  };
  if ("script" in manifest || "code" in manifest) {
    throw new Error("SCRIPT_EXPORT: forbidden executable field");
  }
  return {
    package_key: packageKey,
    kind: "script",
    name: input.flow.name,
    version: input.version,
    schema_version: 1,
    ...(input.description ? { description: input.description } : {}),
    manifest,
    dependencies: [],
    runtime_compatibility: { runner_min: runnerMin },
  };
}

/**
 * Catalog / status inspection — 0-step and missing-step Scripts are listed as incomplete.
 * Does not publish and does not throw for incompleteness.
 */
export function buildScriptCatalogSnapshot(input: ScriptExportInput): ScriptCatalogSnapshot {
  const reasons: string[] = [];
  if (!SEMVER.test(input.version)) {
    reasons.push("invalid_version");
  }
  let package_key = input.flow.id;
  try {
    package_key = packageKeyFor(input.flow, input.packageKey);
  } catch {
    reasons.push("invalid_package_key");
    package_key = input.flow.id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, ".")
      .replace(/^\.+|\.+$/g, "") || "invalid.script";
  }

  const { stepPayloads, missing } = mapStepPayloads(input.flow, input.steps);
  for (const m of missing) reasons.push(`missing_step:${m}`);
  if (stepPayloads.length === 0) reasons.push("steps_required");
  if (!input.videoDemo) reasons.push(MISSING_DEMO_REASON);

  const version = SEMVER.test(input.version) ? input.version : "0.0.0";
  const softInput = { ...input, version };
  let body: ScriptPublishBody;
  try {
    body = assembleBody(softInput, stepPayloads);
    body = { ...body, package_key };
  } catch (e) {
    reasons.push(String((e as Error).message || e));
    body = {
      package_key,
      kind: "script",
      name: input.flow.name,
      version,
      schema_version: 1,
      manifest: {
        script_id: input.flow.id,
        variables: [],
        outputs: [],
        steps: [],
        runtime_requirements: { runner_min: "2.0.0" },
        assets: input.assets ?? [],
      },
      dependencies: [],
      runtime_compatibility: { runner_min: "2.0.0" },
    };
  }

  let publish_body: ScriptPublishBody | null = null;
  try {
    publish_body = assertScriptPublishBody(structuredClone(body));
  } catch {
    publish_body = null;
  }

  const incomplete = reasons.length > 0 || publish_body === null;
  return {
    package_key: body.package_key,
    name: body.name,
    version: body.version,
    content_digest: computeScriptContentDigest(body),
    execution_digest: computeExecutionDigest(body.manifest),
    incomplete,
    incomplete_reasons: [...new Set(reasons)],
    publish_body,
  };
}

/** Map Scenario/Flow → SEO-OPS Script release (publish path — requires Steps). */
export function buildScriptPublishBody(input: ScriptExportInput): ScriptPublishBody {
  const { flow, steps, version } = input;
  if (!SEMVER.test(version)) throw new Error("SCRIPT_EXPORT: invalid version");
  const { stepPayloads, missing } = mapStepPayloads(flow, steps);
  if (missing.length) {
    throw new Error(`SCRIPT_EXPORT: missing step ${missing[0]}`);
  }
  if (stepPayloads.length === 0) throw new Error("SCRIPT_EXPORT: steps required");
  return assembleBody(input, stepPayloads);
}

export function assertScriptPublishBody(body: ScriptPublishBody) {
  if (body.kind !== "script") throw new Error("SCRIPT_EXPORT: kind must be script");
  if (!body.manifest.script_id) throw new Error("SCRIPT_EXPORT: script_id required");
  if (!Array.isArray(body.manifest.variables)) throw new Error("SCRIPT_EXPORT: variables required");
  if (!Array.isArray(body.manifest.steps) || body.manifest.steps.length === 0) {
    throw new Error("SCRIPT_EXPORT: steps required");
  }
  const v = body.manifest.video_demo;
  if (!v) throw new Error("SCRIPT_EXPORT: missing_demo — attach a Test Lab Script Demo first");
  if (v.audio !== false || v.desktop_capture !== false) {
    throw new Error("SCRIPT_EXPORT: video demo must be browser-only silent capture");
  }
  if (!v.test_run_id || !v.artifact_ref) throw new Error("SCRIPT_EXPORT: video demo incomplete");
  if (!v.reviewed) throw new Error("SCRIPT_EXPORT: video demo must be reviewed");
  if (!v.thumbnail_ref) throw new Error("SCRIPT_EXPORT: video demo thumbnail required");
  return body;
}
