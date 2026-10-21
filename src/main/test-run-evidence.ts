import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserCore } from "./browser-core.js";
import type { CaseResult } from "../shared/contracts.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ownedFiles = new Set(["recording.webm", "recording.webm.tmp", "final.png", "final.png.tmp", "metadata.json", "metadata.json.tmp"]);
/** Browser content only. No desktop capture, uploads, data URLs in metadata or Runtime changes. */
export class TestRunEvidence {
  constructor(private readonly root: string) {}
  private directory(caseId: string, runId?: string) {
    if (!uuid.test(caseId) || (runId !== undefined && !uuid.test(runId))) throw new Error("Test Run ID không hợp lệ.");
    const target = path.resolve(this.root, caseId, ...(runId ? [runId] : []));
    const relative = path.relative(path.resolve(this.root), target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Đường dẫn ảnh không hợp lệ.");
    return target;
  }
  async capture(browser: BrowserCore, caseId: string, runId: string) {
    const directory = this.directory(caseId, runId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Electron captures the tested WebContents, never the host window/desktop.
      const image = await Promise.race([
        browser.view.webContents.capturePage(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Chụp Browser quá 4 giây.")), 4000); }),
      ]);
      if (image.isEmpty()) throw new Error("Browser trả về ảnh rỗng.");
      const buffer = image.toPNG();
      if (!buffer.length) throw new Error("Không tạo được dữ liệu PNG của Browser.");
      const screenshotAt = new Date().toISOString();
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "final.png.tmp"), buffer, { flag: "wx" });
      await rename(path.join(directory, "final.png.tmp"), path.join(directory, "final.png"));
      return { screenshotAt, screenshotPath: `${caseId}/${runId}/final.png` };
    } catch (error) {
      await unlink(path.join(directory, "final.png.tmp")).catch(() => {});
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  async metadata(caseId: string, result: CaseResult) {
    const directory = this.directory(caseId, result.runId);
    if (!result.runId) throw new Error("Thiếu Test Run ID.");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "metadata.json.tmp"), JSON.stringify(result, null, 2), "utf8");
    await rename(path.join(directory, "metadata.json.tmp"), path.join(directory, "metadata.json"));
  }
  async read(caseId: string, result: CaseResult) {
    const directory = this.directory(caseId, result.runId);
    if (!result.runId || result.screenshotPath !== `${caseId}/${result.runId}/final.png`) throw new Error("Lượt chạy này chưa có screenshot.");
    const buffer = await readFile(path.join(directory, "final.png"));
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }
  async video(caseId: string, result: CaseResult) {
    const directory = this.directory(caseId, result.runId);
    if (!result.runId || result.recordingPath !== `${caseId}/${result.runId}/recording.webm`) throw new Error("No recording for this run.");
    return `data:video/webm;base64,${(await readFile(path.join(directory, "recording.webm"))).toString("base64")}`;
  }
  /** Keep latest + one previous run per Case. Delete only known files under our UUID directories. */
  async prune(caseId: string, latestRunId?: string, deletingCase = false) {
    const directory = this.directory(caseId);
    const runs = await readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const previous: { id: string; at: string }[] = [];
    for (const entry of runs) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !uuid.test(entry.name) || entry.name === latestRunId) continue;
      const runDirectory = this.directory(caseId, entry.name);
      let at = "";
      try {
        const metadata = JSON.parse(await readFile(path.join(runDirectory, "metadata.json"), "utf8")) as CaseResult;
        if (metadata.caseId !== caseId || metadata.runId !== entry.name) continue;
        at = typeof metadata.finishedAt === "string" ? metadata.finishedAt : "";
      } catch { /* Incomplete writes from an interrupted run are also owned files. */ }
      previous.push({ id: entry.name, at });
    }
    previous.sort((a, b) => b.at.localeCompare(a.at));
    for (const old of previous.slice(deletingCase ? 0 : 1)) {
      const runDirectory = this.directory(caseId, old.id);
      const files = await readdir(runDirectory, { withFileTypes: true });
      if (files.some(file => !file.isFile() || !ownedFiles.has(file.name))) continue;
      for (const file of files) await unlink(path.join(runDirectory, file.name));
      await rmdir(runDirectory);
    }
    if (deletingCase) await rmdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
