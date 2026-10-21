import type { Flow, Step, Variable, VariableValues } from "./contracts.js";

export const V3_SCHEMA = 1 as const;
export const V3_RUNTIME = "2.0.0";
export const V3_CAPABILITIES = ["browser.input", "browser.visual", "browser.ocr", "browser.upload", "browser.clipboard"] as const;
export type Value = string | string[] | number;
export type ValueType = Variable["type"];
export type Fields = Field[];
export type Field = { key: string; label: string; type: ValueType; required: boolean;
  visibility: "exposed" | "hidden"; description?: string; default?: Value; sensitive?: boolean;
  validation?: { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string } };
export type Port = { key: string; type: ValueType; required: boolean; sensitive?: boolean };
export type Binding = { source: "input"; key: string } | { source: "node"; nodeId: string; key: string }
  | { source: "literal"; type: ValueType; value: Value };
export type Snapshot = { schemaVersion: 1; flow: Flow; steps: Step[] };
export type ScenarioRef = { id: string; steps: { id: string; version: number }[] };
export type CompositionNode = { id: string; scenario?: ScenarioRef; releaseId?: string;
  mappings: Record<string, Binding>; failure: "stop" };
export type Output = Port & { binding: Binding };
export type Preview = { id: string; kind: "screenshot" | "video"; filename: string; sha256: string;
  caseId: string; runId: string; reviewedAt: string; reviewed: true };
export type Lifecycle = "draft" | "validated" | "tested" | "built" | "published" | "deprecated";
export type Definition = { id: string; revision: number; name: string; kind: "variation" | "widget" | "workflow";
  version: string; variationId?: string; packageId?: string; fields: Fields; nodes: CompositionNode[]; outputs: Output[];
  capabilities: string[]; previewIds: string[]; state: Lifecycle; updatedAt: string;
  testedDigest?: string; testedRunId?: string; testedAt?: string };
export type Issue = { code: string; path: string; message: string };
export type RunResult = { id: string; status: "VERIFIED" | "ACTION_SENT" | "BLOCKED" | "ERROR";
  startedAt: string; finishedAt: string; outputs: Record<string, Value>; nodes: { id: string; status: string; outputs: Record<string, Value> }[];
  issues: Issue[]; digest: string };
export type Manifest = { schemaVersion: 1; packageId: string; name: string; kind: "widget" | "workflow";
  version: string; runtimeMinVersion: string; entrypoint: "graph.json"; requiredCapabilities: string[];
  dependencies: { releaseId: string; packageId: string; version: string; mode: "bundled" }[];
  previews: { path: string; kind: Preview["kind"]; sha256: string; reviewed: true }[];
  files: Record<string, string>; checksum: string; releaseId: string };
export type Release = { definitionId: string; manifest: Manifest; status: "built" | "published" | "deprecated";
  createdAt: string; publishedAt?: string; validation: Issue[]; testedRunId: string };
export type BuildAttempt = { id: string; definitionId: string; name: string; kind: Definition["kind"]; version: string;
  status: "built" | "failed"; createdAt: string; releaseId?: string; issues: Issue[] };
export type StudioState = { builds?: BuildAttempt[]; contracts?: Record<string, { fields: Field[]; inputs: Port[]; outputs: Port[] }>; definitions: Definition[]; releases: Release[]; previews: Preview[]; runs: RunResult[]; imports: Manifest[] };
export type V3Request =
  | { action: "state" }
  | { action: "save"; definition: Definition }
  | { action: "duplicate"; id: string }
  | { action: "delete"; id: string; confirmed: boolean }
  | { action: "validate" | "build"; id: string }
  | { action: "publish" | "deprecate" | "export"; releaseId: string }
  | { action: "import" }
  | { action: "run"; id: string; sessionId: string; startUrl: string; values: VariableValues; imported?: boolean }
  | { action: "selectPreview"; caseId: string; runId: string; kind: Preview["kind"]; confirmed: boolean }
  | { action: "preview"; id: string };
export type V3Response = { state: StudioState; issues?: Issue[]; result?: RunResult; media?: { kind: Preview["kind"]; url: string }; cancelled?: boolean; error?: { code: string; message: string } };
export const scenarioOutputs: Port[] = ["status", "message", "runId", "scenarioId"].map(key => ({ key, type: "text" as const, required: true }));
export const inputPorts = (fields: Field[]): Port[] => fields.filter(f => f.visibility === "exposed" || f.sensitive).map(f => ({
  key: f.key, type: f.type, required: f.required && f.default === undefined, ...(f.sensitive ? { sensitive: true } : {})
}));
export function isValue(type: ValueType, value: unknown): value is Value {
  return type === "files" ? Array.isArray(value) && value.every(x => typeof x === "string")
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === "string";
}
export function compatible(source: ValueType, target: ValueType) { return source === target || source === "integer" && target === "number"; }
export function inputValues(fields: Fields, supplied: Record<string, unknown>): Record<string, Value> {
  const values: Record<string, Value> = Object.create(null);
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("INPUT_OBJECT: Input values must be an object.");
  for (const key of Object.keys(supplied)) if (!fields.some(f => f.key === key && (f.visibility === "exposed" || f.sensitive))) throw new Error(`UNKNOWN_INPUT: ${key}`);
  for (const f of fields) {
    const x = supplied[f.key] ?? f.default;
    if (x === undefined || x === "" || Array.isArray(x) && !x.length) { if (f.required) throw new Error(`REQUIRED_INPUT: ${f.key}`); if (x === undefined) continue; }
    if (!isValue(f.type, x)) throw new Error(`INPUT_TYPE: ${f.key}`);
    const v = f.validation;
    if (v && ((typeof x === "number" && (v.min !== undefined && x < v.min || v.max !== undefined && x > v.max))
      || (typeof x === "string" && (v.minLength !== undefined && x.length < v.minLength || v.maxLength !== undefined && x.length > v.maxLength
        || v.pattern !== undefined && !new RegExp(v.pattern).test(x))))) throw new Error(`INPUT_VALIDATION: ${f.key}`);
    values[f.key] = x;
  }
  return values;
}
export function readBinding(binding: Binding, inputs: Record<string, Value>, nodes: Record<string, Record<string, Value>>): Value | undefined {
  return binding.source === "literal" ? binding.value : binding.source === "input" ? inputs[binding.key] : nodes[binding.nodeId]?.[binding.key];
}
export function resolveBinding(binding: Binding, inputs: Record<string, Value>, nodes: Record<string, Record<string, Value>>): Value {
  const value = readBinding(binding, inputs, nodes);
  if (value === undefined) throw new Error("MISSING_MAPPING_VALUE");
  return value;
}
