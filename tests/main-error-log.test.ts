import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeMainFileLogging,
  logMainEvent,
  resetMainFileLoggingForTest,
} from "../src/main/main-error-log.js";

test("each start creates a unique bounded log file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rpa-start-log-"));
  try {
    const now = new Date("2026-10-24T02:58:00.000Z");
    const first = initializeMainFileLogging(directory, { now, maxFiles: 2, maxBytes: 1024 });
    const second = initializeMainFileLogging(directory, { now, maxFiles: 2, maxBytes: 1024 });
    const third = initializeMainFileLogging(directory, { now, maxFiles: 2, maxBytes: 1024 });
    assert.notEqual(first, second);
    assert.notEqual(second, third);
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".log")).length, 2);
    logMainEvent(directory, "large", { value: "x".repeat(4096) });
    assert.ok(readFileSync(third).byteLength <= 1024);
  } finally {
    resetMainFileLoggingForTest();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file logging preserves run identifiers and redacts secrets", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rpa-redact-log-"));
  try {
    const file = initializeMainFileLogging(directory);
    logMainEvent(directory, "ocr-raw", {
      runId: "run-1",
      batchRunId: "batch-1",
      stepId: "step-1",
      rawText: "visible OCR",
      sessionId: "browser-session-1",
      password: "do-not-write",
      seoOpsToken: "also-secret",
      authorization: "Bearer abc.def.ghi",
    });
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /run-1/);
    assert.match(contents, /batch-1/);
    assert.match(contents, /step-1/);
    assert.match(contents, /visible OCR/);
    assert.match(contents, /browser-session-1/);
    assert.doesNotMatch(contents, /do-not-write|also-secret|abc\.def\.ghi/);
    assert.match(contents, /\[REDACTED\]/);
  } finally {
    resetMainFileLoggingForTest();
    rmSync(directory, { recursive: true, force: true });
  }
});
