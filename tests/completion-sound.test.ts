import assert from "node:assert/strict";
import test from "node:test";
import { COMPLETION_SOUND_KEY, COMPLETION_SOUND_VOLUME_KEY, playCompletionSound } from "../src/renderer/completion-sound";

test("completion sound plays three chimes per task, dedupes task id, and stops when disabled", async () => {
  const values = new Map<string, string>();
  let plays = 0;
  const volumes: number[] = [];
  Object.assign(globalThis, {
    window: { setTimeout, location: { href: "file:///app/dist/renderer/index.html" } },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    Audio: class { private value = 1; set volume(value: number) { this.value = value; volumes.push(value); } get volume() { return this.value; } async play() { plays++; } },
  });
  values.set(COMPLETION_SOUND_KEY, "on");
  values.set(COMPLETION_SOUND_VOLUME_KEY, "0.82");
  assert.equal(await playCompletionSound("SUCCESS", "task-three"), true);
  assert.equal(plays, 3);
  assert.deepEqual(volumes, [0.82, 0.82, 0.82]);
  assert.equal(await playCompletionSound("SUCCESS", "task-three"), false);
  assert.equal(plays, 3);

  Reflect.set(globalThis, "Audio", class {
    volume = 1;
    async play() { plays++; values.set(COMPLETION_SOUND_KEY, "off"); }
  });
  values.set(COMPLETION_SOUND_KEY, "on");
  assert.equal(await playCompletionSound("NEEDS_ATTENTION", "task-disable-mid-sequence"), true);
  assert.equal(plays, 4);
});
