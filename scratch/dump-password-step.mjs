import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const id = "1e7c2ad4-94ea-4b05-85c3-ef63daca5f86";
const userId = "04c801be-1933-47aa-bd26-9ff8bd31e5f7";

for (const stepId of [userId, id]) {
  const rows = db.prepare("SELECT version, payload FROM steps WHERE id = ? ORDER BY version").all(stepId);
  console.log("\n=== steps", stepId, "count", rows.length);
  for (const row of rows) {
    const parsed = JSON.parse(row.payload);
    const target = parsed?.payload?.target || parsed?.target;
    const ocr = target?.ocr;
    console.log(
      JSON.stringify(
        {
          version: row.version,
          name: parsed.name,
          action: parsed?.payload?.action || parsed?.action,
          matchTo: target?.matchTo,
          roi: target?.roi,
          environment: target?.environment,
          clickOffset: target?.clickOffset,
          asset: target?.asset,
          ocr: ocr
            ? {
                text: ocr.text,
                kind: ocr.kind,
                bbox: ocr.bbox,
                confidence: ocr.confidence,
                confirmed: ocr.confirmed,
              }
            : null,
          hasNestedPayload: Boolean(parsed.payload),
          keys: Object.keys(parsed),
          nestedKeys: parsed.payload ? Object.keys(parsed.payload) : [],
        },
        null,
        2,
      ),
    );
  }
}

console.log("\noverrides schema", db.prepare("PRAGMA table_info(overrides)").all());
const overrides = db.prepare("SELECT * FROM overrides LIMIT 20").all();
console.log("overrides sample", overrides.length, overrides[0] && Object.keys(overrides[0]));
for (const row of overrides.slice(0, 10)) {
  const blob = JSON.stringify(row);
  if (blob.includes("1e7c2ad4") || blob.includes("Password")) {
    console.log("override hit", blob.slice(0, 2000));
  }
}

// Find max version anywhere mentioning Password OCR
const all = db.prepare("SELECT id, version, payload FROM steps").all();
const passwordish = all.filter((r) => /Password|password/i.test(r.payload));
console.log(
  "\npasswordish versions",
  passwordish.map((r) => {
    const p = JSON.parse(r.payload);
    const target = p?.payload?.target || p?.target;
    return {
      id: r.id,
      version: r.version,
      name: p.name,
      ocrText: target?.ocr?.text,
      ocrKind: target?.ocr?.kind,
      bbox: target?.ocr?.bbox,
      clickOffset: target?.clickOffset,
      matchTo: target?.matchTo,
      roi: target?.roi,
    };
  }),
);
