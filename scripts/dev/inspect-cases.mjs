import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const stepIds = [
  "030160d7-4630-4c3a-aafe-8dd91378b468",
  "7093f687-9f6b-4ca7-af58-e5877412d5ee",
  "08947dd7-1436-4210-9279-130f2d00d4ad",
];

const flows = db.prepare("SELECT id, name, json FROM flows").all();
const steps = db.prepare("SELECT * FROM steps").all();
const overrides = db.prepare("SELECT * FROM overrides").all();
const settings = db.prepare("SELECT * FROM settings").all();

function parse(j) {
  try {
    return typeof j === "string" ? JSON.parse(j) : j;
  } catch {
    return j;
  }
}

const report = {
  flows: flows.map((f) => ({ id: f.id, name: f.name, ...summarizeFlow(parse(f.json)) })),
  caseSteps: {},
  settingsKeys: settings.map((s) => s.key),
};

function summarizeFlow(json) {
  if (!json || typeof json !== "object") return { raw: typeof json };
  return {
    keys: Object.keys(json),
    stepOrder: json.stepIds ?? json.steps?.map((s) => s.id) ?? json.order,
    pinned: json.pinnedVersions ?? json.versions,
  };
}

for (const id of stepIds) {
  const row = steps.find((s) => s.id === id);
  if (!row) {
    report.caseSteps[id] = { missing: true };
    continue;
  }
  const versions = parse(row.versions_json ?? row.versions ?? row.json ?? row.payload);
  const base = parse(row.base_json ?? row.base);
  const pinned = row.pinned_version ?? row.version;
  report.caseSteps[id] = {
    columns: Object.keys(row),
    name: row.name,
    flowId: row.flow_id ?? row.flowId,
    pinned,
    rowSummary: Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === "string" && v.length > 200 ? `[string ${v.length}]` : v,
      ]),
    ),
  };
  // try parse all string cols
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
      report.caseSteps[id][`parsed_${k}`] = summarizePayloadTree(parse(v));
    }
  }
}

function summarizePayloadTree(value, depth = 0) {
  if (depth > 6) return "...";
  if (Array.isArray(value)) {
    if (value.length && value[0]?.version != null) {
      return value.map((v) => summarizeVersion(v));
    }
    return { len: value.length, sample: value.slice(0, 2).map((x) => summarizePayloadTree(x, depth + 1)) };
  }
  if (value && typeof value === "object") {
    if (value.payload || value.target || value.action) return summarizeVersion(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "versions" && Array.isArray(v)) out.versions = v.map(summarizeVersion);
      else if (typeof v === "string" && v.length > 120) out[k] = `[string ${v.length}]`;
      else out[k] = summarizePayloadTree(v, depth + 1);
    }
    return out;
  }
  return value;
}

function summarizeVersion(v) {
  if (!v || typeof v !== "object") return v;
  const p = v.payload ?? v;
  const t = p.target ?? v.target;
  return {
    version: v.version ?? v.v,
    action: p.action,
    method: p.method,
    matchTo: t?.matchTo,
    ocr: t?.ocr
      ? {
          confirmed: t.ocr.confirmed,
          text: t.ocr.text,
          kind: t.ocr.kind,
          confidence: t.ocr.confidence,
          bbox: t.ocr.bbox,
          language: t.ocr.language,
        }
      : null,
    roi: t?.roi,
    asset: t?.asset,
    environment: t?.environment,
    variableId: p.variableId,
    threshold: p.threshold,
    assetExists: t?.asset
      ? existsSync(path.join(".local/creator/targets", t.asset))
      : null,
  };
}

// Facebook scenarios: find steps belonging to those flows
const fbFlows = flows.filter((f) => /Facebook draft/i.test(f.name ?? ""));
report.facebookFlows = fbFlows.map((f) => {
  const json = parse(f.json);
  const order = json?.stepIds ?? json?.order ?? [];
  const flowSteps = steps.filter((s) => (s.flow_id ?? s.flowId) === f.id);
  return {
    id: f.id,
    name: f.name,
    order,
    pinnedVersions: json?.pinnedVersions ?? json?.pins,
    steps: flowSteps.map((s) => {
      const summary = { id: s.id, name: s.name, cols: Object.keys(s) };
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
          summary[`parsed_${k}`] = summarizePayloadTree(parse(v));
        } else if (typeof v !== "string" || v.length < 80) summary[k] = v;
      }
      return summary;
    }),
  };
});

// recent targets with dims
const targetsDir = ".local/creator/targets";
report.targets = readdirSync(targetsDir)
  .filter((n) => n.endsWith(".png"))
  .map((n) => {
    const st = statSync(path.join(targetsDir, n));
    return { name: n, size: st.size, mtime: st.mtime.toISOString() };
  })
  .sort((a, b) => b.mtime.localeCompare(a.mtime));

// overrides referencing case steps
report.overridesForCases = overrides
  .filter((o) => stepIds.some((id) => JSON.stringify(o).includes(id)))
  .map((o) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        typeof v === "string" && v.length > 300 ? `[string ${v.length}]` : v,
      ]),
    ),
  );

writeFileSync("scripts/dev/inspect-cases-out.json", JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      flowCount: flows.length,
      stepCount: steps.length,
      fb: report.facebookFlows.map((f) => ({ name: f.name, steps: f.steps.length })),
      caseKeys: Object.keys(report.caseSteps),
      recentTargets: report.targets.slice(0, 8),
    },
    null,
    2,
  ),
);
