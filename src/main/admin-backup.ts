import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeZip, encodeZip } from "./package-zip.js";
import type { Store } from "./storage.js";

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
  const snapshot = store.backupSnapshot();
  const manifest = { schema: 1, installationId, revision, createdAt: new Date().toISOString(),
    counts: { scenarios: snapshot.flows.length, stepVersions: snapshot.steps.length, assets: Object.keys(files).length } };
  files["creator.json"] = Buffer.from(JSON.stringify(snapshot));
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  const archive = encodeZip(files);
  return { archive, sha256: createHash("sha256").update(archive).digest("hex"), manifest };
}

export function inspectAdminBackup(archive: Buffer, expectedSha256?: string) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error("RESTORE_INTEGRITY: archive checksum mismatch");
  const files = decodeZip(archive);
  if (!files["creator.json"] || !files["manifest.json"]) throw new Error("RESTORE_INVALID: manifest/database missing");
  const snapshot = JSON.parse(files["creator.json"].toString("utf8")) as Record<string, unknown[]>;
  const manifest = JSON.parse(files["manifest.json"].toString("utf8")) as Record<string, unknown>;
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
