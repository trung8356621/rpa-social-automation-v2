export const COMPLETION_SOUND_KEY = "rpa:settings:completion-sound";

export function completionSoundEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(COMPLETION_SOUND_KEY) !== "off";
}

export function setCompletionSoundEnabled(enabled: boolean) {
  localStorage.setItem(COMPLETION_SOUND_KEY, enabled ? "on" : "off");
}

const played = new Set<string>();
const CHIME_COUNT = 3;
const CHIME_GAP_MS = 650;
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

async function playOne(kind: "SUCCESS" | "NEEDS_ATTENTION"): Promise<boolean> {
  try {
    const file = kind === "SUCCESS" ? "completion-success.wav" : "completion-attention.wav";
    const audio = new Audio(new URL(`sounds/${file}`, window.location.href).href);
    audio.volume = 0.58;
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
      const oscillator = context.createOscillator(), gain = context.createGain(), at = start + index * 0.11;
      oscillator.type = "sine"; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.1, at + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain).connect(context.destination); oscillator.start(at); oscillator.stop(at + 0.17);
    });
    window.setTimeout(() => { void context.close(); }, 500);
    return true;
  } catch { return false; }
}

/** Original generated tones shipped under public/sounds; no copyrighted/external media. */
export async function playCompletionSound(kind: "SUCCESS" | "NEEDS_ATTENTION", taskId: string): Promise<boolean> {
  if (!completionSoundEnabled() || played.has(taskId)) return false;
  played.add(taskId);
  let sounded = false;
  for (let index = 0; index < CHIME_COUNT; index++) {
    if (!completionSoundEnabled()) break;
    sounded = await playOne(kind) || sounded;
    if (index < CHIME_COUNT - 1) await wait(CHIME_GAP_MS);
  }
  return sounded;
}
