import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunResult, Value } from "../shared/admin-v3.js";
import { inputValues, isValue, resolveBinding, V3_CAPABILITIES } from "../shared/admin-v3.js";
import { validateVariables, resolvePayload } from "../shared/flow-model.js";
import type { ExecuteSnapshot } from "./admin-v3.js";
import { readBundle, type Bundle } from "./studio-packages.js";

/** Runner compatibility boundary. Reads only the validated bundle and caller-owned local session/runtime. */
export async function runBundle(bundle: Bundle, supplied: Record<string, Value>, bundleDirectory: string,
  execute: ExecuteSnapshot, capabilities: readonly string[] = V3_CAPABILITIES): Promise<RunResult> {
  // Revalidate the supplied bytes at the execution boundary, including nested dependencies.
  bundle = readBundle(bundle.files);
  const result: RunResult = { id: `r${randomUUID()}`, status: "VERIFIED", startedAt: new Date().toISOString(), finishedAt: "",
    digest: bundle.manifest.checksum, outputs: {}, nodes: [], issues: [] };
  try {
    if (bundle.manifest.requiredCapabilities.some(c => !capabilities.includes(c))) throw new Error("RUNNER_CAPABILITY_MISSING");
    const inputs = inputValues(bundle.definition.fields, supplied), nodes: Record<string, Record<string, Value>> = Object.create(null);
    for (const node of bundle.definition.nodes) {
      const values = Object.fromEntries(Object.entries(node.mappings).map(([key, binding]) => [key, resolveBinding(binding, inputs, nodes)]));
      let outputs: Record<string, Value>, status: RunResult["status"];
      if (bundle.manifest.kind === "workflow") {
        const dependency = node.releaseId && bundle.dependencies[node.releaseId]; if (!dependency) throw new Error("MISSING_WIDGET_DEPENDENCY");
        const nested = await runBundle(dependency, values, path.join(bundleDirectory, "dependencies", dependency.manifest.releaseId), execute, capabilities);
        outputs = nested.outputs; status = nested.status;
        if (nested.issues.length) result.issues.push(...nested.issues.map(issue => ({ ...issue, path: `${node.id}.${issue.path}` })));
      } else {
        const snapshot = structuredClone(bundle.snapshots[node.id]);
        validateVariables(snapshot.flow.variables ?? [], values); snapshot.flow.defaultPattern = { values };
        for (const step of snapshot.steps) resolvePayload(step.payload, snapshot.flow);
        const run = await execute(snapshot, values, path.join(bundleDirectory, "assets"));
        status = run.status; outputs = { status, message: run.message, runId: run.runId, scenarioId: snapshot.flow.id };
      }
      nodes[node.id] = outputs; result.nodes.push({ id: node.id, status, outputs });
      if (["BLOCKED", "ERROR"].includes(status)) { result.status = status; throw new Error(`NODE_FAILED: ${node.id}`); }
      if (status === "ACTION_SENT") result.status = "ACTION_SENT";
    }
    for (const output of bundle.definition.outputs) {
      const value = resolveBinding(output.binding, inputs, nodes);
      if (!isValue(output.type, value)) throw new Error(`OUTPUT_TYPE: ${output.key}`);
      result.outputs[output.key] = value;
    }
  } catch (error) {
    if (!["BLOCKED", "ERROR"].includes(result.status)) result.status = "BLOCKED";
    result.issues.push({ code: "RUNNER_EXECUTION", path: "run", message: String(error) });
  }
  result.finishedAt = new Date().toISOString(); return result;
}
