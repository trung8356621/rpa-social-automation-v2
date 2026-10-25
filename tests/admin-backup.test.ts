import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { applyAdminBackup, createAdminBackup, inspectAdminBackup } from "../src/main/admin-backup.js";

test("Full Backup bundles Windows upload files, OCR and demo media, then restores usable paths", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-source-"));
  const restoreDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-restore-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-windows-files-"));
  const source = new Store(path.join(sourceDir, "creator.sqlite"));
  const target = new Store(path.join(restoreDir, "creator.sqlite"));
  try {
    const imageA = path.join(externalDir, "upload one.png"), imageB = path.join(externalDir, "upload two.png");
    await writeFile(imageA, "image-a"); await writeFile(imageB, "image-b");
    await mkdir(path.join(sourceDir, "targets"), { recursive: true });
    await mkdir(path.join(sourceDir, "test-runs", "demos", "flow", "run"), { recursive: true });
    const roi = "11111111-1111-1111-1111-111111111111.png";
    await writeFile(path.join(sourceDir, "targets", roi), "roi");
    await writeFile(path.join(sourceDir, "test-runs", "demos", "flow", "run", "recording.webm"), "video");
    await writeFile(path.join(sourceDir, "test-runs", "demos", "flow", "run", "recording-thumb.jpg"), "thumb");

    const flow = source.newFlow("Portable upload", 1);
    source.updateVariables([
      { id: "imgs", key: "imgs", type: "files" },
      { id: "caption", key: "caption", type: "text" },
    ], { imgs: [imageA, imageB], caption: "ordinary C:\\text\\with\\slashes" });
    const upload = source.saveStep("Upload", { action: "UPLOAD_FILE", variableId: "imgs",
      target: { asset: roi, roi: { x: 0, y: 0, width: 10, height: 10 } } });
    const ocrV1 = source.saveStep("OCR", { action: "CLICK_TARGET", target: { asset: roi, roi: { x: 0, y: 0, width: 10, height: 10 } } });
    source.saveStep("OCR", { action: "CLICK_TARGET", target: { asset: roi, roi: { x: 0, y: 0, width: 10, height: 10 } } }, ocrV1.id);
    source.selectVersion(ocrV1.id, 1);
    source.setSetting(`videoDemo:${flow.id}`, JSON.stringify({ artifactRef: "demos/flow/run/recording.webm", thumbnailRef: "demos/flow/run/recording-thumb.jpg" }));
    source.setSetting("password", "must-not-export");
    const dbBefore = await readFile(path.join(sourceDir, "creator.sqlite"));
    const imageBefore = await readFile(imageA);

    const bundle = await createAdminBackup(source, sourceDir, "install-a", 1);
    assert.equal(bundle.manifest.complete, true);
    assert.deepEqual(bundle.manifest.counts, { scenarios: 1, stepVersions: 3, assets: 5, missingFiles: 0 });
    const inspected = inspectAdminBackup(bundle.archive, bundle.sha256);
    assert.equal(inspected.manifest.uploadBindings.length, 2);
    assert.equal(Object.keys(inspected.files).filter(name => name.startsWith("assets/uploads/")).length, 2);
    assert.doesNotMatch(inspected.files["creator.json"].toString(), /must-not-export/);
    const portableSnapshot = JSON.parse(inspected.files["creator.json"].toString()) as { flows: Array<{ payload: string }> };
    const portableFlow = JSON.parse(portableSnapshot.flows[0].payload) as { defaultPattern?: { values: Record<string, unknown> } };
    assert.equal(portableFlow.defaultPattern!.values.caption, "ordinary C:\\text\\with\\slashes",
      "ordinary text that resembles a path is not interpreted as a file");

    await applyAdminBackup(target, restoreDir, bundle.archive, bundle.sha256);
    const restoredFlow = target.flows()[0];
    const restoredFiles = restoredFlow.defaultPattern!.values.imgs as string[];
    assert.equal(restoredFiles.length, 2); assert.ok(restoredFiles.every(file => path.isAbsolute(file)));
    assert.equal(await readFile(restoredFiles[0], "utf8"), "image-a");
    assert.equal(await readFile(restoredFiles[1], "utf8"), "image-b");
    assert.equal(target.step(upload.id, upload.version).payload.variableId, "imgs");
    assert.equal(target.flow()!.steps.find(ref => ref.id === ocrV1.id)!.version, 1);
    assert.equal(await readFile(path.join(restoreDir, "targets", roi), "utf8"), "roi");
    assert.equal(await readFile(path.join(restoreDir, "test-runs", "demos", "flow", "run", "recording.webm"), "utf8"), "video");
    assert.equal(await readFile(path.join(restoreDir, "test-runs", "demos", "flow", "run", "recording-thumb.jpg"), "utf8"), "thumb");
    assert.deepEqual(await readFile(path.join(sourceDir, "creator.sqlite")), dbBefore, "source SQLite remains unchanged");
    assert.deepEqual(await readFile(imageA), imageBefore, "external source asset remains unchanged");

    const corrupt = Buffer.from(bundle.archive); corrupt[40] ^= 1;
    assert.throws(() => inspectAdminBackup(corrupt, bundle.sha256), /INTEGRITY/);
  } finally {
    source.close(); target.close();
    await rm(sourceDir, { recursive: true, force: true }); await rm(restoreDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("Full Backup reports exact Scenario and File variable when an external file is missing", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-missing-"));
  const source = new Store(path.join(sourceDir, "creator.sqlite"));
  try {
    source.newFlow("Facebook draft POC 3", 1);
    const missingA = path.join(sourceDir, "gone-a.png"), missingB = path.join(sourceDir, "gone-b.png");
    source.updateVariables([
      { id: "imgs", key: "imgs", type: "files" },
      { id: "caption", key: "caption", type: "text" },
    ], { imgs: [missingA, missingB], caption: "C:\\ordinary\\text" });
    const bundle = await createAdminBackup(source, sourceDir, "install-a", 2);
    assert.equal(bundle.manifest.complete, false); assert.equal(bundle.manifest.counts.missingFiles, 2);
    assert.deepEqual(bundle.manifest.missing.map(item => item.logicalReference), [
      "Facebook draft POC 3 → Default Pattern → imgs",
      "Facebook draft POC 3 → Default Pattern → imgs",
    ]);
    assert.deepEqual(bundle.manifest.missing.map(item => item.originalPath), [missingA, missingB]);
    assert.throws(() => inspectAdminBackup(bundle.archive, bundle.sha256), /RESTORE_INCOMPLETE/);
  } finally { source.close(); await rm(sourceDir, { recursive: true, force: true }); }
});

test("Full Backup without external assets remains complete and independently restorable", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-empty-source-"));
  const restoreDir = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-empty-restore-"));
  const source = new Store(path.join(sourceDir, "creator.sqlite")), target = new Store(path.join(restoreDir, "creator.sqlite"));
  try {
    source.newFlow("No assets", 1);
    const bundle = await createAdminBackup(source, sourceDir, "install-a", 3);
    assert.equal(bundle.manifest.complete, true); assert.equal(bundle.manifest.counts.assets, 0);
    inspectAdminBackup(bundle.archive, bundle.sha256);
    await applyAdminBackup(target, restoreDir, bundle.archive, bundle.sha256);
    assert.equal(target.flows()[0].name, "No assets");
  } finally { source.close(); target.close(); await rm(sourceDir, { recursive: true, force: true }); await rm(restoreDir, { recursive: true, force: true }); }
});
