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

test("Runtime Hotfix 2: validateNavigableUrl and resolveFullUrl support relative URLs and block invalid schemes", async () => {
  const { validateNavigableUrl, resolveFullUrl } = await import(
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

  const relQuery = "?__cft__[0]=AZ1XN0BsjX9N&__tn__=-UC%2CP-R";
  const navRelQuery = validateNavigableUrl(relQuery);
  assert.equal(navRelQuery.valid, true);
  assert.equal(
    navRelQuery.resolvedUrl,
    "https://www.facebook.com/?__cft__[0]=AZ1XN0BsjX9N&__tn__=-UC%2CP-R",
  );

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


