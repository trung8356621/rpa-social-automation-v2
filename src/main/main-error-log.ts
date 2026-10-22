import { appendFileSync } from "node:fs";
import path from "node:path";

/** Main-process diagnostics are also persisted; Facebook DevTools only shows renderer logs. */
export function logMainError(directory: string, scope: string, error: unknown,
  context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const validation =
    /Match To|không hợp lệ|Invalid Step|Variable|xác nhận|OCR/i.test(message);
  const entry = {
    at: new Date().toISOString(),
    scope,
    ...context,
    error: error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          ...(validation ? {} : { stack: error.stack }),
        }
      : { message },
  };
  if (validation) console.error(`[Creator ${scope}] ${message}`);
  else console.error(`[Creator ${scope}]`, entry);
  try {
    appendFileSync(path.join(directory, "creator-errors.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (logError) {
    console.error("[Creator diagnostics write failed]", logError);
  }
}

export function logMainEvent(directory: string, scope: string, context: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), scope, ...context };
  console.info(`[Creator ${scope}]`, scope === "ocr-raw" ? JSON.stringify(entry) : entry);
  try { appendFileSync(path.join(directory, "creator-execution.jsonl"), JSON.stringify(entry) + "\n", "utf8"); }
  catch (error) { console.error("[Creator execution log write failed]", error); }
}

export function logTestBoundary(directory: string, phase: "START" | "END", scope: {
  runId: string; batchRunId?: string; label: string; status?: string; ocrPasses?: number; scrolls?: number;
}) {
  const at = new Date().toISOString();
  const line = phase === "START"
    ? `========== RPA TEST START | ${at} | ${scope.label} | runId ${scope.runId}${scope.batchRunId ? ` | batchRunId ${scope.batchRunId}` : ""} ==========`
    : `========== RPA TEST END | Status ${scope.status} | OCR ${scope.ocrPasses ?? 0} | Scroll ${scope.scrolls ?? 0} | runId ${scope.runId} | ${scope.label} ==========`;
  console.info(line);
  try { appendFileSync(path.join(directory,"creator-tests.log"), line + "\n", "utf8"); }
  catch (error) { console.error("[Creator test boundary log write failed]", error); }
  logMainEvent(directory, `test-${phase.toLowerCase()}`, { at, ...scope });
}
