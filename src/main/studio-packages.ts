import { inputPorts } from "../shared/admin-v3.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile, readdir, lstat, rename, rm } from "node:fs/promises";
import type { Definition, Manifest, Snapshot, Release, Field, Output, Port, StudioState, BuildAttempt } from "../shared/admin-v3.js";
import { V3_RUNTIME, V3_CAPABILITIES } from "../shared/admin-v3.js";
import { validateDefinition, safeKey } from "../shared/admin-v3-validation.js";
import { validateVariables } from "../shared/flow-model.js";
import { validatePayload } from "./storage.js";
import { validateZoom } from "../shared/geometry.js";
import { AdminStudio, StudioError } from "./admin-v3.js";
import { canonical, sha256 } from "./admin-v3-store.js";
import { encodeZip, decodeZip, safePackagePath } from "./package-zip.js";

export type Bundle = { manifest: Manifest; definition: Definition; snapshots: Record<string, Snapshot>; files: Record<string, Buffer>; dependencies: Record<string, Bundle> };
const jsonBytes = (value: unknown) => Buffer.from(canonical(value));
function keys(value: object, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error("PACKAGE_SCHEMA: Unknown property.");
}
export function portableJson(value: unknown) {
  if (typeof value === "string") {
    if (/(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|^\/[^/]|\bBearer\s+[A-Za-z0-9._-]+|persist:)/i.test(value)) throw new Error("PACKAGE_PRIVATE_DATA: Machine paths, session partitions and credentials cannot be exported.");
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|cookie|credential|api.?key/i.test(k))) throw new Error("PACKAGE_SECRET_URL");
    }
  } else if (Array.isArray(value)) value.forEach(portableJson);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(cookies?|credentials?|password|proxySecret|partition|sessionId|browserSession|authorization|accessToken|apiKey)$/i.test(key)) throw new Error("PACKAGE_SECRET_METADATA");
    portableJson(item);
  }
}
function digestManifest(manifest: Manifest) { const { checksum: _checksum, releaseId: _id, ...content } = manifest; return sha256(canonical(content)); }
function parse<T>(files: Record<string, Buffer>, name: string): T {
  const bytes = files[name]; if (!bytes || bytes.length > 4 * 1024 * 1024) throw new Error(`PACKAGE_JSON: ${name}`);
  const value = JSON.parse(bytes.toString("utf8")); portableJson(value); return value as T;
}
function validateSnapshot(snapshot: Snapshot) {
  keys(snapshot, ["schemaVersion", "flow", "steps"]);
  if (snapshot.schemaVersion !== 1) throw new Error("SNAPSHOT_SCHEMA_VERSION");
  keys(snapshot.flow, ["id", "name", "zoom", "steps", "variables"]);
  validateZoom(snapshot.flow.zoom); validateVariables(snapshot.flow.variables ?? [], {});
  if (typeof snapshot.flow.id !== "string" || typeof snapshot.flow.name !== "string" || !Array.isArray(snapshot.steps) || !snapshot.steps.length || snapshot.steps.length > 2000 || !Array.isArray(snapshot.flow.steps)) throw new Error("SNAPSHOT_SCHEMA");
  for (const variable of snapshot.flow.variables ?? []) keys(variable, ["id", "key", "type", "description"]);
  const seen = new Set<string>();
  for (const ref of snapshot.flow.steps) {
    keys(ref, ["id", "version"]);
    if (typeof ref.id !== "string" || !Number.isSafeInteger(ref.version) || ref.version < 1 || seen.has(ref.id)) throw new Error("SNAPSHOT_PIN");
    seen.add(ref.id);
  }
  for (const step of snapshot.steps) {
    keys(step, ["id", "version", "name", "createdAt", "payload"]);
    if (typeof step.name !== "string" || typeof step.createdAt !== "string") throw new Error("STEP_SCHEMA");
    keys(step.payload, ["action", "variableId", "quickTagRows", "sleepMs", "inputMethod", "target", "method", "deltaY", "timeoutMs", "threshold"]);
    validatePayload(step.payload);
    const p = step.payload;
    if (["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE", "QUICK_TAG"].includes(p.action)) {
      const variable = snapshot.flow.variables?.find(v => v.id === p.variableId);
      const types = p.action === "QUICK_TAG" ? ["integer"] : p.action === "UPLOAD_FILE" ? ["file", "files"] : ["text"];
      if (!variable || !types.includes(variable.type)) throw new Error("ACTION_VARIABLE_TYPE");
    }
    if (p.target) {
      keys(p.target, ["matchTo", "environment", "asset", "roi", "ocr"]);
      keys(p.target.roi, ["x", "y", "width", "height"]);
      if (p.target.environment) keys(p.target.environment, ["width", "height", "zoom"]);
      if (p.target.ocr) { keys(p.target.ocr, ["text", "bbox", "confidence", "kind", "confirmed", "language"]); keys(p.target.ocr.bbox, ["x", "y", "width", "height"]); }
    }
  }
  if (snapshot.steps.length !== snapshot.flow.steps.length || snapshot.flow.steps.some((ref, i) => snapshot.steps[i].id !== ref.id || snapshot.steps[i].version !== ref.version)) throw new Error("SNAPSHOT_ORDER");
}
function checkFieldShape(fields: Field[]) {
  if (!Array.isArray(fields)) throw new Error("FORM_SCHEMA");
  for (const f of fields) keys(f, ["key", "label", "type", "required", "visibility", "description", "default", "sensitive", "validation"]);
}
function checkBinding(b: object) { keys(b, ["source", "key", "nodeId", "type", "value"]); }
/** Same validator is used by build, export, import and the standalone Runner adapter. */
export function readBundle(files: Record<string, Buffer>, ancestors: string[] = []): Bundle {
  const manifest = parse<Manifest>(files, "manifest.json");
  keys(manifest, ["schemaVersion", "packageId", "name", "kind", "version", "runtimeMinVersion", "entrypoint", "requiredCapabilities", "dependencies", "previews", "files", "checksum", "releaseId"]);
  if (manifest.schemaVersion !== 1 || !["widget", "workflow"].includes(manifest.kind) || !safeKey(manifest.packageId) || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || manifest.runtimeMinVersion !== V3_RUNTIME || manifest.entrypoint !== "graph.json" || !Array.isArray(manifest.requiredCapabilities)
    || manifest.requiredCapabilities.some(x => !(V3_CAPABILITIES as readonly string[]).includes(x)) || !Array.isArray(manifest.dependencies) || !Array.isArray(manifest.previews)
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("MANIFEST_COMPATIBILITY");
  const checksum = digestManifest(manifest);
  if (manifest.checksum !== checksum || manifest.releaseId !== `r${checksum}`) throw new Error("MANIFEST_CHECKSUM");
  if (ancestors.includes(manifest.releaseId) || ancestors.length > 8) throw new Error("DEPENDENCY_CYCLE");
  const expected = new Set(["manifest.json", ...Object.keys(manifest.files)]);
  if (expected.size !== Object.keys(files).length || expected.size > 3000 || Object.keys(files).some(k => !expected.has(k))) throw new Error("PACKAGE_UNDECLARED_FILE");
  const folded = new Set<string>();
  for (const [name, digest] of Object.entries(manifest.files)) {
    safePackagePath(name);
    if (name === "manifest.json" || folded.has(name.toLowerCase())) throw new Error("PACKAGE_DUPLICATE_FILE"); folded.add(name.toLowerCase());
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !files[name] || sha256(files[name]) !== digest) throw new Error(`FILE_CHECKSUM: ${name}`);
  }
  const fields = parse<Field[]>(files, "form.json"), inputs = parse<Port[]>(files, "inputs.json"), outputs = parse<Output[]>(files, "outputs.json");
  checkFieldShape(fields);
  if (canonical(inputs) !== canonical(inputPorts(fields))) throw new Error("INPUT_CONTRACT_MISMATCH");
  if (!Array.isArray(outputs)) throw new Error("OUTPUT_SCHEMA");
  for (const output of outputs) { keys(output, ["key", "type", "required", "binding"]); checkBinding(output.binding); }
  const permissions = parse<{ capabilities: string[] }>(files, "permissions.json"); keys(permissions, ["capabilities"]);
  if (canonical(permissions.capabilities) !== canonical(manifest.requiredCapabilities)) throw new Error("CAPABILITY_MISMATCH");
  const graph = parse<{ schemaVersion: number; kind: string; nodes: Definition["nodes"] }>(files, "graph.json"); keys(graph, ["schemaVersion", "kind", "nodes"]);
  if (graph.schemaVersion !== 1 || graph.kind !== manifest.kind || !Array.isArray(graph.nodes)) throw new Error("GRAPH_SCHEMA");
  const snapshots: Record<string, Snapshot> = Object.create(null), dependencies: Record<string, Bundle> = Object.create(null), manifests: Record<string, Manifest> = Object.create(null);
  const contracts: Record<string, { inputs: Port[]; outputs: Port[] }> = Object.create(null);
  const allowed = new Set(["form.json", "inputs.json", "outputs.json", "permissions.json", "graph.json"]);
  for (const dep of manifest.dependencies) {
    keys(dep, ["releaseId", "packageId", "version", "mode"]);
    if (manifest.kind !== "workflow" || dep.mode !== "bundled" || !/^r[a-f0-9]{64}$/.test(dep.releaseId) || dependencies[dep.releaseId]) throw new Error("DEPENDENCY_CONTRACT");
    const prefix = `dependencies/${dep.releaseId}/`, nested: Record<string, Buffer> = Object.create(null);
    for (const [name, bytes] of Object.entries(files)) if (name.startsWith(prefix)) { nested[name.slice(prefix.length)] = bytes; allowed.add(name); }
    const bundle = readBundle(nested, [...ancestors, manifest.releaseId]);
    if (bundle.manifest.kind !== "widget" || bundle.manifest.releaseId !== dep.releaseId || bundle.manifest.packageId !== dep.packageId || bundle.manifest.version !== dep.version) throw new Error("DEPENDENCY_PIN_MISMATCH");
    dependencies[dep.releaseId] = bundle; manifests[dep.releaseId] = bundle.manifest;
    contracts[dep.releaseId] = { inputs: inputPorts(bundle.definition.fields), outputs: bundle.definition.outputs };
    if (bundle.manifest.requiredCapabilities.some(c => !manifest.requiredCapabilities.includes(c))) throw new Error("DEPENDENCY_CAPABILITY_MISSING");
  }
  for (const node of graph.nodes) {
    keys(node, ["id", "scenario", "releaseId", "mappings", "failure"]);
    if (!safeKey(node.id) || !node.mappings || typeof node.mappings !== "object" || Array.isArray(node.mappings)) throw new Error("NODE_SCHEMA");
    for (const binding of Object.values(node.mappings)) checkBinding(binding);
    if (manifest.kind === "widget") {
      if (!node.scenario || node.releaseId) throw new Error("SCENARIO_REFERENCE"); keys(node.scenario, ["id", "steps"]);
      const name = `scenarios/${node.id}.json`; allowed.add(name);
      const snapshot = parse<Snapshot>(files, name); validateSnapshot(snapshot); snapshots[node.id] = snapshot;
      for (const step of snapshot.steps) {
        const p = step.payload, target = p.target;
        const required = ["browser.input", ...(target ? ["browser.visual"] : []), ...(target?.ocr || p.method === "ocr" ? ["browser.ocr"] : []), ...(p.action === "UPLOAD_FILE" ? ["browser.upload"] : []), ...(p.inputMethod === "clipboard" ? ["browser.clipboard"] : [])];
        if (required.some(c => !manifest.requiredCapabilities.includes(c))) throw new Error("ACTION_CAPABILITY_MISSING");
        if (target) { const asset = `assets/${target.asset}`; allowed.add(asset); if (!files[asset] || !files[asset].subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("TARGET_ASSET_MISSING_OR_INVALID"); }
      }
    } else if (!node.releaseId || node.scenario || !dependencies[node.releaseId]) throw new Error("MISSING_WIDGET_DEPENDENCY");
  }
  for (const preview of manifest.previews) {
    keys(preview, ["path", "kind", "sha256", "reviewed"]);
    if (!/^assets\/[a-f0-9-]{36}\.(png|webm)$/.test(preview.path) || !["screenshot", "video"].includes(preview.kind) || preview.reviewed !== true
      || sha256(files[preview.path] ?? Buffer.alloc(0)) !== preview.sha256 || !files[preview.path]?.length) throw new Error("PREVIEW_REVIEW_MISSING");
    allowed.add(preview.path);
  }
  if (manifest.dependencies.some(dep => !graph.nodes.some(n => n.releaseId === dep.releaseId))) throw new Error("UNUSED_DEPENDENCY");
  if (Object.keys(manifest.files).some(k => !allowed.has(k))) throw new Error("PACKAGE_UNEXPECTED_CONTENT");
  const definition: Definition = { id: manifest.packageId, name: manifest.name, kind: manifest.kind, version: manifest.version,
    fields, nodes: graph.nodes, outputs, capabilities: manifest.requiredCapabilities, previewIds: [], revision: 1, state: "built", updatedAt: "" };
  const issues = validateDefinition(definition, snapshots, manifests, contracts); if (issues.length) throw new StudioError(issues);
  return { manifest, definition, snapshots, files, dependencies };
}

export class PackageStudio extends AdminStudio {
  async bundle(releaseId: string): Promise<Bundle> {
    if (!/^r[a-f0-9]{64}$/.test(releaseId)) throw new Error("RELEASE_ID");
    const root = path.join(this.root, "bundles", releaseId), files: Record<string, Buffer> = Object.create(null);
    async function walk(directory: string, prefix = "") {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("PACKAGE_SYMLINK");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`; safePackagePath(name);
        if (entry.isSymbolicLink()) throw new Error("PACKAGE_SYMLINK");
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${name}/`);
        else if (entry.isFile()) files[name] = await readFile(path.join(directory, entry.name));
        else throw new Error("PACKAGE_FILE_TYPE");
      }
    }
    await walk(root); return readBundle(files);
  }
  async state(): Promise<StudioState> {
    const state = await super.state(); state.contracts = {}; state.builds = await this.data.list<BuildAttempt>("builds");
    for (const manifest of [...state.releases.map(x => x.manifest), ...state.imports]) {
      const bundle = await this.bundle(manifest.releaseId);
      state.contracts[manifest.releaseId] = { fields: bundle.definition.fields, inputs: inputPorts(bundle.definition.fields), outputs: bundle.definition.outputs };
    }
    return state;
  }
  async build(id: string) {
    const definition = await this.data.get<Definition>("definitions", id);
    const attempt: BuildAttempt = { id: `b${randomUUID()}`, definitionId: id, name: definition.name, kind: definition.kind,
      version: definition.version, createdAt: new Date().toISOString(), status: "failed", issues: [] };
    let release: Release;
    try {
      release = await this.buildPackage(id);
    } catch (error) {
      attempt.issues = error instanceof StudioError ? error.issues : [{ code: "BUILD_VALIDATION", path: "package", message: String(error) }];
      await this.data.put("builds", attempt.id, attempt, true); throw error;
    }
    attempt.status = "built"; attempt.releaseId = release.manifest.releaseId;
    await this.data.put("builds", attempt.id, attempt, true); return release;
  }
  private async buildPackage(id: string) {
    const d = await this.data.get<Definition>("definitions", id);
    if (d.kind === "variation") throw new Error("BUILD_WIDGET: Create a Widget from this Variation first.");
    const prepared = await this.prepare(d);
    if (prepared.issues.length) throw new StudioError(prepared.issues);
    if (d.testedDigest !== prepared.digest || !d.testedRunId) throw new Error("TEST_REQUIRED: Run the exact saved composition before build.");
    if (["published", "deprecated"].includes(d.state)) throw new Error("IMMUTABLE: Create a new version/revision.");
    const files: Record<string, Buffer> = { ...prepared.files,
      "form.json": jsonBytes(d.fields), "inputs.json": jsonBytes(inputPorts(d.fields)),
      "outputs.json": jsonBytes(d.outputs), "permissions.json": jsonBytes({ capabilities: d.capabilities }),
      "graph.json": jsonBytes({ schemaVersion: 1, kind: d.kind, nodes: d.nodes }) };
    for (const [nodeId, snapshot] of Object.entries(prepared.snapshots)) files[`scenarios/${nodeId}.json`] = jsonBytes(snapshot);
    const previews: Manifest["previews"] = [];
    for (const id of d.previewIds) { const { preview } = await this.previews.bytes(id); previews.push({ path: `assets/${preview.filename}`, kind: preview.kind, sha256: preview.sha256, reviewed: true }); }
    const manifest: Manifest = { schemaVersion: 1, packageId: d.packageId ?? d.id, name: d.name, kind: d.kind, version: d.version,
      runtimeMinVersion: V3_RUNTIME, entrypoint: "graph.json", requiredCapabilities: d.capabilities,
      dependencies: Object.values(prepared.manifests).map(m => ({ releaseId: m.releaseId, packageId: m.packageId, version: m.version, mode: "bundled" })),
      previews, files: Object.fromEntries(Object.entries(files).map(([name, buffer]) => [name, sha256(buffer)])), checksum: "", releaseId: "" };
    manifest.checksum = digestManifest(manifest); manifest.releaseId = `r${manifest.checksum}`;
    files["manifest.json"] = jsonBytes(manifest); readBundle(files);
    const all = await this.data.releases();
    if (all.some(r => r.manifest.packageId === (d.packageId ?? d.id) && r.manifest.version === d.version && r.manifest.releaseId !== manifest.releaseId)) throw new Error("VERSION_ALREADY_BUILT: Increment version before changing bytes.");
    const existing = all.find(r => r.manifest.releaseId === manifest.releaseId); if (existing) return existing;
    await this.persistBundle(files);
    const release: Release = { definitionId: d.id, manifest, status: "built", createdAt: new Date().toISOString(), validation: [], testedRunId: d.testedRunId };
    await this.data.put("releases", manifest.releaseId, release, true);
    d.state = "built"; await this.data.put("definitions", id, d); return release;
  }
  async persistBundle(files: Record<string, Buffer>) {
    const bundle = readBundle(files), root = path.join(this.root, "bundles", bundle.manifest.releaseId);
    await mkdir(path.dirname(root), { recursive: true });
    const staging = path.join(this.root, "bundles", `.staging-${randomUUID()}`);
    await mkdir(staging);
    try {
      for (const [name, bytes] of Object.entries(files)) { safePackagePath(name); const file = path.join(staging, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: "wx" }); }
      try { await rename(staging, root); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await this.bundle(bundle.manifest.releaseId); // Existing bytes must verify; never overwrite them.
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
    return bundle;
  }
  async export(releaseId: string) { return encodeZip((await this.bundle(releaseId)).files); }
  async import(bytes: Buffer) {
    const files = decodeZip(bytes), bundle = readBundle(files);
    await this.persistBundle(files);
    await this.data.put("imports", bundle.manifest.releaseId, bundle.manifest);
    return bundle;
  }
  async publish(releaseId: string) {
    const release = await this.data.get<Release>("releases", releaseId);
    if (release.status !== "built") throw new Error("LIFECYCLE: Only a built release can publish.");
    await this.bundle(releaseId); // Recheck all bytes, pins, capabilities and media before publishing.
    const definition = await this.data.get<Definition>("definitions", release.definitionId);
    const prepared = await this.prepare(definition);
    if (prepared.issues.length || definition.version !== release.manifest.version || definition.testedRunId !== release.testedRunId || definition.testedDigest !== prepared.digest) throw new Error("RELEASE_STALE: Build and test the current version before publishing.");
    release.status = "published"; release.publishedAt = new Date().toISOString(); await this.data.put("releases", releaseId, release);
    definition.state = "published"; await this.data.put("definitions", definition.id, definition);
  }
  async deprecate(releaseId: string) {
    const release = await this.data.get<Release>("releases", releaseId);
    if (release.status !== "published") throw new Error("LIFECYCLE: Only a published release can deprecate.");
    release.status = "deprecated"; await this.data.put("releases", releaseId, release);
    const definition = (await this.data.definitions()).find(d => d.id === release.definitionId);
    if (definition?.state === "published" && definition.version === release.manifest.version) { definition.state = "deprecated"; await this.data.put("definitions", definition.id, definition); }
  }
}
