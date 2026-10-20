import type { Flow, Payload, Variable, StepGroup } from "./contracts.js";
export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0111\u0110]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "group";
export function resolvePayload(p: Payload, f: Flow): Payload {
  if (!["TYPE_ONLY", "CLICK_AND_TYPE", "UPLOAD_FILE", "QUICK_TAG"].includes(p.action))
    return p;
  const v = f.variables?.find((v) => v.id === p.variableId),
    value = v && f.defaultPattern?.values[v.id];
  if (!v) throw new Error("Missing variable for Action");
  if (p.action === "QUICK_TAG") {
    if (v.type !== "integer" || typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10 || value > (p.quickTagRows ?? 0))
      throw new Error(`Variable ${v.key}: QUICK_TAG cần Integer Default Pattern 1–10, không vượt số hàng ROI`);
    return { ...p, quickTagCount: value };
  }
  if (p.action === "UPLOAD_FILE") {
    if (v.type === "file" && typeof value === "string" && value)
      return { ...p, files: [value] };
    if (
      v.type === "files" &&
      Array.isArray(value) &&
      value.length &&
      value.every((x) => typeof x === "string" && x)
    )
      return { ...p, files: value };
  } else if (
    v.type === "text" &&
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 20000
  )
    return { ...p, text: value };
  throw new Error(
    `Variable ${v.key}: missing Default Pattern value or type mismatch`,
  );
}
export function validateVariables(
  vars: Variable[],
  values: Record<string, string | string[] | number>,
) {
  const ids = new Set(),
    keys = new Set();
  for (const v of vars) {
    if (
      !v.id ||
      !v.key.trim() ||
      ids.has(v.id) ||
      keys.has(v.key) ||
      !["text", "file", "files", "integer", "number"].includes(v.type)
    )
      throw new Error("Invalid or duplicate variable");
    ids.add(v.id);
    keys.add(v.key);
    const x = values[v.id];
    if (
      x !== undefined &&
      (v.type === "number" ? typeof x !== "number" || !Number.isFinite(x) : v.type === "integer" ? typeof x !== "number" || !Number.isSafeInteger(x) : v.type === "files"
        ? !Array.isArray(x) || x.some((y) => typeof y !== "string")
        : typeof x !== "string")
    )
      throw new Error("Variable type mismatch");
  }
  if (Object.keys(values).some((id) => !ids.has(id)))
    throw new Error("Unknown variable value");
}
export function validateOrganization(
  f: Flow,
  groups: StepGroup[],
  order: string[],
) {
  if (
    order.length !== f.steps.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !f.steps.some((s) => s.id === id))
  )
    throw new Error("Incomplete execution order");
  const ids = new Set(),
    slugs = new Set(),
    members = new Set();
  for (const g of groups) {
    if (
      !g.id ||
      ids.has(g.id) ||
      !g.name.trim() ||
      g.slug !== slugify(g.slug) ||
      slugs.has(g.slug)
    )
      throw new Error("Invalid or duplicate group slug/ID");
    if (g.emptyPosition !== undefined && (!Number.isInteger(g.emptyPosition) || g.emptyPosition < 0))
      throw new Error("Invalid empty group position");
    ids.add(g.id);
    slugs.add(g.slug);
    g.stepIds.forEach((id, i) => {
      if (
        members.has(id) ||
        !order.includes(id) ||
        (i > 0 && order.indexOf(id) !== order.indexOf(g.stepIds[i - 1]) + 1)
      )
        throw new Error("Invalid group order");
      members.add(id);
    });
  }
}
