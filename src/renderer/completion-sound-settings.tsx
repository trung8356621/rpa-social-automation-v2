import React, { useState } from "react";
import { completionSoundEnabled, completionSoundVolume, playCompletionSound, setCompletionSoundEnabled, setCompletionSoundVolume } from "./completion-sound";

export function CompletionSoundSettings() {
  const [enabled, setEnabled] = useState(completionSoundEnabled);
  const [volume, setVolume] = useState(completionSoundVolume);
  return <section className="network-settings-page" aria-label="Completion Sound Settings">
    <h2>Completion Sound</h2>
    <p className="hint">Play a three-beat alert when Auto Match, Auto Scan, or Batch Validation finishes. Cancelled tasks stay silent.</p>
    <label><input type="checkbox" checked={enabled} onChange={event => { const next = event.target.checked; setEnabled(next); setCompletionSoundEnabled(next); }} /> Enable completion sound</label>
    <label>Volume {Math.round(volume * 100)}% <input type="range" min="0" max="100" value={Math.round(volume * 100)} disabled={!enabled} onChange={event => { const next = Number(event.target.value) / 100; setVolume(next); setCompletionSoundVolume(next); }} /></label>
    <div className="popover-footer"><button disabled={!enabled} onClick={() => void playCompletionSound("SUCCESS", `settings-preview-success-${Date.now()}`)}>Preview Success</button><button disabled={!enabled} onClick={() => void playCompletionSound("NEEDS_ATTENTION", `settings-preview-attention-${Date.now()}`)}>Preview Attention</button></div>
  </section>;
}
