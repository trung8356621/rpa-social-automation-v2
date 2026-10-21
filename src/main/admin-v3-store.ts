import { mkdir, readFile, readdir, rename, unlink, writeFile, link } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Definition, Release, RunResult } from "../shared/admin-v3.js";
import { safeKey } from "../shared/admin-v3-validation.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("V3_JSON: Unsupported value.");
  return serialized;
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function executable(d: Definition) {
  return { id: d.id, packageId: d.packageId, name: d.name, kind: d.kind, version: d.version, fields: d.fields, nodes: d.nodes,
    outputs: d.outputs, capabilities: d.capabilities, previewIds: d.previewIds };
}
/** Independent V3 files; never migrate or modify the V2 database. */
export class AdminV3Store {
  constructor(readonly root: string) {}
  location(area: string, id: string) {
    if (!["definitions", "releases", "runs", "imports", "packages", "builds"].includes(area) || !safeKey(id)) throw new Error("Invalid V3 storage key.");
    return path.join(this.root, area, `${id}.json`);
  }
  async list<T>(area: string): Promise<T[]> {
    const directory = path.dirname(this.location(area, "index"));
    await mkdir(directory, { recursive: true });
    const names = await readdir(directory);
    return Promise.all(names.filter(x => /^[A-Za-z][A-Za-z0-9_-]{0,79}\.json$/.test(x)).map(async x => JSON.parse(await readFile(path.join(directory, x), "utf8")) as T));
  }
  async get<T>(area: string, id: string): Promise<T> { return JSON.parse(await readFile(this.location(area, id), "utf8")) as T; }
  async put(area: string, id: string, value: unknown, immutable = false) {
    const target = this.location(area, id); await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, canonical(value), { flag: "wx" });
    try {
      if (immutable) await link(temp, target); // Atomic visibility and no replacement of an existing ID.
      else await rename(temp, target);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async removeDefinition(id: string) { await unlink(this.location("definitions", id)); }
  definitions() { return this.list<Definition>("definitions"); }
  releases() { return this.list<Release>("releases"); }
  runs() { return this.list<RunResult>("runs"); }
}
