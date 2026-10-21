import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Preview } from "../shared/admin-v3.js";
import type { CaseResult } from "../shared/contracts.js";

/** Protected copies: deleting a Test Case/run cannot delete selected public previews. */
export class PreviewAssets {
  constructor(private readonly root: string, private readonly evidenceRoot: string) {}
  async list(): Promise<Preview[]> {
    await mkdir(this.root, { recursive: true });
    const files = await readdir(this.root);
    return Promise.all(files.filter(x => /^[a-f0-9-]{36}\.json$/.test(x)).map(async x => JSON.parse(await readFile(path.join(this.root, x), "utf8")) as Preview));
  }
  async select(result: CaseResult, kind: Preview["kind"], confirmed: boolean) {
    if (confirmed !== true) throw new Error("PREVIEW_REVIEW: Confirm you reviewed all visible content and removed credentials/private information before packaging.");
    if (result.status === "RUNNING" || !result.caseId || !result.runId || ![result.caseId, result.runId].every(x => /^[a-f0-9-]{36}$/.test(x))) throw new Error("PREVIEW_RUN: Select a completed Test Run.");
    if (!["screenshot", "video"].includes(kind)) throw new Error("PREVIEW_KIND");
    const file = kind === "screenshot" ? "final.png" : "recording.webm";
    const expected = `${result.caseId}/${result.runId}/${file}`;
    if ((kind === "screenshot" ? result.screenshotPath : result.recordingPath) !== expected) throw new Error("PREVIEW_MISSING: This run has no selected media.");
    const buffer = await readFile(path.join(this.evidenceRoot, result.caseId, result.runId, file));
    const id = randomUUID(), filename = `${id}.${kind === "screenshot" ? "png" : "webm"}`;
    const preview: Preview = { id, filename, kind, sha256: createHash("sha256").update(buffer).digest("hex"),
      caseId: result.caseId, runId: result.runId, reviewed: true, reviewedAt: new Date().toISOString() };
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, filename), buffer, { flag: "wx" });
    await writeFile(path.join(this.root, `${id}.json`), JSON.stringify(preview), { flag: "wx" });
    return preview;
  }
  async bytes(id: string) {
    const preview = (await this.list()).find(x => x.id === id);
    if (!preview || !preview.reviewed || !/^[a-f0-9-]{36}\.(png|webm)$/.test(preview.filename)) throw new Error("PREVIEW_NOT_REVIEWED");
    const bytes = await readFile(path.join(this.root, preview.filename));
    if (createHash("sha256").update(bytes).digest("hex") !== preview.sha256) throw new Error("PREVIEW_CHANGED: Review a fresh copy.");
    return { preview, bytes };
  }
}
