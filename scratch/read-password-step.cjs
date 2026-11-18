const Database = require("better-sqlite3");
const db = new Database(".local/creator/creator.sqlite", { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("tables", tables.map((t) => t.name));
const cols = db.prepare("PRAGMA table_info(steps)").all();
console.log("steps cols", cols.map((c) => c.name));
const row = db
  .prepare("SELECT * FROM steps WHERE id LIKE ? LIMIT 1")
  .get("1e7c2ad4%");
if (!row) {
  const all = db.prepare("SELECT id, name, version FROM steps LIMIT 20").all();
  console.log("sample", all);
  process.exit(0);
}
const payload = JSON.parse(row.payload_json || row.payload || "{}");
const ocr = payload?.target?.ocr || payload?.ocr;
console.log(
  JSON.stringify(
    {
      id: row.id,
      name: row.name,
      version: row.version,
      action: payload.action,
      matchTo: payload?.target?.matchTo,
      roi: payload?.target?.roi,
      environment: payload?.target?.environment,
      clickOffset: payload?.target?.clickOffset,
      ocr: ocr
        ? {
            text: ocr.text,
            kind: ocr.kind,
            bbox: ocr.bbox,
            confidence: ocr.confidence,
            confirmed: ocr.confirmed,
          }
        : null,
      textLen: typeof payload.text === "string" ? payload.text.length : null,
    },
    null,
    2,
  ),
);
