import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeZip, encodeZip } from "./package-zip.js";
import type { Store } from "./storage.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SECRET_SETTING = /(?:token|password|cookie|credential|browserSessions?|sessionPartition)/i;

function portableSnapshot(raw: ReturnType<Store["backupSnapshot"]>, missing: string[]) {
  const snapshot = structuredClone(raw);
  snapshot.settings = (snapshot.settings as Array<{ key: string; value: string }>).filter(row => !SECRET_SETTING.test(row.key));
  const scrub = (value: unknown, logical: string): unknown => {
    if (typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/home/") || value.startsWith("/Users/"))) {
      missing.push(`nonportable:${logical}`); return `__LOCAL_FILE_NOT_EXPORTED__/${path.basename(value)}`;
    }
    if (Array.isArray(value)) return value.map((item, index) => scrub(item, `${logical}[${index}]`));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, `${logical}.${key}`)]));
    return value;
  };
  for (const table of ["flows", "steps", "overrides", "runs"] as const) for (const row of snapshot[table] as Array<{ payload: string }>) {
    row.payload = JSON.stringify(scrub(JSON.parse(row.payload), `${table}.payload`));
  }
  return snapshot;
}

async function filesUnder(root: string, prefix: string, out: Record<string, Buffer>) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const absolute = path.join(root, entry.name), relative = `${prefix}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) await filesUnder(absolute, relative, out);
    else if (entry.isFile()) out[relative] = await readFile(absolute);
  }
}

export async function createAdminBackup(store: Store, dataPath: string, installationId: string, revision: number) {
  const files: Record<string, Buffer> = {};
  await filesUnder(path.join(dataPath, "targets"), "targets", files);
  await filesUnder(path.join(dataPath, "test-runs", "demos"), "demos", files);
  const missing: string[] = [];
  const snapshot = portableSnapshot(store.backupSnapshot(), missing);
  for (const row of snapshot.steps as Array<{payload:string}>) {
    const step = JSON.parse(row.payload) as { payload?: { target?: { asset?: string } } }; const asset = step.payload?.target?.asset;
    if (asset && !files[`targets/${asset}`]) missing.push(`ocr:${asset}`);
  }
  for (const row of snapshot.settings as Array<{key:string;value:string}>) if (row.key.startsWith("videoDemo:")) {
    const demo = JSON.parse(row.value) as { artifactRef?: string; thumbnailRef?: string };
    for (const ref of [demo.artifactRef, demo.thumbnailRef].filter(Boolean) as string[]) if (!files[ref]) missing.push(`demo:${ref}`);
  }
  const manifest = { schema: 2, installationId, revision, createdAt: new Date().toISOString(), complete: missing.length === 0,
    missing: [...new Set(missing)], counts: { scenarios: snapshot.flows.length, stepVersions: snapshot.steps.length, assets: Object.keys(files).length } };
  files["creator.json"] = Buffer.from(JSON.stringify(snapshot));
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  files["checksums.json"] = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]))));
  const archive = encodeZip(files);
  return { archive, sha256: sha(archive), manifest };
}

export function inspectAdminBackup(archive: Buffer, expectedSha256?: string) {
  const sha256 = sha(archive);
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error("RESTORE_INTEGRITY: archive checksum mismatch");
  const files = decodeZip(archive);
  if (!files["creator.json"] || !files["manifest.json"] || !files["checksums.json"]) throw new Error("RESTORE_INVALID: manifest/database/checksums missing");
  const checksums = JSON.parse(files["checksums.json"].toString("utf8")) as Record<string, string>;
  for (const [name, expected] of Object.entries(checksums)) if (!files[name] || sha(files[name]) !== expected) throw new Error(`RESTORE_INTEGRITY: checksum mismatch ${name}`);
  const snapshot = JSON.parse(files["creator.json"].toString("utf8")) as Record<string, unknown[]>;
  const manifest = JSON.parse(files["manifest.json"].toString("utf8")) as Record<string, unknown>;
  if (manifest.complete !== true) throw new Error(`RESTORE_INCOMPLETE: ${JSON.stringify(manifest.missing ?? [])}`);
  if (!["settings", "flows", "steps", "overrides", "runs"].every(table => Array.isArray(snapshot[table]))) throw new Error("RESTORE_INVALID: SQLite relationships unavailable");
  for (const row of snapshot.steps as Array<{payload?: string}>) {
    const step = JSON.parse(String(row.payload ?? "{}")) as { payload?: { target?: { asset?: string } } };
    const asset = step.payload?.target?.asset;
    if (asset && !files[`targets/${asset}`]) throw new Error(`RESTORE_ASSET_MISSING: ${asset}`);
  }
  for (const row of snapshot.settings as Array<{key?: string;value?: string}>) {
    if (!String(row.key).startsWith("videoDemo:")) continue;
    const demo = JSON.parse(String(row.value ?? "{}")) as { artifactRef?: string; thumbnailRef?: string };
    for (const ref of [demo.artifactRef, demo.thumbnailRef].filter(Boolean) as string[]) if (!files[ref]) throw new Error(`RESTORE_ASSET_MISSING: ${ref}`);
  }
  return { files, snapshot, manifest, sha256 };
}

export async function applyAdminBackup(store: Store, dataPath: string, archive: Buffer, expectedSha256: string) {
  const checked = inspectAdminBackup(archive, expectedSha256);
  const rollback = await createAdminBackup(store, dataPath, `rollback-${randomUUID()}`, Date.now());
  const rollbackDir = path.join(dataPath, "restore-backups"); await mkdir(rollbackDir, { recursive: true });
  const rollbackPath = path.join(rollbackDir, `before-restore-${Date.now()}.zip`); await writeFile(rollbackPath, rollback.archive, { flag: "wx" });
  const stage = path.join(dataPath, `.restore-${randomUUID()}`); await mkdir(stage, { recursive: true });
  const moved: Array<{ destination: string; old: string }> = [];
  try {
    await mkdir(path.join(stage, "targets"), { recursive: true }); await mkdir(path.join(stage, "demos"), { recursive: true });
    for (const [name, bytes] of Object.entries(checked.files)) {
      if (!name.startsWith("targets/") && !name.startsWith("demos/")) continue;
      const target = path.join(stage, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" });
    }
    store.restoreSnapshot(checked.snapshot);
    for (const folder of ["targets", "demos"]) {
      const source = path.join(stage, folder); const destination = folder === "demos" ? path.join(dataPath, "test-runs", "demos") : path.join(dataPath, folder);
      const old = `${destination}.before-restore-${randomUUID()}`; await mkdir(path.dirname(destination), { recursive: true });
      await rename(destination, old).then(() => moved.push({ destination, old })).catch(() => {});
      await rename(source, destination);
    }
    for (const item of moved) await rm(item.old, { recursive: true, force: true });
    return { rollbackPath, manifest: checked.manifest };
  } catch (error) {
    const prior = inspectAdminBackup(rollback.archive, rollback.sha256);
    store.restoreSnapshot(prior.snapshot);
    for (const item of moved.reverse()) { await rm(item.destination, { recursive: true, force: true }).catch(() => {}); await rename(item.old, item.destination).catch(() => {}); }
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}
