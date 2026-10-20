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

// Only editor/UI values travel with a workspace tab. Saved Flow data, app settings
// and execution locks always come from the main process, never from a tab snapshot.
const editorDefaults = {
  variableId: "", action: "CLICK_TARGET", name: "", text: undefined,
  delta: -400, quickTagRows: 5, sleepMs: undefined, inputMethod: "keyboard",
  pairDelay: 800, target: undefined, targetImage: "", files: undefined,
  ocrResult: undefined, ocrError: "", ocrLoading: false, ocrKind: "none",
  selected: undefined, overrideId: "", roi: undefined, results: [],
  message: "Chọn Step hoặc tạo Step mới.", context: "Ngữ cảnh sửa lỗi",
  editorRevision: 0, editorExpanded: false,
} satisfies Partial<Record<DraftKey, unknown>>;
export type EditorDraft = Partial<Record<DraftKey, unknown>>;
export function captureEditorDraft(): EditorDraft {
  return Object.fromEntries((Object.keys(editorDefaults) as DraftKey[]).map(key =>
    [key, window.creator.readDraft(key, editorDefaults[key as keyof typeof editorDefaults]).value]));
}
export function restoreEditorDraft(snapshot?: EditorDraft) {
  for (const key of Object.keys(editorDefaults) as (keyof typeof editorDefaults)[]) {
    const entry = window.creator.writeDraft(key, snapshot ? snapshot[key] : editorDefaults[key]);
    cache.set(key, entry);
    listeners.get(key)?.forEach(notify => notify());
  }
}
