import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
for (const id of [
  "48f48584-75b8-4e01-8bff-20a95be2daba",
  "690493bd-a830-4648-83b3-86da1533c77a",
]) {
  const r = db.prepare("SELECT payload FROM flows WHERE id=?").get(id);
  const f = JSON.parse(r.payload);
  console.log({
    id: id.slice(0, 8),
    name: f.name,
    startUrl: f.startUrl,
    urlPattern: f.urlPattern,
    tag: f.actionTagKey,
  });
}
const lab = JSON.parse(
  db.prepare("SELECT value FROM settings WHERE key=?").get("testLab").value,
);
for (const c of lab.cases) {
  console.log({
    case: c.name,
    flow: String(c.flowId).slice(0, 8),
    startUrl: c.startUrl,
    last: c.lastResult?.status,
    msg: String(c.lastResult?.message || "").slice(0, 100),
    runId: c.lastResult?.runId,
  });
}
