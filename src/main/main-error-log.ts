import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|credential/i;

let activeLogFile: string | undefined;
let activeMaxBytes = DEFAULT_MAX_BYTES;
let limitReported = false;

function timestampName(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "");
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string")
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(password|passwd|token|secret)=([^\s&]+)/gi, "$1=[REDACTED]");
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
  ]));
}

function append(entry: Record<string, unknown>) {
  if (!activeLogFile) return;
  try {
    const line = JSON.stringify(redact(entry)) + "\n";
    const size = statSync(activeLogFile).size;
    if (size + Buffer.byteLength(line) > activeMaxBytes) {
      if (!limitReported) {
        limitReported = true;
        const notice = JSON.stringify({ at: new Date().toISOString(), scope: "logger", message: "LOG_SIZE_LIMIT_REACHED" }) + "\n";
        if (size + Buffer.byteLength(notice) <= activeMaxBytes)
          appendFileSync(activeLogFile, notice, "utf8");
      }
      return;
    }
    appendFileSync(activeLogFile, line, "utf8");
  } catch (error) {
    console.error("[Creator diagnostics write failed]", error instanceof Error ? error.message : String(error));
  }
}

export function initializeMainFileLogging(
  directory: string,
  options: { maxFiles?: number; maxBytes?: number; now?: Date } = {},
) {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  activeMaxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  limitReported = false;
  mkdirSync(directory, { recursive: true });
  const base = `rpa-${timestampName(options.now ?? new Date())}`;
  let candidate = path.join(directory, `${base}.log`);
  for (let suffix = 1; ; suffix++) {
    try {
      const handle = openSync(candidate, "wx");
      closeSync(handle);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidate = path.join(directory, `${base}-${suffix}.log`);
    }
  }
  activeLogFile = candidate;
  append({ at: new Date().toISOString(), scope: "startup", pid: process.pid, message: "RPA_START" });
  try {
    const old = readdirSync(directory)
      .filter((name) => /^rpa-.*\.log$/.test(name) && path.join(directory, name) !== candidate)
      .map((name) => ({ path: path.join(directory, name), mtime: statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of old.slice(maxFiles - 1)) unlinkSync(item.path);
  } catch (error) {
    console.error("[Creator log retention failed]", error instanceof Error ? error.message : String(error));
  }
  return candidate;
}

export function resetMainFileLoggingForTest() {
  activeLogFile = undefined;
  activeMaxBytes = DEFAULT_MAX_BYTES;
  limitReported = false;
}

/** Main-process diagnostics are persisted in the per-start log file. */
export function logMainError(_directory: string, scope: string, error: unknown,
  context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const validation = /Match To|không hợp lệ|Invalid Step|Variable|xác nhận|OCR/i.test(message);
  const entry = {
    at: new Date().toISOString(),
    level: "error",
    scope,
    ...context,
    error: error instanceof Error
      ? { name: error.name, message: error.message, ...(validation ? {} : { stack: error.stack }) }
      : { message },
  };
  console.error(`[Creator ${scope}] ${message}`);
  append(entry);
}

export function logMainEvent(_directory: string, scope: string, context: Record<string, unknown>) {
  append({ at: new Date().toISOString(), level: "info", scope, ...context });
}

export function logTestBoundary(directory: string, phase: "START" | "END", scope: {
  runId: string; batchRunId?: string; label: string; status?: string; ocrPasses?: number; scrolls?: number;
}) {
  const at = new Date().toISOString();
  const line = phase === "START"
    ? `RPA TEST START | ${scope.label} | runId ${scope.runId}${scope.batchRunId ? ` | batchRunId ${scope.batchRunId}` : ""}`
    : `RPA TEST END | ${scope.status} | OCR ${scope.ocrPasses ?? 0} | Scroll ${scope.scrolls ?? 0} | runId ${scope.runId}`;
  console.info(line);
  logMainEvent(directory, `test-${phase.toLowerCase()}`, { at, ...scope });
}
