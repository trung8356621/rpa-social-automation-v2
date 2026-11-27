import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(".local/qa-profile-facebook-sandbox/creator.sqlite", {
  readOnly: true,
});

console.log(
  "TABLES",
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1").all(),
);

const flows = db.prepare("SELECT id, payload FROM flows").all();
for (const row of flows) {
  const p = JSON.parse(row.payload);
  console.log("FLOW", {
    id: row.id,
    name: p.name,
    actionTagKey: p.actionTagKey,
    actionTagId: p.actionTagId,
    steps: Array.isArray(p.steps) ? p.steps.length : 0,
    disabled: !!p.disabled,
  });
}

console.log(
  "TAGS",
  db.prepare("SELECT id, tag_key, name FROM action_tags ORDER BY tag_key").all(),
);

const metaRaw = db.prepare("SELECT value FROM settings WHERE key=?").get("seoOpsSyncMeta");
if (metaRaw?.value) {
  const meta = JSON.parse(metaRaw.value);
  console.log("META", meta.last_sync_at, meta.last_result);
  for (const r of Object.values(meta.rows || {})) {
    console.log("META_ROW", {
      script_id: r.script_id,
      name: r.name,
      status: r.status,
      message: r.message,
      incomplete: r.incomplete,
      last_result: r.last_result,
      local_digest: r.local_digest?.slice?.(0, 12),
      remote_digest: r.remote_digest?.slice?.(0, 12),
    });
  }
}

console.log(
  "ACTIVE",
  db.prepare("SELECT value FROM settings WHERE key=?").get("activeScriptsByTag")?.value,
);

const stepCounts = db
  .prepare("SELECT id, COUNT(*) AS versions FROM steps GROUP BY id ORDER BY id")
  .all();
console.log("STEP_IDS", stepCounts.slice(0, 30));
