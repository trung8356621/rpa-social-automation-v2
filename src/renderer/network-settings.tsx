import React, { useState } from "react";
import type { Command, State } from "../shared/contracts";
import { defaultNetworkSettings, NETWORK_LABELS, NETWORK_MODES, MAX_NETWORK_DELAY_MS,
  validateNetworkSettings, type NetworkSettings as Settings } from "../shared/network-mode";
import { UiPopover } from "./ui-popover";

export function NetworkSettings({ state, locked, update }: {
  state?: State; locked: boolean; update: (command: Command) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Settings>(defaultNetworkSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saved = state?.networkSettings ?? defaultNetworkSettings();
  const delays = saved.presets[saved.mode];
  const current = draft.presets[draft.mode];
  const close = () => { if (!saving) setOpen(false); };
  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      validateNetworkSettings(draft);
      await update({ type: "setNetworkSettings", settings: draft });
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  }
  return <div className="network-settings-control">
    <button disabled={locked || !state} onClick={() => {
      setDraft(structuredClone(saved)); setError(""); setOpen(true);
    }}>Settings · {NETWORK_LABELS[saved.mode]}</button>
    <small>Step {delays.stepDelayMs}ms · Sleep {delays.sleepDelayMs}ms</small>
    {open && <UiPopover variant="modal" label="Settings" className="network-settings-modal" close={close}>
      <div className="popover-heading"><b>Settings · Network Mode</b>
        <button className="icon-button" aria-label="Đóng Settings" disabled={saving} onClick={close}>×</button>
      </div>
      <label>Network Mode
        <select aria-label="Network Mode" disabled={saving} value={draft.mode}
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
              <input type="number" min={0} max={MAX_NETWORK_DELAY_MS} step={1} disabled={saving}
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
      <p className="hint">Bấm Lưu Settings để áp dụng thay đổi hoặc khôi phục mặc định.</p>
      <div className="popover-footer">
        <button disabled={saving} onClick={() => { setDraft(defaultNetworkSettings()); setError(""); }}>Khôi phục mặc định</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>Lưu Settings</button>
        <button disabled={saving} onClick={close}>Đóng</button>
      </div>
    </UiPopover>}
  </div>;
}
