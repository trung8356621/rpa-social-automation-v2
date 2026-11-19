/**
 * Ephemeral session pointer for which Collector Script the Workspace is bound to.
 * Not Script configuration — config lives in PartLibraryRepository.
 */
export const ACTIVE_COLLECTOR_SCRIPT_SESSION_KEY = "rpa.collector-scripts.activeScriptId";

export function getActiveCollectorScriptId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_COLLECTOR_SCRIPT_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setActiveCollectorScriptId(scriptId: string | null): void {
  try {
    if (!scriptId) sessionStorage.removeItem(ACTIVE_COLLECTOR_SCRIPT_SESSION_KEY);
    else sessionStorage.setItem(ACTIVE_COLLECTOR_SCRIPT_SESSION_KEY, scriptId);
  } catch {
    /* ignore */
  }
}
