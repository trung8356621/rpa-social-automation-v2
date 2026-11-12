import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  computeRunSummaryStats,
  getFeedCollectorState,
  setFeedCollectorState,
  resetFeedCollectorRun,
} from "../src/renderer/feed-item-collector/store.js";
import type { FrameReport, LiveCandidate } from "../src/renderer/feed-item-collector/types.js";
import { shouldShowBrowserForPage, resolveBrowserViewBounds } from "../src/shared/collector-browser-host.js";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Phase 2: Feed Item Collector menu and routing are independent from Collector V1", () => {
  const shell = read("src/renderer/app-shell.tsx");
  const renderer = read("src/renderer/main.tsx");
  const main = read("src/main/main.ts");
  const contracts = read("src/shared/contracts.ts");
  const tabs = read("src/renderer/workspace-tabs.tsx");

  // Menu registration
  assert.match(shell, /page: "feed-item-collector", label: "Feed Item Collector"/);
  assert.match(shell, /page: "collectors", label: "Collectors"/);

  // Contracts
  assert.match(contracts, /"collectors" \| "collector-test-lab" \| "feed-item-collector"/);

  // Main process IPC command validator
  assert.match(main, /case "appPage":[\s\S]*"feed-item-collector"/);

  // Workspace tabs
  assert.match(tabs, /"feed-item-collector": "Feed Item Collector"/);

  // Main renderer routing
  assert.match(renderer, /appPage === "feed-item-collector" && <FeedItemCollectorPage/);
  assert.match(renderer, /appPage === "collectors" \|\| appPage === "collector-test-lab"/);
});

test("Phase 1 & 2: BrowserCore hosting and bounds resolution supports Feed Item Collector", () => {
  assert.equal(
    shouldShowBrowserForPage({ page: "feed-item-collector", browserVisible: true, collectorHostActive: true }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "feed-item-collector", browserVisible: true, collectorHostActive: false }),
    false,
  );
  assert.equal(
    shouldShowBrowserForPage({ page: "feed-item-collector", browserVisible: false, collectorHostActive: true }),
    false,
  );

  const host = { x: 50, y: 100, width: 900, height: 500, active: true };
  const creator = { x: 0, y: 0, width: 1024, height: 560 };
  const bounds = resolveBrowserViewBounds({
    page: "feed-item-collector",
    collectorHost: host,
    creatorBrowser: creator,
  });
  assert.deepEqual(bounds, { x: 50, y: 100, width: 900, height: 500 });
});

test("Phase 1: Collector V1 is preserved as legacy and not overwritten", () => {
  const v1Page = read("src/renderer/collectors/CollectorsPage.tsx");
  const v1Editor = read("src/renderer/collectors/CollectorEditor.tsx");
  const v1Store = read("src/shared/collectors/store.ts");
  const v1Types = read("src/shared/collectors/types.ts");

  assert.match(v1Page, /CollectorsPage/);
  assert.match(v1Editor, /CollectorEditor/);
  assert.match(v1Store, /COLLECTOR_STORAGE_KEY/);
  assert.match(v1Types, /rpa\.collectors\.prototype\.v1/);
});

test("Phase 3 & 4: Store manages Step 1-3 state and computes run summary metrics", () => {
  resetFeedCollectorRun();
  const initial = getFeedCollectorState();
  assert.equal(initial.step, 1);
  assert.equal(initial.reports.length, 0);

  // Mock 5 sample reports
  const mockCand = (status: "BOUNDARY_FOUND" | "BOUNDARY_AMBIGUOUS" | "BOUNDARY_NOT_FOUND"): LiveCandidate => ({
    bbox: { x: 10, y: 100, width: 300, height: 40 },
    score: 0.95,
    iconCount: 3,
    status: status === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION",
    context: "post",
    fingerprint: "01010101",
    docY: 600,
    boundary: {
      status,
      ancestorsChecked: 5,
      firstPermalinkLevel: 2,
      boundaryCrossedLevel: 3,
      hitElement: { tag: "div", rect: { x: 10, y: 100, width: 300, height: 40 } },
    },
  });

  const mockReports: FrameReport[] = [
    {
      frame: 1,
      capture: {} as any,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "OK",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "BOUNDARY_FOUND",
      rawIconMatches: 3,
      actionClusters: 1,
      candidates: [mockCand("BOUNDARY_FOUND")],
    },
    {
      frame: 2,
      capture: {} as any,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "OK",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "BOUNDARY_FOUND",
      rawIconMatches: 3,
      actionClusters: 1,
      candidates: [mockCand("BOUNDARY_FOUND")],
    },
    {
      frame: 3,
      capture: {} as any,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "OK",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "BOUNDARY_AMBIGUOUS",
      rawIconMatches: 3,
      actionClusters: 1,
      candidates: [mockCand("BOUNDARY_AMBIGUOUS")],
    },
    {
      frame: 4,
      capture: {} as any,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "OK",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "BOUNDARY_FOUND",
      rawIconMatches: 3,
      actionClusters: 1,
      candidates: [mockCand("BOUNDARY_FOUND")],
    },
    {
      frame: 5,
      capture: {} as any,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "OK",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "NO_ACTION_ROW",
      rawIconMatches: 0,
      actionClusters: 0,
      candidates: [],
    },
  ];

  const stats = computeRunSummaryStats(mockReports);
  assert.equal(stats.totalActionRows, 4);
  assert.equal(stats.domHitSuccess, 4);
  assert.equal(stats.boundaryFound, 3);
  assert.equal(stats.boundaryAmbiguous, 1);
  assert.equal(stats.boundaryNotFound, 0);
  assert.deepEqual(stats.attentionFrames, [3, 5]);

  setFeedCollectorState({ reports: mockReports, summaryStats: stats, step: 2 });
  const updated = getFeedCollectorState();
  assert.equal(updated.step, 2);
  assert.equal(updated.reports.length, 5);
  assert.equal(updated.summaryStats?.boundaryFound, 3);
});

test("Phase 5: Step 3 reuses CurrentItemUrlList, UrlVerificationPanel, PermalinkRuleEditor", () => {
  const step3Source = read("src/renderer/feed-item-collector/UrlBoundaryReviewStep.tsx");
  assert.match(step3Source, /<CurrentItemUrlList/);
  assert.match(step3Source, /<UrlVerificationPanel/);
  assert.match(step3Source, /<PermalinkRuleEditor/);
  assert.match(step3Source, /extractInspectableUrls/);
  assert.match(step3Source, /deriveUrlVerificationStatus/);
  // Ensures advanced technical diagnostics are excluded from Feed Item Collector V2 default review
  assert.doesNotMatch(step3Source, /<PermalinkTechnicalDetails/);
});
