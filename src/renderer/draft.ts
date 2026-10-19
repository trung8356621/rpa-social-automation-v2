import { useSyncExternalStore, type SetStateAction } from "react";

// Each native panel is a separate renderer. The main process orders draft updates;
// the runtime/storage remain authoritative for saved steps and test results.
import type { DraftKey } from "../shared/contracts";

const cache = new Map<string, { revision: number; value: unknown }>();
const listeners = new Map<string, Set<() => void>>();
window.creator.onDraft((key, entry) => {
  if (entry.revision <= (cache.get(key)?.revision ?? -1)) return;
  cache.set(key, entry);
  listeners.get(key)?.forEach((notify) => notify());
});
export function useDraft<T>(
  key: DraftKey,
  initial: T,
): readonly [T, (next: SetStateAction<T>) => void];
export function useDraft<T = undefined>(
  key: DraftKey,
): readonly [T | undefined, (next: SetStateAction<T | undefined>) => void];
export function useDraft<T>(key: DraftKey, initial?: T) {
  if (!cache.has(key)) cache.set(key, window.creator.readDraft(key, initial));
  const value = useSyncExternalStore(
    (notify) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(notify);
      return () => {
        set.delete(notify);
      };
    },
    () => cache.get(key)!.value as T,
  );
  const update = (next: SetStateAction<T>) => {
    const previous = cache.get(key)!.value as T;
    const resolved =
      typeof next === "function" ? (next as (value: T) => T)(previous) : next;
    const entry = window.creator.writeDraft(key, resolved);
    cache.set(key, entry);
    listeners.get(key)?.forEach((notify) => notify());
  };
  return [value, update] as const;
}
