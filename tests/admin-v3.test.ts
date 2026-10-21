import test from "node:test";
import assert from "node:assert/strict";
import { encodeZip, decodeZip } from "../src/main/package-zip.js";
import { canonical, sha256 } from "../src/main/admin-v3-store.js";
import { portableJson, readBundle } from "../src/main/studio-packages.js";
import { inputValues, inputPorts } from "../src/shared/admin-v3.js";
import type { Field, Manifest, Definition, Snapshot } from "../src/shared/admin-v3.js";
import { validateDefinition, validateFields } from "../src/shared/admin-v3-validation.js";
import { runBundle } from "../src/main/runner-package.js";

function packageBytes() {
  const snapshot: Snapshot = { schemaVersion: 1, flow: { id: "scenario1", name: "Sleep", zoom: 1, variables: [], steps: [{ id: "step1", version: 1 }] },
    steps: [{ id: "step1", version: 1, name: "Wait", createdAt: "2026-10-21T00:00:00Z", payload: { action: "SLEEP" } }] };
  const files: Record<string, Buffer> = Object.fromEntries(Object.entries({ "form.json": [], "inputs.json": [], "outputs.json": [],
    "permissions.json": { capabilities: ["browser.input"] }, "graph.json": { schemaVersion: 1, kind: "widget", nodes: [{ id: "node1", scenario: { id: "scenario1", steps: snapshot.flow.steps }, mappings: {}, failure: "stop" }] },
    "scenarios/node1.json": snapshot }).map(([k, v]) => [k, Buffer.from(canonical(v))]));
  const manifest: Manifest = { schemaVersion: 1, packageId: "widget1", name: "Example", version: "1.0.0", kind: "widget", runtimeMinVersion: "2.0.0", entrypoint: "graph.json",
    requiredCapabilities: ["browser.input"], dependencies: [], previews: [], files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha256(b)])), checksum: "", releaseId: "" };
  const seal = () => {
    const { checksum: _digest, releaseId: _id, ...content } = manifest;
    manifest.checksum = sha256(canonical(content)); manifest.releaseId = `r${manifest.checksum}`; files["manifest.json"] = Buffer.from(canonical(manifest));
  };
  seal(); return { files, manifest, seal, snapshot };
}
test("ZIP STORE roundtrip preserves exact package bytes; corruption is rejected", () => {
  const { files } = packageBytes(), zip = encodeZip(files), decoded = decodeZip(zip);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(decoded[name], bytes);
  const corrupted = Buffer.from(zip); corrupted[30 + corrupted.readUInt16LE(26)] ^= 1;
  assert.throws(() => decodeZip(corrupted), /INTEGRITY/);
});
test("ZIP rejects traversal, duplicate case aliases, symlink attributes and trailing bytes", () => {
  assert.throws(() => encodeZip({ "../secret": Buffer.from("x") }), /ZIP_PATH/);
  assert.throws(() => decodeZip(encodeZip({ "a.json": Buffer.from("a"), "A.json": Buffer.from("b") })), /DUPLICATE/);
  const zip = encodeZip({ "file.json": Buffer.from("data") }), changed = Buffer.from(zip);
  const central = changed.readUInt32LE(changed.length - 6); changed.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => decodeZip(changed), /ZIP_ENTRY/);
  assert.throws(() => decodeZip(Buffer.concat([zip, Buffer.from("extra")])));
});
test("package verifies every file and blocks undeclared data or unsupported runtime", () => {
  const { files, manifest, seal } = packageBytes(); assert.equal(readBundle(files).manifest.releaseId, manifest.releaseId);
  assert.throws(() => readBundle({ ...files, "cookies.json": Buffer.from("[]") }), /UNDECLARED_FILE/);
  assert.throws(() => readBundle({ ...files, "form.json": Buffer.from("[1]") }), /FILE_CHECKSUM/);
  manifest.runtimeMinVersion = "99.0.0"; seal(); assert.throws(() => readBundle(files), /COMPATIBILITY/);
});
test("snapshot rejects missing Step versions even with a recomputed valid file digest", () => {
  const { files, manifest, seal, snapshot } = packageBytes(); snapshot.steps[0].version = 2;
  files["scenarios/node1.json"] = Buffer.from(canonical(snapshot)); manifest.files["scenarios/node1.json"] = sha256(files["scenarios/node1.json"]); seal();
  assert.throws(() => readBundle(files), /SNAPSHOT_ORDER/);
});
test("typed form defaults, required values, hidden inputs and numeric bounds", () => {
  const fields: Field[] = [{ key: "count", label: "Count", type: "integer", required: true, visibility: "exposed", validation: { min: 1, max: 10 } },
    { key: "mode", label: "Mode", type: "text", required: true, visibility: "hidden", default: "test" }];
  assert.deepEqual({ ...inputValues(fields, { count: 3 }) }, { count: 3, mode: "test" });
  assert.throws(() => inputValues(fields, { count: "3" }), /INPUT_TYPE/);
  assert.throws(() => inputValues(fields, { count: 11 }), /INPUT_VALIDATION/);
  assert.throws(() => inputValues(fields, { count: 3, mode: "override" }), /UNKNOWN_INPUT/);
  assert.throws(() => inputValues(fields, {}), /REQUIRED_INPUT/);
  assert.ok(validateFields([{ ...fields[0], sensitive: true, default: 1 }]).length);
  assert.deepEqual(inputPorts(fields).map(p => p.key), ["count"]);
  assert.equal(inputPorts([{ ...fields[0], default: 2 }])[0].required, false);
});
test("two bundled Widgets map typed outputs without Admin Scenario access", async () => {
  const { files: widgetFiles, manifest: widgetManifest, snapshot } = packageBytes();
  const put = (files: Record<string, Buffer>, name: string, value: unknown) => { files[name] = Buffer.from(canonical(value)); };
  const seal = (files: Record<string, Buffer>, manifest: Manifest) => {
    manifest.files = Object.fromEntries(Object.entries(files).filter(([name]) => name !== "manifest.json").map(([name, bytes]) => [name, sha256(bytes)]));
    const { checksum: _checksum, releaseId: _release, ...content } = manifest;
    manifest.checksum = sha256(canonical(content)); manifest.releaseId = `r${manifest.checksum}`; put(files, "manifest.json", manifest);
  };
  const fields: Field[] = [{ key: "input", label: "Input", type: "text", required: true, visibility: "exposed" }];
  snapshot.flow.variables = [{ id: "variable1", key: "value", type: "text" }];
  put(widgetFiles, "scenarios/node1.json", snapshot); put(widgetFiles, "form.json", fields); put(widgetFiles, "inputs.json", inputPorts(fields));
  put(widgetFiles, "graph.json", { schemaVersion: 1, kind: "widget", nodes: [{ id: "node1", scenario: { id: "scenario1", steps: snapshot.flow.steps }, mappings: { variable1: { source: "input", key: "input" } }, failure: "stop" }] });
  put(widgetFiles, "outputs.json", [{ key: "status", type: "text", required: true, binding: { source: "node", nodeId: "node1", key: "status" } }]);
  seal(widgetFiles, widgetManifest);
  const workflowFiles: Record<string, Buffer> = Object.fromEntries(Object.entries(widgetFiles).map(([name, bytes]) => [`dependencies/${widgetManifest.releaseId}/${name}`, bytes]));
  put(workflowFiles, "form.json", []); put(workflowFiles, "inputs.json", []); put(workflowFiles, "permissions.json", { capabilities: ["browser.input"] });
  put(workflowFiles, "graph.json", { schemaVersion: 1, kind: "workflow", nodes: [
    { id: "first", releaseId: widgetManifest.releaseId, mappings: { input: { source: "literal", type: "text", value: "hello" } }, failure: "stop" },
    { id: "second", releaseId: widgetManifest.releaseId, mappings: { input: { source: "node", nodeId: "first", key: "status" } }, failure: "stop" }
  ] });
  put(workflowFiles, "outputs.json", [{ key: "status", type: "text", required: true, binding: { source: "node", nodeId: "second", key: "status" } }]);
  const manifest: Manifest = { ...widgetManifest, packageId: "workflow1", name: "Two Widgets", kind: "workflow", files: {},
    dependencies: [{ releaseId: widgetManifest.releaseId, packageId: widgetManifest.packageId, version: widgetManifest.version, mode: "bundled" }] };
  seal(workflowFiles, manifest);
  const values: unknown[] = [];
  const result = await runBundle(readBundle(workflowFiles), {}, "runner-local", async s => {
    values.push(s.flow.defaultPattern?.values.variable1);
    return { status: "VERIFIED", runId: "local-run", message: "Verified" };
  });
  assert.deepEqual(values, ["hello", "VERIFIED"]); assert.equal(result.outputs.status, "VERIFIED");
});
test("composition rejects forward output references and type mismatches", () => {
  const { snapshot } = packageBytes(); snapshot.flow.variables = [{ id: "textVar", key: "text", type: "text" }];
  const definition: Definition = { id: "variation1", name: "Composition", kind: "variation", version: "1.0.0", revision: 1, state: "draft", updatedAt: "",
    fields: [{ key: "count", label: "Count", type: "integer", required: true, visibility: "exposed" }], outputs: [], capabilities: ["browser.input"], previewIds: [],
    nodes: [{ id: "node1", scenario: { id: "scenario1", steps: snapshot.flow.steps }, mappings: { textVar: { source: "node", nodeId: "node2", key: "status" } }, failure: "stop" }] };
  assert.ok(validateDefinition(definition, { node1: snapshot }, {}).some(x => x.code === "BROKEN_MAPPING"));
  definition.nodes[0].mappings.textVar = { source: "input", key: "count" };
  assert.ok(validateDefinition(definition, { node1: snapshot }, {}).some(x => x.code === "TYPE_MISMATCH"));
});
test("portable metadata rejects paths, session partitions and credential URLs", () => {
  for (const value of ["C:\\Users\\Admin\\secret.txt", "persist:creator-default", "https://example.com/?token=secret", { cookies: [] }]) assert.throws(() => portableJson(value));
});
test("Runner binds only the bundled snapshot and refuses absent capabilities before actions", async () => {
  const bundle = readBundle(packageBytes().files); let calls = 0;
  const execute = async (snapshot: Snapshot) => { calls++; assert.equal(snapshot.steps[0].version, 1); return { status: "VERIFIED" as const, runId: "run1", message: "Verified" }; };
  const blocked = await runBundle(bundle, {}, "local-runner-bundle", execute, []);
  assert.equal(blocked.status, "BLOCKED"); assert.equal(calls, 0);
  const result = await runBundle(bundle, {}, "local-runner-bundle", execute);
  assert.equal(result.status, "VERIFIED"); assert.equal(calls, 1);
});
