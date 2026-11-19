import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const flowId = "48f48584-75b8-4e01-8bff-20a95be2daba";
const like = db.prepare("SELECT key, substr(value,1,400) AS value FROM settings WHERE key LIKE ? OR value LIKE ?").all(
  "%invalid%",
  "%076fa189%",
);
console.log(JSON.stringify(like, null, 2));

// invalid_steps table if present
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(
    "tables",
    tables.map((t) => t.name).filter((n) => /invalid|step/i.test(n)),
  );
} catch (e) {
  console.log("table scan failed", e);
}
