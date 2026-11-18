import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const flows = db.prepare("SELECT * FROM flows").all();
for (const f of flows) {
  const raw = typeof f.payload === "string" ? f.payload : JSON.stringify(f);
  console.log("---");
  console.log(raw.slice(0, 1200));
}
