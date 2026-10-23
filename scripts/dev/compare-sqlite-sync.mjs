/**
 * Read-only compare desktop (SoT) vs laptop SQLite for Facebook draft flows.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const DESKTOP = "D:/transfer/creator/creator.sqlite";
const LAPTOP =
  "D:/work-app/new/rpa-social-automation-v2/.local/creator/creator.sqlite";

function load(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const flows = db
    .prepare("SELECT id, payload FROM flows")
    .all()
    .map((r) => ({ id: r.id, ...JSON.parse(r.payload) }));
  const steps = {};
  for (const r of db.prepare("SELECT id, version, payload FROM steps").all()) {
    (steps[r.id] ??= {})[r.version] = JSON.parse(r.payload);
  }
  db.close();
  return { flows, steps };
}

function execFields(step) {
  const p = step?.payload ?? {};
  const t = p.target ?? {};
  return {
    name: step?.name,
    action: p.action,
    method: p.method,
    threshold: p.threshold,
    timeoutMs: p.timeoutMs,
    variableId: p.variableId,
    inputMethod: p.inputMethod,
    text: p.text,
    files: p.files,
    quickTagRows: p.quickTagRows,
    matchTo: t.matchTo,
    ocr: t.ocr
      ? {
          confirmed: t.ocr.confirmed,
          text: t.ocr.text,
          kind: t.ocr.kind,
          confidence: t.ocr.confidence,
          language: t.ocr.language,
          bbox: t.ocr.bbox,
        }
      : null,
    roi: t.roi,
    asset: t.asset,
    environment: t.environment,
  };
}

function diffObj(a, b, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const pa = `${prefix}${k}`;
    const va = a?.[k];
    const vb = b?.[k];
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (
      va &&
      vb &&
      typeof va === "object" &&
      typeof vb === "object" &&
      !Array.isArray(va)
    ) {
      out.push(...diffObj(va, vb, `${pa}.`));
    } else {
      out.push({ field: pa, desktop: va ?? null, laptop: vb ?? null });
    }
  }
  return out;
}

const desk = load(DESKTOP);
const lap = load(LAPTOP);

const report = { flows: [], summary: { lostOcr: [], matchToChanged: [], varOrphan: [], pinChanged: [] } };

for (const df of desk.flows.filter((f) => /Facebook draft/i.test(f.name || ""))) {
  const lf = lap.flows.find((f) => f.id === df.id) ?? lap.flows.find((f) => f.name === df.name);
  const flowDiff = {
    id: df.id,
    name: df.name,
    laptopFound: Boolean(lf),
    pinDiffs: [],
    stepDiffs: [],
    variableDiffs: [],
    patternDiffs: [],
  };

  if (!lf) {
    flowDiff.note = "missing on laptop";
    report.flows.push(flowDiff);
    continue;
  }

  // pins
  const dPins = Object.fromEntries((df.steps || []).map((s) => [s.id, s.version]));
  const lPins = Object.fromEntries((lf.steps || []).map((s) => [s.id, s.version]));
  for (const id of new Set([...Object.keys(dPins), ...Object.keys(lPins)])) {
    if (dPins[id] !== lPins[id]) {
      flowDiff.pinDiffs.push({ stepId: id, desktop: dPins[id], laptop: lPins[id] });
      report.summary.pinChanged.push(`${df.name}:${id.slice(0, 8)} ${dPins[id]}→${lPins[id]}`);
    }
  }

  // variables
  const dVars = Object.fromEntries((df.variables || []).map((v) => [v.id, v]));
  const lVars = Object.fromEntries((lf.variables || []).map((v) => [v.id, v]));
  for (const id of new Set([...Object.keys(dVars), ...Object.keys(lVars)])) {
    const diffs = diffObj(dVars[id], lVars[id]);
    if (diffs.length || !dVars[id] || !lVars[id]) {
      flowDiff.variableDiffs.push({
        id,
        desktop: dVars[id] ?? null,
        laptop: lVars[id] ?? null,
        diffs,
      });
    }
  }

  // default pattern
  const dPat = df.defaultPattern?.values || {};
  const lPat = lf.defaultPattern?.values || {};
  for (const id of new Set([...Object.keys(dPat), ...Object.keys(lPat)])) {
    if (JSON.stringify(dPat[id]) !== JSON.stringify(lPat[id])) {
      flowDiff.patternDiffs.push({
        key: id,
        desktop: dPat[id] ?? null,
        laptop: lPat[id] ?? null,
        desktopIsVar: Boolean(dVars[id]),
        laptopIsVar: Boolean(lVars[id]),
      });
      if (lPat[id] !== undefined && !lVars[id])
        report.summary.varOrphan.push(`${df.name}:pattern ${id}`);
    }
  }

  // compare pinned step payloads (and latest if pin differs)
  for (const pin of df.steps || []) {
    const dStep = desk.steps[pin.id]?.[pin.version];
    const lPinVer = lPins[pin.id];
    const lStep = lap.steps[pin.id]?.[lPinVer];
    // also compare same version number if exists on both
    const sameVerLap = lap.steps[pin.id]?.[pin.version];
    const dFields = execFields(dStep);
    const lFields = execFields(lStep);
    const sameFields = execFields(sameVerLap);
    const pinFieldDiffs = diffObj(dFields, lFields);
    const sameVerDiffs = sameVerLap ? diffObj(dFields, sameFields) : [{ field: "_", desktop: "exists", laptop: "missing same version" }];

    if (pinFieldDiffs.length || sameVerDiffs.length) {
      const lostOcr =
        dFields.ocr?.confirmed && !lFields.ocr?.confirmed;
      const matchChanged = dFields.matchTo !== lFields.matchTo;
      if (lostOcr)
        report.summary.lostOcr.push(
          `${df.name}:${pin.id.slice(0, 8)} v${pin.version}→pin${lPinVer}`,
        );
      if (matchChanged)
        report.summary.matchToChanged.push(
          `${df.name}:${pin.id.slice(0, 8)} ${dFields.matchTo}→${lFields.matchTo}`,
        );
      flowDiff.stepDiffs.push({
        stepId: pin.id,
        desktopPinned: pin.version,
        laptopPinned: lPinVer,
        desktopVersions: Object.keys(desk.steps[pin.id] || {}).map(Number),
        laptopVersions: Object.keys(lap.steps[pin.id] || {}).map(Number),
        pinFieldDiffs,
        sameVersionDiffs: sameVerDiffs,
        desktopExec: dFields,
        laptopPinnedExec: lFields,
        laptopSameVersionExec: sameFields,
      });
    }
  }

  report.flows.push(flowDiff);
}

writeFileSync(
  "scripts/dev/compare-sqlite-sync-out.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report.summary, null, 2));
console.log(
  "flows",
  report.flows.map((f) => ({
    name: f.name,
    pins: f.pinDiffs.length,
    steps: f.stepDiffs.length,
    vars: f.variableDiffs.length,
    patterns: f.patternDiffs.length,
  })),
);
