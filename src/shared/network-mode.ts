export const NETWORK_MODES = ["fast", "normal", "slow", "very-slow"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
export const NETWORK_LABELS: Record<NetworkMode, string> = {
  fast: "Fast", normal: "Normal", slow: "Slow", "very-slow": "Very Slow",
};
export type NetworkDelays = { stepDelayMs: number; sleepDelayMs: number };
export type NetworkSettings = { mode: NetworkMode; presets: Record<NetworkMode, NetworkDelays> };
export type NetworkRunSettings = Readonly<NetworkDelays & { mode: NetworkMode }>;
export const MAX_NETWORK_DELAY_MS = 60000;
export function defaultNetworkSettings(): NetworkSettings {
  return { mode: "normal", presets: {
    fast: { stepDelayMs: 500, sleepDelayMs: 1000 },
    normal: { stepDelayMs: 1000, sleepDelayMs: 2000 },
    slow: { stepDelayMs: 2000, sleepDelayMs: 4000 },
    "very-slow": { stepDelayMs: 4000, sleepDelayMs: 8000 },
  } };
}
export function validateNetworkSettings(value: NetworkSettings) {
  if (!value || !NETWORK_MODES.includes(value.mode) || !value.presets)
    throw new Error("Network Mode không hợp lệ.");
  for (const mode of NETWORK_MODES) {
    const preset = value.presets[mode];
    if (!preset || [preset.stepDelayMs, preset.sleepDelayMs].some(ms =>
      !Number.isInteger(ms) || ms < 0 || ms > MAX_NETWORK_DELAY_MS))
      throw new Error("Delay phải là số nguyên từ 0–60000ms.");
  }
}
/** Copy at the run boundary; editing Settings cannot change an active run. */
export function snapshotNetworkSettings(settings: NetworkSettings): NetworkRunSettings {
  validateNetworkSettings(settings);
  const preset = settings.presets[settings.mode];
  return Object.freeze({ mode: settings.mode, stepDelayMs: preset.stepDelayMs, sleepDelayMs: preset.sleepDelayMs });
}
