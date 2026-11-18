import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });

console.log("=== settings keys ===");
for (const row of db.prepare("SELECT key, substr(value,1,400) AS v FROM settings").all()) {
  console.log(row.key, row.v);
}

console.log("\n=== flows summary ===");
for (const row of db.prepare("SELECT * FROM flows").all()) {
  const f = typeof row.payload === "string" ? JSON.parse(row.payload) : row;
  const flow = f.payload ? f : f;
  const body = typeof flow === "object" && flow.payload ? JSON.parse(typeof flow.payload === "string" ? flow.payload : JSON.stringify(flow)) : flow;
  // flows table may store full JSON in one column
  const raw = row.payload ? JSON.parse(row.payload) : row;
  console.log(
    JSON.stringify(
      {
        id: raw.id,
        name: raw.name,
        actionTagKey: raw.actionTagKey,
        actionTagId: raw.actionTagId,
        steps: (raw.steps || []).length,
        stepIds: (raw.steps || []).map((s) => `${s.id}@v${s.version}`),
        publishedVersion: raw.publishedVersion ?? raw.published_version,
        draftStatus: raw.draftStatus ?? raw.draft_status,
        release: raw.release,
        demo: raw.demoVideo || raw.demo || raw.acceptance,
        scriptRequestId: raw.scriptRequestId,
      },
      null,
      2,
    ),
  );
}

console.log("\n=== action_tags ===");
try {
  for (const row of db.prepare("SELECT * FROM action_tags").all()) {
    console.log(JSON.stringify(row).slice(0, 500));
  }
} catch (e) {
  console.log(String(e.message || e));
}
