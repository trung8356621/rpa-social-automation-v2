import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { applyAdminBackup, createAdminBackup, inspectAdminBackup } from "../src/main/admin-backup.js";

test("Admin backup restores immutable Step versions, pins, OCR assets and demo media", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-a-")), b = await mkdtemp(path.join(os.tmpdir(), "rpa-backup-b-"));
  const source = new Store(path.join(a, "creator.sqlite")), target = new Store(path.join(b, "creator.sqlite"));
  try {
    await mkdir(path.join(a, "targets"), { recursive: true }); await mkdir(path.join(a, "test-runs", "demos", "flow", "run"), { recursive: true });
    const roi = "11111111-1111-1111-1111-111111111111.png";
    await writeFile(path.join(a, "targets", roi), "roi"); await writeFile(path.join(a, "test-runs", "demos", "flow", "run", "recording.webm"), "video");
    await writeFile(path.join(a, "test-runs", "demos", "flow", "run", "recording-thumb.jpg"), "thumb");
    const flow = source.newFlow("Backup", 1); const v1 = source.saveStep("OCR", { action: "CLICK_TARGET", target: { asset: roi, roi: { x: 0, y: 0, width: 10, height: 10 } } });
    source.saveStep("OCR", { action: "CLICK_TARGET", target: { asset: roi, roi: { x: 0, y: 0, width: 10, height: 10 } } }, v1.id);
    source.selectVersion(v1.id, 1); source.setSetting(`videoDemo:${flow.id}`, JSON.stringify({ artifactRef: "demos/flow/run/recording.webm", thumbnailRef: "demos/flow/run/recording-thumb.jpg" }));
    source.setSetting("password", "must-not-export");
    const bundle = await createAdminBackup(source, a, "install-a", 1);
    assert.equal(bundle.manifest.complete, true); assert.equal(bundle.manifest.counts.scenarios, 1); assert.equal(bundle.manifest.counts.stepVersions, 2);
    const inspected = inspectAdminBackup(bundle.archive, bundle.sha256);
    assert.ok(inspected.files["checksums.json"]); assert.doesNotMatch(inspected.files["creator.json"].toString(), /must-not-export/);
    const restored = await applyAdminBackup(target, b, bundle.archive, bundle.sha256);
    assert.equal(target.steps().length, 2); assert.equal(target.flow()!.steps[0].version, 1);
    assert.equal(await readFile(path.join(b, "targets", roi), "utf8"), "roi");
    assert.equal(await readFile(path.join(b, "test-runs", "demos", "flow", "run", "recording.webm"), "utf8"), "video");
    assert.match(restored.rollbackPath, /restore-backups/);
    assert.equal(await readFile(path.join(a, "targets", roi), "utf8"), "roi", "source asset remains untouched");
    const corrupt = Buffer.from(bundle.archive); corrupt[40] ^= 1;
    assert.throws(() => inspectAdminBackup(corrupt, bundle.sha256), /INTEGRITY/);
    await rm(path.join(a, "targets", roi));
    const incomplete = await createAdminBackup(source, a, "install-a", 2);
    assert.equal(incomplete.manifest.complete, false); assert.deepEqual(incomplete.manifest.missing, [`ocr:${roi}`]);
    assert.throws(() => inspectAdminBackup(incomplete.archive, incomplete.sha256), /RESTORE_INCOMPLETE/);
  } finally { source.close(); target.close(); await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
});
