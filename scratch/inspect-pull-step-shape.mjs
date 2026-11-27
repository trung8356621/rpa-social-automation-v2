import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

const profile = path.resolve(import.meta.dirname, "../.local/qa-profile-facebook-sandbox");
app.setPath("userData", path.join(profile, "chromium"));
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";
const id = "ea7822b3-ed2b-48e9-ab55-7ec7fe5349a1";

function shape(v, depth = 0) {
  if (v == null) return v;
  if (typeof v !== "object") return typeof v;
  if (depth > 4) return Array.isArray(v) ? `array(${v.length})` : "object";
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => shape(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length > 80) out[k] = `string(${val.length})`;
    else if (k === "asset_base64" || k === "content_base64") out[k] = "[binary]";
    else out[k] = shape(val, depth + 1);
  }
  return out;
}

app.whenReady().then(async () => {
  const token = safeStorage.decryptString(fs.readFileSync(path.join(profile, "seo-ops-rpa-admin.token")));
  const res = await fetch(`${base}/scripts/pull`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ package_key: id, version: "3" }),
  });
  const body = await res.json();
  const steps = body.release?.manifest?.steps || body.release?.steps || [];
  const first = steps[0] || null;
  console.log(JSON.stringify({
    status: res.status,
    ok: body.ok,
    stepCount: steps.length,
    firstStepKeys: first ? Object.keys(first) : [],
    firstStepShape: shape(first),
    // targeted OCR paths
    paths: first ? {
      "payload.target.asset": first.payload?.target?.asset,
      "payload.target.ocr.text": first.payload?.target?.ocr?.text,
      "payload.target.matchTo": first.payload?.target?.matchTo,
      "target.asset": first.target?.asset,
      "ocr.text": first.ocr?.text,
      "step.payload keys": first.payload ? Object.keys(first.payload) : null,
      "payload.action": first.payload?.action,
    } : null,
    sync404: await (async () => {
      const r = await fetch(`${base}/scripts/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "normal", package_key: "__x__", name: "x", schema_version: 1, runtime_compatibility: {}, dependencies: [], manifest: { script_id: "__x__", steps: [], variables: [], assets: [] } }),
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, ct: r.headers.get("content-type"), errors: j?.errors, message: j?.message, preview: t.slice(0, 200) };
    })(),
  }, null, 2));
  app.exit(0);
});
