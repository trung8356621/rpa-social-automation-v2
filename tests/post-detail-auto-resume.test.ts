import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { shouldRetrySavedParentResolution } from "../src/renderer/post-detail-collector/auto-resume.js";

const result = (failureCode: "BROWSER_NOT_READY" | "ACTION_ROW_SELECTOR_NOT_FOUND" | "ACTION_ROW_AMBIGUOUS" | "ACTION_ROW_INVALID" | "PARENT_LEVEL_NOT_FOUND" | "POST_IDENTITY_MISMATCH") => ({ status: "REMATCH_REQUIRED" as const, innerHTML: "", rect: null, failureCode, diagnostics: [] });

test("auto resume retries only potentially transient Facebook render failures", () => {
  for (const code of ["BROWSER_NOT_READY", "ACTION_ROW_SELECTOR_NOT_FOUND", "ACTION_ROW_INVALID", "POST_IDENTITY_MISMATCH"] as const) assert.equal(shouldRetrySavedParentResolution(result(code)), true);
  for (const code of ["ACTION_ROW_AMBIGUOUS", "PARENT_LEVEL_NOT_FOUND"] as const) assert.equal(shouldRetrySavedParentResolution(result(code)), false);
});

test("Step 1 keeps Source URL copyable but removes Browser URL and mismatch rows", () => {
  const source = readFileSync("src/renderer/post-detail-collector/BrowserCaptureStep.tsx", "utf8");
  assert.match(source, /aria-label="Source URL"/);
  assert.match(source, /readOnly/);
  assert.doesNotMatch(source, /<p className="pdc-browser-url"/);
  assert.doesNotMatch(source, /Source URL ≠ Browser URL/);
});

test("auto resume guards unmount and navigation before entering Step 3", () => {
  const source = readFileSync("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx", "utf8");
  assert.match(source, /cancelled \|\| navigationEpoch\.current !== startedAtEpoch/);
  assert.match(source, /shouldRetrySavedParentResolution/);
  assert.match(source, /updateStore\(\{ savedParentResolution, step: 3 \}\)/);
  assert.match(source, /status: "RESOLVING"/);
  assert.match(source, /step: 3/);
  assert.match(source, /Auto-resume belongs to this Collector mount/);
  assert.match(source, /autoResolveStarted\.current = false/);
  assert.match(source, /\}, \[\]\);/);
});

test("Step 3 keeps BrowserCore mounted while resolving or showing failure", () => {
  const source = readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");
  assert.match(source, /Resolving Parent\.\.\./);
  assert.match(source, /status !== "NOT_CONFIGURED"/);
  assert.match(source, /data-browser-core-host/);
  assert.match(source, /diagnosticMeta/);
});
