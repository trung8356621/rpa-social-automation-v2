import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const out = {};
out.tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

const stepIds = [
  "030160d7-4630-4c3a-aafe-8dd91378b468",
  "7093f687-9f6b-4ca7-af58-e5877412d5ee",
  "08947dd7-1436-4210-9279-130f2d00d4ad",
];

for (const name of out.tables) {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  out[`schema_${name}`] = cols;
}

const dump = {};
for (const table of out.tables) {
  const cols = out[`schema_${table}`];
  const idCol = cols.find((c) => /id|uuid/i.test(c));
  if (!idCol) continue;
  for (const id of stepIds) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).all(id);
      if (rows.length) dump[`${table}:${id}`] = rows;
    } catch {
      /* ignore */
    }
  }
  // also search payload/json columns for step id
  for (const col of cols.filter((c) => /json|payload|data|body/i.test(c))) {
    for (const id of stepIds) {
      try {
        const rows = db
          .prepare(`SELECT * FROM ${table} WHERE CAST(${col} AS TEXT) LIKE ? LIMIT 5`)
          .all(`%${id}%`);
        if (rows.length) dump[`like_${table}.${col}:${id}`] = rows;
      } catch {
        /* ignore */
      }
    }
  }
}

// scenarios by name
for (const table of out.tables) {
  const cols = out[`schema_${table}`];
  const nameCol = cols.find((c) => c === "name" || c === "title");
  if (!nameCol) continue;
  try {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE ${nameCol} LIKE ? LIMIT 20`)
      .all("%Facebook draft%");
    if (rows.length) dump[`name_${table}`] = rows;
  } catch {
    /* ignore */
  }
}

writeFileSync(
  "scripts/dev/inspect-steps-out.json",
  JSON.stringify({ tables: out.tables, schemas: Object.fromEntries(out.tables.map((t) => [t, out[`schema_${t}`]])), dump }, null, 2),
);
console.log("tables", out.tables.join(", "));
console.log("dump keys", Object.keys(dump).length);
