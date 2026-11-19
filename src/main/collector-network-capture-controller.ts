/**
 * C2B.6 — invoke-oriented Network Capture controller (main-process).
 * Keeps active-session lifecycle out of renderer; main.ts delegates IPC here.
 */

import type { CdpDebuggerSession } from "./cdp-debugger-session.js";
import { CollectorNetworkCapture } from "./collector-network-capture.js";
import { CollectorCaptureSessionStorage } from "./collector-capture-session-storage.js";
import type {
  CollectorCaptureSessionRecord,
  CollectorCaptureStatus,
} from "../shared/collectors/capture-session-types.js";

export type CollectorNetworkCaptureStartCommand = {
  scriptId: string;
  networkPartId: string;
  networkPartVersion: number;
  sourceUrl?: string;
};

export class CollectorNetworkCaptureController {
  private active: CollectorNetworkCapture | null = null;

  constructor(
    private readonly getCdp: () => CdpDebuggerSession,
    private readonly storage: CollectorCaptureSessionStorage,
    private readonly projectDir: string,
    private readonly getBrowserSessionId: () => string | undefined,
    private readonly getBrowserUrl: () => string | undefined,
  ) {}

  async start(command: CollectorNetworkCaptureStartCommand): Promise<CollectorCaptureSessionRecord> {
    if (
      typeof command.scriptId !== "string" ||
      !command.scriptId.trim() ||
      typeof command.networkPartId !== "string" ||
      !command.networkPartId.trim() ||
      !Number.isInteger(command.networkPartVersion) ||
      command.networkPartVersion < 1
    ) {
      throw new Error("Invalid Network Capture start parameters.");
    }
    const current = this.active?.getStatus().status;
    if (current === "running" || current === "stopping") {
      throw new Error("Network Capture is already active. Stop it before starting another session.");
    }
    const cdp = this.getCdp();
    this.active = new CollectorNetworkCapture({
      cdp,
      storage: this.storage,
      projectDir: this.projectDir,
    });
    return this.active.start({
      scriptId: command.scriptId.trim(),
      networkPartId: command.networkPartId.trim(),
      networkPartVersion: command.networkPartVersion,
      browserSessionId: this.getBrowserSessionId(),
      sourceUrl: command.sourceUrl ?? this.getBrowserUrl(),
      cdpGeneration: cdp.diagnostics().generation,
    });
  }

  async stop(reason = "manual"): Promise<{
    status: CollectorCaptureStatus | "idle";
    session: CollectorCaptureSessionRecord | undefined;
  }> {
    if (!this.active) return { status: "idle", session: undefined };
    const stopped = await this.active.stop(reason);
    return { status: stopped.status, session: stopped };
  }

  status(): {
    status: CollectorCaptureStatus | "idle";
    session: CollectorCaptureSessionRecord | null;
    browserSessionId: string | undefined;
    browserUrl: string | undefined;
    cdpGeneration: number;
  } {
    const snap = this.active?.getStatus();
    return {
      status: snap?.status ?? "idle",
      session: snap?.session ?? null,
      browserSessionId: this.getBrowserSessionId(),
      browserUrl: this.getBrowserUrl(),
      cdpGeneration: this.getCdp().diagnostics().generation,
    };
  }

  async stopIfActive(reason: string): Promise<void> {
    if (!this.active) return;
    const status = this.active.getStatus().status;
    if (status === "running" || status === "stopping") {
      await this.active.stop(reason).catch(() => undefined);
    }
  }

  listSessions(opts?: { scriptId?: string; limit?: number }) {
    return this.storage.listSessions(opts);
  }

  async listRequests(captureSessionId: string, offset = 0, limit = 200) {
    const rows = await this.storage.readRequestsNdjson(captureSessionId);
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return {
      total: rows.length,
      offset: safeOffset,
      items: rows.slice(safeOffset, safeOffset + safeLimit),
    };
  }

  readBodyPreview(captureSessionId: string, artifactRef: string, maxBytes?: number) {
    return this.storage.readBodyPreview(captureSessionId, artifactRef, maxBytes);
  }
}
