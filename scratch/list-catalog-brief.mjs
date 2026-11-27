import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const profile = path.resolve(import.meta.dirname, "../.local/qa-profile-facebook-sandbox");
app.setPath("userData", path.join(profile, "chromium"));
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";

app.whenReady().then(async () => {
  const token = safeStorage.decryptString(fs.readFileSync(path.join(profile, "seo-ops-rpa-admin.token")));
  const res = await fetch(`${base}/scripts`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = await res.json();
  const db = new DatabaseSync(path.join(profile, "creator.sqlite"), { readOnly: true });
  const localIds = new Set(db.prepare("SELECT id FROM flows").all().map((r) => r.id));
  const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
  const syncMeta = JSON.parse(settings.seoOpsSyncMeta || '{"rows":{}}');
  db.close();

  const rows = (body.scripts || []).map((s) => ({
    script_id: s.script_id,
    name: s.name,
    version: s.version,
    action_tag_key: s.action_tag_key,
    assets_complete: s.assets_complete,
    demo_status: s.demo_status,
    content_digest: String(s.content_digest || "").slice(0, 12),
    localPresent: localIds.has(s.script_id),
    localStatus: syncMeta.rows?.[s.script_id]?.status,
    localMessage: syncMeta.rows?.[s.script_id]?.message,
  }));
  console.log(JSON.stringify({ status: res.status, count: rows.length, rows }, null, 2));
  app.exit(0);
});
