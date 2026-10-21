import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Store } from "./storage.js";
import { validatePayload } from "./storage.js";
import { validateVariables, resolvePayload } from "../shared/flow-model.js";
import type { Definition, Snapshot, Issue, Manifest, Port, RunResult, Value, StudioState, CompositionNode } from "../shared/admin-v3.js";
import { inputValues, readBinding, isValue } from "../shared/admin-v3.js";
import { validateDefinition } from "../shared/admin-v3-validation.js";
import { AdminV3Store, canonical, executable, sha256 } from "./admin-v3-store.js";
import { PreviewAssets } from "./preview-assets.js";

export type Prepared = { definition: Definition; snapshots: Record<string, Snapshot>; issues: Issue[];
  manifests: Record<string, Manifest>; contracts: Record<string, { inputs: Port[]; outputs: Port[] }>;
  files: Record<string, Buffer>; digest: string };
export type ExecuteSnapshot = (snapshot: Snapshot, values: Record<string, Value>, assetDir: string) => Promise<{ status: RunResult["status"]; message: string; runId: string }>;
export class StudioError extends Error {
  constructor(readonly issues: Issue[]) { super(issues.map(x => `${x.code} (${x.path}): ${x.message}`).join("\n")); }
}
export class AdminStudio {
  readonly data: AdminV3Store;
  readonly previews: PreviewAssets;
  constructor(readonly root: string, readonly source: Store, readonly targetRoot: string, evidenceRoot: string) {
    this.data = new AdminV3Store(root); this.previews = new PreviewAssets(path.join(root, "previews"), evidenceRoot);
  }
  async state(): Promise<StudioState> {
    return { definitions: await this.data.definitions(), releases: await this.data.releases(),
      previews: await this.previews.list(), runs: await this.data.runs(), imports: await this.data.list<Manifest>("imports") };
  }
  async save(definition: Definition) {
    // Drafts may have incomplete mappings. Validate outer schema before touching disk.
    if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.fields) || !Array.isArray(definition.outputs) || !Array.isArray(definition.capabilities) || !Array.isArray(definition.previewIds)
      || !["variation", "widget", "workflow"].includes(definition.kind)) throw new Error("DEFINITION_SCHEMA");
    const all = await this.data.definitions(), previous = all.find(x => x.id === definition.id);
    if (previous && ["published", "deprecated"].includes(previous.state)) throw new Error("IMMUTABLE: Duplicate as a new revision/version.");
    if (previous && definition.revision !== previous.revision) throw new Error("REVISION_CONFLICT: Reopen the latest saved definition.");
    // Persist only the authoring contract; client cannot submit lifecycle/test evidence.
    const value: Definition = { ...structuredClone(executable(definition)), variationId: definition.variationId,
      revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), state: "draft" };
    if (value.packageId) this.data.location("definitions", value.packageId);
    // Validate identity even for incomplete drafts; no path is derived from a display name.
    this.data.location("definitions", value.id);
    if (!value.name?.trim() || value.name.length > 120 || !/^\d+\.\d+\.\d+$/.test(value.version)) throw new Error("NAME_VERSION_SCHEMA");
    if (all.some(x => x.id !== value.id && x.kind === value.kind && x.name === value.name && x.version === value.version)) throw new Error("DUPLICATE_VERSION");
    await this.data.put("definitions", value.id, value); return value;
  }
  async duplicate(id: string) {
    const original = await this.data.get<Definition>("definitions", id);
    const revision = ["published", "deprecated"].includes(original.state);
    const [major, minor, patch] = original.version.split(".").map(Number);
    return this.save({ ...original, id: `d${randomUUID()}`, packageId: revision ? original.packageId ?? original.id : undefined,
      name: revision ? original.name : `${original.name} copy`.slice(0, 120), version: revision ? `${major}.${minor}.${patch + 1}` : original.version, revision: 0, state: "draft" });
  }
  async delete(id: string, confirmed: boolean) {
    if (confirmed !== true) throw new Error("DELETE_CONFIRMATION_REQUIRED");
    const original = await this.data.get<Definition>("definitions", id);
    if (["published", "deprecated"].includes(original.state) || (await this.data.releases()).some(x => (x.definitionId === id || x.manifest.packageId === id))) throw new Error("RELEASE_REFERENCE: Released definitions are retained. Deprecate the release.");
    if ((await this.data.definitions()).some(x => x.variationId === id)) throw new Error("VARIATION_IN_USE");
    await this.data.removeDefinition(id);
  }
  async prepare(definition: Definition): Promise<Prepared> {
    const snapshots: Record<string, Snapshot> = Object.create(null), files: Record<string, Buffer> = Object.create(null);
    const issues: Issue[] = [], manifests: Record<string, Manifest> = Object.create(null), contracts: Prepared["contracts"] = Object.create(null);
    const add = (code: string, at: string, message: string) => issues.push({ code, path: at, message });
    if (!Array.isArray(definition.nodes)) return { definition, snapshots, files, manifests, contracts, issues: [{ code: "SCHEMA", path: "nodes", message: "Nodes required." }], digest: "" };
    for (const node of definition.nodes) {
      if (definition.kind === "workflow") continue; // Filled by package-aware preparation in the Workflow layer.
      const flow = this.source.flows().find(x => x.id === node.scenario?.id);
      if (!flow || !node.scenario || !Array.isArray(node.scenario.steps)) { add("MISSING_SCENARIO", node.id, "Select a saved Scenario and pin its Steps."); continue; }
      try {
        const steps = node.scenario.steps.map(ref => {
          if (!flow.steps.some(s => s.id === ref.id)) throw new Error("Step is not owned by the referenced Scenario.");
          const step = structuredClone(this.source.step(ref.id, ref.version));
          const p = step.payload;
          // Input data must come from mapped Variables, never inline legacy data/absolute paths.
          if ((p.text !== undefined || p.files !== undefined) && !p.variableId) throw new Error("Legacy inline input must be converted to a mapped Scenario Variable before packaging.");
          delete p.text; delete p.files; delete p.quickTagCount;
          validatePayload(p);
          return step;
        });
        const snapshot: Snapshot = { schemaVersion: 1, flow: { id: flow.id, name: flow.name, zoom: flow.zoom,
          steps: structuredClone(node.scenario.steps), variables: structuredClone(flow.variables ?? []) }, steps };
        validateVariables(snapshot.flow.variables ?? [], {});
        snapshots[node.id] = snapshot;
        for (const step of steps) {
          const p = step.payload;
          if (["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE", "QUICK_TAG"].includes(p.action)) {
            const variable = flow.variables?.find(v => v.id === p.variableId);
            const types = p.action === "QUICK_TAG" ? ["integer"] : p.action === "UPLOAD_FILE" ? ["file", "files"] : ["text"];
            if (!variable || !types.includes(variable.type)) add("ACTION_VARIABLE_TYPE", node.id, "Action requires a compatible declared Scenario Variable.");
          }
          const required = ["browser.input", ...(p.target ? ["browser.visual"] : []), ...(p.target?.ocr || p.method === "ocr" ? ["browser.ocr"] : []),
            ...(p.action === "UPLOAD_FILE" ? ["browser.upload"] : []), ...(p.inputMethod === "clipboard" ? ["browser.clipboard"] : [])];
          for (const capability of required) if (!definition.capabilities.includes(capability)) add("CAPABILITY_REQUIRED", node.id, capability);
          if (p.target) {
            try { files[`assets/${p.target.asset}`] = await readFile(path.join(this.targetRoot, p.target.asset)); }
            catch { add("MISSING_TARGET_ASSET", node.id, p.target.asset); }
          }
        }
      } catch (error) { add("SCENARIO_SNAPSHOT", node.id, String(error)); }
    }
    for (const id of definition.previewIds ?? []) {
      try { const { preview, bytes } = await this.previews.bytes(id); files[`assets/${preview.filename}`] = bytes; }
      catch (error) { add("PREVIEW_REVIEW", id, String(error)); }
    }
    issues.push(...validateDefinition(definition, snapshots, manifests, contracts));
    return { definition, snapshots, files, manifests, contracts, issues,
      digest: sha256(canonical({ definition: executable(definition), snapshots, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])) })) };
  }
  async validate(id: string) {
    const definition = await this.data.get<Definition>("definitions", id), prepared = await this.prepare(definition);
    if (!prepared.issues.length && !["published", "deprecated", "built", "tested"].includes(definition.state)) {
      definition.state = "validated"; await this.data.put("definitions", id, definition);
    }
    return prepared;
  }
  protected async executeNode(prepared: Prepared, node: CompositionNode, values: Record<string, Value>, execute: ExecuteSnapshot, assetRoot: string) {
    const snapshot = prepared.snapshots[node.id];
    if (!snapshot) throw new Error("SNAPSHOT_MISSING");
    validateVariables(snapshot.flow.variables ?? [], values);
    const clone = structuredClone(snapshot); clone.flow.defaultPattern = { values };
    for (const step of clone.steps) resolvePayload(step.payload, clone.flow);
    const run = await execute(clone, values, assetRoot);
    return { status: run.status, outputs: { status: run.status, message: run.message, runId: run.runId, scenarioId: clone.flow.id } as Record<string, Value> };
  }
  async execute(prepared: Prepared, supplied: Record<string, Value>, execute: ExecuteSnapshot, assetRoot = this.targetRoot): Promise<RunResult> {
    const result: RunResult = { id: `r${randomUUID()}`, status: "VERIFIED", startedAt: new Date().toISOString(), finishedAt: "", outputs: {}, nodes: [], issues: [...prepared.issues], digest: prepared.digest };
    try {
      if (result.issues.length) throw new StudioError(result.issues);
      const inputs = inputValues(prepared.definition.fields, supplied), nodes: Record<string, Record<string, Value>> = Object.create(null);
      for (const node of prepared.definition.nodes) {
        const values = Object.fromEntries(Object.entries(node.mappings).map(([k, b]) => [k, readBinding(b, inputs, nodes)] as const).filter((entry): entry is readonly [string, Value] => entry[1] !== undefined));
        const run = await this.executeNode(prepared, node, values, execute, assetRoot);
        nodes[node.id] = run.outputs; result.nodes.push({ id: node.id, status: run.status, outputs: run.outputs });
        if (["BLOCKED", "ERROR"].includes(run.status)) { result.status = run.status; throw new Error(`NODE_FAILED: ${node.id}`); }
        if (run.status === "ACTION_SENT") result.status = "ACTION_SENT";
      }
      for (const output of prepared.definition.outputs) {
        const value = readBinding(output.binding, inputs, nodes);
        if (value === undefined && !output.required) continue;
        if (!isValue(output.type, value)) throw new Error(`OUTPUT_TYPE: ${output.key}`);
        result.outputs[output.key] = value;
      }
    } catch (error) {
      if (!["BLOCKED", "ERROR"].includes(result.status)) result.status = "BLOCKED";
      if (!(error instanceof StudioError)) result.issues.push({ code: "EXECUTION", path: "run", message: String(error) });
    }
    result.finishedAt = new Date().toISOString();
    // Do not persist end-user inputs/outputs or runtime messages, which may contain private data.
    await this.data.put("runs", result.id, { ...result, outputs: {}, nodes: result.nodes.map(n => ({ ...n, outputs: {} })) }, true);
    if (!["BLOCKED", "ERROR"].includes(result.status)) {
      const latest = (await this.data.definitions()).find(x => x.id === prepared.definition.id);
      if (latest && canonical(executable(latest)) === canonical(executable(prepared.definition)) && !["published", "deprecated"].includes(latest.state)) {
        latest.state = "tested"; latest.testedDigest = prepared.digest; latest.testedRunId = result.id; latest.testedAt = result.finishedAt;
        await this.data.put("definitions", latest.id, latest);
      }
    }
    return result;
  }
}
