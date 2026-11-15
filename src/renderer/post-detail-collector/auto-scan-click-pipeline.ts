import type { PostDetailContainerResult, PostDetailScanFrame, VisualReferenceSample } from "../../shared/post-detail-collector/types";
import { auditVisualReferenceRoles } from "../../shared/post-detail-collector/visual-reference-role";

export type AutoScanDiagnosticStage =
  | "CLICK_RECEIVED"
  | "VALIDATION_PASS"
  | "INPUT_LOCKED"
  | "SCAN_STARTED"
  | "FRAME_CAPTURED"
  | "SCAN_COMPLETED"
  | "SCAN_CANCELLED"
  | "FAILED"
  | "INPUT_UNLOCKED";

export type AutoScanFailureCode =
  | "ALREADY_RUNNING"
  | "BROWSER_CORE_UNAVAILABLE"
  | "NO_REFERENCES"
  | "LEGACY_REFERENCE_ROLE"
  | "DUPLICATE_REFERENCE_ROLE"
  | "MISSING_REFERENCE_ROLE"
  | "POST_PROBE_UNAVAILABLE"
  | "POST_PROBE_REJECTED"
  | "INVALID_SOCIAL_PAGE"
  | "INPUT_LOCK_FAILED"
  | "SCAN_IPC_REJECTED"
  | "UNKNOWN";

export type AutoScanDiagnosticEvent = {
  stage: AutoScanDiagnosticStage;
  at: string;
  failureCode?: AutoScanFailureCode;
  detail?: string;
  frameIndex?: number;
};

export class AutoScanStartError extends Error {
  constructor(public readonly failureCode: AutoScanFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutoScanStartError";
  }
}

export function validateAutoScanStart(input: {
  browserCoreAvailable: boolean;
  alreadyRunning: boolean;
  visualReferences: VisualReferenceSample[];
}): { ok: true } | { ok: false; failureCode: AutoScanFailureCode; message: string } {
  if (input.alreadyRunning) return { ok: false, failureCode: "ALREADY_RUNNING", message: "Auto Scan is already running." };
  if (!input.browserCoreAvailable) return { ok: false, failureCode: "BROWSER_CORE_UNAVAILABLE", message: "BrowserCore/Electron bridge is unavailable." };
  if (!input.visualReferences.length) return { ok: false, failureCode: "NO_REFERENCES", message: "No visual references. Capture Like, Comment, and Share first." };
  const audit = auditVisualReferenceRoles(input.visualReferences);
  if (audit.legacy.length) return { ok: false, failureCode: "LEGACY_REFERENCE_ROLE", message: `${audit.legacy.length} legacy reference(s) have no structured semanticRole. Use Back → Browser & Capture to relabel; recapture is not required.` };
  if (audit.duplicates.length) return { ok: false, failureCode: "DUPLICATE_REFERENCE_ROLE", message: `Duplicate active semantic role(s): ${audit.duplicates.join(", ")}. Keep one active reference per role.` };
  if (audit.missing.length) return { ok: false, failureCode: "MISSING_REFERENCE_ROLE", message: `Missing semantic role(s): ${audit.missing.join(", ")}. Relabel or capture the missing role(s).` };
  return { ok: true };
}

type ScanResult = { runId: string; frames: PostDetailScanFrame[]; container: PostDetailContainerResult };

export async function runAutoScanClickPipeline(input: {
  browserCoreAvailable: boolean;
  alreadyRunning: boolean;
  visualReferences: VisualReferenceSample[];
  probe: () => Promise<{ url?: string } | null>;
  assertSocialPage: (url: string) => void;
  fallbackUrl: string;
  publishHost: () => void;
  setInputLock: (locked: boolean) => Promise<{ ok: boolean; locked: boolean }>;
  runScan: (onFrame: (frame: PostDetailScanFrame, frames: PostDetailScanFrame[]) => void) => Promise<ScanResult>;
  onFrame: (frame: PostDetailScanFrame, frames: PostDetailScanFrame[]) => void;
  isCancelled: () => boolean;
  onDiagnostic: (event: AutoScanDiagnosticEvent) => void;
}): Promise<ScanResult> {
  const emit = (stage: AutoScanDiagnosticStage, extra: Omit<AutoScanDiagnosticEvent, "stage" | "at"> = {}) => {
    const event = { stage, at: new Date().toISOString(), ...extra };
    input.onDiagnostic(event);
    console.info("[PDC AutoScan]", JSON.stringify(event));
  };
  emit("CLICK_RECEIVED");
  const gate = validateAutoScanStart(input);
  if (!gate.ok) {
    emit("FAILED", { failureCode: gate.failureCode, detail: gate.message });
    throw new AutoScanStartError(gate.failureCode, gate.message);
  }
  emit("VALIDATION_PASS", { detail: "LIKE, COMMENT, SHARE structured roles are unique." });

  let lockAttempted = false;
  try {
    let probe: { url?: string } | null;
    try { probe = await input.probe(); }
    catch (error) { throw new AutoScanStartError("POST_PROBE_REJECTED", error instanceof Error ? error.message : String(error), { cause: error }); }
    if (!probe) throw new AutoScanStartError("POST_PROBE_UNAVAILABLE", "BrowserCore post probe is unavailable.");
    try { input.assertSocialPage(probe.url || input.fallbackUrl); }
    catch (error) { throw new AutoScanStartError("INVALID_SOCIAL_PAGE", error instanceof Error ? error.message : String(error), { cause: error }); }
    input.publishHost();
    lockAttempted = true;
    let lock: { ok: boolean; locked: boolean };
    try { lock = await input.setInputLock(true); }
    catch (error) { throw new AutoScanStartError("INPUT_LOCK_FAILED", error instanceof Error ? error.message : String(error), { cause: error }); }
    if (!lock.ok || !lock.locked) throw new AutoScanStartError("INPUT_LOCK_FAILED", "BrowserCore input lock was not acquired.");
    emit("INPUT_LOCKED");
    emit("SCAN_STARTED");
    const result = await input.runScan((frame, frames) => {
      emit("FRAME_CAPTURED", { frameIndex: frame.frameIndex, detail: `anchors=${frame.anchors.length}` });
      input.onFrame(frame, frames);
    });
    if (input.isCancelled()) emit("SCAN_CANCELLED", { detail: `frames=${result.frames.length}` });
    else emit("SCAN_COMPLETED", { detail: `frames=${result.frames.length}; status=${result.container.status}` });
    return result;
  } catch (error) {
    const failureCode = error instanceof AutoScanStartError ? error.failureCode : "SCAN_IPC_REJECTED";
    emit("FAILED", { failureCode, detail: error instanceof Error ? error.message : String(error) });
    throw error instanceof AutoScanStartError ? error : new AutoScanStartError("SCAN_IPC_REJECTED", error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    if (lockAttempted) {
      try {
        await input.setInputLock(false);
        emit("INPUT_UNLOCKED");
      } catch (error) {
        emit("FAILED", { failureCode: "UNKNOWN", detail: `Input unlock failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
}
