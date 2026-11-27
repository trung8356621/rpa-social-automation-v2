import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const srcDir = process.argv[2];
const bakDir = process.argv[3];
if (!srcDir || !bakDir) {
  console.error("Usage: node scratch/qa-sqlite-online-backup.mjs <srcDir> <bakDir>");
  process.exit(2);
}

fs.mkdirSync(bakDir, { recursive: true });
const srcDb = path.join(srcDir, "creator.sqlite");
const destDb = path.join(bakDir, "creator.sqlite");
if (fs.existsSync(destDb)) fs.unlinkSync(destDb);

const db = new DatabaseSync(srcDb);
const destEsc = destDb.replaceAll("'", "''");
db.exec(`VACUUM INTO '${destEsc}'`);
db.close();

const size = fs.statSync(destDb).size;
console.log(JSON.stringify({ ok: true, destDb, size }));

const probe = new DatabaseSync(destDb, { readOnly: true });
const flows = probe.prepare("SELECT id, payload FROM flows").all();
for (const row of flows) {
  const p = JSON.parse(row.payload);
  console.log(
    JSON.stringify({
      id: row.id,
      name: p.name,
      steps: (p.steps || []).length,
      actionTagKey: p.actionTagKey,
      scriptRequestId: p.scriptRequestId,
      startUrl: p.startUrl,
    }),
  );
}
console.log(JSON.stringify({ flowCount: flows.length }));
probe.close();
