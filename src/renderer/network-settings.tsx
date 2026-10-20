import React, { useState } from "react";
import type { Command, State } from "../shared/contracts";
import { defaultNetworkSettings, NETWORK_LABELS, NETWORK_MODES, MAX_NETWORK_DELAY_MS,
  validateNetworkSettings, type NetworkSettings as Settings } from "../shared/network-mode";

export function NetworkSettings({ state, locked, update }: {
  state?: State; locked: boolean; update: (command: Command) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(state?.networkSettings ?? defaultNetworkSettings()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saved = state?.networkSettings ?? defaultNetworkSettings();
  const delays = saved.presets[saved.mode];
  const current = draft.presets[draft.mode];
  async function save() {
    if (saving || locked) return;
    setSaving(true);
    setError("");
    try {
      validateNetworkSettings(draft);
      await update({ type: "setNetworkSettings", settings: draft });
      setNotice("Đã lưu Settings.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  }
  return <section className="network-settings-page" aria-label="Network Mode Settings">
      <h2>Network Mode</h2>
      <p className="hint">Đang áp dụng: {NETWORK_LABELS[saved.mode]} · Step {delays.stepDelayMs}ms · Sleep {delays.sleepDelayMs}ms</p>
      <label>Network Mode
        <select aria-label="Network Mode" disabled={saving || locked} value={draft.mode}
          onChange={event => setDraft({ ...draft, mode: event.target.value as Settings["mode"] })}>
          {NETWORK_MODES.map(mode => <option key={mode} value={mode}>{NETWORK_LABELS[mode]}</option>)}
        </select>
      </label>
      <p>Step Delay: {Number.isFinite(current.stepDelayMs) ? current.stepDelayMs : "—"}ms · Sleep Delay: {Number.isFinite(current.sleepDelayMs) ? current.sleepDelayMs : "—"}ms</p>
      <p className="hint">Step Delay là thời gian giữa các Step trong Play All. Sleep Delay là thời gian chờ của Action SLEEP. Cấu hình lưu riêng trên máy này và áp dụng từ lượt chạy tiếp theo.</p>
      <details><summary>Nâng cao · chỉnh thời gian chờ</summary>
        <table className="network-presets"><thead><tr><th>Mode</th><th>Step Delay (ms)</th><th>Sleep Delay (ms)</th></tr></thead>
          <tbody>{NETWORK_MODES.map(mode => <tr key={mode}><th>{NETWORK_LABELS[mode]}</th>
            {(["stepDelayMs", "sleepDelayMs"] as const).map(field => <td key={field}>
              <input type="number" min={0} max={MAX_NETWORK_DELAY_MS} step={1} disabled={saving || locked}
                aria-label={`${NETWORK_LABELS[mode]} ${field === "stepDelayMs" ? "Step Delay" : "Sleep Delay"}`}
                value={Number.isFinite(draft.presets[mode][field]) ? draft.presets[mode][field] : ""}
                onChange={event => setDraft({ ...draft, presets: { ...draft.presets,
                  [mode]: { ...draft.presets[mode], [field]: event.target.value === "" ? Number.NaN : Number(event.target.value) },
                } })} />
            </td>)}
          </tr>)}</tbody>
        </table>
        <p className="hint">Số nguyên từ 0–{MAX_NETWORK_DELAY_MS}ms cho mỗi delay.</p>
      </details>
      {error && <p role="alert">{error}</p>}
      {notice && !error && <p role="status">{notice}</p>}
      <p className="hint">Bấm Lưu Settings để áp dụng thay đổi hoặc khôi phục mặc định.</p>
      <div className="popover-footer">
        <button disabled={saving || locked} onClick={() => { setDraft(defaultNetworkSettings()); setError(""); setNotice(""); }}>Khôi phục mặc định</button>
        <button className="primary" disabled={saving || locked} onClick={() => void save()}>Lưu Settings</button>
      </div>
  </section>;
}
