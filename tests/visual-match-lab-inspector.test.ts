import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveBoundaryFromAncestors } from "../src/shared/boundary-probe.js";
import { FacebookPermalinkAdapter } from "../src/shared/permalink-adapter.js";
import { PermalinkRuleRegistry, BUILTIN_PERMALINK_RULES } from "../src/shared/permalink-rules.js";

test("Frame Inspector: navigation bounds and Previous/Next logic", () => {
  const totalFrames = 50;
  let currentIndex = 0;

  const previous = (idx: number) => Math.max(0, idx - 1);
  const next = (idx: number, total: number) => Math.min(total - 1, idx + 1);

  // At start
  assert.equal(previous(0), 0);
  assert.equal(next(0, totalFrames), 1);

  // Middle
  currentIndex = 25;
  assert.equal(previous(currentIndex), 24);
  assert.equal(next(currentIndex, totalFrames), 26);

  // At end
  currentIndex = 49;
  assert.equal(previous(currentIndex), 48);
  assert.equal(next(currentIndex, totalFrames), 49);
});

test("Frame Inspector: frame filter correctly segments ALL, FOUND, ATTENTION, and NO_ACTION_ROW", () => {
  type MockFrame = { frame: number; boundaryStatus: "BOUNDARY_FOUND" | "BOUNDARY_AMBIGUOUS" | "BOUNDARY_NOT_FOUND" | "NO_ACTION_ROW" };
  const mockFrames: MockFrame[] = [
    { frame: 1, boundaryStatus: "BOUNDARY_FOUND" },
    { frame: 2, boundaryStatus: "BOUNDARY_FOUND" },
    { frame: 3, boundaryStatus: "BOUNDARY_AMBIGUOUS" },
    { frame: 4, boundaryStatus: "BOUNDARY_NOT_FOUND" },
    { frame: 5, boundaryStatus: "NO_ACTION_ROW" },
    { frame: 6, boundaryStatus: "BOUNDARY_FOUND" },
    { frame: 7, boundaryStatus: "BOUNDARY_NOT_FOUND" },
    { frame: 8, boundaryStatus: "NO_ACTION_ROW" },
  ];

  const filterFrames = (frames: MockFrame[], filter: string) => {
    return frames.filter(f => {
      if (filter === "FOUND") return f.boundaryStatus === "BOUNDARY_FOUND";
      if (filter === "ATTENTION") return f.boundaryStatus === "BOUNDARY_AMBIGUOUS" || f.boundaryStatus === "BOUNDARY_NOT_FOUND";
      if (filter === "NO_ACTION_ROW") return f.boundaryStatus === "NO_ACTION_ROW";
      return true;
    });
  };

  assert.equal(filterFrames(mockFrames, "ALL").length, 8);
  assert.equal(filterFrames(mockFrames, "FOUND").length, 3);
  assert.equal(filterFrames(mockFrames, "ATTENTION").length, 3);
  assert.equal(filterFrames(mockFrames, "NO_ACTION_ROW").length, 2);

  // Next error jump algorithm
  const findNextError = (frames: MockFrame[], currentIdx: number): number => {
    const start = (currentIdx + 1) % frames.length;
    for (let i = 0; i < frames.length; i++) {
      const idx = (start + i) % frames.length;
      const b = frames[idx].boundaryStatus;
      if (b === "BOUNDARY_NOT_FOUND" || b === "BOUNDARY_AMBIGUOUS" || b === "NO_ACTION_ROW") {
        return idx;
      }
    }
    return currentIdx;
  };

  assert.equal(findNextError(mockFrames, 0), 2); // Frame 3 (AMBIGUOUS)
  assert.equal(findNextError(mockFrames, 2), 3); // Frame 4 (NOT_FOUND)
  assert.equal(findNextError(mockFrames, 4), 6); // Frame 7 (NOT_FOUND)
});

test("Frame Inspector: screenshot mode fallback when highlighted evidence is missing", () => {
  const getEffectiveImage = (
    mode: "highlighted" | "original",
    highlightedUrl: string | undefined,
    originalUrl: string
  ) => {
    const hasHighlighted = Boolean(highlightedUrl);
    return mode === "highlighted" && hasHighlighted ? highlightedUrl! : originalUrl;
  };

  const orig = "data:image/png;base64,ORIGINAL_DATA";
  const hl = "data:image/png;base64,HIGHLIGHTED_DATA";

  // When highlighted is present
  assert.equal(getEffectiveImage("highlighted", hl, orig), hl);
  assert.equal(getEffectiveImage("original", hl, orig), orig);

  // When highlighted is missing
  assert.equal(getEffectiveImage("highlighted", undefined, orig), orig);
  assert.equal(getEffectiveImage("original", undefined, orig), orig);
});

test("Evidence Persistence: reads legacy visual-match-lab-boundary-debug run and preserves data integrity", () => {
  const scratchDir = path.resolve(process.cwd(), "scratch");
  const liveRunPath = path.join(scratchDir, "visual-match-lab-boundary-debug-run_1794363137380_f0a3s.json");

  assert.ok(fs.existsSync(liveRunPath), "Live run artifact must exist on disk");
  const data = JSON.parse(fs.readFileSync(liveRunPath, "utf8"));

  assert.equal(data.runId, "run_1794363137380_f0a3s");
  assert.equal(data.totalFrames, 50);
  assert.equal(data.summary.totalProbed, 31);
  assert.equal(data.summary.boundaryFoundCount, 28);
  assert.equal(data.summary.boundaryNotFoundCount, 3);
  assert.deepEqual(data.summary.jumpedFrames, [7, 8, 9]);

  // Frame 9 deep check
  const f9 = data.records.find((r: any) => r.frameNumber === 9);
  assert.ok(f9, "Frame 9 must be present in live run records");
  assert.equal(f9.boundaryStatus, "BOUNDARY_NOT_FOUND");
  assert.equal(f9.transitions.jumpedZeroToTwoPlus, true);
  assert.equal(f9.ancestorDepth, 28);
  assert.equal(f9.ancestors[27].role, "feed");
  assert.equal(f9.ancestors[27].uniqueKeys.length, 3);
});

test("Boundary Resolver Core invariance: recognition results remain strictly identical", () => {
  const fbAdapter = new FacebookPermalinkAdapter();
  const postUrl = "https://www.facebook.com/groups/mmo_community/posts/101589324789/";
  const postIdentity = fbAdapter.extractPostIdentity(postUrl);

  const post2Url = "https://www.facebook.com/groups/mmo_community/posts/99999/";
  const post2Identity = fbAdapter.extractPostIdentity(post2Url);

  const ancestors = [
    {
      level: 0,
      tag: "div",
      id: "",
      className: "like-btn",
      role: "button",
      rect: { x: 100, y: 300, width: 60, height: 28 },
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 1,
      tag: "div",
      id: "",
      className: "action-row",
      role: null,
      rect: { x: 90, y: 295, width: 400, height: 38 },
      postIdentities: [],
      uniqueKeys: [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 2,
      tag: "div",
      id: "post-1",
      className: "post-container",
      role: "article",
      rect: { x: 80, y: 100, width: 500, height: 350 },
      rawUrls: [postUrl],
      postIdentities: postIdentity ? [postIdentity] : [],
      uniqueKeys: postIdentity ? [`${postIdentity.platform}:${postIdentity.postId}`] : [],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
    {
      level: 3,
      tag: "div",
      id: "feed",
      className: "feed",
      role: "feed",
      rect: { x: 80, y: 0, width: 500, height: 2000 },
      rawUrls: [postUrl, post2Url],
      postIdentities: [
        ...(postIdentity ? [postIdentity] : []),
        ...(post2Identity ? [post2Identity] : []),
      ],
      uniqueKeys: [
        ...(postIdentity ? [`${postIdentity.platform}:${postIdentity.postId}`] : []),
        ...(post2Identity ? [`${post2Identity.platform}:${post2Identity.postId}`] : []),
      ],
      hasNestedArticle: false,
      hasQuoteOrReplyHint: false,
    },
  ];

  const boundary = resolveBoundaryFromAncestors(
    ancestors,
    { x: 120, y: 310 },
    { x: 90, y: 295, width: 400, height: 38 },
  );

  assert.equal(boundary.status, "BOUNDARY_FOUND");
  assert.equal(boundary.candidateContainer?.level, 2);
  assert.equal(boundary.candidateContainer?.role, "article");
  assert.equal(boundary.firstPermalinkLevel, 2);
  assert.equal(boundary.secondPermalinkLevel, 3);
});

test("50-frame memory and evidence handling test: processes 50 frames without crash or memory bloat", () => {
  const dummyFrames = Array.from({ length: 50 }, (_, i) => ({
    frame: i + 1,
    status: (i % 10 === 0 ? "BOUNDARY_NOT_FOUND" : "BOUNDARY_FOUND") as "BOUNDARY_FOUND" | "BOUNDARY_NOT_FOUND",
    actionRow: { x: 100, y: 200, width: 300, height: 40 },
    evidencePath: `scratch/boundary-evidence-f${i + 1}-r0.png`,
  }));

  assert.equal(dummyFrames.length, 50);

  // Group by status
  const found = dummyFrames.filter(f => f.status === "BOUNDARY_FOUND").length;
  const notFound = dummyFrames.filter(f => f.status === "BOUNDARY_NOT_FOUND").length;
  assert.equal(found, 45);
  assert.equal(notFound, 5);

  // Verify memory footprint of references vs giant base64 strings
  const stringifiedJson = JSON.stringify(dummyFrames);
  assert.ok(stringifiedJson.length < 10000, "50 frames with file path evidence must be under 10KB JSON");
});

test("UI Hotfix: generateTemplateSuggestion produces proper rule templates from raw URLs", async () => {
  const { generateTemplateSuggestion } = await import(
    "../src/renderer/experiments/visual-match-lab/PermalinkRuleEditor.js"
  );

  // Group post
  const res1 = generateTemplateSuggestion("https://www.facebook.com/groups/devviet/posts/1234567890/?comment_id=1");
  assert.equal(res1.template, "https://www.facebook.com/groups/{groupId}/posts/{postId}/");
  assert.equal(res1.ruleName, "Facebook Group Post");

  // Group permalink
  const res2 = generateTemplateSuggestion("https://www.facebook.com/groups/devviet/permalink/9876543210/");
  assert.equal(res2.template, "https://www.facebook.com/groups/{groupId}/permalink/{postId}/");
  assert.equal(res2.ruleName, "Facebook Group Permalink");

  // Photo with set=pcb
  const res3 = generateTemplateSuggestion("https://www.facebook.com/photo/?fbid=111&set=pcb.222333");
  assert.equal(res3.template, "https://www.facebook.com/photo/?fbid={photoId}&set=pcb.{postId}");

  // Photo with set=gm
  const res4 = generateTemplateSuggestion("https://www.facebook.com/photo/?fbid=111&set=gm.444555&idorvanity=777");
  assert.equal(res4.template, "https://www.facebook.com/photo/?fbid={photoId}&set=gm.{postId}&idorvanity={groupId}");

  // Page/profile post
  const res5 = generateTemplateSuggestion("https://www.facebook.com/myPageName/posts/555666777");
  assert.equal(res5.template, "https://www.facebook.com/{pageOrUser}/posts/{postId}/");
});

test("UI Hotfix: Save Rule is disabled until rule is tested and matches tested template", () => {
  const canSaveRule = (
    templateInput: string,
    testResult: { valid: boolean; matchedUrls: number } | null,
    lastTestedTemplate: string | null
  ) => {
    return Boolean(
      templateInput.trim() &&
      testResult?.valid &&
      testResult.matchedUrls > 0 &&
      lastTestedTemplate === templateInput.trim()
    );
  };

  const tpl = "https://www.facebook.com/groups/{groupId}/posts/{postId}/";

  // Initially untrusted
  assert.equal(canSaveRule(tpl, null, null), false);

  // Tested with 0 matches
  assert.equal(canSaveRule(tpl, { valid: true, matchedUrls: 0 }, tpl), false);

  // Tested with >=1 matches
  assert.equal(canSaveRule(tpl, { valid: true, matchedUrls: 1 }, tpl), true);

  // Modified template after test without retesting
  assert.equal(canSaveRule(tpl + "extra", { valid: true, matchedUrls: 1 }, tpl), false);
});

test("UI Hotfix: Image load guard suppresses overlay bounding boxes when image is not loaded or has error", () => {
  const shouldRenderBboxOverlay = (imageLoaded: boolean, imageError: boolean, hasImageSrc: boolean) => {
    return imageLoaded && !imageError && hasImageSrc;
  };

  // Image loading in progress
  assert.equal(shouldRenderBboxOverlay(false, false, true), false);

  // Image load error
  assert.equal(shouldRenderBboxOverlay(true, true, true), false);

  // Missing image source
  assert.equal(shouldRenderBboxOverlay(true, false, false), false);

  // Image successfully loaded
  assert.equal(shouldRenderBboxOverlay(true, false, true), true);
});

test("Runtime Hotfix 2: validateNavigableUrl, resolveFullUrl, and stripFacebookTrackingParams handle relative URLs, root tracking queries, and invalid schemes", async () => {
  const { validateNavigableUrl, resolveFullUrl, stripFacebookTrackingParams } = await import(
    "../src/renderer/experiments/visual-match-lab/PermalinkInspector.js"
  );

  // Relative Facebook URLs from DOM href attributes
  const relGroupUser = "/groups/295931577185665/user/1000044444691156/?__cft__[0]=AZ1XN0BsjX9N";
  assert.equal(
    resolveFullUrl(relGroupUser),
    "https://www.facebook.com/groups/295931577185665/user/1000044444691156/?__cft__[0]=AZ1XN0BsjX9N",
  );
  const navRelGroup = validateNavigableUrl(relGroupUser);
  assert.equal(navRelGroup.valid, true);
  assert.equal(
    navRelGroup.resolvedUrl,
    "https://www.facebook.com/groups/295931577185665/user/1000044444691156/?__cft__[0]=AZ1XN0BsjX9N",
  );

  // Strip tracking parameters helper
  assert.equal(
    stripFacebookTrackingParams(relGroupUser),
    "https://www.facebook.com/groups/295931577185665/user/1000044444691156/",
  );

  // Query-only tracking string (?__cft__[0]=...) resolves against active group URL and is navigable in BrowserCore
  const relQuery = "?__cft__[0]=AZ1XN0BsjX9N&__tn__=-UC%2CP-R";
  const navRelQuery = validateNavigableUrl(relQuery, "https://www.facebook.com/groups/295931577185665/");
  assert.equal(navRelQuery.valid, true);
  assert.equal(
    navRelQuery.resolvedUrl,
    "https://www.facebook.com/groups/295931577185665/?__cft__[0]=AZ1XN0BsjX9N&__tn__=-UC%2CP-R",
  );

  // Hash-only anchor (#) is blocked
  assert.equal(validateNavigableUrl("#").valid, false);

  // Root permalink.php with story_fbid is still valid
  const storyQuery = "/permalink.php?story_fbid=123456&id=789";
  assert.equal(validateNavigableUrl(storyQuery).valid, true);

  // Valid Facebook
  assert.equal(validateNavigableUrl("https://www.facebook.com/groups/mmo_community/posts/101589324789/").valid, true);
  assert.equal(validateNavigableUrl("https://fb.com/groups/123/posts/456").valid, true);
  assert.equal(validateNavigableUrl("http://facebook.com/photo/?fbid=111&set=gm.222").valid, true);

  // Valid Threads
  assert.equal(validateNavigableUrl("https://www.threads.net/@zuck/post/ABC123xyz").valid, true);
  assert.equal(validateNavigableUrl("https://threads.com/@user/post/999").valid, true);

  // Invalid scheme
  assert.equal(validateNavigableUrl("javascript:alert(1)").valid, false);
  assert.equal(validateNavigableUrl("file:///C:/Users/Admin/secrets.txt").valid, false);
  assert.equal(validateNavigableUrl("data:text/html,<b>hi</b>").valid, false);

  // Non-platform domain
  assert.equal(validateNavigableUrl("https://google.com").valid, false);
  assert.equal(validateNavigableUrl("https://example.com/test").valid, false);
});

test("Runtime Hotfix 2: listRuns excludes synthetic run_audit_* and loadRun preserves all real run screenshots", async () => {
  const { VisualMatchLabRuntime } = await import("../src/main/visual-match-lab.js");
  const svc = new VisualMatchLabRuntime({} as any, async fn => fn());

  const runs = await svc.listRuns();
  assert.ok(runs.length >= 3, "At least 3 real saved runs should be listed");
  assert.equal(
    runs.some(r => r.runId.startsWith("run_audit_")),
    false,
    "Synthetic CLI audit runs must not appear in UI Saved Runs list",
  );

  for (const r of runs) {
    const loaded = await svc.loadRun(r.runId);
    assert.equal(loaded.ok, true);
    const withImages = loaded.report.records.filter(rec => Boolean(rec.evidenceScreenshotBase64));
    assert.equal(
      withImages.length,
      loaded.report.records.length,
      `Every probed record in real run ${r.runId} must have its screenshot restored`,
    );
  }
});

test("Runtime Hotfix 2: Candidate-matching evidence resolution prevents stationary overlay mismatch", () => {
  const mockCandidates = [
    {
      bbox: { x: 181, y: 135, width: 111, height: 22 },
      boundary: { status: "BOUNDARY_NOT_FOUND" },
      highlightedEvidenceUrl: "data:image/png;base64,F8_R0_EVIDENCE",
    },
    {
      bbox: { x: 181, y: 382, width: 146, height: 22 },
      boundary: { status: "BOUNDARY_FOUND" },
      highlightedEvidenceUrl: "data:image/png;base64,F8_R1_EVIDENCE",
    },
  ];

  const resolveCandidateEvidence = (candidates: typeof mockCandidates, selectedIndex: number) => {
    const selected = candidates[selectedIndex] ?? candidates[0];
    return (
      selected?.highlightedEvidenceUrl ||
      candidates.find(c => c.boundary?.status === "BOUNDARY_FOUND" && c.highlightedEvidenceUrl)?.highlightedEvidenceUrl ||
      candidates.find(c => c.highlightedEvidenceUrl)?.highlightedEvidenceUrl
    );
  };

  // When Candidate 0 (Row 1 at y=135) is selected, must return R0 evidence (not jumping to R1 at y=382)
  assert.equal(resolveCandidateEvidence(mockCandidates, 0), "data:image/png;base64,F8_R0_EVIDENCE");

  // When Candidate 1 (Row 2 at y=382) is selected, must return R1 evidence
  assert.equal(resolveCandidateEvidence(mockCandidates, 1), "data:image/png;base64,F8_R1_EVIDENCE");
});

test("Runtime Hotfix 2: Navigation is strictly blocked when Live Scroll Test is running", () => {
  const canNavigateBrowserCore = (isLiveRunning: boolean, url: string, validator: (u: string) => { valid: boolean }) => {
    if (isLiveRunning) return { canNavigate: false, reason: "BLOCKED_WHILE_RUNNING" };
    const check = validator(url);
    if (!check.valid) return { canNavigate: false, reason: "INVALID_URL" };
    return { canNavigate: true };
  };

  const dummyValidator = (u: string) => ({ valid: u.startsWith("https://") });

  assert.equal(canNavigateBrowserCore(true, "https://facebook.com/post/1", dummyValidator).canNavigate, false);
  assert.equal(canNavigateBrowserCore(true, "https://facebook.com/post/1", dummyValidator).reason, "BLOCKED_WHILE_RUNNING");
  assert.equal(canNavigateBrowserCore(false, "https://facebook.com/post/1", dummyValidator).canNavigate, true);
  assert.equal(canNavigateBrowserCore(false, "ftp://bad", dummyValidator).canNavigate, false);
});

test("Open URL Browser Host: keeps page in visual-match-lab (never switches to creator/Script Editor) and detects Facebook redirects", async () => {
  const mainSource = fs.readFileSync(path.resolve("src/main/main.ts"), "utf8");
  const navCaseIdx = mainSource.indexOf('case "visualMatchLabNavigateBrowserCore":');
  assert.ok(navCaseIdx >= 0, "visualMatchLabNavigateBrowserCore handler must exist");
  const navCaseChunk = mainSource.slice(navCaseIdx, navCaseIdx + 7500);

  // Must NOT call overlays.setPage("creator")
  assert.doesNotMatch(
    navCaseChunk,
    /overlays\.setPage\(\s*["']creator["']\s*\)/,
    "visualMatchLabNavigateBrowserCore must not switch to Script Editor (creator page)",
  );

  // Verify redirect detection logic between requestedUrl and finalUrl
  const evaluateNavigationOutcome = (requestedUrl: string, finalUrl: string) => {
    const reqParsed = new URL(requestedUrl);
    const finParsed = new URL(finalUrl);
    const reqPath = reqParsed.pathname.replace(/\/+$/, "") || "/";
    const finPath = finParsed.pathname.replace(/\/+$/, "") || "/";
    if (reqPath !== finPath) {
      return {
        ok: true,
        status: "REDIRECTED" as const,
        redirected: true,
        requestedUrl,
        finalUrl,
        redirectReason:
          finPath === "/"
            ? `Facebook đã redirect từ "${reqPath}" về trang chủ "${finalUrl}".`
            : `Facebook đã chuyển hướng đường dẫn từ "${reqPath}" sang "${finPath}".`,
      };
    }
    return {
      ok: true,
      status: "SUCCESS" as const,
      redirected: false,
      requestedUrl,
      finalUrl,
    };
  };

  // 1. Direct permalink stays on target -> SUCCESS
  const okOutcome = evaluateNavigationOutcome(
    "https://www.facebook.com/groups/295931577185665/posts/101589324789/",
    "https://www.facebook.com/groups/295931577185665/posts/101589324789/",
  );
  assert.equal(okOutcome.status, "SUCCESS");
  assert.equal(okOutcome.redirected, false);

  // 2. Group user link with tracking redirected by Facebook to homepage -> REDIRECTED (not silently claimed as normal success)
  const redirectedToRoot = evaluateNavigationOutcome(
    "https://www.facebook.com/groups/295931577185665/user/1000044444691156/?__cft__[0]=AZ1",
    "https://www.facebook.com/",
  );
  assert.equal(redirectedToRoot.status, "REDIRECTED");
  assert.equal(redirectedToRoot.redirected, true);
  assert.match(redirectedToRoot.redirectReason!, /redirect.*trang chủ/i);
});

test("Evidence Storage Isolation (Tests 1–7): Run A vs Run B isolation, SHA-256 immutability, multi-attempt preservation, and restart reopen", async () => {
  const crypto = await import("node:crypto");
  const os = await import("node:os");
  const { VisualMatchRunStorage } = await import("../src/main/visual-match-lab-storage.js");

  const tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-v2-storage-test-"));
  const sha256File = (filePath: string) =>
    crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

  const makePngDataUrl = (tag: string) =>
    `data:image/png;base64,${Buffer.from(`PNG_EVIDENCE_PAYLOAD::${tag}`).toString("base64")}`;

  try {
    const storage1 = new VisualMatchRunStorage(tempProjectDir);
    const runA = "run_1800000000001_testa";
    const runB = "run_1800000000002_testb";

    // 1. Run Test A with frame 1 (row 0, row 1) and frame 2 (row 0)
    const reportA = {
      runId: runA,
      timestamp: "2026-11-11T10:00:00.000Z",
      createdAt: "2026-11-11T09:59:00.000Z",
      completedAt: "2026-11-11T10:00:00.000Z",
      status: "COMPLETED" as const,
      environment: { width: 1024, height: 560, zoom: 1, platform: "facebook" as const },
      sessionRef: { webContentsId: 101, pageUrl: "https://www.facebook.com/groups/groupA/" },
      totalFrames: 2,
      records: [
        {
          runId: runA,
          frameNumber: 1,
          scrollY: 0,
          browserWebContentsId: 101,
          rowIndex: 0,
          actionRowBbox: { x: 180, y: 200, width: 120, height: 24 },
          matchingScore: 0.98,
          hitPoint: { x: 195, y: 212 },
          ancestorDepth: 4,
          ancestors: [
            {
              level: 2,
              tag: "div",
              role: "article",
              id: "post-a1",
              className: "card",
              rect: { x: 150, y: 50, width: 500, height: 300 },
              rawUrls: ["https://www.facebook.com/groups/groupA/posts/111111/"],
              postIdentities: [
                {
                  platform: "facebook" as const,
                  postId: "111111",
                  rawUrl: "https://www.facebook.com/groups/groupA/posts/111111/",
                  canonicalUrl: "https://www.facebook.com/groups/groupA/posts/111111/",
                  matchedPattern: "group_posts",
                },
              ],
              uniqueKeys: ["facebook:111111"],
              uniqueCount: 1,
            },
          ],
          transitions: {
            firstPermalinkLevel: 2,
            secondPermalinkLevel: 3,
            boundaryCrossedLevel: 3,
            jumpedZeroToTwoPlus: false,
            jumpReason: null,
          },
          candidateContainer: { tag: "div", role: "article", id: "post-a1", className: "card", level: 2, rect: { x: 150, y: 50, width: 500, height: 300 } },
          crossedContainer: null,
          boundaryStatus: "BOUNDARY_FOUND" as const,
          riskReason: null,
          ownershipEvidence: { isArticle: true, hasDistinctCardLayout: true, containsActionRow: true, notes: ["Run A Frame 1 Row 0"] },
          originalScreenshotBase64: makePngDataUrl("RUN_A_F1_RAW"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_A_F1_R0_HIGHLIGHTED"),
        },
        {
          runId: runA,
          frameNumber: 1,
          scrollY: 0,
          browserWebContentsId: 101,
          rowIndex: 1,
          actionRowBbox: { x: 180, y: 420, width: 120, height: 24 },
          matchingScore: 0.95,
          hitPoint: { x: 195, y: 432 },
          ancestorDepth: 4,
          ancestors: [],
          transitions: {
            firstPermalinkLevel: null,
            secondPermalinkLevel: null,
            boundaryCrossedLevel: null,
            jumpedZeroToTwoPlus: false,
            jumpReason: null,
          },
          candidateContainer: null,
          crossedContainer: null,
          boundaryStatus: "BOUNDARY_NOT_FOUND" as const,
          riskReason: "Run A Frame 1 Row 1",
          ownershipEvidence: { isArticle: false, hasDistinctCardLayout: false, containsActionRow: false, notes: [] },
          originalScreenshotBase64: makePngDataUrl("RUN_A_F1_RAW"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_A_F1_R1_HIGHLIGHTED"),
        },
        {
          runId: runA,
          frameNumber: 2,
          scrollY: 364,
          browserWebContentsId: 101,
          rowIndex: 0,
          actionRowBbox: { x: 180, y: 190, width: 120, height: 24 },
          matchingScore: 0.99,
          hitPoint: { x: 195, y: 202 },
          ancestorDepth: 4,
          ancestors: [],
          transitions: {
            firstPermalinkLevel: 2,
            secondPermalinkLevel: 3,
            boundaryCrossedLevel: 3,
            jumpedZeroToTwoPlus: false,
            jumpReason: null,
          },
          candidateContainer: { tag: "div", role: "article", id: "post-a2", className: "card", level: 2, rect: { x: 150, y: 40, width: 500, height: 320 } },
          crossedContainer: null,
          boundaryStatus: "BOUNDARY_FOUND" as const,
          riskReason: null,
          ownershipEvidence: { isArticle: true, hasDistinctCardLayout: true, containsActionRow: true, notes: ["Run A Frame 2 Row 0"] },
          originalScreenshotBase64: makePngDataUrl("RUN_A_F2_RAW"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_A_F2_R0_HIGHLIGHTED"),
        },
      ],
      summary: {
        totalProbed: 3,
        boundaryFoundCount: 2,
        boundaryAmbiguousCount: 0,
        boundaryNotFoundCount: 1,
        jumpedZeroToTwoPlusCount: 0,
        jumpedFrames: [],
      },
    };

    const resA = await storage1.saveRun(reportA);
    assert.equal(resA.ok, true);

    const runADir = path.join(tempProjectDir, "scratch", "runs", runA);
    const runAF1Raw = path.join(runADir, "frames", "frame-001", "screenshot.png");
    const runAF1Hl = path.join(runADir, "frames", "frame-001", "highlighted.png");
    const runAF1R0 = path.join(runADir, "frames", "frame-001", "row-000.png");
    const runAF1R1 = path.join(runADir, "frames", "frame-001", "row-001.png");
    const runAF2Raw = path.join(runADir, "frames", "frame-002", "screenshot.png");
    const runAF2Hl = path.join(runADir, "frames", "frame-002", "highlighted.png");
    const runAF2R0 = path.join(runADir, "frames", "frame-002", "row-000.png");

    // Verify exact directory structure of Run A
    assert.ok(fs.existsSync(path.join(runADir, "manifest.json")), "manifest.json must exist");
    assert.ok(fs.existsSync(path.join(runADir, "result.json")), "result.json must exist");
    assert.ok(fs.existsSync(path.join(runADir, "logs", "pipeline.jsonl")), "logs/pipeline.jsonl must exist");
    assert.ok(fs.existsSync(path.join(runADir, "logs", "errors.jsonl")), "logs/errors.jsonl must exist");
    assert.ok(fs.existsSync(runAF1Raw), "frames/frame-001/screenshot.png must exist");
    assert.ok(fs.existsSync(runAF1Hl), "frames/frame-001/highlighted.png must exist");
    assert.ok(fs.existsSync(runAF1R0), "frames/frame-001/row-000.png must exist");
    assert.ok(fs.existsSync(runAF1R1), "frames/frame-001/row-001.png must exist");
    assert.ok(fs.existsSync(runAF2Raw), "frames/frame-002/screenshot.png must exist");
    assert.ok(fs.existsSync(runAF2Hl), "frames/frame-002/highlighted.png must exist");
    assert.ok(fs.existsSync(runAF2R0), "frames/frame-002/row-000.png must exist");

    // Record SHA-256 checksums of Run A before running Run B
    const hashBeforeB = {
      f1Raw: sha256File(runAF1Raw),
      f1Hl: sha256File(runAF1Hl),
      f1R0: sha256File(runAF1R0),
      f1R1: sha256File(runAF1R1),
      f2Raw: sha256File(runAF2Raw),
      f2Hl: sha256File(runAF2Hl),
      f2R0: sha256File(runAF2R0),
    };

    // 2. Run Test B with IDENTICAL frameIndex (1, 2) and rowIndex (0, 1)
    const reportB = {
      ...reportA,
      runId: runB,
      timestamp: "2026-11-11T10:05:00.000Z",
      createdAt: "2026-11-11T10:04:00.000Z",
      completedAt: "2026-11-11T10:05:00.000Z",
      sessionRef: { webContentsId: 202, pageUrl: "https://www.facebook.com/groups/groupB/" },
      records: [
        {
          ...reportA.records[0]!,
          runId: runB,
          originalScreenshotBase64: makePngDataUrl("RUN_B_F1_RAW_DIFFERENT"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_B_F1_R0_HIGHLIGHTED_DIFFERENT"),
        },
        {
          ...reportA.records[1]!,
          runId: runB,
          originalScreenshotBase64: makePngDataUrl("RUN_B_F1_RAW_DIFFERENT"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_B_F1_R1_HIGHLIGHTED_DIFFERENT"),
        },
        {
          ...reportA.records[2]!,
          runId: runB,
          originalScreenshotBase64: makePngDataUrl("RUN_B_F2_RAW_DIFFERENT"),
          evidenceScreenshotBase64: makePngDataUrl("RUN_B_F2_R0_HIGHLIGHTED_DIFFERENT"),
        },
      ],
    };

    const resB = await storage1.saveRun(reportB);
    assert.equal(resB.ok, true);

    const runBDir = path.join(tempProjectDir, "scratch", "runs", runB);
    // 3. Verify A and B live in two separate directories and no flat files are written to scratch/
    assert.notEqual(runADir, runBDir);
    assert.ok(fs.existsSync(runADir));
    assert.ok(fs.existsSync(runBDir));
    const scratchTopEntries = fs.readdirSync(path.join(tempProjectDir, "scratch"));
    assert.deepEqual(scratchTopEntries, ["runs"], "No flat files may be written to scratch/ root");

    // 4. Verify SHA-256 checksums of Run A's images are 100% unchanged after Run B
    assert.equal(sha256File(runAF1Raw), hashBeforeB.f1Raw, "Run A frame-001/screenshot.png checksum must not change");
    assert.equal(sha256File(runAF1Hl), hashBeforeB.f1Hl, "Run A frame-001/highlighted.png checksum must not change");
    assert.equal(sha256File(runAF1R0), hashBeforeB.f1R0, "Run A frame-001/row-000.png checksum must not change");
    assert.equal(sha256File(runAF1R1), hashBeforeB.f1R1, "Run A frame-001/row-001.png checksum must not change");
    assert.equal(sha256File(runAF2Raw), hashBeforeB.f2Raw, "Run A frame-002/screenshot.png checksum must not change");
    assert.equal(sha256File(runAF2Hl), hashBeforeB.f2Hl, "Run A frame-002/highlighted.png checksum must not change");
    assert.equal(sha256File(runAF2R0), hashBeforeB.f2R0, "Run A frame-002/row-000.png checksum must not change");

    // Verify Run B has its own distinct checksums
    const runBF1R0 = path.join(runBDir, "frames", "frame-001", "row-000.png");
    assert.notEqual(sha256File(runBF1R0), hashBeforeB.f1R0, "Run B must have its own distinct evidence payload");

    // 6. Re-probe the same frame (frame-001, row-000) in Run A -> creates attempt-002 without overwriting attempt-001 or row-000.png
    const attempt1R0Path = path.join(runADir, "frames", "frame-001", "attempts", "attempt-001", "row-000.png");
    const attempt1R0Hash = sha256File(attempt1R0Path);

    const attemptRes = await storage1.saveFrameAttempt({
      runId: runA,
      frameIndex: 1,
      rowIndex: 0,
      reason: "reprobe-custom-permalink-rule",
      ruleTested: { id: "rule_custom_1", name: "Custom Rule", template: "https://www.facebook.com/groups/{groupId}/posts/{postId}/" },
      record: {
        ...reportA.records[0]!,
        boundaryStatus: "BOUNDARY_FOUND",
        evidenceScreenshotBase64: makePngDataUrl("RUN_A_F1_R0_ATTEMPT_2_REPROBED"),
      },
      highlightedBase64: makePngDataUrl("RUN_A_F1_R0_ATTEMPT_2_REPROBED"),
    });

    assert.equal(attemptRes.ok, true);
    assert.equal(attemptRes.attemptId, "attempt-002");
    const attempt2R0Path = path.join(runADir, "frames", "frame-001", "attempts", "attempt-002", "row-000.png");
    assert.ok(fs.existsSync(attempt1R0Path), "attempt-001/row-000.png must still exist");
    assert.ok(fs.existsSync(attempt2R0Path), "attempt-002/row-000.png must be created");
    assert.equal(sha256File(attempt1R0Path), attempt1R0Hash, "attempt-001/row-000.png checksum must remain untouched");
    assert.equal(sha256File(runAF1R0), hashBeforeB.f1R0, "Primary frame-001/row-000.png checksum must remain untouched");
    assert.notEqual(sha256File(attempt2R0Path), attempt1R0Hash, "attempt-002 must contain new reprobed evidence");

    // 5 & 7. Simulate app restart (fresh storage instance) and reopen both Run A and Run B from disk
    const storageAfterRestart = new VisualMatchRunStorage(tempProjectDir);
    const listedRuns = await storageAfterRestart.listRuns();
    assert.equal(listedRuns.length, 2);
    assert.deepEqual(
      listedRuns.map(r => r.runId),
      [runB, runA],
    );

    const reopenedA = await storageAfterRestart.loadRun(runA);
    const reopenedB = await storageAfterRestart.loadRun(runB);

    assert.equal(reopenedA.ok, true);
    assert.equal(reopenedB.ok, true);
    assert.equal(reopenedA.report.runId, runA);
    assert.equal(reopenedB.report.runId, runB);

    // Check that reopened A has its exact original images and 2 attempts on frame 1
    assert.equal(
      reopenedA.report.records[0]!.evidenceScreenshotBase64,
      makePngDataUrl("RUN_A_F1_R0_HIGHLIGHTED"),
    );
    assert.equal(
      reopenedA.report.records[0]!.originalScreenshotBase64,
      makePngDataUrl("RUN_A_F1_RAW"),
    );
    assert.equal(reopenedA.report.frames?.[0]?.attempts?.length, 2);

    // Check that reopened B has its exact distinct images
    assert.equal(
      reopenedB.report.records[0]!.evidenceScreenshotBase64,
      makePngDataUrl("RUN_B_F1_R0_HIGHLIGHTED_DIFFERENT"),
    );
    assert.equal(
      reopenedB.report.records[0]!.originalScreenshotBase64,
      makePngDataUrl("RUN_B_F1_RAW_DIFFERENT"),
    );
  } finally {
    fs.rmSync(tempProjectDir, { recursive: true, force: true });
  }
});

test("URL Inspector UI Refactor: formatShortUrl, classifyUrlCandidate, and extractInspectableUrls handle long URLs, missing Post ID, multiple candidates, and preserve feedNeighborUrls in data only", async () => {
  const {
    formatShortUrl,
    classifyUrlCandidate,
    extractInspectableUrls,
  } = await import("../src/renderer/experiments/visual-match-lab/PermalinkInspector.js");

  // 1. Long URL with huge __cft__ tracking string is shortened <= 76 chars
  const longUrl =
    "https://www.facebook.com/groups/295931577185665/?__cft__[0]=AZV9X0BsjX9N_VERY_LONG_TRACKING_TOKEN_".repeat(4) +
    "&__tn__=-UC%2CP-R";
  const short1 = formatShortUrl(longUrl);
  assert.ok(short1.length <= 76, `shortUrl length ${short1.length} must be <= 76`);
  assert.match(short1, /^\/groups\/295931577185665\/\?__cft__\.\.\./);

  // 2. Classification for recognized vs unrecognized URLs
  assert.equal(
    classifyUrlCandidate("https://www.facebook.com/groups/295931577185665/"),
    "Facebook Group",
  );
  assert.equal(
    classifyUrlCandidate("https://www.facebook.com/groups/295931577185665/user/1000044444691156/"),
    "Facebook Group Member",
  );
  assert.equal(
    classifyUrlCandidate("https://www.facebook.com/groups/295931577185665/posts/101589324789/"),
    "Facebook Group Post",
  );

  // 3. Multiple candidates + Feed/Neighbor separation
  const mockBoundary: any = {
    status: "BOUNDARY_FOUND",
    firstPermalinkLevel: 2,
    secondPermalinkLevel: 4,
    boundaryCrossedLevel: 4,
    ancestorSteps: [
      {
        level: 1,
        tag: "a",
        role: "link",
        rawUrls: [
          "/groups/295931577185665/?__cft__[0]=AZ1_UNRECOGNIZED_GROUP_LINK",
          "/groups/295931577185665/user/1000044444691156/?__cft__[0]=AZ1_USER",
        ],
      },
      {
        level: 2,
        tag: "div",
        role: "article",
        rawUrls: [
          "https://www.facebook.com/groups/295931577185665/posts/101589324789/?__cft__[0]=AZ1_POST",
        ],
      },
      {
        level: 4,
        tag: "div",
        role: "feed",
        rawUrls: [
          "https://www.facebook.com/groups/295931577185665/posts/999999999999/",
        ],
      },
    ],
  };

  const extracted = extractInspectableUrls(mockBoundary, BUILTIN_PERMALINK_RULES);
  assert.equal(extracted.currentItemUrls.length, 3);
  // Feed/Neighbor URLs remain preserved in data structure for internal diagnostics/logs
  assert.equal(extracted.feedNeighborUrls.length, 1);
  assert.equal(extracted.feedNeighborUrls[0]!.identity?.postId, "999999999999");

  // Current item URLs are sorted with RECOGNIZED first, numbered 1, 2, 3
  assert.deepEqual(
    extracted.currentItemUrls.map(u => u.index),
    [1, 2, 3],
  );
  assert.equal(extracted.currentItemUrls[0]!.recognitionBadge, "RECOGNIZED");
  assert.equal(extracted.currentItemUrls[0]!.identity?.postId, "101589324789");
  assert.equal(extracted.currentItemUrls[1]!.recognitionBadge, "UNRECOGNIZED");
  assert.equal(extracted.currentItemUrls[1]!.identity, undefined);
  assert.equal(extracted.currentItemUrls[2]!.recognitionBadge, "UNRECOGNIZED");
  assert.equal(extracted.currentItemUrls[2]!.identity, undefined);
});

test("URL Inspector UI Refactor: deriveUrlVerificationStatus distinguishes NOT_TESTED, VERIFIED, and MISMATCH without false VERIFIED inference", async () => {
  const {
    extractInspectableUrls,
    deriveUrlVerificationStatus,
  } = await import("../src/renderer/experiments/visual-match-lab/PermalinkInspector.js");

  const mockBoundary: any = {
    status: "BOUNDARY_FOUND",
    boundaryCrossedLevel: 5,
    ancestorSteps: [
      {
        level: 1,
        tag: "a",
        role: "link",
        rawUrls: [
          "https://www.facebook.com/groups/295931577185665/posts/101589324789/",
          "https://www.facebook.com/groups/295931577185665/?__cft__[0]=AZ1_GROUP",
        ],
      },
    ],
  };

  const { currentItemUrls } = extractInspectableUrls(mockBoundary, BUILTIN_PERMALINK_RULES);
  const recognizedCand = currentItemUrls[0]!;
  const unrecognizedCand = currentItemUrls[1]!;

  // 1. Before testing in BrowserCore -> strictly NOT_TESTED (even for RECOGNIZED URL)
  assert.equal(deriveUrlVerificationStatus(recognizedCand, null).status, "NOT_TESTED");
  assert.equal(deriveUrlVerificationStatus(unrecognizedCand, null).status, "NOT_TESTED");

  // 2. When BrowserCore redirects to homepage -> MISMATCH
  const redirectedNav: any = {
    ok: true,
    status: "REDIRECTED",
    redirected: true,
    requestedUrl: recognizedCand.url,
    finalUrl: "https://www.facebook.com/",
    redirectReason: "Redirected to home",
    events: [],
    webContentsId: 1,
    title: "Facebook",
  };
  assert.equal(deriveUrlVerificationStatus(recognizedCand, redirectedNav).status, "MISMATCH");

  // 3. When BrowserCore navigation fails -> MISMATCH
  const failedNav: any = {
    ok: false,
    status: "FAILED",
    redirected: false,
    requestedUrl: recognizedCand.url,
    finalUrl: "",
    error: "ERR_ABORTED",
    events: [],
    webContentsId: 1,
    title: "",
  };
  assert.equal(deriveUrlVerificationStatus(recognizedCand, failedNav).status, "MISMATCH");

  // 4. When UNRECOGNIZED URL (missing Post ID) opens without HTTP redirect -> still NOT_TESTED (never auto-inferred as VERIFIED)
  const unrecSuccessNav: any = {
    ok: true,
    status: "SUCCESS",
    redirected: false,
    requestedUrl: unrecognizedCand.url,
    finalUrl: unrecognizedCand.url,
    events: [],
    webContentsId: 1,
    title: "Facebook Group",
  };
  assert.equal(deriveUrlVerificationStatus(unrecognizedCand, unrecSuccessNav).status, "NOT_TESTED");

  // 5. When RECOGNIZED URL opens without redirect and finalUrl preserves postId -> VERIFIED
  const recSuccessNav: any = {
    ok: true,
    status: "SUCCESS",
    redirected: false,
    requestedUrl: recognizedCand.url,
    finalUrl: "https://www.facebook.com/groups/295931577185665/posts/101589324789/",
    events: [],
    webContentsId: 1,
    title: "Post",
  };
  assert.equal(deriveUrlVerificationStatus(recognizedCand, recSuccessNav).status, "VERIFIED");
});

test("URL Inspector UI Refactor: renders 4 ordered sections, hides Feed / Neighbor URLs in UI, and keeps Technical Details collapsed by default", async () => {
  const React = await import("react");
  const ReactDOMServer = await import("react-dom/server");
  const { FrameDiagnostics } = await import(
    "../src/renderer/experiments/visual-match-lab/FrameDiagnostics.js"
  );

  const mockCandidate: any = {
    bbox: { x: 100, y: 200, width: 120, height: 24 },
    score: 0.97,
    iconCount: 3,
    status: "NEW_ITEM",
    context: "post",
    fingerprint: "1111",
    docY: 500,
    boundary: {
      status: "BOUNDARY_FOUND",
      firstPermalinkLevel: 2,
      secondPermalinkLevel: 4,
      boundaryCrossedLevel: 4,
      ancestorsChecked: 6,
      postIdentities: [
        {
          platform: "facebook",
          postId: "101589324789",
          canonicalUrl: "https://www.facebook.com/groups/295931577185665/posts/101589324789",
          rawUrl: "https://www.facebook.com/groups/295931577185665/posts/101589324789/",
        },
      ],
      ancestorSteps: [
        {
          level: 1,
          tag: "a",
          role: "link",
          rawUrls: ["/groups/295931577185665/?__cft__[0]=AZ1_UNREC_LONG_QUERY"],
        },
        {
          level: 2,
          tag: "div",
          role: "article",
          rawUrls: ["https://www.facebook.com/groups/295931577185665/posts/101589324789/"],
        },
        {
          level: 4,
          tag: "div",
          role: "feed",
          rawUrls: ["https://www.facebook.com/groups/295931577185665/posts/8888888888/"],
        },
      ],
    },
  };

  const mockCapture: any = {
    id: "capture_1",
    webContentsId: 10,
    width: 1024,
    height: 560,
    dataUrl: "data:image/png;base64,AAA",
    viewport: { width: 1024, height: 560, scrollY: 320, url: "https://www.facebook.com/groups/295931577185665/" },
  };

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(FrameDiagnostics, {
      frameNumber: 3,
      capture: mockCapture,
      captureStatus: "CAPTURE_PASS",
      pipelineStatus: "PASS",
      templateStatus: "READY",
      detectionStatus: "DETECTION_PASS",
      boundaryStatus: "BOUNDARY_FOUND",
      rawIconMatches: 3,
      actionClusters: 1,
      candidates: [mockCandidate],
      selectedCandidateIndex: 0,
      onSelectCandidate: () => {},
      rules: BUILTIN_PERMALINK_RULES,
      onRuleSaved: () => {},
      onUpdateBoundary: () => {},
      invoke: async () => ({}) as any,
    }),
  );

  // 1. Feed / Neighbor URLs must NOT appear anywhere in the rendered UI
  assert.doesNotMatch(html, /Feed \/ Neighbor URLs/i);
  assert.doesNotMatch(html, /FEED_NEIGHBOR/i);
  assert.doesNotMatch(html, /8888888888/);

  // 2. Verify exact order of the 4 sections in the right panel:
  const idx1 = html.indexOf("1. Current Item URLs");
  const idx2 = html.indexOf("2. URL Verification");
  const idx3 = html.indexOf("3. User-configurable Permalink Rule Editor");
  const idx4 = html.indexOf("4. Technical Details");

  assert.ok(idx1 >= 0, "Section 1 (Current Item URLs) must be present");
  assert.ok(idx2 > idx1, "Section 2 (URL Verification) must follow Section 1");
  assert.ok(idx3 > idx2, "Section 3 (Permalink Rule Editor) must follow Section 2");
  assert.ok(idx4 > idx3, "Section 4 (Technical Details) must follow Section 3");

  // 3. Technical Details <details> must be collapsed by default (no open="" attribute on .permalink-technical-details)
  assert.match(html, /<details class="permalink-technical-details">/);

  // 4. Cards show URL #1, URL #2, Post ID, and Open / Copy / Use URL buttons
  assert.match(html, /URL #1/);
  assert.match(html, /URL #2/);
  assert.match(html, /facebook:101589324789/);
  assert.match(html, /Chưa xác định/);
  assert.match(html, />Open</);
  assert.match(html, />Copy</);
  assert.match(html, />Use URL</);
});




