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
  assert.match(source, /id:\s*"copy-url"/);
  assert.match(source, /clipboard\?\.writeText/);
  assert.doesNotMatch(source, /<p className="pdc-browser-url"/);
  assert.doesNotMatch(source, /Source URL ≠ Browser URL/);
});

test("auto resume guards unmount and navigation before entering Step 3", () => {
  const source = readFileSync("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx", "utf8");
  assert.match(source, /cancelled \|\| navigationEpoch\.current !== startedAtEpoch/);
  assert.match(source, /shouldRetrySavedParentResolution/);
  assert.match(source, /savedParentResolution,/);
  assert.match(source, /status: "RESOLVING"/);
  assert.match(source, /step: 3/);
  assert.match(source, /Auto-resume belongs to this Collector mount/);
  assert.match(source, /autoResolveStarted\.current = false/);
  assert.doesNotMatch(source, /runPostDetailAutoScan/);
  assert.doesNotMatch(source, /postDetailResolveVisualActionRowParent/);
  assert.match(source, /\}, \[\]\);/);
});

test("Post Detail restores the persisted social URL when restarted BrowserCore is blank", () => {
  const source = readFileSync("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx", "utf8");
  assert.match(source, /const restoreUrl = state\.browserUrl \|\| state\.sourceUrl/);
  assert.match(source, /live && !live\.isSocialPage/);
  assert.match(source, /type: "postDetailNavigate", url: restoreUrl/);
  assert.match(source, /Restoring the last BrowserCore post/);
});

test("Step 3 keeps BrowserCore mounted while resolving or showing failure", () => {
  const source = readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");
  assert.match(source, /Resolving Parent\.\.\./);
  assert.match(source, /status !== "NOT_CONFIGURED"/);
  assert.match(source, /<BrowserHost/);
  assert.match(readFileSync("src/renderer/components/BrowserWorkspace.tsx", "utf8"), /data-browser-core-host=""/);
  assert.match(source, /diagnosticMeta/);
});

test("Step 3 host attachment primes a BrowserCore page loaded while hidden", () => {
  const core = readFileSync("src/main/browser-core.ts", "utf8");
  const main = readFileSync("src/main/main.ts", "utf8");
  assert.match(core, /async prepareVisibleSurface/);
  assert.match(core, /capturePage\(\)/);
  assert.match(core, /attempt <= 2/);
  assert.match(main, /host\?\.active && browser\.visible/);
  assert.match(main, /await browser\.prepareVisibleSurface\(\)/);
});

test("Step 3 cold-start owns, measures, republishes and cleans up its BrowserCore host independently", () => {
  const source = readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");
  assert.match(source, /claimCollectorHostOwner\("pdc-step3"\)/);
  assert.match(source, /isCollectorHostOwner\(ownerId\)/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /attachWhenMeasured = \(remaining = 8\)/);
  assert.match(source, /window\.addEventListener\("scroll", scheduler\.schedule, true\)/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /releaseCollectorHostOwner\(ownerId/);
});

test("post navigation re-primes the current native surface without creating another webContents", () => {
  const core = readFileSync("src/main/browser-core.ts", "utf8");
  const main = readFileSync("src/main/main.ts", "utf8");
  assert.match(core, /preparedVisibleSurfaceKey/);
  assert.match(core, /did-start-navigation/);
  assert.match(main, /BrowserCore post-navigation surface not ready/);
  assert.doesNotMatch(main, /post-navigation[\s\S]{0,300}new WebContentsView/);
});
