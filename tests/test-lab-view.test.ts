import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initialResultMedia, initialTestCaseMode, stepStatusLabel } from "../src/shared/test-lab-view.js";
import type { CaseResult } from "../src/shared/contracts.js";

const result = (extra: Partial<CaseResult> = {}): CaseResult => ({
  status: "ACTION_SENT", startedAt: "2026-10-24T01:00:00.000Z",
  finishedAt: "2026-10-24T01:00:03.000Z", message: "done", ...extra,
});

test("new Test Case configures first; completed Test Case opens Result", () => {
  assert.equal(initialTestCaseMode(), "configure");
  assert.equal(initialTestCaseMode(result()), "result");
});

test("video is primary when ready or preparing; unavailable video falls back to screenshot", () => {
  assert.equal(initialResultMedia(result({ recordingPath: "case/run/recording.webm" })), "video");
  assert.equal(initialResultMedia(result({ status: "RUNNING" })), "video");
  assert.equal(initialResultMedia(result({ recordingError: "missing" })), "screenshot");
  assert.equal(initialResultMedia(result()), "screenshot");
});

test("status labels never promote ACTION_SENT and distinguish success/failure", () => {
  assert.equal(stepStatusLabel("ACTION_SENT"), "ACTION_SENT");
  assert.equal(stepStatusLabel("PASS"), "SUCCESS");
  assert.equal(stepStatusLabel("ERROR"), "FAILED");
  assert.equal(stepStatusLabel("BLOCKED"), "BLOCKED");
});

test("result media is responsive without horizontal overflow", async () => {
  const css = await readFile(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /\.case-result-media[^}]*width:\s*min\(1180px, 100%\)/);
  assert.match(css, /\.case-video-player[^}]*width:\s*100%/);
  assert.match(css, /\.case-video-player[^}]*object-fit:\s*contain/);
  assert.match(css, /@media \(max-width: 720px\)/);
});
