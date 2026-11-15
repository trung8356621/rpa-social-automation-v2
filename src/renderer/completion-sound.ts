export const COMPLETION_SOUND_KEY = "rpa:settings:completion-sound";

export function completionSoundEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(COMPLETION_SOUND_KEY) !== "off";
}

export function setCompletionSoundEnabled(enabled: boolean) {
  localStorage.setItem(COMPLETION_SOUND_KEY, enabled ? "on" : "off");
}

const played = new Set<string>();

/** Original generated tones shipped under public/sounds; no copyrighted/external media. */
export async function playCompletionSound(kind: "SUCCESS" | "NEEDS_ATTENTION", taskId: string): Promise<boolean> {
  if (!completionSoundEnabled() || played.has(taskId)) return false;
  played.add(taskId);
  try {
    const file = kind === "SUCCESS" ? "completion-success.wav" : "completion-attention.wav";
    const audio = new Audio(new URL(`sounds/${file}`, window.location.href).href);
    audio.volume = 0.7;
    await audio.play();
    return true;
  } catch {
    // Packaged asset/autoplay failure must never fail the task. Fall back to Web Audio.
  }
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return false;
    const context = new AudioContextCtor();
    const frequencies = kind === "SUCCESS" ? [523.25, 659.25] : [392, 311.13];
    const start = context.currentTime;
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const at = start + index * 0.11;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.17);
    });
    window.setTimeout(() => { void context.close(); }, 500);
    return true;
  } catch {
    return false;
  }
}
