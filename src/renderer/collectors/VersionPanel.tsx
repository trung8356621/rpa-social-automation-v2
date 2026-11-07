import React, { useState } from "react";
import { UiPopover } from "../ui-popover";
import {
  markVersionActive,
  revertDraftToVersion,
} from "../../shared/collectors/ops";
import type { CollectorDraft } from "../../shared/collectors/types";

type Props = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
  onSave: () => void;
  onClose?: () => void;
};

export function VersionPanel({ draft, locked, onChange, onSave, onClose }: Props) {
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [revertId, setRevertId] = useState<string>();

  const left = draft.versions.find((v) => v.id === compareA);
  const right = draft.versions.find((v) => v.id === compareB);

  return (
    <div className="collector-version-panel" role="complementary" aria-label="Collector versions">
      <div className="collector-version-panel-head">
        <h3>Versions</h3>
        {onClose && (
          <button type="button" className="icon-button" aria-label="Close Versions" onClick={onClose}>×</button>
        )}
      </div>
      <p className="hint">
        Save creates an immutable snapshot (auto-labeled vN). No mandatory label.
        Stack is unbounded in this prototype — older versions are kept for inspect/restore.
      </p>
      <div className="collector-row-actions">
        <button className="primary" disabled={locked} onClick={onSave}>Save</button>
      </div>
      <div className="collector-version-list">
        {!draft.versions.length && <p className="hint">No versions yet — Save to create the first snapshot.</p>}
        {draft.versions.slice().reverse().map((version) => (
          <div className="collector-version-item" key={version.id}>
            <div>
              <b>{version.label}</b>
              {version.active && <span className="script-badge badge-active">Active</span>}
              <small>{new Date(version.createdAt).toLocaleString()}</small>
            </div>
            <small className="mono">
              captures {(version.captures ?? []).length}
              {" · "}
              confirmed {(version.captureAudits ?? []).filter((a) => a.status === "confirmed").length}
            </small>
            <div className="collector-row-actions">
              <button
                disabled={locked || version.active}
                onClick={() => onChange(markVersionActive(draft, version.id))}
              >
                {version.active ? "Active" : "Mark Active"}
              </button>
              <button disabled={locked} onClick={() => setRevertId(version.id)}>
                Restore…
              </button>
            </div>
          </div>
        ))}
      </div>
      {draft.versions.length >= 2 && (
        <div className="collector-version-compare">
          <h4>Compare metadata</h4>
          <label>
            A
            <select disabled={locked} value={compareA} onChange={(e) => setCompareA(e.target.value)}>
              <option value="">—</option>
              {draft.versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          <label>
            B
            <select disabled={locked} value={compareB} onChange={(e) => setCompareB(e.target.value)}>
              <option value="">—</option>
              {draft.versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          {left && right && (
            <pre>{JSON.stringify({
              a: {
                label: left.label,
                strategy: left.strategy,
                variables: left.variables.length,
                captures: (left.captures ?? []).length,
                audits: left.captureAudits,
                wizardStep: left.wizardStep,
              },
              b: {
                label: right.label,
                strategy: right.strategy,
                variables: right.variables.length,
                captures: (right.captures ?? []).length,
                audits: right.captureAudits,
                wizardStep: right.wizardStep,
              },
            }, null, 2)}</pre>
          )}
        </div>
      )}
      {revertId && (
        <UiPopover variant="modal" label="Restore draft" className="unsaved-confirm" close={() => setRevertId(undefined)}>
          <div className="popover-heading">
            <b>Restore draft to version?</b>
            <button onClick={() => setRevertId(undefined)}>×</button>
          </div>
          <p>Draft will be overwritten by the selected snapshot. Snapshot stays immutable. Validation becomes outdated.</p>
          <div className="popover-footer">
            <button onClick={() => setRevertId(undefined)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                const next = revertDraftToVersion(draft, revertId);
                if (next) onChange(next);
                setRevertId(undefined);
              }}
            >
              Restore draft
            </button>
          </div>
        </UiPopover>
      )}
    </div>
  );
}
