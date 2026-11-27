import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".local/qa-profile-facebook-sandbox/creator.sqlite", {
  readOnly: true,
});
for (const id of [
  "017a87a0-c8cf-4408-97c9-df27ad970f8b",
  "ea7822b3-ed2b-48e9-ab55-7ec7fe5349a1",
]) {
  const flow = JSON.parse(
    db.prepare("SELECT payload FROM flows WHERE id=?").get(id).payload,
  );
  console.log("\nFLOW", id, flow.name, "steps", flow.steps?.length);
  for (const ref of flow.steps || []) {
    const row = db
      .prepare("SELECT payload FROM steps WHERE id=? AND version=?")
      .get(ref.id, ref.version);
    console.log(
      ref,
      row ? "OK " + JSON.parse(row.payload).name : "MISSING",
    );
  }
}
