import { app, safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";

console.error("boot");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");

const root = process.cwd();
const dataPath = path.join(root, ".local/creator");
// Must match main.ts userData or safeStorage cannot decrypt the token.
app.setPath("userData", dataPath);
app.setPath("sessionData", path.join(dataPath, "chromium-catalog-probe"));
const tokenPath = path.join(dataPath, "seo-ops-rpa-admin.token");

const timer = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout" }));
  app.exit(3);
}, 25000);

app.whenReady().then(async () => {
  console.error("ready");
  try {
    const db = new DatabaseSync(path.join(dataPath, "creator.sqlite"), { readOnly: true });
    const baseUrl =
      db.prepare("SELECT value FROM settings WHERE key = ?").get("seoOpsBaseUrl")?.value ||
      "https://seo-ops.duckdns.org";
    console.error("base", baseUrl);
    console.error("tokenExists", true);
    const raw = await readFile(tokenPath);
    console.error("tokenBytes", raw.length, "enc", safeStorage.isEncryptionAvailable());
    const token = safeStorage.decryptString(raw);
    console.error("tokenLen", token ? token.length : 0);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 12000);
    const url = `${String(baseUrl).replace(/\/$/, "")}/api/v1/social-automation/rpa-admin/scripts`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    console.error("status", response.status);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { parse_error: true, raw: text.slice(0, 300) };
    }
    const scripts = Array.isArray(json?.scripts) ? json.scripts : [];
    const summary = scripts.map((s) => ({
      script_id: s.script_id || s.id,
      package_key: s.package_key,
      version: s.version,
      content_digest: String(s.content_digest || "").slice(0, 16),
      execution_digest: String(s.execution_digest || "").slice(0, 16),
      assets_complete: s.assets_complete,
      demo_status: s.demo_status,
      action_tag_key:
        s.action_tag_key ||
        s.tag_key ||
        s.manifest?.action_tag_key ||
        s.release?.action_tag_key,
    }));
    console.log(
      JSON.stringify(
        {
          ok: response.ok,
          httpStatus: response.status,
          count: summary.length,
          scripts: summary,
          hasFacebookPoc: summary.some(
            (s) => s.script_id === "48f48584-75b8-4e01-8bff-20a95be2daba",
          ),
          hasLogin: summary.some(
            (s) => s.script_id === "690493bd-a830-4648-83b3-86da1533c77a",
          ),
          hasPostDetail: summary.some(
            (s) => s.script_id === "facebook-group-post-detail",
          ),
          topKeys: json && typeof json === "object" ? Object.keys(json) : [],
        },
        null,
        2,
      ),
    );
    clearTimeout(timer);
    app.exit(response.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    clearTimeout(timer);
    app.exit(1);
  }
});
