import React, { useState } from "react";
import { completionSoundEnabled, playCompletionSound, setCompletionSoundEnabled } from "./completion-sound";

export function CompletionSoundSettings() {
  const [enabled, setEnabled] = useState(completionSoundEnabled);
  return <section className="network-settings-page" aria-label="Completion Sound Settings">
    <h2>Completion Sound</h2>
    <p className="hint">Play one short sound when Auto Match, Auto Scan, or Batch Validation finishes. Cancelled tasks stay silent.</p>
    <label><input type="checkbox" checked={enabled} onChange={event => { const next = event.target.checked; setEnabled(next); setCompletionSoundEnabled(next); }} /> Enable completion sound</label>
    <div className="popover-footer"><button disabled={!enabled} onClick={() => void playCompletionSound("SUCCESS", `settings-preview-${Date.now()}`)}>Test sound</button></div>
  </section>;
}
