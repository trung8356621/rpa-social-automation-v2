import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginTestRunLog,
  endTestRunLog,
  initializeMainFileLogging,
  logMainError,
  logMainEvent,
  logTestBoundary,
  resetMainFileLoggingForTest,
} from "../src/main/main-error-log.js";

function tempLogs() {
  return mkdtempSync(path.join(os.tmpdir(), "rpa-test-log-"));
}

test("two Play All runs create separate files and each keeps all child Steps", () => {
  const directory = tempLogs();
  try {
    const now = new Date("2026-10-24T03:17:00.000Z");
    initializeMainFileLogging(directory, { now });
    for (const batchRunId of ["batch-1", "batch-2"]) {
      const file = beginTestRunLog(batchRunId, "Play All", now)!;
      logTestBoundary(directory, "START", { runId: batchRunId, label: "Play All" });
      for (const [index, stepId] of ["step-1", "step-2"].entries()) {
        const runId = `run-${batchRunId}-${index}`;
        logMainEvent(directory, "execution-start", { runId, testRunId: runId, batchRunId, stepId });
        logMainEvent(directory, "ocr-raw", { runId, testRunId: runId, batchRunId, stepId, rawText: "Bạn viết gì đi..." });
        logMainEvent(directory, "execution-stop", { runId, testRunId: runId, batchRunId, stepId, status: "MATCHED" });
      }
      logTestBoundary(directory, "END", { runId: batchRunId, label: "Play All", status: "COMPLETED" });
      endTestRunLog(batchRunId);
      const contents = readFileSync(file, "utf8");
      assert.match(contents, /step-1/);
      assert.match(contents, /step-2/);
      assert.match(contents, /test-start/);
      assert.match(contents, /test-end/);
    }
    assert.equal(readdirSync(directory).filter((name) => name.startsWith("test-")).length, 2);
  } finally {
    resetMainFileLoggingForTest();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone Test log is bounded, redacted and separate from application errors", () => {
  const directory = tempLogs();
  try {
    const appFile = initializeMainFileLogging(directory, { maxBytes: 1024 });
    const testFile = beginTestRunLog("run-1", "Step step-1")!;
    logMainEvent(directory, "ocr-raw", {
      runId: "execution-1",
      testRunId: "run-1",
      stepId: "step-1",
      rawText: "visible OCR",
      sessionId: "browser-session-1",
      password: "do-not-write",
      seoOpsToken: "also-secret",
      authorization: "Bearer abc.def.ghi",
    });
    logMainError(directory, "startup", new Error("startup failed"));
    logMainEvent(directory, "large", { testRunId: "run-1", value: "x".repeat(4096) });
    endTestRunLog("run-1");

    const testContents = readFileSync(testFile, "utf8");
    assert.match(testContents, /run-1|execution-1/);
    assert.match(testContents, /step-1/);
    assert.match(testContents, /visible OCR/);
    assert.match(testContents, /browser-session-1/);
    assert.doesNotMatch(testContents, /do-not-write|also-secret|abc\.def\.ghi|startup failed/);
    assert.match(testContents, /\[REDACTED\]/);
    assert.ok(readFileSync(testFile).byteLength <= 1024);
    assert.match(readFileSync(appFile, "utf8"), /startup failed/);
  } finally {
    resetMainFileLoggingForTest();
    rmSync(directory, { recursive: true, force: true });
  }
});
