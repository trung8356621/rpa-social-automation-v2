import { readFileSync } from "node:fs";

const token = readFileSync(
  ".local/qa-profile-facebook-sandbox/seo-ops-rpa-admin.token",
  "utf8",
).trim();
const base = "https://seo-ops.duckdns.org/api/v1/social-automation/rpa-admin";

async function hit(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  const preview = text.slice(0, 220).replace(/\s+/g, " ");
  console.log(
    JSON.stringify({
      method,
      path,
      status: res.status,
      contentType: ct,
      preview,
    }),
  );
  return { res, text, ct };
}

await hit("GET", "/scripts");
await hit("POST", "/scripts/sync", { mode: "normal", package_key: "probe-missing" });
await hit("POST", "/scripts/sync/plan", { local_scripts: [] });
await hit("POST", "/scripts/publish", {});
await hit("POST", "/scripts/pull", { package_key: "x", version: "1" });
