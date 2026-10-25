import test from "node:test";
import assert from "node:assert/strict";
import { createSeoOpsBackupScheduler } from "../src/main/seo-ops-backup-scheduler.js";
import { SeoOpsHttpError } from "../src/shared/seo-ops-http.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("draft backup requests coalesce and never overlap", async () => {
  let calls = 0, active = 0, maxActive = 0;
  let release: (() => void) | undefined;
  const scheduler = createSeoOpsBackupScheduler({ debounceMs: 5, random: () => 0, failed: () => undefined,
    backup: async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => { release = resolve; });
      active--;
    } });
  scheduler.request(); scheduler.request(); scheduler.request();
  await wait(10);
  assert.equal(calls, 1);
  scheduler.request(); scheduler.request();
  release?.();
  await wait(10);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  release?.(); scheduler.stop();
});

test("draft backup respects Retry-After and retries once after cooldown", async () => {
  let calls = 0;
  const scheduler = createSeoOpsBackupScheduler({ debounceMs: 1, initialBackoffMs: 1, random: () => 0, failed: () => undefined,
    backup: async () => {
      calls++;
      if (calls === 1) throw new SeoOpsHttpError({ method: "POST", endpoint: "/backup", status: 429,
        contentType: "application/json", category: "rate_limited", retryAfterSeconds: 0.03 });
    } });
  scheduler.request();
  await wait(10);
  assert.equal(calls, 1);
  await wait(35);
  assert.equal(calls, 2);
  assert.equal(scheduler.getState().scheduled, false);
  scheduler.stop();
});
