import { mkdir, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  requireCdpSessionForDebugger,
  type CdpDebuggerSession,
  type CdpLease,
} from "./cdp-debugger-session.js";

/** CDP captures only the executing Browser. The trusted shell encodes silent WebM. */
export class BrowserRecording {
  private lastFrameAt = 0;
  private active?: {
    token: string;
    browser: WebContents;
    file: FileHandle;
    temp: string;
    final: string;
    thumb: string;
    bytes: number;
    error?: string;
    queue: Promise<void>;
    ready: () => void;
    done: () => void;
    readyPromise: Promise<void>;
    donePromise: Promise<void>;
    lastFrame?: string;
    cdp: CdpDebuggerSession;
    lease?: CdpLease;
    offMessage?: () => void;
    offInvalidation?: () => void;
  };
  constructor(private readonly shell: WebContents, private readonly root: string) {}

  private handleFrame = (
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const run = this.active;
    if (!run || !run.lease?.alive || method !== "Page.screencastFrame") return;
    if (typeof params.data === "string" && params.data.length > 0) run.lastFrame = params.data;
    if (Date.now() - this.lastFrameAt >= 80) {
      this.lastFrameAt = Date.now();
      this.shell.send("creator:recording", { type: "frame", token: run.token, data: params.data });
    }
    void run.cdp
      .sendCommand(run.lease, "Page.screencastFrameAck", {
        sessionId: params.sessionId,
      })
      .catch(() => {});
  };

  async start(browser: WebContents, caseId: string, runId: string) {
    if (this.active) throw new Error("Recording already active.");
    if (![caseId, runId].every((x) => /^[a-f0-9-]{36}$/.test(x)))
      throw new Error("Invalid recording IDs.");
    const cdp = requireCdpSessionForDebugger(browser.debugger);
    const directory = path.join(this.root, caseId, runId);
    await mkdir(directory, { recursive: true });
    const temp = path.join(directory, "recording.webm.tmp");
    const final = path.join(directory, "recording.webm");
    const thumb = path.join(directory, "recording-thumb.jpg");
    const file = await open(temp, "wx");
    let ready!: () => void,
      done!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const donePromise = new Promise<void>((resolve) => {
      done = resolve;
    });
    const run: NonNullable<BrowserRecording["active"]> = {
      token: randomUUID(),
      browser,
      file,
      temp,
      final,
      thumb,
      bytes: 0,
      queue: Promise.resolve(),
      ready,
      done,
      readyPromise,
      donePromise,
      cdp,
    };
    this.active = run;
    try {
      this.shell.send("creator:recording", { type: "start", token: run.token });
      await this.timeout(readyPromise, 5000);
      if (run.error) throw new Error(run.error);
      run.offInvalidation = cdp.onUnexpectedDetach(() => {
        if (!this.active || this.active.token !== run.token) return;
        run.error = "Debugger bị ngắt trong lúc ghi hình.";
        run.ready();
        run.done();
      });
      run.lease = await cdp.acquire("screencast");
      run.offMessage = cdp.onMessage(run.lease, this.handleFrame);
      await cdp.sendCommand(run.lease, "Page.enable");
      await cdp.sendCommand(run.lease, "Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        everyNthFrame: 1,
        maxWidth: 1280,
        maxHeight: 720,
      });
    } catch (error) {
      run.error = String(error);
      // Unblock encoder waiters so stop() cleanup does not sit on ready/done timeouts.
      run.ready();
      run.done();
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async receive(token: string, type: "ready" | "chunk" | "done" | "error", data?: string) {
    const run = this.active;
    if (!run || run.token !== token) throw new Error("Recording token expired.");
    if (type === "error") {
      run.error = "Browser video encoder failed.";
      run.ready();
      run.done();
    } else if (type === "ready") run.ready();
    else if (type === "done") run.done();
    else if (type === "chunk") {
      if (
        typeof data !== "string" ||
        data.length > 8 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      ) {
        throw new Error("Invalid video chunk.");
      }
      const bytes = Buffer.from(data, "base64");
      run.bytes += bytes.length;
      if (run.bytes > 256 * 1024 * 1024) {
        run.error = "Recording exceeded 256 MiB limit.";
        return;
      }
      run.queue = run.queue
        .then(async () => {
          await run.file.write(bytes);
        })
        .catch(() => {
          run.error = "Could not persist recording.";
        });
      await run.queue;
    }
  }

  async stop(): Promise<{ videoPath: string; thumbPath?: string } | undefined> {
    const run = this.active;
    if (!run) return;
    try {
      if (run.lease?.alive) {
        await run.cdp.sendCommand(run.lease, "Page.stopScreencast").catch(() => {});
      }
      run.offMessage?.();
      run.offMessage = undefined;
      this.shell.send("creator:recording", { type: "stop", token: run.token });
      await this.timeout(run.donePromise, 10000);
      await run.queue;
      await run.file.close();
      if (run.error || !run.bytes) throw new Error(run.error ?? "No recording frames received.");
      await rename(run.temp, run.final);
      let thumbPath: string | undefined;
      if (run.lastFrame) {
        await writeFile(run.thumb, Buffer.from(run.lastFrame, "base64"));
        thumbPath = run.thumb;
      }
      return { videoPath: run.final, thumbPath };
    } finally {
      this.active = undefined;
      run.offMessage?.();
      run.offInvalidation?.();
      if (run.lease) await run.lease.release().catch(() => undefined);
      await run.file.close().catch(() => {});
      await unlink(run.temp).catch(() => {});
      // Never debugger.detach() — shared adapter / peer tenants may still need the session.
    }
  }

  private async timeout(promise: Promise<void>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Video encoder timed out.")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
