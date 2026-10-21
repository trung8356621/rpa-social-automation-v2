import type { Definition, Snapshot, Manifest, Issue, Port, Binding, ValueType, Field } from "./admin-v3.js";
import { compatible, isValue, scenarioOutputs, V3_CAPABILITIES } from "./admin-v3.js";
export const safeKey = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(x) && !["constructor", "prototype", "__proto__"].includes(x);
export const valueTypes = ["text", "file", "files", "integer", "number"];
export function validateFields(fields: Field[]): Issue[] {
  const issues: Issue[] = [], keys = new Set<string>();
  const add = (path: string, message: string) => issues.push({ code: "FORM_SCHEMA", path, message });
  if (!Array.isArray(fields) || fields.length > 200) return [{ code: "FORM_SCHEMA", path: "fields", message: "Expected at most 200 fields." }];
  for (const [i, f] of fields.entries()) {
    const at = `fields.${i}`;
    if (!f || !safeKey(f.key) || keys.has(f.key)) { add(at, "Invalid/duplicate key."); continue; }
    keys.add(f.key);
    if (!valueTypes.includes(f.type) || typeof f.label !== "string" || !f.label.trim() || typeof f.required !== "boolean" || !["hidden", "exposed"].includes(f.visibility)) add(at, "Invalid field type, label, visibility or required flag.");
    if (f.default !== undefined && !isValue(f.type, f.default)) add(at, "Default type does not match field.");
    if (f.sensitive && f.default !== undefined) add(at, "Sensitive inputs cannot have stored defaults.");
    if (f.visibility === "hidden" && !f.sensitive && f.default === undefined) add(at, "Hidden input requires an explicit default.");
    if (["file", "files"].includes(f.type) && f.default !== undefined) add(at, "File paths must be supplied locally at runtime.");
    const v = f.validation;
    if (v) {
      if (typeof v !== "object" || Object.keys(v).some(k => !["min", "max", "minLength", "maxLength", "pattern"].includes(k))) add(at, "Unsupported validation rule.");
      for (const n of [v.min, v.max, v.minLength, v.maxLength]) if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n))) add(at, "Validation bounds must be finite numbers.");
      if (v.min !== undefined && v.max !== undefined && v.min > v.max || v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) add(at, "Invalid bounds.");
      if (v.pattern !== undefined) {
        // Deliberately bounded regex subset: avoid nested quantifiers/backreferences in user schemas.
        if (typeof v.pattern !== "string" || v.pattern.length > 120 || /[(){}]|\\[1-9]/.test(v.pattern)) add(at, "Pattern supports a bounded subset without groups, braces or backreferences.");
        else try { new RegExp(v.pattern); } catch { add(at, "Invalid pattern."); }
      }
    }
  }
  return issues;
}
export function validateDefinition(d: Definition, snapshots: Record<string, Snapshot>, releases: Record<string, Manifest>, contracts: Record<string, { inputs: Port[]; outputs: Port[] }> = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!d || typeof d !== "object") return [{ code: "SCHEMA", path: "definition", message: "Definition required." }];
  if (!safeKey(d.id) || !["variation", "widget", "workflow"].includes(d.kind) || typeof d.name !== "string" || !d.name.trim() || d.name.length > 120 || !/^\d+\.\d+\.\d+$/.test(d.version)) add("SCHEMA", "definition", "Invalid ID, name, kind or semantic version.");
  issues.push(...validateFields(d.fields));
  if (!Array.isArray(d.nodes) || !d.nodes.length || d.nodes.length > 100 || !Array.isArray(d.outputs) || !Array.isArray(d.capabilities) || !Array.isArray(d.previewIds)) {
    add("SCHEMA", "graph", "Expected 1–100 nodes, outputs, capabilities and preview IDs."); return issues;
  }
  for (const capability of d.capabilities) if (!(V3_CAPABILITIES as readonly string[]).includes(capability)) add("CAPABILITY_UNSUPPORTED", "capabilities", String(capability));
  const previous: Record<string, Port[]> = Object.create(null);
  function binding(b: Binding, port: Port, at: string) {
    if (!b || typeof b !== "object") { add("MISSING_MAPPING", at, "Mapping required."); return; }
    const source = b.source === "literal" ? (isValue(b.type, b.value) && valueTypes.includes(b.type) ? b.type : undefined)
      : b.source === "input" ? d.fields?.find(f => f.key === b.key)?.type
      : b.source === "node" ? previous[b.nodeId]?.find(f => f.key === b.key)?.type : undefined;
    if (!source) add("BROKEN_MAPPING", at, "Source must exist and precede its consumer; cycles and forward references are forbidden.");
    else if (!compatible(source, port.type)) add("TYPE_MISMATCH", at, `${source} cannot map to ${port.type}.`);
    if (b.source === "input" && port.required) {
      const field = d.fields.find(f => f.key === b.key);
      if (field && !field.required && field.default === undefined) add("OPTIONAL_TO_REQUIRED", at, "Required target needs a required source or default.");
    }
  }
  for (const [i, n] of d.nodes.entries()) {
    const at = `nodes.${i}`;
    if (!n || !safeKey(n.id) || previous[n.id]) { add("DUPLICATE_NODE", at, "Invalid or duplicate node ID."); continue; }
    if (n.failure !== "stop" || !n.mappings || typeof n.mappings !== "object" || Array.isArray(n.mappings)) { add("GRAPH_SCHEMA", at, "V1 requires mappings and an explicit stop-on-failure path."); continue; }
    let ports: Port[] = [], outputs: Port[] = [];
    if (d.kind === "workflow") {
      const release = n.releaseId && releases[n.releaseId];
      if (!release || release.kind !== "widget") add("MISSING_WIDGET", at, "Pin an existing Widget release ID.");
      // Dependency input/output contracts are resolved by the main-process package reader.
      const snapshot = snapshots[n.id];
      if (snapshot) { ports = (snapshot.flow.variables ?? []).map(v => ({ key: v.id, type: v.type, required: true })); }
      outputs = contracts[n.releaseId ?? ""]?.outputs ?? [];
      ports = contracts[n.releaseId ?? ""]?.inputs ?? ports;
    } else {
      const snapshot = snapshots[n.id];
      if (!n.scenario || !snapshot || snapshot.flow.id !== n.scenario.id) add("MISSING_SCENARIO", at, "Scenario does not exist.");
      else {
        if (!Array.isArray(n.scenario.steps) || !n.scenario.steps.length || JSON.stringify(snapshot.flow.steps) !== JSON.stringify(n.scenario.steps)
          || snapshot.steps.length !== n.scenario.steps.length || n.scenario.steps.some(ref => !snapshot.steps.some(s => s.id === ref.id && s.version === ref.version))) add("MISSING_STEP_VERSION", at, "Pinned Step/version is missing or snapshot order differs.");
        ports = (snapshot.flow.variables ?? []).map(v => ({ key: v.id, type: v.type, required: true }));
        outputs = scenarioOutputs;
      }
    }
    for (const port of ports) binding(n.mappings[port.key], port, `${at}.mappings.${port.key}`);
    for (const key of Object.keys(n.mappings)) if (!ports.some(p => p.key === key)) add("UNKNOWN_TARGET", `${at}.mappings.${key}`, "Unknown target input.");
    previous[n.id] = outputs;
  }
  const outKeys = new Set<string>();
  for (const [i, output] of d.outputs.entries()) {
    if (!output || !safeKey(output.key) || outKeys.has(output.key) || !valueTypes.includes(output.type) || typeof output.required !== "boolean") add("OUTPUT_SCHEMA", `outputs.${i}`, "Invalid or duplicate output.");
    else { outKeys.add(output.key); binding(output.binding, output, `outputs.${i}`); }
  }
  return issues;
}
