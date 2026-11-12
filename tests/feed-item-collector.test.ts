import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  computeRunSummaryStats,
  getFeedCollectorState,
  setFeedCollectorState,
  resetFeedCollectorRun,
  hydrateFeedCollectorFromStorage,
} from "../src/renderer/feed-item-collector/store.js";
import type { FrameReport, LiveCandidate } from "../src/renderer/feed-item-collector/types.js";
import { shouldShowBrowserForPage, resolveBrowserViewBounds } from "../src/shared/collector-browser-host.js";
import {
  validatePostUrlForConfirmation,
  reevaluateCandidateBoundaryOffline,
  updateCandidateInReports,
} from "../src/renderer/feed-item-collector/boundary-reevaluation.js";
import type { UserPermalinkRule } from "../src/shared/permalink-rules.js";

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
    candidateId: "cand_mock",
    frameId: 1,
    bbox: { x: 10, y: 100, width: 300, height: 40 },
    score: 0.95,
    matchScore: 0.95,
    iconCount: 3,
    status: status === "BOUNDARY_FOUND" ? "NEW_ITEM" : "NEEDS_ATTENTION",
    boundaryStatus: status,
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "01010101",
    docY: 600,
    boundary: {
      status,
      ancestorsChecked: 5,
      firstPermalinkLevel: 2,
      boundaryCrossedLevel: 3,
      hitElement: {
        tag: "div",
        role: "button",
        id: "",
        className: "",
        ariaLabel: "",
        textSnippet: "",
        rect: { x: 10, y: 100, width: 300, height: 40 },
      },
    } as any,
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

test("Phase 3 (Step 1 Refactor): Reuses Collector V1 Capture Mode & Browser Live Mode", () => {
  const step1Source = read("src/renderer/feed-item-collector/CalibrationStep.tsx");

  // Browser Live Mode by default
  assert.match(step1Source, /collectorSetBrowserVisible\(invoke, true\)/);
  assert.match(step1Source, /collectorReportBrowserHost/);
  assert.match(step1Source, /className="collector-browser-host"/);
  assert.match(step1Source, /data-browser-core-host=""/);

  // Capture Mode ON / OFF toggle and freeze mechanism
  assert.match(step1Source, /Capture Mode:\s*ON/i);
  assert.match(step1Source, /collectorFreezeFrame\(invoke\)/);
  assert.match(step1Source, /className="collector-capture-freeze snapshot"/);

  // Reuses Collector V1 coordinate translation and ROI selection
  assert.match(step1Source, /clientToImageCoords/);
  assert.match(step1Source, /dragToCaptureRoi/);
  assert.match(step1Source, /className="collector-roi-highlight"/);

  // Returns to Live Mode after saving crop without resetting browser
  assert.match(step1Source, /exitCaptureMode/);
  assert.match(step1Source, /collectorSetBrowserVisible\(invoke, true\)/);

  // Help / Example guide for default templates
  assert.match(step1Source, /showHelpExample/);
  assert.match(step1Source, /Mẫu Facebook tiêu chuẩn/);

  // BrowserCore position fix: scroll & resize listener, fixed workspace bounds
  assert.match(step1Source, /window\.addEventListener\("scroll",\s*publishHost,\s*true\)/);
  assert.match(step1Source, /window\.addEventListener\("resize",\s*publishHost\)/);
  assert.doesNotMatch(step1Source, /style=\{\{\s*width:\s*"100%",\s*height:\s*560\s*\}\}/);

  const ficCss = read("src/renderer/feed-item-collector/feed-item-collector.css");
  assert.match(ficCss, /\.workspace-page-strip ~ \.app-page\.feed-item-collector-page[\s\S]*overflow:\s*hidden/);
  assert.match(ficCss, /\.fic-calibration-workspace[\s\S]*overflow:\s*hidden/);

  const creatorOverlays = read("src/main/creator-overlays.ts");
  const browserHost = read("src/shared/collector-browser-host.ts");
  // Host-page membership lives in COLLECTOR_BROWSER_HOST_PAGES (includes feed-item-collector).
  assert.match(creatorOverlays, /isCollectorBrowserHostPage/);
  assert.match(browserHost, /"feed-item-collector"/);
});

test("Phase 4: Step 2 Scroll Sampling (400px, 100px base unit, 1/3, 2/2, 3/1 splits & dedupe)", async () => {
  const {
    TOTAL_STEP_SCROLL_PX,
    BASE_SCROLL_UNIT_PX,
    SCROLL_SPLIT_MAP,
    calculateSplitDeltas,
    pickScrollSplit,
    evaluateScrollProgress,
    dedupeCandidates,
  } = await import("../src/renderer/feed-item-collector/scroll-sampling.js");

  // 1. Constants
  assert.equal(TOTAL_STEP_SCROLL_PX, 400);
  assert.equal(BASE_SCROLL_UNIT_PX, 100);

  // 2. All ratios sum to 400px and each segment is a multiple of 100px
  const ratios = ["1/3", "2/2", "3/1"] as const;
  for (const ratio of ratios) {
    const [d1, d2] = SCROLL_SPLIT_MAP[ratio];
    assert.equal(d1 + d2, 400);
    assert.equal(d1 % 100, 0);
    assert.equal(d2 % 100, 0);

    const split = calculateSplitDeltas(ratio);
    assert.equal(split.totalDelta, 400);
    assert.equal(split.firstDelta, d1);
    assert.equal(split.secondDelta, d2);
  }

  // 3. pickScrollSplit coverage with RNG
  const split1 = pickScrollSplit(() => 0.0); // 1/3
  assert.equal(split1.ratio, "1/3");
  assert.equal(split1.firstDelta, 100);
  assert.equal(split1.secondDelta, 300);

  const split2 = pickScrollSplit(() => 0.5); // 2/2
  assert.equal(split2.ratio, "2/2");
  assert.equal(split2.firstDelta, 200);
  assert.equal(split2.secondDelta, 200);

  const split3 = pickScrollSplit(() => 0.99); // 3/1
  assert.equal(split3.ratio, "3/1");
  assert.equal(split3.firstDelta, 300);
  assert.equal(split3.secondDelta, 100);

  // 4. evaluateScrollProgress
  const initial = evaluateScrollProgress(null, 500, 200);
  assert.equal(initial.moved, true);
  assert.equal(initial.priorScrollY, 500);

  const moved = evaluateScrollProgress(500, 700, 200);
  assert.equal(moved.moved, true);
  assert.equal(moved.actualDelta, 200);
  assert.equal(moved.stoppedReason, undefined);

  const stopped = evaluateScrollProgress(700, 700, 200);
  assert.equal(stopped.moved, false);
  assert.equal(stopped.actualDelta, 0);
  assert.equal(stopped.stoppedReason, "SCROLL_DID_NOT_MOVE");

  const stoppedBackwards = evaluateScrollProgress(700, 680, 200);
  assert.equal(stoppedBackwards.moved, false);
  assert.equal(stoppedBackwards.stoppedReason, "SCROLL_DID_NOT_MOVE");

  // 5. dedupeCandidates
  const baseCand: LiveCandidate = {
    candidateId: "cand_base",
    frameId: 1,
    bbox: { x: 50, y: 100, width: 300, height: 40 },
    score: 0.9,
    matchScore: 0.9,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "1111000011110000",
    docY: 1000,
  };

  const candDuplicate: LiveCandidate = {
    ...baseCand,
    candidateId: "cand_dup",
    docY: 1030, // within 70px
    fingerprint: "1111000011110001", // Hamming distance 1 (<= 18)
  };

  const candDifferentDocY: LiveCandidate = {
    ...baseCand,
    candidateId: "cand_diff_y",
    docY: 1200, // diff 200px (> 70px)
    fingerprint: "1111000011110000",
  };

  const candDifferentFp: LiveCandidate = {
    ...baseCand,
    candidateId: "cand_diff_fp",
    docY: 1010, // within 70px
    fingerprint: "0000111100001111",
  };
  // Ensure hamming distance > 18
  candDifferentFp.fingerprint = "0".repeat(32);
  const base64FpCand = { ...baseCand, fingerprint: "1".repeat(32) };

  const { merged, duplicateCount } = dedupeCandidates(
    [base64FpCand],
    [
      { ...base64FpCand, candidateId: "cand_b2_dup", docY: base64FpCand.docY + 20 }, // duplicate
      candDifferentDocY, // non-duplicate (docY)
      { ...candDifferentFp, docY: base64FpCand.docY + 10 }, // non-duplicate (fp diff = 32 > 18)
    ],
  );

  assert.equal(duplicateCount, 1);
  assert.equal(merged.length, 4);
  assert.equal(merged[1]!.status, "DUPLICATE");
  assert.equal(merged[2]!.status, "NEW_ITEM");
  assert.equal(merged[3]!.status, "NEW_ITEM");
});

test("Phase 4 & 5: Candidate-level Status, Post ID Dedupe, Overlapping & Disjoint frames", async () => {
  const {
    computeFrameCandidateCounts,
    deriveFrameBoundaryStatus,
    dedupeCandidates,
    extractCandidatePostIdentity,
  } = await import("../src/renderer/feed-item-collector/scroll-sampling.js");

  // 1. Task 1: Frame status aggregation & Candidate status isolation
  // Sample #3 scenario: 1 NEEDS_ATTENTION, 2 DUPLICATE
  const sample3Candidates: LiveCandidate[] = [
    {
      candidateId: "cand_s3_1",
      frameId: 3,
      bbox: { x: 10, y: 100, width: 300, height: 40 },
      score: 0.9,
      matchScore: 0.9,
      iconCount: 3,
      status: "NEEDS_ATTENTION",
      boundaryStatus: "BOUNDARY_NOT_FOUND",
      dedupeStatus: "NEW_ITEM",
      context: "post",
      fingerprint: "11111111",
      docY: 3450,
    },
    {
      candidateId: "cand_s3_2",
      frameId: 3,
      bbox: { x: 10, y: 300, width: 300, height: 40 },
      score: 0.88,
      matchScore: 0.88,
      iconCount: 3,
      status: "DUPLICATE",
      boundaryStatus: "BOUNDARY_FOUND", // Even if duplicate of a found post
      dedupeStatus: "DUPLICATE",
      context: "post",
      fingerprint: "22222222",
      docY: 3650,
    },
    {
      candidateId: "cand_s3_3",
      frameId: 3,
      bbox: { x: 10, y: 450, width: 300, height: 40 },
      score: 0.85,
      matchScore: 0.85,
      iconCount: 3,
      status: "DUPLICATE",
      boundaryStatus: "BOUNDARY_FOUND",
      dedupeStatus: "DUPLICATE",
      context: "post",
      fingerprint: "33333333",
      docY: 3800,
    },
  ];

  const counts = computeFrameCandidateCounts(sample3Candidates);
  assert.equal(counts.found, 0);
  assert.equal(counts.needsAttention, 1);
  assert.equal(counts.duplicate, 2);
  assert.equal(counts.total, 3);

  // Sample #3 must NOT be reported as BOUNDARY_FOUND!
  const s3FrameStatus = deriveFrameBoundaryStatus(sample3Candidates);
  assert.equal(s3FrameStatus, "BOUNDARY_NOT_FOUND");

  // Sample #2 scenario: 1 NEEDS_ATTENTION, 1 NEW_ITEM (FOUND), 1 DUPLICATE
  const sample2Candidates: LiveCandidate[] = [
    { ...sample3Candidates[0]!, candidateId: "cand_s2_1", frameId: 2 },
    {
      ...sample3Candidates[1]!,
      candidateId: "cand_s2_2",
      frameId: 2,
      status: "NEW_ITEM",
      boundaryStatus: "BOUNDARY_FOUND",
      dedupeStatus: "NEW_ITEM",
    },
    { ...sample3Candidates[2]!, candidateId: "cand_s2_3", frameId: 2 },
  ];
  const s2Counts = computeFrameCandidateCounts(sample2Candidates);
  assert.equal(s2Counts.found, 1);
  assert.equal(s2Counts.needsAttention, 1);
  assert.equal(s2Counts.duplicate, 1);
  assert.equal(deriveFrameBoundaryStatus(sample2Candidates), "BOUNDARY_AMBIGUOUS");

  // 2. Task 2: Dedupe cùng verified post ID (Tier 1)
  const candA: LiveCandidate = {
    candidateId: "cand_A",
    frameId: 1,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.95,
    matchScore: 0.95,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    postIdentity: { platform: "facebook", postId: "post_999888777" },
    context: "post",
    fingerprint: "10101010",
    docY: 2600,
  };

  const candB_samePostId: LiveCandidate = {
    candidateId: "cand_B",
    frameId: 2,
    bbox: { x: 20, y: 150, width: 300, height: 40 },
    score: 0.92,
    matchScore: 0.92,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    postIdentity: { platform: "facebook", postId: "post_999888777" }, // Trùng postId!
    context: "post",
    fingerprint: "11111111", // Khác fingerprint
    docY: 3000, // Khác docY 400px
  };

  const dedupePostIdRes = dedupeCandidates([], [candB_samePostId], [candA]);
  assert.equal(dedupePostIdRes.duplicateCount, 1);
  assert.equal(dedupePostIdRes.merged[0]!.dedupeStatus, "DUPLICATE");
  assert.equal(dedupePostIdRes.merged[0]!.status, "DUPLICATE");
  assert.match(dedupePostIdRes.merged[0]!.dedupeReason!, /POST_IDENTITY_MATCH/);

  // 3. Task 2: Dedupe giữa hai overlapping frames (Tier 2: docY <= 70 + fp dist <= 18)
  const candC_overlap: LiveCandidate = {
    candidateId: "cand_C",
    frameId: 2,
    bbox: { x: 20, y: 105, width: 300, height: 40 },
    score: 0.94,
    matchScore: 0.94,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "10101011", // Hamming distance = 1 (<= 18)
    docY: 2615, // docY diff = 15px (<= 70px)
  };

  const dedupeOverlapRes = dedupeCandidates([], [candC_overlap], [candA]);
  assert.equal(dedupeOverlapRes.duplicateCount, 1);
  assert.equal(dedupeOverlapRes.merged[0]!.dedupeStatus, "DUPLICATE");
  assert.match(dedupeOverlapRes.merged[0]!.dedupeReason!, /OVERLAPPING_ACTION_ROW/);

  // 4. Task 2: Hai bài khác nhau nhưng cùng author (không được dedupe thành duplicate)
  const candD_sameAuthorDifferentPost: LiveCandidate = {
    candidateId: "cand_D",
    frameId: 2,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.92,
    matchScore: 0.92,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    postIdentity: { platform: "facebook", postId: "post_111111", scope: "author_john_doe" },
    context: "post",
    fingerprint: "00000000",
    docY: 3000,
  };

  const candE_sameAuthorDifferentPost: LiveCandidate = {
    candidateId: "cand_E",
    frameId: 3,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.92,
    matchScore: 0.92,
    iconCount: 3,
    status: "NEW_ITEM",
    boundaryStatus: "BOUNDARY_FOUND",
    dedupeStatus: "NEW_ITEM",
    postIdentity: { platform: "facebook", postId: "post_222222", scope: "author_john_doe" }, // Cùng author, khác post ID!
    context: "post",
    fingerprint: "11111111",
    docY: 3400,
  };

  const dedupeAuthorRes = dedupeCandidates([], [candE_sameAuthorDifferentPost], [candD_sameAuthorDifferentPost]);
  assert.equal(dedupeAuthorRes.duplicateCount, 0);
  assert.equal(dedupeAuthorRes.merged[0]!.dedupeStatus, "NEW_ITEM");
  assert.equal(dedupeAuthorRes.merged[0]!.status, "NEW_ITEM");

  // 5. Task 2: Hai candidate chưa có URL (Sample #4 và #5 tại scrollY 3800 và 4200)
  // Hai bài cách nhau 400px không được gộp bừa chỉ vì đều không có URL
  const candF_s4_noUrl: LiveCandidate = {
    candidateId: "cand_s4_noUrl",
    frameId: 4,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.85,
    matchScore: 0.85,
    iconCount: 3,
    status: "NEEDS_ATTENTION",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "01010101",
    docY: 3900,
  };

  const candG_s5_noUrl: LiveCandidate = {
    candidateId: "cand_s5_noUrl",
    frameId: 5,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.84,
    matchScore: 0.84,
    iconCount: 3,
    status: "NEEDS_ATTENTION",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "01010101",
    docY: 4300, // Cách 400px!
  };

  const dedupeNoUrlRes = dedupeCandidates([], [candG_s5_noUrl], [candF_s4_noUrl]);
  assert.equal(dedupeNoUrlRes.duplicateCount, 0);
  assert.equal(dedupeNoUrlRes.merged[0]!.dedupeStatus, "NEW_ITEM");
  assert.equal(dedupeNoUrlRes.merged[0]!.status, "NEEDS_ATTENTION");

  // 6. Task 2: Nghi trùng nhưng chưa có post ID (Tier 3: POSSIBLE_DUPLICATE)
  const candH_suspect: LiveCandidate = {
    candidateId: "cand_suspect",
    frameId: 5,
    bbox: { x: 20, y: 100, width: 300, height: 40 },
    score: 0.84,
    matchScore: 0.84,
    iconCount: 3,
    status: "NEEDS_ATTENTION",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "01010111", // fp distance = 1
    docY: 3980, // docY diff = 80px (> 70px nhưng <= 120px)
  };

  const dedupeSuspectRes = dedupeCandidates([], [candH_suspect], [candF_s4_noUrl]);
  assert.equal(dedupeSuspectRes.duplicateCount, 0); // Không coi là DUPLICATE khẳng định
  assert.equal(dedupeSuspectRes.possibleDuplicateCount, 1);
  assert.equal(dedupeSuspectRes.merged[0]!.dedupeStatus, "POSSIBLE_DUPLICATE");
  assert.equal(dedupeSuspectRes.merged[0]!.status, "NEEDS_ATTENTION"); // Giữ nguyên candidate riêng với NEEDS_ATTENTION

  // 7. Task 3: URL Ownership - Exclude feed/neighbor URLs & non-post URLs
  const mockBoundaryWithFeedNeighbor = {
    status: "BOUNDARY_FOUND",
    boundaryCrossedLevel: 3,
    ancestorSteps: [
      {
        level: 1,
        tag: "div",
        role: "article",
        rawUrls: ["https://www.facebook.com/groups/123/posts/99999/"],
        postIdentities: [{ platform: "facebook", postId: "99999" }],
      },
      {
        level: 3, // at crossed level (feed level)
        tag: "div",
        role: "feed",
        rawUrls: ["https://www.facebook.com/groups/123/posts/88888_neighbor/"],
        postIdentities: [{ platform: "facebook", postId: "88888_neighbor" }],
      },
    ],
  } as any;

  const ownIdentity = extractCandidatePostIdentity(mockBoundaryWithFeedNeighbor);
  assert.equal(ownIdentity?.postId, "99999");
  assert.notEqual(ownIdentity?.postId, "88888_neighbor");

  // Non-post URL /groups/{groupId}/?__cft__... must NOT produce post identity
  const mockBoundaryWithGroupHomeUrl = {
    status: "BOUNDARY_NOT_FOUND",
    boundaryCrossedLevel: 2,
    ancestorSteps: [
      {
        level: 1,
        tag: "div",
        role: null,
        rawUrls: ["https://www.facebook.com/groups/12345/?__cft__[0]=AZX..."],
        postIdentities: [],
      },
    ],
  } as any;
  const noPostIdentity = extractCandidatePostIdentity(mockBoundaryWithGroupHomeUrl);
  assert.equal(noPostIdentity, undefined);
});

test("Phase 5: Task 1-5 URL Confirmation & Offline Boundary Re-evaluation", () => {
  // Mock localStorage for Node test runner
  const storageMap = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
    removeItem: (key: string) => { storageMap.delete(key); },
    clear: () => { storageMap.clear(); },
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    length: 0,
  } as any;

  // 1. Task 3: URL Non-post Validations
  // Group Member URL
  const memberRes = validatePostUrlForConfirmation("https://www.facebook.com/groups/techgroup/user/1000222/");
  assert.equal(memberRes.valid, false);
  assert.equal(memberRes.classification, "GROUP_MEMBER");
  assert.match(memberRes.reason!, /Group Member/);

  // Profile URL without post
  const profileRes = validatePostUrlForConfirmation("https://www.facebook.com/profile.php?id=1000888999");
  assert.equal(profileRes.valid, false);
  assert.equal(profileRes.classification, "PROFILE");

  // Group Homepage
  const groupHomeRes = validatePostUrlForConfirmation("https://www.facebook.com/groups/123456789/");
  assert.equal(groupHomeRes.valid, false);
  assert.equal(groupHomeRes.classification, "GROUP_HOME");

  // Tracking query only
  const trackingRes = validatePostUrlForConfirmation("https://www.facebook.com/?__cft__[0]=AZX123&__tn__=R");
  assert.equal(trackingRes.valid, false);
  assert.equal(trackingRes.classification, "TRACKING_ONLY");

  const groupTrackingRes = validatePostUrlForConfirmation("https://www.facebook.com/groups/123456789/?__cft__[0]=AZX123");
  assert.equal(groupTrackingRes.valid, false);
  assert.equal(groupTrackingRes.classification, "TRACKING_ONLY");

  // 2. Task 3: Valid Post URL Validation
  const validPostRes = validatePostUrlForConfirmation("https://www.facebook.com/groups/12345/posts/999888/");
  assert.equal(validPostRes.valid, true);
  assert.equal(validPostRes.classification, "POST");
  assert.equal(validPostRes.postIdentity?.postId, "999888");

  // 3. Task 2 & 5: Confirm URL hợp lệ và re-evaluate offline thành công
  const ancestorTrajectory = [
    {
      level: 1,
      tag: "div",
      id: "action_row_parent",
      className: "row-wrapper",
      role: null,
      rect: { x: 10, y: 100, width: 300, height: 40 },
      rawUrls: ["https://www.facebook.com/groups/12345/posts/999888/"],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 2,
      tag: "div",
      id: "card_container",
      className: "feed-card",
      role: "article",
      rect: { x: 8, y: 50, width: 320, height: 250 },
      rawUrls: ["https://www.facebook.com/groups/12345/posts/999888/"],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 3,
      tag: "div",
      id: "feed_wrapper",
      className: "feed-stream",
      role: "feed",
      rect: { x: 0, y: 0, width: 400, height: 1000 },
      rawUrls: [
        "https://www.facebook.com/groups/12345/posts/999888/",
        "https://www.facebook.com/groups/12345/posts/111222_neighbor/",
      ],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
  ];

  const candNeedsAttention: LiveCandidate = {
    candidateId: "cand_test_confirm",
    frameId: 1,
    bbox: { x: 10, y: 100, width: 300, height: 40 },
    score: 0.9,
    matchScore: 0.9,
    iconCount: 3,
    status: "NEEDS_ATTENTION",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    dedupeStatus: "NEW_ITEM",
    context: "post",
    fingerprint: "11001100",
    docY: 1000,
    boundary: {
      status: "BOUNDARY_NOT_FOUND",
      actionPoint: { x: 30, y: 110 },
      ancestorsChecked: 3,
      firstPermalinkLevel: null,
      secondPermalinkLevel: null,
      boundaryCrossedLevel: null,
      postIdentities: [],
      candidateContainer: null,
      crossedContainer: null,
      hasQuoteOrSharedPostRisk: false,
      riskReason: "No permalink matched",
      ownershipEvidence: { isArticle: false, hasDistinctCardLayout: false, containsActionRow: false, notes: [] },
      ancestorSteps: ancestorTrajectory,
    },
  };

  const reevalRes = reevaluateCandidateBoundaryOffline({
    candidate: candNeedsAttention,
    rules: [],
    confirmedUrl: "https://www.facebook.com/groups/12345/posts/999888/",
    source: "USER_CONFIRMATION",
  });

  assert.equal(reevalRes.success, true);
  if (reevalRes.success) {
    assert.equal(reevalRes.beforeStatus, "BOUNDARY_NOT_FOUND");
    assert.equal(reevalRes.afterStatus, "BOUNDARY_FOUND");
    assert.equal(reevalRes.beforeDisplayStatus, "NEEDS_ATTENTION");
    assert.equal(reevalRes.afterDisplayStatus, "FOUND");
    assert.equal(reevalRes.updatedCandidate.status, "NEW_ITEM");
    assert.equal(reevalRes.updatedCandidate.postIdentity?.postId, "999888");
    assert.ok(reevalRes.updatedCandidate.verificationTypes?.includes("URL_VERIFIED"));
    assert.ok(reevalRes.updatedCandidate.verificationTypes?.includes("BOUNDARY_CONFIRMED"));

    // Check revision history
    assert.equal(reevalRes.updatedCandidate.evaluationRevisions?.length, 1);
    assert.equal(reevalRes.updatedCandidate.latestRevision?.source, "USER_CONFIRMATION");
    assert.equal(reevalRes.updatedCandidate.latestRevision?.beforeStatus, "BOUNDARY_NOT_FOUND");
    assert.equal(reevalRes.updatedCandidate.latestRevision?.afterStatus, "BOUNDARY_FOUND");

    // Raw evidence remains immutable
    assert.equal(reevalRes.updatedCandidate.rawEvidence?.initialBoundary.status, "BOUNDARY_NOT_FOUND");
  }

  // 4. Task 5: Bổ sung permalink rule mới rồi re-evaluate
  const customPhotoUrl = "https://www.facebook.com/photo.php?fbid=987654321&set=pcb.7766554433";
  const customPhotoTrajectory = [
    {
      level: 1,
      tag: "div",
      id: "photo_row",
      className: "row",
      role: null,
      rect: { x: 10, y: 100, width: 300, height: 40 },
      rawUrls: [customPhotoUrl],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 2,
      tag: "div",
      id: "photo_card",
      className: "card",
      role: "article",
      rect: { x: 8, y: 50, width: 320, height: 250 },
      rawUrls: [customPhotoUrl],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 3,
      tag: "div",
      id: "feed",
      className: "feed",
      role: "feed",
      rect: { x: 0, y: 0, width: 400, height: 1000 },
      rawUrls: [
        customPhotoUrl,
        "https://www.facebook.com/groups/123/posts/222_neighbor/",
      ],
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
  ];

  const candCustomPhoto: LiveCandidate = {
    ...candNeedsAttention,
    candidateId: "cand_custom_photo",
    boundary: {
      ...candNeedsAttention.boundary!,
      ancestorSteps: customPhotoTrajectory,
    },
  };

  const customRule: UserPermalinkRule = {
    id: "rule_custom_photo_pcb",
    name: "Custom Photo PCB",
    platform: "facebook",
    template: "https://www.facebook.com/photo.php?fbid={photoId}&set=pcb.{postId}",
    enabled: true,
  };

  const reevalRuleRes = reevaluateCandidateBoundaryOffline({
    candidate: candCustomPhoto,
    rules: [customRule],
    source: "RULE_SAVED",
    ruleId: customRule.id,
  });

  assert.equal(reevalRuleRes.success, true);
  if (reevalRuleRes.success) {
    assert.equal(reevalRuleRes.afterStatus, "BOUNDARY_FOUND");
    assert.equal(reevalRuleRes.updatedCandidate.postIdentity?.postId, "7766554433");
    assert.equal(reevalRuleRes.updatedCandidate.latestRevision?.ruleId, "rule_custom_photo_pcb");
  }

  // 5. Task 4 & 5: Hai candidates cùng frame (Không ghi đè candidate khác & không làm mất DUPLICATE status)
  const candDuplicate: LiveCandidate = {
    candidateId: "cand_duplicate_prev",
    frameId: 1,
    bbox: { x: 10, y: 200, width: 300, height: 40 },
    score: 0.92,
    matchScore: 0.92,
    iconCount: 3,
    status: "DUPLICATE",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    dedupeStatus: "DUPLICATE",
    context: "post",
    fingerprint: "11001100",
    docY: 800,
  };

  const sampleFrameReport: FrameReport = {
    frame: 1,
    capture: {
      id: "cap_1",
      dataUrl: "data:image/png;base64,mock",
      width: 1024,
      height: 560,
      url: "https://facebook.com",
      viewport: { width: 1024, height: 560, scrollX: 0, scrollY: 1000, dpr: 1, url: "https://facebook.com" },
      webContentsId: 1,
    },
    captureStatus: "CAPTURE_PASS",
    pipelineStatus: "OK",
    templateStatus: "READY",
    detectionStatus: "DETECTION_PASS",
    boundaryStatus: "BOUNDARY_NOT_FOUND",
    rawIconMatches: 2,
    actionClusters: 2,
    candidates: [candNeedsAttention, candDuplicate],
  };

  const updatedReports = updateCandidateInReports(
    [sampleFrameReport],
    0,
    0,
    reevalRes.success ? reevalRes.updatedCandidate : candNeedsAttention,
  );

  // Candidate #1 was updated to FOUND
  assert.equal(updatedReports[0]!.candidates[0]!.boundaryStatus, "BOUNDARY_FOUND");
  assert.equal(updatedReports[0]!.candidates[0]!.status, "NEW_ITEM");

  // Candidate #2 DUPLICATE is preserved untouched!
  assert.equal(updatedReports[0]!.candidates[1]!.candidateId, "cand_duplicate_prev");
  assert.equal(updatedReports[0]!.candidates[1]!.status, "DUPLICATE");
  assert.equal(updatedReports[0]!.candidates[1]!.dedupeStatus, "DUPLICATE");

  // Sample frame boundary aggregation: 1 found, 0 needs_attention -> BOUNDARY_FOUND
  assert.equal(updatedReports[0]!.boundaryStatus, "BOUNDARY_FOUND");

  // 6. Task 5: Re-evaluate với evidence không đầy đủ (INSUFFICIENT_EVIDENCE)
  const candNoEvidence: LiveCandidate = {
    ...candNeedsAttention,
    candidateId: "cand_no_evidence",
    boundary: undefined,
    rawEvidence: undefined,
  };
  const missingEvidRes = reevaluateCandidateBoundaryOffline({
    candidate: candNoEvidence,
    rules: [],
    source: "OFFLINE_REEVALUATION",
  });
  assert.equal(missingEvidRes.success, false);
  if (!missingEvidRes.success) {
    assert.equal(missingEvidRes.error, "INSUFFICIENT_EVIDENCE");
  }

  // 7. Task 5: Reload app và xem lại evaluation revision
  resetFeedCollectorRun();
  setFeedCollectorState({
    reports: updatedReports,
    summaryStats: computeRunSummaryStats(updatedReports),
    currentRunId: "run_test_persistence",
  });

  // Verify stored in localStorage
  const loadedState = hydrateFeedCollectorFromStorage();
  assert.equal(loadedState.reports.length, 1);
  const reloadedCand = loadedState.reports[0]!.candidates[0]!;
  assert.equal(reloadedCand.boundaryStatus, "BOUNDARY_FOUND");
  assert.equal(reloadedCand.evaluationRevisions?.length, 1);
  assert.equal(reloadedCand.latestRevision?.beforeStatus, "BOUNDARY_NOT_FOUND");
  assert.equal(reloadedCand.latestRevision?.afterStatus, "BOUNDARY_FOUND");
  assert.equal(reloadedCand.latestRevision?.matchedPostIdentity?.postId, "999888");
});
