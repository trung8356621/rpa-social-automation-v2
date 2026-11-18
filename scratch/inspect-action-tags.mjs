import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".local/creator/creator.sqlite", { readOnly: true });
const rows = db.prepare("SELECT payload FROM action_tags").all();
for (const row of rows) {
  const t = JSON.parse(row.payload);
  console.log(JSON.stringify({
    tag_key: t.tag_key,
    keys: Object.keys(t).sort(),
    base_url: t.base_url,
    url_pattern: t.url_pattern,
    path_inputs: t.path_inputs,
    url_mode: t.url_mode,
    start_url_mode: t.start_url_mode,
    navigation_mode: t.navigation_mode,
    dynamic: t.dynamic,
    is_dynamic: t.is_dynamic,
    static: t.static,
    url_kind: t.url_kind,
    site_url_mode: t.site_url_mode,
  }, null, 2));
}
