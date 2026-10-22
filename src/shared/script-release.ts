import type { Flow, Step, Variable } from "./contracts.js";

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

const PACKAGE_KEY = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/;

/** Map Scenario/Flow → SEO-OPS Script release (no Widget/Workflow packaging). */
export function buildScriptPublishBody(input: ScriptExportInput): ScriptPublishBody {
  const { flow, steps, version } = input;
  if (!SEMVER.test(version)) throw new Error("SCRIPT_EXPORT: invalid version");
  const packageKey =
    input.packageKey ??
    flow.id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
  if (!PACKAGE_KEY.test(packageKey)) throw new Error("SCRIPT_EXPORT: invalid package_key");

  const variables: ScriptVariable[] = (flow.variables ?? []).map((v) => ({
    key: v.key,
    type: v.type,
    ...(v.description ? { description: v.description } : {}),
  }));

  const stepPayloads = flow.steps.map((ref) => {
    const step = steps.find((s) => s.id === ref.id && s.version === ref.version);
    if (!step) throw new Error(`SCRIPT_EXPORT: missing step ${ref.id}@${ref.version}`);
    const variable = flow.variables?.find((v) => v.id === step.payload.variableId);
    return {
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
    };
  });

  if (stepPayloads.length === 0) throw new Error("SCRIPT_EXPORT: steps required");

  const runnerMin = input.runnerMin ?? "2.0.0";
  const manifest: ScriptReleaseManifest = {
    script_id: flow.id,
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

  // Never emit forbidden executable keys.
  if ("script" in manifest || "code" in manifest) {
    throw new Error("SCRIPT_EXPORT: forbidden executable field");
  }

  return {
    package_key: packageKey,
    kind: "script",
    name: flow.name,
    version,
    schema_version: 1,
    ...(input.description ? { description: input.description } : {}),
    manifest,
    dependencies: [],
    runtime_compatibility: { runner_min: runnerMin },
  };
}

export function assertScriptPublishBody(body: ScriptPublishBody) {
  if (body.kind !== "script") throw new Error("SCRIPT_EXPORT: kind must be script");
  if (!body.manifest.script_id) throw new Error("SCRIPT_EXPORT: script_id required");
  if (!Array.isArray(body.manifest.variables)) throw new Error("SCRIPT_EXPORT: variables required");
  if (!Array.isArray(body.manifest.steps) || body.manifest.steps.length === 0) {
    throw new Error("SCRIPT_EXPORT: steps required");
  }
  if (body.manifest.video_demo) {
    const v = body.manifest.video_demo;
    if (v.audio !== false || v.desktop_capture !== false) {
      throw new Error("SCRIPT_EXPORT: video demo must be browser-only silent capture");
    }
    if (!v.test_run_id || !v.artifact_ref) throw new Error("SCRIPT_EXPORT: video demo incomplete");
  }
  return body;
}
