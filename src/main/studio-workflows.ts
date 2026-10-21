import path from "node:path";
import type { Definition, CompositionNode, Value } from "../shared/admin-v3.js";
import { validateDefinition } from "../shared/admin-v3-validation.js";
import { PackageStudio } from "./studio-packages.js";
import { canonical, executable, sha256 } from "./admin-v3-store.js";
import type { Prepared, ExecuteSnapshot } from "./admin-v3.js";
import { runBundle } from "./runner-package.js";

/** V1 graph is an ordered DAG: Start → pinned Widgets → End; each failure stops. */
export class WorkflowStudio extends PackageStudio {
  async prepare(definition: Definition): Promise<Prepared> {
    if (definition.kind !== "workflow") return super.prepare(definition);
    const prepared: Prepared = { definition, snapshots: Object.create(null), files: Object.create(null),
      manifests: Object.create(null), contracts: Object.create(null), issues: [], digest: "" };
    const releases = await this.data.releases();
    for (const node of definition.nodes ?? []) {
      try {
        const release = releases.find(r => r.manifest.releaseId === node.releaseId);
        if (!release || release.status === "deprecated" || release.manifest.kind !== "widget") throw new Error("Widget must pin an available built/published release.");
        const dependency = await this.bundle(release.manifest.releaseId);
        prepared.manifests[dependency.manifest.releaseId] = dependency.manifest;
        prepared.contracts[dependency.manifest.releaseId] = { inputs: dependency.definition.fields.map(f => ({ key: f.key, type: f.type, required: f.required })), outputs: dependency.definition.outputs };
        for (const capability of dependency.manifest.requiredCapabilities) if (!definition.capabilities.includes(capability)) prepared.issues.push({ code: "CAPABILITY_REQUIRED", path: node.id, message: capability });
        for (const [name, bytes] of Object.entries(dependency.files)) prepared.files[`dependencies/${dependency.manifest.releaseId}/${name}`] = bytes;
      } catch (error) { prepared.issues.push({ code: "WIDGET_DEPENDENCY", path: node.id, message: String(error) }); }
    }
    for (const id of definition.previewIds ?? []) {
      try { const { preview, bytes } = await this.previews.bytes(id); prepared.files[`assets/${preview.filename}`] = bytes; }
      catch (error) { prepared.issues.push({ code: "PREVIEW_REVIEW", path: id, message: String(error) }); }
    }
    prepared.issues.push(...validateDefinition(definition, prepared.snapshots, prepared.manifests, prepared.contracts));
    prepared.digest = sha256(canonical({ definition: executable(definition), files: Object.fromEntries(Object.entries(prepared.files).map(([k, v]) => [k, sha256(v)])) }));
    return prepared;
  }
  protected async executeNode(prepared: Prepared, node: CompositionNode, values: Record<string, Value>, execute: ExecuteSnapshot, assetRoot: string) {
    if (prepared.definition.kind !== "workflow") return super.executeNode(prepared, node, values, execute, assetRoot);
    if (!node.releaseId || !prepared.manifests[node.releaseId]) throw new Error("WIDGET_PIN_MISSING");
    const dependency = await this.bundle(node.releaseId);
    const result = await runBundle(dependency, values, path.join(this.root, "bundles", node.releaseId), execute);
    return { status: result.status, outputs: result.outputs };
  }
}
