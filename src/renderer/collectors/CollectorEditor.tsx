import React, { useEffect, useMemo, useState } from "react";
import { WIZARD_STEPS, saveAsVersion, stepValidationErrors } from "../../shared/collectors/ops";
import type { CollectorDraft, WizardStepId } from "../../shared/collectors/types";
import type { State } from "../../shared/contracts";
import { VersionPanel } from "./VersionPanel";
import { StepCaptureSamples } from "./CaptureStep";
import { StepReviewMapping } from "./ReviewMappingStep";
import { StepMatchTest } from "./MatchTestStep";
import { StepDiscovery, StepValidation } from "./wizard-steps";
import type { CollectorInvoke } from "./browser-capture";

export type CollectorEditorHandle = {
  dirty: boolean;
  name: string;
  save: () => Promise<void>;
  discard: () => void;
};

export function validateCollectorDraft(draft: CollectorDraft): string[] {
  const errors: string[] = [];
  if (!draft.name || !draft.name.trim()) {
    errors.push("Collector Name is required.");
  }
  if (draft.variables?.some((v) => !v.key.trim())) {
    errors.push("Every Variable needs a stable key.");
  }
  const keys = draft.variables?.map((v) => v.key.trim()) ?? [];
  if (new Set(keys).size !== keys.length) {
    errors.push("Variable keys must be unique.");
  }
  return errors;
}

type Props = {
  initial: CollectorDraft;
  locked: boolean;
  classifications: string[];
  storageWarnings?: string[];
  onSave: (draft: CollectorDraft) => void;
  onClose: () => void;
  onAddClassification: (label: string) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
  report?: (handle: CollectorEditorHandle | undefined) => void;
};

const DISMISSED_WARNINGS_KEY = "rpa.collectors.dismissedWarnings";

function getDismissedWarningKeys(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_WARNINGS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function recordDismissedWarningKey(key: string): void {
  try {
    const set = getDismissedWarningKeys();
    set.add(key);
    sessionStorage.setItem(DISMISSED_WARNINGS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    /* ignore */
  }
}

function useVersionsDrawerMode() {
  const [drawer, setDrawer] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const sync = () => setDrawer(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return drawer;
}

export function CollectorEditor({
  initial,
  locked,
  classifications: _classifications,
  storageWarnings = [],
  onSave,
  onClose,
  onAddClassification: _onAddClassification,
  invoke,
  state,
  onSelectSession,
  report,
}: Props) {
  const [draft, setDraft] = useState<CollectorDraft>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(() => getDismissedWarningKeys());
  const drawerMode = useVersionsDrawerMode();
  const currentStep = useMemo(
    () => WIZARD_STEPS.find((s) => s.id === draft.wizardStep) ?? WIZARD_STEPS[0]!,
    [draft.wizardStep],
  );
  const metaLabel = [
    draft.platformLabel || "platform unset",
    draft.classification || "classification unset",
    draft.strategy || "strategy unset",
  ].join(" · ");

  useEffect(() => {
    setDraft({
      ...initial,
      captures: initial.captures ?? [],
      captureAudits: initial.captureAudits ?? [],
      schemaRevision: initial.schemaRevision ?? 1,
      variants: initial.variants ?? [],
      auditActions: initial.auditActions ?? [],
    });
  }, [initial.id]);

  useEffect(() => {
    if (draft.wizardStep === 1 || draft.wizardStep === 2 || draft.wizardStep === 3 || drawerMode) setVersionsOpen(false);
    else setVersionsOpen(true);
  }, [drawerMode, draft.wizardStep]);

  function patch(next: CollectorDraft) {
    setDraft(next);
    setErrors([]);
  }

  function goto(step: WizardStepId, validateCurrent = false) {
    if (validateCurrent && step > draft.wizardStep) {
      const currentErrors = stepValidationErrors(draft, draft.wizardStep);
      if (currentErrors.length) {
        setErrors(currentErrors);
        return;
      }
    }
    setErrors([]);
    setDraft((d) => ({ ...d, wizardStep: step, dirty: true }));
  }

  function performSave(closeAfter = false): boolean {
    const validationErrors = validateCollectorDraft(draft);
    if (validationErrors.length) {
      setErrors(validationErrors);
      return false;
    }
    const next = saveAsVersion(draft);
    setDraft(next);
    onSave(next);
    setSavedFlash(`Saved ${next.versions[next.versions.length - 1]?.label ?? "version"}`);
    setTimeout(() => setSavedFlash(""), 2000);
    if (closeAfter) {
      onClose();
    }
    return true;
  }

  function save() {
    performSave(false);
  }

  function saveAndClose() {
    performSave(true);
  }

  useEffect(() => {
    if (!report) return;
    report({
      dirty: Boolean(draft.dirty),
      name: draft.name,
      save: async () => {
        const validationErrors = validateCollectorDraft(draft);
        if (validationErrors.length) {
          setErrors(validationErrors);
          throw new Error(validationErrors.join("; "));
        }
        const next = saveAsVersion(draft);
        setDraft(next);
        onSave(next);
      },
      discard: () => {
        setDraft(initial);
      },
    });
    return () => report(undefined);
  }, [report, draft, onSave, initial]);

  // Filter warnings relevant to this collector or general storage failures
  const relevantWarnings = useMemo(() => {
    return storageWarnings.filter((w) => {
      // General corruption or storage error applies to all
      if (!w.startsWith("Migrated collector")) return true;
      // Migration warning applies only to the named collector
      const match = w.match(/^Migrated collector "([^"]+)"/);
      if (!match) return true;
      const targetName = match[1];
      return targetName === draft.name || targetName === initial.name;
    });
  }, [storageWarnings, draft.name, initial.name]);

  const activeWarnings = useMemo(() => {
    return relevantWarnings.filter((w) => !dismissedWarnings.has(w));
  }, [relevantWarnings, dismissedWarnings]);

  function dismissWarnings() {
    for (const w of activeWarnings) {
      recordDismissedWarningKey(w);
    }
    setDismissedWarnings((prev) => new Set([...prev, ...activeWarnings]));
  }

  const versionsPanel = (
    <VersionPanel
      draft={draft}
      locked={locked}
      onChange={patch}
      onSave={save}
      onClose={drawerMode ? () => setVersionsOpen(false) : undefined}
    />
  );

  const showStorageWarn = activeWarnings.length > 0;

  return (
    <section
      className={`collector-editor${versionsOpen ? " versions-open" : " versions-closed"}${drawerMode ? " versions-drawer-mode" : ""}`}
      aria-label="Collector Rule Editor"
      data-versions-open={versionsOpen ? "true" : "false"}
    >
      <div className="collector-editor-chrome">
        {showStorageWarn && (
          <div className="collector-banner warn collector-banner-compact" role="status">
            <span className="collector-banner-text" title={activeWarnings.join(" · ")}>
              Storage: {activeWarnings[0]}
              {activeWarnings.length > 1 ? ` (+${activeWarnings.length - 1})` : ""}
            </span>
            <button type="button" className="collector-banner-dismiss" onClick={dismissWarnings}>
              Dismiss
            </button>
          </div>
        )}

        <div className="collector-editor-row1">
          <button
            type="button"
            className="collector-back-btn"
            disabled={locked}
            onClick={onClose}
            aria-label="Back to Collectors"
            title="Back to Collectors"
          >
            ←
          </button>
          <h1 className="collector-editor-name" title={draft.name}>
            {draft.name}
            {draft.dirty ? " ●" : ""}
          </h1>
          <span className="collector-current-step" aria-live="polite">
            {currentStep.id}. {currentStep.short}
          </span>
          <details className="collector-meta-details">
            <summary title={metaLabel}>Details</summary>
            <div className="collector-meta-popover">
              <div><small>Platform</small><b>{draft.platformLabel || "unset"}</b></div>
              <div><small>Classification</small><b>{draft.classification || "unset"}</b></div>
              <div><small>Strategy</small><b>{draft.strategy || "unset"}</b></div>
              <div><small>Mode</small><b>Prototype wizard</b></div>
            </div>
          </details>
          <div className="collector-editor-actions">
            <button
              type="button"
              disabled={locked}
              aria-expanded={versionsOpen}
              aria-controls="collector-versions-panel"
              onClick={() => setVersionsOpen((v) => !v)}
            >
              {versionsOpen ? "Hide Versions" : "Versions"}
            </button>
            <button className="primary" disabled={locked} onClick={save}>Save</button>
            <button
              type="button"
              disabled={locked}
              onClick={saveAndClose}
              title="Save version and return to library"
            >
              Save &amp; Close
            </button>
            {savedFlash && <small role="status">{savedFlash}</small>}
          </div>
        </div>

        <ol className="collector-wizard-progress" aria-label="Wizard progress">
          {WIZARD_STEPS.map((step) => (
            <li key={step.id}>
              <button
                type="button"
                disabled={locked}
                aria-current={draft.wizardStep === step.id ? "step" : undefined}
                className={draft.wizardStep === step.id ? "active" : draft.wizardStep > step.id ? "done" : ""}
                onClick={() => goto(step.id)}
              >
                <span>{step.id}</span>
                {step.short}
              </button>
            </li>
          ))}
        </ol>

        {!!errors.length && (
          <div className="collector-banner warn collector-banner-compact" role="alert">
            <span className="collector-banner-text">{errors.join(" · ")}</span>
          </div>
        )}
      </div>

      <div className="collector-editor-body">
        <div className="collector-wizard-main">
          <div className="collector-wizard-stage">
            {draft.wizardStep === 1 && (
              <StepCaptureSamples
                draft={draft}
                locked={locked}
                onChange={patch}
                invoke={invoke}
                state={state}
                onSelectSession={onSelectSession}
              />
            )}
            {draft.wizardStep === 2 && (
              <StepReviewMapping
                draft={draft}
                locked={locked}
                onChange={patch}
                invoke={invoke}
              />
            )}
            {draft.wizardStep === 3 && (
              <StepMatchTest
                draft={draft}
                locked={locked}
                onChange={patch}
                invoke={invoke}
                state={state}
                onSelectSession={onSelectSession}
              />
            )}
            {draft.wizardStep === 4 && <StepDiscovery draft={draft} locked={locked} onChange={patch} />}
            {draft.wizardStep === 5 && (
              <StepValidation
                draft={draft}
                locked={locked}
                onChange={patch}
                onGotoStep={(step) => goto(step)}
              />
            )}
          </div>
          <div className="collector-wizard-nav">
            <button
              type="button"
              disabled={locked || draft.wizardStep === 1}
              onClick={() => goto((draft.wizardStep - 1) as WizardStepId)}
            >
              Back
            </button>
            <button type="button" className="primary" disabled={locked} onClick={save}>Save</button>
            <button
              type="button"
              disabled={locked}
              onClick={saveAndClose}
              title="Save version and return to library"
            >
              Save &amp; Close
            </button>
            <button
              type="button"
              disabled={locked || draft.wizardStep === 5}
              className="primary"
              onClick={() => goto((draft.wizardStep + 1) as WizardStepId, true)}
            >
              Next
            </button>
          </div>
        </div>

        {!drawerMode && versionsOpen && (
          <div id="collector-versions-panel" className="collector-versions-slot">
            {versionsPanel}
          </div>
        )}
      </div>

      {drawerMode && versionsOpen && (
        <div className="collector-versions-drawer-layer" role="presentation">
          <button
            type="button"
            className="collector-versions-backdrop"
            aria-label="Close Versions"
            onClick={() => setVersionsOpen(false)}
          />
          <div id="collector-versions-panel" className="collector-versions-drawer" role="dialog" aria-modal="true" aria-label="Collector versions">
            {versionsPanel}
          </div>
        </div>
      )}
    </section>
  );
}
