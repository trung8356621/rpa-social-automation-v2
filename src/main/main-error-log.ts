import { appendFileSync } from "node:fs";
import path from "node:path";

/** Main-process diagnostics are also persisted; Facebook DevTools only shows renderer logs. */
export function logMainError(directory: string, scope: string, error: unknown,
  context: Record<string, unknown> = {}) {
  const entry = { at: new Date().toISOString(), scope, ...context,
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) } };
  console.error(`[Creator ${scope}]`, entry);
  try {
    appendFileSync(path.join(directory, "creator-errors.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (logError) {
    console.error("[Creator diagnostics write failed]", logError);
  }
}

export function logMainEvent(directory: string, scope: string, context: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), scope, ...context };
  console.info(`[Creator ${scope}]`, entry);
  try { appendFileSync(path.join(directory, "creator-execution.jsonl"), JSON.stringify(entry) + "\n", "utf8"); }
  catch (error) { console.error("[Creator execution log write failed]", error); }
}
