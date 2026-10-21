import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";

/** CDP captures only the executing Browser. The trusted shell encodes silent WebM. */
export class BrowserRecording {
  private lastFrameAt = 0;
  private active?: { token: string; browser: WebContents; file: FileHandle; temp: string; final: string;
    bytes: number; error?: string; attached: boolean; queue: Promise<void>; ready: () => void; done: () => void;
    readyPromise: Promise<void>; donePromise: Promise<void> };
  constructor(private readonly shell: WebContents, private readonly root: string) {}
  private frame = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    const run = this.active;
    if (!run || method !== "Page.screencastFrame") return;
    if (Date.now() - this.lastFrameAt >= 80) {
      this.lastFrameAt = Date.now();
      this.shell.send("creator:recording", { type: "frame", token: run.token, data: params.data });
    }
    void run.browser.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  };
  async start(browser: WebContents, caseId: string, runId: string) {
    if (this.active) throw new Error("Recording already active.");
    if (![caseId, runId].every(x => /^[a-f0-9-]{36}$/.test(x))) throw new Error("Invalid recording IDs.");
    const directory = path.join(this.root, caseId, runId);
    await mkdir(directory, { recursive: true });
    const temp = path.join(directory, "recording.webm.tmp"), final = path.join(directory, "recording.webm");
    const file = await open(temp, "wx");
    let ready!: () => void, done!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; }), donePromise = new Promise<void>(resolve => { done = resolve; });
    const run: NonNullable<BrowserRecording["active"]> = { token: randomUUID(), browser, file, temp, final, bytes: 0, attached: false,
      queue: Promise.resolve(), ready, done, readyPromise, donePromise };
    this.active = run;
    try {
      this.shell.send("creator:recording", { type: "start", token: run.token });
      await this.timeout(readyPromise, 5000);
      if (run.error) throw new Error(run.error);
      if (!browser.debugger.isAttached()) { browser.debugger.attach("1.3"); run.attached = true; }
      browser.debugger.on("message", this.frame);
      await browser.debugger.sendCommand("Page.enable");
      await browser.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 });
    } catch (error) { run.error = String(error); await this.stop().catch(() => {}); throw error; }
  }
  async receive(token: string, type: "ready" | "chunk" | "done" | "error", data?: string) {
    const run = this.active;
    if (!run || run.token !== token) throw new Error("Recording token expired.");
    if (type === "error") { run.error = "Browser video encoder failed."; run.ready(); run.done(); }
    else if (type === "ready") run.ready();
    else if (type === "done") run.done();
    else if (type === "chunk") {
      if (typeof data !== "string" || data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid video chunk.");
      const bytes = Buffer.from(data, "base64");
      run.bytes += bytes.length;
      if (run.bytes > 256 * 1024 * 1024) { run.error = "Recording exceeded 256 MiB limit."; return; }
      run.queue = run.queue.then(async () => { await run.file.write(bytes); }).catch(() => { run.error = "Could not persist recording."; });
      await run.queue;
    }
  }
  async stop() {
    const run = this.active;
    if (!run) return;
    try {
      await run.browser.debugger.sendCommand("Page.stopScreencast").catch(() => {});
      run.browser.debugger.removeListener("message", this.frame);
      this.shell.send("creator:recording", { type: "stop", token: run.token });
      await this.timeout(run.donePromise, 10000);
      await run.queue;
      await run.file.close();
      if (run.error || !run.bytes) throw new Error(run.error ?? "No recording frames received.");
      await rename(run.temp, run.final);
      return run.final;
    } finally {
      this.active = undefined;
      await run.file.close().catch(() => {});
      await unlink(run.temp).catch(() => {});
      if (run.attached && run.browser.debugger.isAttached()) run.browser.debugger.detach();
    }
  }
  private async timeout(promise: Promise<void>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Video encoder timed out.")), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
