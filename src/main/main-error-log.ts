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

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const APP_MAX_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|credential/i;

let logDirectory: string | undefined;
let applicationLogFile: string | undefined;
let maxFiles = DEFAULT_MAX_FILES;
let testMaxBytes = DEFAULT_MAX_BYTES;
const testLogs = new Map<string, string>();
const limitedFiles = new Set<string>();

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

function append(file: string | undefined, entry: Record<string, unknown>, sizeLimit: number) {
  if (!file) return;
  try {
    const line = JSON.stringify(redact(entry)) + "\n";
    const size = statSync(file).size;
    if (size + Buffer.byteLength(line) > sizeLimit) {
      if (!limitedFiles.has(file)) {
        limitedFiles.add(file);
        const notice = JSON.stringify({ at: new Date().toISOString(), scope: "logger", message: "LOG_SIZE_LIMIT_REACHED" }) + "\n";
        if (size + Buffer.byteLength(notice) <= sizeLimit)
          appendFileSync(file, notice, "utf8");
      }
      return;
    }
    appendFileSync(file, line, "utf8");
  } catch (error) {
    console.error("[Creator diagnostics write failed]", error instanceof Error ? error.message : String(error));
  }
}

function uniqueLog(prefix: "app" | "test", correlationId?: string, now = new Date()) {
  if (!logDirectory) throw new Error("File logging is not initialized.");
  const safeId = correlationId?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  const base = [prefix, timestampName(now), safeId].filter(Boolean).join("-");
  let candidate = path.join(logDirectory, `${base}.log`);
  for (let suffix = 1; ; suffix++) {
    try {
      const handle = openSync(candidate, "wx");
      closeSync(handle);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidate = path.join(logDirectory, `${base}-${suffix}.log`);
    }
  }
}

function rotateLogs(current: string) {
  if (!logDirectory) return;
  try {
    const old = readdirSync(logDirectory)
      .filter((name) => /^(?:app|test)-.*\.log$/.test(name) && path.join(logDirectory!, name) !== current)
      .map((name) => ({ path: path.join(logDirectory!, name), mtime: statSync(path.join(logDirectory!, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of old.slice(maxFiles - 1)) {
      if (item.path !== applicationLogFile && ![...testLogs.values()].includes(item.path)) unlinkSync(item.path);
    }
  } catch (error) {
    console.error("[Creator log retention failed]", error instanceof Error ? error.message : String(error));
  }
}

function correlation(entry: Record<string, unknown>) {
  for (const key of ["batchRunId", "testRunId", "runId"]) {
    const value = entry[key];
    if (typeof value === "string" && testLogs.has(value)) return value;
  }
}

export function initializeMainFileLogging(
  directory: string,
  options: { maxFiles?: number; maxBytes?: number; now?: Date } = {},
) {
  logDirectory = directory;
  maxFiles = Math.max(2, options.maxFiles ?? DEFAULT_MAX_FILES);
  testMaxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  mkdirSync(directory, { recursive: true });
  applicationLogFile = uniqueLog("app", undefined, options.now);
  append(applicationLogFile, {
    at: new Date().toISOString(),
    scope: "startup",
    pid: process.pid,
    message: "RPA_START",
  }, APP_MAX_BYTES);
  rotateLogs(applicationLogFile);
  return applicationLogFile;
}

export function beginTestRunLog(correlationId: string, label: string, now = new Date()) {
  if (!logDirectory || !correlationId) return;
  if (testLogs.has(correlationId)) return testLogs.get(correlationId);
  try {
    const file = uniqueLog("test", correlationId, now);
    testLogs.set(correlationId, file);
    append(file, {
      at: new Date().toISOString(),
      level: "info",
      scope: "test-log-open",
      runId: correlationId,
      label,
    }, testMaxBytes);
    rotateLogs(file);
    console.info(`[Creator] Test log: ${file}`);
    return file;
  } catch (error) {
    console.error("[Creator test log unavailable]", error instanceof Error ? error.message : String(error));
    return;
  }
}

export function endTestRunLog(correlationId: string) {
  testLogs.delete(correlationId);
}

export function resetMainFileLoggingForTest() {
  logDirectory = undefined;
  applicationLogFile = undefined;
  maxFiles = DEFAULT_MAX_FILES;
  testMaxBytes = DEFAULT_MAX_BYTES;
  testLogs.clear();
  limitedFiles.clear();
}

function write(entry: Record<string, unknown>) {
  const id = correlation(entry);
  append(id ? testLogs.get(id) : applicationLogFile, entry, id ? testMaxBytes : APP_MAX_BYTES);
}

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
  write(entry);
}

export function logMainEvent(_directory: string, scope: string, context: Record<string, unknown>) {
  write({ at: new Date().toISOString(), level: "info", scope, ...context });
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
