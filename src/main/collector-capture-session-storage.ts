import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./visual-match-lab-storage.js";
import type {
  CollectorCaptureSessionRecord,
  NetworkDiagnosticRecord,
  NetworkRequestMetaRecord,
} from "../shared/collectors/capture-session-types.js";
import type { VisualObservationRecord } from "../shared/collectors/visual-observation-types.js";
import { safeRequestFileId } from "../shared/collectors/network-body-parse.js";
import { redactPreviewText } from "../shared/collectors/network-capture-redaction.js";

function assertSafeCaptureSessionId(id: string): string {
  if (!/^[0-9A-Za-z_-]{8,128}$/.test(id)) {
    throw new Error(`Invalid captureSessionId: ${id}`);
  }
  return id;
}

export class CollectorCaptureSessionStorage {
  constructor(private readonly projectDir: string = process.cwd()) {}

  getSessionsRoot(): string {
    return path.join(this.projectDir, "scratch", "collector-capture-sessions");
  }

  getSessionDir(captureSessionId: string): string {
    return path.join(this.getSessionsRoot(), assertSafeCaptureSessionId(captureSessionId));
  }

  getNetworkDir(captureSessionId: string): string {
    return path.join(this.getSessionDir(captureSessionId), "network");
  }

  getResponsesDir(captureSessionId: string): string {
    return path.join(this.getNetworkDir(captureSessionId), "responses");
  }

  getVisualDir(captureSessionId: string): string {
    return path.join(this.getSessionDir(captureSessionId), "visual");
  }

  getVisualHtmlDir(captureSessionId: string): string {
    return path.join(this.getVisualDir(captureSessionId), "html");
  }

  async ensureSessionLayout(captureSessionId: string): Promise<{
    sessionDir: string;
    requestsPath: string;
    diagnosticsPath: string;
    responsesDir: string;
    sessionPath: string;
    visualDir: string;
    visualObservationsPath: string;
    visualHtmlDir: string;
  }> {
    const sessionDir = this.getSessionDir(captureSessionId);
    const networkDir = this.getNetworkDir(captureSessionId);
    const responsesDir = this.getResponsesDir(captureSessionId);
    const visualDir = this.getVisualDir(captureSessionId);
    const visualHtmlDir = this.getVisualHtmlDir(captureSessionId);
    await mkdir(responsesDir, { recursive: true });
    await mkdir(visualHtmlDir, { recursive: true });
    return {
      sessionDir,
      requestsPath: path.join(networkDir, "requests.ndjson"),
      diagnosticsPath: path.join(networkDir, "diagnostics.ndjson"),
      responsesDir,
      sessionPath: path.join(sessionDir, "session.json"),
      visualDir,
      visualObservationsPath: path.join(visualDir, "observations.ndjson"),
      visualHtmlDir,
    };
  }

  /**
   * Persist a Visual observation under the shared Capture Session.
   * Ready for main-process IPC; unit-tested without renderer.
   * Max HTML bytes capped when callers supply htmlBodies.
   */
  async appendVisualObservation(
    record: VisualObservationRecord,
    htmlBodies?: Array<{ candidateId: string; html: string; maxBytes?: number }>,
  ): Promise<{ observationArtifactRef: string; htmlArtifactRefs: Record<string, string> }> {
    const captureSessionId = assertSafeCaptureSessionId(record.captureSessionId);
    const { visualObservationsPath, visualHtmlDir, sessionDir } = await this.ensureSessionLayout(
      captureSessionId,
    );
    const htmlArtifactRefs: Record<string, string> = {};
    const candidates = record.candidates.map((c) => ({ ...c }));

    if (htmlBodies?.length) {
      for (const body of htmlBodies) {
        const maxBytes = Math.max(1024, Math.min(body.maxBytes ?? 200_000, 500_000));
        const raw = body.html ?? "";
        if (!raw.trim()) continue;
        const truncated = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
        const safeId = safeRequestFileId(body.candidateId);
        const fileName = `${safeId}.html`;
        const absolutePath = path.join(visualHtmlDir, fileName);
        const tmp = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, truncated, "utf8");
        await rename(tmp, absolutePath);
        const rel = path.relative(sessionDir, absolutePath).replace(/\\/g, "/");
        htmlArtifactRefs[body.candidateId] = rel;
        const idx = candidates.findIndex((c) => c.candidateId === body.candidateId);
        if (idx >= 0) {
          candidates[idx] = {
            ...candidates[idx]!,
            htmlArtifactRef: rel,
            htmlSkippedReason: truncated.length < raw.length ? "truncated_html" : undefined,
          };
        }
      }
    }

    const toWrite: VisualObservationRecord = {
      ...record,
      candidates,
      observationArtifactRef: `visual/observations.ndjson#${record.observationId}`,
    };
    await appendFile(visualObservationsPath, `${JSON.stringify(toWrite)}\n`, "utf8");
    return {
      observationArtifactRef: toWrite.observationArtifactRef!,
      htmlArtifactRefs,
    };
  }

  async readVisualObservations(captureSessionId: string): Promise<VisualObservationRecord[]> {
    const observationsPath = path.join(
      this.getVisualDir(assertSafeCaptureSessionId(captureSessionId)),
      "observations.ndjson",
    );
    try {
      const raw = await readFile(observationsPath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as VisualObservationRecord);
    } catch {
      return [];
    }
  }

  async writeSession(record: CollectorCaptureSessionRecord): Promise<string> {
    const { sessionPath } = await this.ensureSessionLayout(record.captureSessionId);
    await writeFileAtomic(sessionPath, JSON.stringify(record, null, 2));
    return sessionPath;
  }

  async readSession(
    captureSessionId: string,
  ): Promise<CollectorCaptureSessionRecord | null> {
    const sessionPath = path.join(
      this.getSessionDir(captureSessionId),
      "session.json",
    );
    try {
      const raw = await readFile(sessionPath, "utf8");
      return JSON.parse(raw) as CollectorCaptureSessionRecord;
    } catch {
      return null;
    }
  }

  async appendRequestMeta(record: NetworkRequestMetaRecord): Promise<void> {
    const { requestsPath } = await this.ensureSessionLayout(record.captureSessionId);
    await appendFile(requestsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async appendDiagnostic(
    captureSessionId: string,
    record: NetworkDiagnosticRecord,
  ): Promise<void> {
    const { diagnosticsPath } = await this.ensureSessionLayout(captureSessionId);
    await appendFile(diagnosticsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async writeResponseBody(
    captureSessionId: string,
    requestId: string,
    body: Buffer | string,
    extension: "json" | "txt" | "bin" = "txt",
  ): Promise<{ absolutePath: string; relativePath: string; bytes: number }> {
    const { responsesDir, sessionDir } = await this.ensureSessionLayout(captureSessionId);
    const fileName = `${safeRequestFileId(requestId)}.${extension}`;
    const absolutePath = path.join(responsesDir, fileName);
    const data = typeof body === "string" ? body : body;
    const tmp = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, absolutePath);
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    return {
      absolutePath,
      relativePath: path.relative(sessionDir, absolutePath).replace(/\\/g, "/"),
      bytes,
    };
  }

  async readRequestsNdjson(
    captureSessionId: string,
  ): Promise<NetworkRequestMetaRecord[]> {
    const requestsPath = path.join(
      this.getNetworkDir(captureSessionId),
      "requests.ndjson",
    );
    try {
      const raw = await readFile(requestsPath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NetworkRequestMetaRecord);
    } catch {
      return [];
    }
  }

  async readDiagnostics(
    captureSessionId: string,
  ): Promise<NetworkDiagnosticRecord[]> {
    const diagnosticsPath = path.join(
      this.getNetworkDir(captureSessionId),
      "diagnostics.ndjson",
    );
    try {
      const raw = await readFile(diagnosticsPath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NetworkDiagnosticRecord);
    } catch {
      return [];
    }
  }

  async listSessions(opts?: {
    scriptId?: string;
    limit?: number;
  }): Promise<CollectorCaptureSessionRecord[]> {
    const root = this.getSessionsRoot();
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const sessions: CollectorCaptureSessionRecord[] = [];
    for (const name of names) {
      const session = await this.readSession(name);
      if (!session) continue;
      if (opts?.scriptId && session.scriptId !== opts.scriptId) continue;
      sessions.push(session);
    }
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const limit = opts?.limit ?? 50;
    return sessions.slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /**
   * Bounded read-only preview. Rejects path traversal; never returns raw binary as text without limit.
   */
  async readBodyPreview(
    captureSessionId: string,
    relativePath: string,
    maxBytes = 64_000,
  ): Promise<{
    ok: boolean;
    truncated: boolean;
    contentTypeHint: "json" | "text" | "binary";
    preview: string;
    bytes: number;
    error?: string;
  }> {
    const sessionDir = this.getSessionDir(captureSessionId);
    const normalized = relativePath.replace(/\\/g, "/");
    if (
      !normalized ||
      normalized.includes("..") ||
      normalized.startsWith("/") ||
      !normalized.startsWith("network/responses/")
    ) {
      return {
        ok: false,
        truncated: false,
        contentTypeHint: "text",
        preview: "",
        bytes: 0,
        error: "Invalid artifact reference",
      };
    }
    const absolute = path.join(sessionDir, ...normalized.split("/"));
    try {
      const info = await stat(absolute);
      const buf = await readFile(absolute);
      const slice = buf.subarray(0, Math.min(buf.length, Math.max(256, maxBytes)));
      const truncated = buf.length > slice.length;
      const asText = slice.toString("utf8");
      const binary =
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(asText) &&
        !normalized.endsWith(".json");
      if (binary) {
        return {
          ok: true,
          truncated,
          contentTypeHint: "binary",
          preview: `[binary ${info.size} bytes — preview withheld]`,
          bytes: info.size,
        };
      }
      const hint = normalized.endsWith(".json") ? "json" : "text";
      return {
        ok: true,
        truncated,
        contentTypeHint: hint,
        preview: redactPreviewText(asText, maxBytes),
        bytes: info.size,
      };
    } catch (error) {
      return {
        ok: false,
        truncated: false,
        contentTypeHint: "text",
        preview: "",
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
