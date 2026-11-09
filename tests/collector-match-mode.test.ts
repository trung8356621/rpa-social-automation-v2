import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MatchTestResult,
  MatchedPostItem,
} from "../src/shared/collectors/types.js";

const matchTestStepSource = readFileSync(
  resolve("src/renderer/collectors/MatchTestStep.tsx"),
  "utf8"
);
const styleCssSource = readFileSync(
  resolve("src/renderer/style.css"),
  "utf8"
);

test("C2.10.6 Match Mode: Initial state defaults to OFF with explicit user instruction", () => {
  // 1. matchMode starts strictly false (OFF)
  assert.match(
    matchTestStepSource,
    /const \[matchMode, setMatchMode\] = useState<boolean>\(false\);/,
    "Match Mode state must initialize to false (OFF)"
  );
  assert.match(
    matchTestStepSource,
    /const matchModeRef = useRef<boolean>\(false\);/,
    "matchModeRef must track OFF state synchronously"
  );

  // 2. When OFF, short instruction is presented to user
  assert.match(matchTestStepSource, /collector-match-off-instruction/);
  assert.match(matchTestStepSource, /Match Mode is OFF/);
  assert.match(matchTestStepSource, /The live browser is interactive/);

  // 3. When OFF, Re-match action is disabled
  assert.match(
    matchTestStepSource,
    /disabled=\{locked \|\| isRunning \|\| !matchMode\}/,
    "Re-match button must be disabled when Match Mode is OFF"
  );
});

test("C2.10.6 Match Mode: Prominent ON/OFF toggle and state transitions", () => {
  // 1. Radiogroup toggle with distinct OFF and ON options
  assert.match(matchTestStepSource, /collector-match-mode-control/);
  assert.match(matchTestStepSource, /collector-match-mode-toggle/);
  assert.match(matchTestStepSource, /handleToggleMatchMode\(false\)/);
  assert.match(matchTestStepSource, /handleToggleMatchMode\(true\)/);

  // 2. CSS styles exist for toggle buttons
  assert.match(styleCssSource, /\.collector-toggle-btn/);
  assert.match(styleCssSource, /\.collector-toggle-btn\.active\.on/);
  assert.match(styleCssSource, /\.collector-toggle-btn\.active\.off/);

  // 3. Switching ON runs exactly one viewport match
  assert.match(
    matchTestStepSource,
    /if \(nextMode\) \{\s*\/\/[^\n]*\s*void runViewportMatch\(\);/,
    "Switching ON must trigger runViewportMatch"
  );

  // 4. Switching OFF invalidates in-flight run and clears visual highlights immediately
  assert.match(
    matchTestStepSource,
    /runIdRef\.current\+\+;\s*isRunningRef\.current = false;\s*setIsRunning\(false\);/,
    "Switching OFF must invalidate current run ID and reset running flag"
  );
  assert.match(
    matchTestStepSource,
    /if \(invoke && isElectronBrowserCoreAvailable\(\)\) \{\s*void collectorClearHighlights\(invoke\);/,
    "Switching OFF must clear browser highlights"
  );
});

test("C2.10.6 Execution: Single-run guarantee prevents duplicate and overlapping invocations", () => {
  // 1. Synchronous guard at the start of match run
  assert.match(
    matchTestStepSource,
    /if \(lockedRef\.current \|\| isRunningRef\.current\) return;/,
    "Must check isRunningRef before any async execution"
  );
  assert.match(
    matchTestStepSource,
    /if \(!matchModeRef\.current\) return;/,
    "Must not run if matchMode is OFF"
  );

  // 2. Guard flag set synchronously before async boundary
  assert.match(
    matchTestStepSource,
    /isRunningRef\.current = true;\s*setIsRunning\(true\);/,
    "isRunningRef must be set true synchronously"
  );

  // 3. No recursive execution or polling timers
  assert.ok(
    !/setInterval/s.test(matchTestStepSource),
    "Match Test must never use polling intervals"
  );
});

test("C2.10.6 Cancellation: Safe rejection of stale async results", () => {
  // 1. Sequence ID incremented on every fresh run, toggle OFF, and unmount
  assert.match(matchTestStepSource, /const currentRunId = \+\+runIdRef\.current;/);

  // 2. Stale checks performed at each asynchronous IPC checkpoint
  const staleCheckRegex =
    /if \(!isMountedRef\.current \|\| currentRunId !== runIdRef\.current \|\| !matchModeRef\.current\)/;
  const matches = matchTestStepSource.match(new RegExp(staleCheckRegex, "g"));
  assert.ok(
    matches && matches.length >= 3,
    "Must check for stale run / OFF state at each async IPC checkpoint"
  );

  // 3. Draft mutation is strictly protected by stale checks
  assert.match(
    matchTestStepSource,
    /if \(isMountedRef\.current && currentRunId === runIdRef\.current && matchModeRef\.current\) \{\s*onChangeRef\.current\(\{ \.\.\.draftRef\.current, matchTest: result, dirty: true \}\);/s,
    "Draft is never updated if run is stale or Match Mode was turned OFF"
  );
});

test("C2.10.6 Scrolling: Strict user control — no automated scrolling, pagination, or scroll listeners", () => {
  // 1. Zero scroll event listeners in MatchTestStep
  assert.ok(
    !/addEventListener\([^)]*["']scroll["']/s.test(matchTestStepSource),
    "MatchTestStep must never listen to scroll events"
  );

  // 2. No automatic scroll commands
  assert.ok(
    !/scrollTo\(/s.test(matchTestStepSource),
    "MatchTestStep must never invoke scrollTo"
  );
  assert.ok(
    !/scrollBy\(/s.test(matchTestStepSource),
    "MatchTestStep must never invoke scrollBy"
  );
  assert.ok(
    !/scrollIntoView\(/s.test(matchTestStepSource),
    "MatchTestStep must never invoke scrollIntoView"
  );
});

test("C2.10.6 Browser Lifecycle: Strictly preserved and decoupled from Match Mode", () => {
  // 1. Host effect dependencies remain only [invoke, publishHost]
  assert.match(
    matchTestStepSource,
    /\}, \[invoke, publishHost\]\);/s,
    "Host lifecycle effect must only depend on [invoke, publishHost]"
  );
  assert.ok(
    !/useEffect\([^)]*publishHost[^)]*matchMode/s.test(matchTestStepSource),
    "Host effect must not depend on matchMode"
  );

  // 2. Unmount cleanup clears Step 3 highlights and detaches frame view without closing user browser session
  assert.match(matchTestStepSource, /void collectorClearHighlights\(invoke\);/);
  assert.match(matchTestStepSource, /void collectorReportBrowserHost\(invoke, null\);/);
  assert.match(matchTestStepSource, /void collectorSetBrowserVisible\(invoke, false\)/);
  assert.ok(
    !/closeSession|destroySession/s.test(matchTestStepSource),
    "Browser session must be preserved across step navigation"
  );
});

test("C2.10.6 Highlights & Status: Highlighting only resolved containers and distinguishing NO MATCH from ERROR", () => {
  // 1. Highlighting filters strictly to resolved post containers
  assert.match(
    matchTestStepSource,
    /const resolvedMatches = \(result\.matchedItems \|\| \[\]\)\.filter\(\(item\) => item\.domResolved\);/,
    "Must filter matchedItems to only those with domResolved === true"
  );
  assert.match(
    matchTestStepSource,
    /await collectorHighlightMatches\(invoke, resolvedMatches\);/,
    "Only resolved matches are forwarded to visual highlight IPC"
  );

  // 2. Status distinction: NO MATCH vs FAILED/ERROR
  assert.match(matchTestStepSource, /displayStatus/);
  assert.match(matchTestStepSource, /rawStatus === ["']FAILED["'] && !isExecutionError && resolvedMatchedCount === 0/);
  assert.match(matchTestStepSource, /\? ["']NO MATCH["']/);

  // 3. CSS badge for NO MATCH exists
  assert.match(styleCssSource, /\.collector-match-pill\.status-no-match/);
});

test("C2.10.6 Simulation: Async runner drops stale results after toggling OFF during in-flight inspection", async () => {
  let isRunning = false;
  let matchMode = true;
  let runId = 1;
  let stateUpdated = false;
  let highlightsDrawn = false;

  const mockRun = async (myRunId: number) => {
    isRunning = true;
    // Step 1: Simulate async DOM inspection delay
    await new Promise((r) => setTimeout(r, 20));

    // Stale check
    if (myRunId !== runId || !matchMode) {
      isRunning = false;
      return;
    }

    highlightsDrawn = true;
    stateUpdated = true;
    isRunning = false;
  };

  // Start in-flight match #1
  const runPromise = mockRun(runId);

  // User immediately switches OFF while match #1 is in flight
  matchMode = false;
  runId++; // Invalidates run #1

  await runPromise;

  // Stale run #1 must have been aborted
  assert.equal(stateUpdated, false, "Stale in-flight match must not update state");
  assert.equal(highlightsDrawn, false, "Stale in-flight match must not draw highlights");
  assert.equal(isRunning, false, "isRunning must be reset");
});
