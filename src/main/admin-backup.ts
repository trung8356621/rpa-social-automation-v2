import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeZip, encodeZip } from "./package-zip.js";
import type { Flow, Override, Step } from "../shared/contracts.js";
import type { Store } from "./storage.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SECRET_SETTING = /(?:token|password|cookie|credential|browserSessions?|sessionPartition)/i;
const RUNTIME_PATH_FIELDS = new Set(["screenshotPath", "recordingPath"]);

export type BackupMissingReference = {
  kind: "upload" | "ocr" | "demo";
  scenarioId?: string; scenarioName?: string; variableId?: string; variableKey?: string;
  logicalReference: string; originalPath?: string;
};
type UploadBinding = {
  scope: "defaultPattern" | "step" | "override";
  scenarioId?: string; variableId?: string; stepId?: string; version?: number;
  overrideId?: string; segmentIndex?: number; index: number; archiveRef: string;
};
type BackupManifest = {
  schema: 3; installationId: string; revision: number; createdAt: string; complete: boolean;
  missing: BackupMissingReference[]; uploadBindings: UploadBinding[];
  counts: { scenarios: number; stepVersions: number; assets: number; missingFiles: number };
};

function scrubRuntimePaths(value: unknown, key = ""): unknown {
  if (typeof value === "string" && RUNTIME_PATH_FIELDS.has(key) && path.isAbsolute(value))
    return `__LOCAL_RUNTIME_FILE_NOT_EXPORTED__/${path.basename(value)}`;
  if (Array.isArray(value)) return value.map(item => scrubRuntimePaths(item));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([childKey, item]) => [childKey, scrubRuntimePaths(item, childKey)]),
  );
  return value;
}
function safeName(file: string) {
  return path.basename(file).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "file";
}
async function filesUnder(root: string, prefix: string, out: Record<string, Buffer>) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const absolute = path.join(root, entry.name), relative = `${prefix}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) await filesUnder(absolute, relative, out);
    else if (entry.isFile()) out[relative] = await readFile(absolute);
  }
}

async function portableSnapshot(raw: ReturnType<Store["backupSnapshot"]>, files: Record<string, Buffer>) {
  const snapshot = structuredClone(raw);
  snapshot.settings = (snapshot.settings as Array<{ key: string; value: string }>).filter(row => !SECRET_SETTING.test(row.key));
  for (const row of snapshot.runs as Array<{ payload: string }>) row.payload = JSON.stringify(scrubRuntimePaths(JSON.parse(row.payload)));
  const missing: BackupMissingReference[] = [], uploadBindings: UploadBinding[] = [];
  const flows = new Map<string, Flow>(), scenarioByStep = new Map<string, Flow>();
  for (const row of snapshot.flows as Array<{ id: string; payload: string }>) {
    const flow = JSON.parse(row.payload) as Flow; flows.set(flow.id, flow);
    for (const ref of flow.steps) scenarioByStep.set(ref.id, flow);
  }
  async function bundle(original: string, folder: string, binding: Omit<UploadBinding, "archiveRef">,
    diagnostic: Omit<BackupMissingReference, "kind" | "originalPath">) {
    const absolute = path.resolve(original);
    const archiveRef = `assets/uploads/${folder}/${binding.index}-${safeName(absolute)}`.replaceAll("\\", "/");
    try {
      files[archiveRef] = await readFile(absolute); uploadBindings.push({ ...binding, archiveRef }); return archiveRef;
    } catch {
      missing.push({ kind: "upload", ...diagnostic, originalPath: original });
      return `__MISSING_LOCAL_FILE__/${safeName(original)}`;
    }
  }
  for (const row of snapshot.flows as Array<{ id: string; payload: string }>) {
    const flow = flows.get(row.id)!, values = flow.defaultPattern?.values;
    if (values) for (const variable of flow.variables ?? []) {
      if (variable.type !== "file" && variable.type !== "files") continue;
      const current = values[variable.id];
      const originals = variable.type === "file" ? (typeof current === "string" && current ? [current] : [])
        : (Array.isArray(current) ? current.filter((item): item is string => typeof item === "string" && item.length > 0) : []);
      const portable: string[] = [];
      for (let index = 0; index < originals.length; index++) portable.push(await bundle(
        originals[index], `${flow.id}/${variable.id}`, { scope: "defaultPattern", scenarioId: flow.id, variableId: variable.id, index },
        { scenarioId: flow.id, scenarioName: flow.name, variableId: variable.id, variableKey: variable.key,
          logicalReference: `${flow.name} → Default Pattern → ${variable.key}` },
      ));
      values[variable.id] = variable.type === "file" ? (portable[0] ?? "") : portable;
    }
    row.payload = JSON.stringify(flow);
  }
  for (const row of snapshot.steps as Array<{ id: string; version: number; payload: string }>) {
    const step = JSON.parse(row.payload) as Step;
    if (step.payload.action === "UPLOAD_FILE" && Array.isArray(step.payload.files)) {
      const flow = scenarioByStep.get(step.id), portable: string[] = [];
      for (let index = 0; index < step.payload.files.length; index++) portable.push(await bundle(
        step.payload.files[index], `${flow?.id ?? "unassigned"}/step-${step.id}-v${step.version}`,
        { scope: "step", scenarioId: flow?.id, stepId: step.id, version: step.version, index },
        { scenarioId: flow?.id, scenarioName: flow?.name,
          logicalReference: `${flow?.name ?? "Unassigned Scenario"} → ${step.name} v${step.version} → files` },
      ));
      step.payload.files = portable;
    }
    row.payload = JSON.stringify(step);
  }
  for (const row of snapshot.overrides as Array<{ id: string; step_id: string; payload: string }>) {
    const override = JSON.parse(row.payload) as Override, flow = scenarioByStep.get(override.stepId);
    for (let segmentIndex = 0; segmentIndex < override.segment.length; segmentIndex++) {
      const payload = override.segment[segmentIndex]; if (payload.action !== "UPLOAD_FILE" || !Array.isArray(payload.files)) continue;
      const portable: string[] = [];
      for (let index = 0; index < payload.files.length; index++) portable.push(await bundle(
        payload.files[index], `${flow?.id ?? "unassigned"}/override-${override.id}-${segmentIndex}`,
        { scope: "override", scenarioId: flow?.id, overrideId: override.id, segmentIndex, index },
        { scenarioId: flow?.id, scenarioName: flow?.name,
          logicalReference: `${flow?.name ?? "Unassigned Scenario"} → Override ${override.name} → files` },
      ));
      payload.files = portable;
    }
    row.payload = JSON.stringify(override);
  }
  return { snapshot, missing, uploadBindings };
}

function materializeUploads(snapshot: Record<string, unknown[]>, manifest: BackupManifest, dataPath: string) {
  const restored = structuredClone(snapshot);
  const flows = new Map((restored.flows as Array<{ id: string; payload: string }>).map(row => [row.id, row]));
  const steps = new Map((restored.steps as Array<{ id: string; version: number; payload: string }>).map(row => [`${row.id}:${row.version}`, row]));
  const overrides = new Map((restored.overrides as Array<{ id: string; payload: string }>).map(row => [row.id, row]));
  for (const binding of manifest.uploadBindings ?? []) {
    const absolute = path.join(dataPath, ...binding.archiveRef.split("/"));
    if (binding.scope === "defaultPattern") {
      const row = flows.get(binding.scenarioId ?? ""); if (!row) throw new Error("RESTORE_INVALID: upload Scenario missing");
      const flow = JSON.parse(row.payload) as Flow, variable = flow.variables?.find(v => v.id === binding.variableId);
      if (!variable || !flow.defaultPattern) throw new Error("RESTORE_INVALID: upload Variable missing");
      const current = flow.defaultPattern.values[variable.id];
      if (variable.type === "file") flow.defaultPattern.values[variable.id] = absolute;
      else { const values = Array.isArray(current) ? [...current] : []; values[binding.index] = absolute; flow.defaultPattern.values[variable.id] = values; }
      row.payload = JSON.stringify(flow);
    } else if (binding.scope === "step") {
      const row = steps.get(`${binding.stepId}:${binding.version}`); if (!row) throw new Error("RESTORE_INVALID: upload Step missing");
      const step = JSON.parse(row.payload) as Step, values = [...(step.payload.files ?? [])]; values[binding.index] = absolute;
      step.payload.files = values; row.payload = JSON.stringify(step);
    } else {
      const row = overrides.get(binding.overrideId ?? ""); if (!row) throw new Error("RESTORE_INVALID: upload Override missing");
      const override = JSON.parse(row.payload) as Override, payload = override.segment[binding.segmentIndex ?? -1];
      if (!payload) throw new Error("RESTORE_INVALID: upload Override segment missing");
      const values = [...(payload.files ?? [])]; values[binding.index] = absolute; payload.files = values; row.payload = JSON.stringify(override);
    }
  }
  return restored;
}

export async function createAdminBackup(store: Store, dataPath: string, installationId: string, revision: number) {
  const files: Record<string, Buffer> = {};
  await filesUnder(path.join(dataPath, "targets"), "targets", files);
  await filesUnder(path.join(dataPath, "test-runs", "demos"), "demos", files);
  const portable = await portableSnapshot(store.backupSnapshot(), files), missing = [...portable.missing];
  for (const row of portable.snapshot.steps as Array<{ payload: string }>) {
    const step = JSON.parse(row.payload) as Step, asset = step.payload.target?.asset;
    if (asset && !files[`targets/${asset}`]) missing.push({ kind: "ocr", logicalReference: `Step ${step.name} v${step.version} → OCR`, originalPath: asset });
  }
  for (const row of portable.snapshot.overrides as Array<{ payload: string }>) {
    const override = JSON.parse(row.payload) as Override;
    for (const payload of override.segment) if (payload.target?.asset && !files[`targets/${payload.target.asset}`])
      missing.push({ kind: "ocr", logicalReference: `Override ${override.name} → OCR`, originalPath: payload.target.asset });
  }
  for (const row of portable.snapshot.settings as Array<{ key: string; value: string }>) if (row.key.startsWith("videoDemo:")) {
    const demo = JSON.parse(row.value) as { artifactRef?: string; thumbnailRef?: string };
    for (const ref of [demo.artifactRef, demo.thumbnailRef].filter(Boolean) as string[]) if (!files[ref])
      missing.push({ kind: "demo", logicalReference: `${row.key} → ${path.basename(ref)}`, originalPath: ref });
  }
  const deduped = [...new Map(missing.map(item => [`${item.kind}:${item.logicalReference}:${item.originalPath}`, item])).values()];
  const manifest: BackupManifest = { schema: 3, installationId, revision, createdAt: new Date().toISOString(), complete: deduped.length === 0,
    missing: deduped, uploadBindings: portable.uploadBindings,
    counts: { scenarios: portable.snapshot.flows.length, stepVersions: portable.snapshot.steps.length,
      assets: Object.keys(files).length, missingFiles: deduped.length } };
  files["creator.json"] = Buffer.from(JSON.stringify(portable.snapshot));
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  files["checksums.json"] = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]))));
  const archive = encodeZip(files); return { archive, sha256: sha(archive), manifest };
}

export function inspectAdminBackup(archive: Buffer, expectedSha256?: string) {
  const sha256 = sha(archive); if (expectedSha256 && sha256 !== expectedSha256) throw new Error("RESTORE_INTEGRITY: archive checksum mismatch");
  const files = decodeZip(archive);
  if (!files["creator.json"] || !files["manifest.json"] || !files["checksums.json"]) throw new Error("RESTORE_INVALID: manifest/database/checksums missing");
  const checksums = JSON.parse(files["checksums.json"].toString("utf8")) as Record<string, string>;
  for (const [name] of Object.entries(files)) if (name !== "checksums.json" && !checksums[name]) throw new Error(`RESTORE_INTEGRITY: undeclared file ${name}`);
  for (const [name, expected] of Object.entries(checksums)) if (!files[name] || sha(files[name]) !== expected) throw new Error(`RESTORE_INTEGRITY: checksum mismatch ${name}`);
  const snapshot = JSON.parse(files["creator.json"].toString("utf8")) as Record<string, unknown[]>;
  const manifest = JSON.parse(files["manifest.json"].toString("utf8")) as BackupManifest;
  if (manifest.complete !== true) throw new Error(`RESTORE_INCOMPLETE: ${JSON.stringify(manifest.missing ?? [])}`);
  if (!["settings", "flows", "steps", "overrides", "runs"].every(table => Array.isArray(snapshot[table]))) throw new Error("RESTORE_INVALID: SQLite relationships unavailable");
  const stepVersions = new Set((snapshot.steps as Array<{ id?: string; version?: number; payload?: string }>).map(row => `${row.id}:${row.version}`));
  const flowIds = new Set<string>();
  for (const row of snapshot.flows as Array<{ id?: string; payload?: string }>) {
    const flow = JSON.parse(String(row.payload ?? "{}")) as Flow;
    if (!flow.id || flow.id !== row.id || flowIds.has(flow.id)) throw new Error(`RESTORE_INVALID: invalid or duplicate Scenario ${String(row.id ?? "")}`);
    flowIds.add(flow.id);
    for (const ref of flow.steps ?? []) if (!stepVersions.has(`${ref.id}:${ref.version}`))
      throw new Error(`RESTORE_INVALID: ${flow.name || flow.id} pins missing Step ${ref.id} v${ref.version}`);
  }
  for (const row of snapshot.overrides as Array<{ step_id?: string; base_version?: number; payload?: string }>) {
    const override = JSON.parse(String(row.payload ?? "{}")) as Override;
    const stepId = override.stepId || String(row.step_id ?? ""), version = override.baseVersion ?? Number(row.base_version);
    if (!stepVersions.has(`${stepId}:${version}`)) throw new Error(`RESTORE_INVALID: Override ${override.name || ""} references missing Step ${stepId} v${version}`);
  }
  for (const binding of manifest.uploadBindings ?? []) if (!files[binding.archiveRef]) throw new Error(`RESTORE_ASSET_MISSING: ${binding.archiveRef}`);
  for (const row of snapshot.steps as Array<{ payload?: string }>) {
    const step = JSON.parse(String(row.payload ?? "{}")) as Step, asset = step.payload?.target?.asset;
    if (asset && !files[`targets/${asset}`]) throw new Error(`RESTORE_ASSET_MISSING: ${asset}`);
  }
  for (const row of snapshot.overrides as Array<{ payload?: string }>) {
    const override = JSON.parse(String(row.payload ?? "{}")) as Override;
    for (const payload of override.segment ?? []) {
      const asset = payload.target?.asset;
      if (asset && !files[`targets/${asset}`]) throw new Error(`RESTORE_ASSET_MISSING: ${asset}`);
    }
  }
  for (const row of snapshot.settings as Array<{ key?: string; value?: string }>) {
    if (!String(row.key).startsWith("videoDemo:")) continue;
    const demo = JSON.parse(String(row.value ?? "{}")) as { artifactRef?: string; thumbnailRef?: string };
    for (const ref of [demo.artifactRef, demo.thumbnailRef].filter(Boolean) as string[]) if (!files[ref]) throw new Error(`RESTORE_ASSET_MISSING: ${ref}`);
  }
  return { files, snapshot, manifest, sha256 };
}

export async function applyAdminBackup(store: Store, dataPath: string, archive: Buffer, expectedSha256: string) {
  const checked = inspectAdminBackup(archive, expectedSha256);
  const rollback = await createAdminBackup(store, dataPath, `rollback-${randomUUID()}`, Date.now());
  if (!rollback.manifest.complete) throw new Error("RESTORE_ROLLBACK_INCOMPLETE: current profile cannot be backed up safely");
  const rollbackDir = path.join(dataPath, "restore-backups"); await mkdir(rollbackDir, { recursive: true });
  const rollbackPath = path.join(rollbackDir, `before-restore-${Date.now()}.zip`); await writeFile(rollbackPath, rollback.archive, { flag: "wx" });
  const stage = path.join(dataPath, `.restore-${randomUUID()}`); await mkdir(stage, { recursive: true });
  const moved: Array<{ destination: string; old: string }> = [];
  try {
    for (const folder of ["targets", "demos", "assets"]) await mkdir(path.join(stage, folder), { recursive: true });
    for (const [name, bytes] of Object.entries(checked.files)) {
      if (!name.startsWith("targets/") && !name.startsWith("demos/") && !name.startsWith("assets/")) continue;
      const target = path.join(stage, ...name.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" });
    }
    store.restoreSnapshot(materializeUploads(checked.snapshot, checked.manifest, dataPath));
    for (const folder of ["targets", "demos", "assets"]) {
      const source = path.join(stage, folder), destination = folder === "demos" ? path.join(dataPath, "test-runs", "demos") : path.join(dataPath, folder);
      const old = `${destination}.before-restore-${randomUUID()}`; await mkdir(path.dirname(destination), { recursive: true });
      await rename(destination, old).then(() => moved.push({ destination, old })).catch(() => {}); await rename(source, destination);
    }
    for (const item of moved) await rm(item.old, { recursive: true, force: true });
    return { rollbackPath, manifest: checked.manifest };
  } catch (error) {
    const prior = inspectAdminBackup(rollback.archive, rollback.sha256);
    store.restoreSnapshot(materializeUploads(prior.snapshot, prior.manifest, dataPath));
    for (const item of moved.reverse()) { await rm(item.destination, { recursive: true, force: true }).catch(() => {}); await rename(item.old, item.destination).catch(() => {}); }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}
