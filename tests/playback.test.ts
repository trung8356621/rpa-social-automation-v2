import test from "node:test";
import assert from "node:assert/strict";
import type { Step, Result } from "../src/shared/contracts.js";
import { playSequential, playbackResult } from "../src/renderer/playback.js";
const steps = [1, 2, 3].map((i) => ({
  id: `s${i}`,
  version: i,
  name: `Step ${i}`,
  createdAt: "fixture",
  payload: { action: "TYPE_ONLY" as const, variableId: "text" },
}));
const result = (
  step: Step,
  status: Result["status"] = "ACTION_SENT",
): Result => ({
  id: step.id,
  stepId: step.id,
  version: step.version,
  action: step.payload.action,
  ok: status === "ACTION_SENT" || status === "VERIFIED",
  status,
  message: status,
  source: "base",
});
test("Play All waits for each existing Test call and keeps pinned order/versions", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    calls: string[] = [],
    events: string[] = [];
  const run = playSequential(
    steps,
    async (s) => {
      calls.push(`${s.id}:${s.version}`);
      if (s.id === "s1") await gate;
      return [result(s)];
    },
    (s, state) => events.push(`${s.id}:${state.status}`),
  );
  assert.deepEqual(calls, ["s1:1"]);
  release();
  await run;
  assert.deepEqual(calls, ["s1:1", "s2:2", "s3:3"]);
  assert.deepEqual(events, [
    "s1:running",
    "s1:pass",
    "s2:running",
    "s2:pass",
    "s3:running",
    "s3:pass",
  ]);
});
test("Play All stops at failed or blocked results and never sends the following step", async () => {
  for (const status of ["FAILED", "BLOCKED"] as const) {
    const calls: string[] = [],
      states: string[] = [];
    await playSequential(
      steps,
      async (s) => {
        calls.push(s.id);
        return [result(s, s.id === "s2" ? status : "ACTION_SENT")];
      },
      (s, state) => states.push(`${s.id}:${state.status}`),
    );
    assert.deepEqual(calls, ["s1", "s2"]);
    assert.equal(
      states.at(-1),
      `s2:${status === "FAILED" ? "fail" : "blocked"}`,
    );
  }
});
test("missing default data is blocked, transport failure and empty responses fail", async () => {
  for (const [error, expected] of [
    [new Error("Missing variable Default Pattern"), "blocked"],
    [new Error("IPC disconnected"), "fail"],
  ] as const) {
    let calls = 0,
      final = "";
    await playSequential(
      steps,
      async () => {
        calls++;
        throw error;
      },
      (_, state) => (final = state.status),
    );
    assert.equal(calls, 1);
    assert.equal(final, expected);
  }
  assert.equal(playbackResult([]).status, "fail");
});
test("UI pass preserves ACTION_SENT and never upgrades it to VERIFIED", () => {
  const sent = result(steps[0]);
  const before = structuredClone(sent);
  const state = playbackResult([sent]);
  assert.equal(state.status, "pass");
  assert.equal(state.resultStatus, "ACTION_SENT");
  assert.deepEqual(sent, before);
});
