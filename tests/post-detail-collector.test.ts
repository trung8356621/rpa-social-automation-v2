import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isCollectorBrowserHostPage,
  shouldShowBrowserForPage,
  resolveBrowserViewBounds,
} from "../src/shared/collector-browser-host.js";
import {
  classifyVisualMatchStatus,
  createPostDetailFrameId,
  createPostDetailRunId,
} from "../src/shared/post-detail-collector/match-status.js";
import { PostDetailRunStorage } from "../src/main/post-detail-storage.js";

function read(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

test("Post Detail Collector menu sits under Feed Item and is wired", () => {
  const shell = read("src/renderer/app-shell.tsx");
  const feedIdx = shell.indexOf('page: "feed-item-collector"');
  const postIdx = shell.indexOf('page: "post-detail-collector"');
  assert.ok(feedIdx > 0);
  assert.ok(postIdx > feedIdx, "Post Detail Collector must be listed after Feed Item Collector");
  assert.match(shell, /label: "Post Detail Collector"/);

  const contracts = read("src/shared/contracts.ts");
  assert.match(contracts, /"feed-item-collector" \| "post-detail-collector"/);
  assert.match(contracts, /type: "postDetailSaveRun"/);
  assert.match(contracts, /type: "postDetailListRuns"/);
  assert.match(contracts, /type: "postDetailLoadRun"/);
  assert.match(contracts, /type: "postDetailBrowserProbe"/);

  const main = read("src/main/main.ts");
  assert.match(main, /post-detail-collector/);
  assert.match(main, /case "postDetailSaveRun"/);
  assert.match(main, /case "postDetailListRuns"/);
  assert.match(main, /case "postDetailLoadRun"/);

  const renderer = read("src/renderer/main.tsx");
  assert.match(renderer, /appPage === "post-detail-collector" && <PostDetailCollectorPage/);
  assert.match(renderer, /PostDetailCollectorPage/);

  const tabs = read("src/renderer/workspace-tabs.tsx");
  assert.match(tabs, /"post-detail-collector": "Post Detail Collector"/);
});

test("Post Detail uses shared BrowserCore host pages without new window", () => {
  assert.equal(isCollectorBrowserHostPage("post-detail-collector"), true);
  assert.equal(
    shouldShowBrowserForPage({
      page: "post-detail-collector",
      browserVisible: true,
      collectorHostActive: true,
    }),
    true,
  );
  assert.equal(
    shouldShowBrowserForPage({
      page: "post-detail-collector",
      browserVisible: true,
      collectorHostActive: false,
    }),
    false,
  );
  const creator = { x: 208, y: 88, width: 1024, height: 560 };
  const host = { x: 240, y: 160, width: 900, height: 480, active: true };
  assert.deepEqual(
    resolveBrowserViewBounds({
      page: "post-detail-collector",
      collectorHost: host,
      creatorBrowser: creator,
    }),
    { x: 240, y: 160, width: 900, height: 480 },
  );

  const overlays = read("src/main/creator-overlays.ts");
  assert.match(overlays, /isCollectorBrowserHostPage/);
});

test("Visual match status classification avoids picking close scores", () => {
  assert.equal(classifyVisualMatchStatus([]), "NOT_FOUND");
  assert.equal(classifyVisualMatchStatus([0.5]), "NOT_FOUND");
  assert.equal(classifyVisualMatchStatus([0.9]), "MATCHED");
  assert.equal(classifyVisualMatchStatus([0.9, 0.88]), "AMBIGUOUS");
  assert.equal(classifyVisualMatchStatus([0.9, 0.7]), "MATCHED");
});

test("Post Detail evidence storage saves multiple OCR frames without overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdc-runs-"));
  try {
    const storage = new PostDetailRunStorage(dir);
    const runId = createPostDetailRunId();
    const frameA = {
      runId,
      frameId: createPostDetailFrameId(1),
      frameIndex: 1,
      scrollY: 0,
      roi: { x: 10, y: 20, width: 100, height: 80 },
      ocrText: "Hello OCR frame one",
      ocrConfidence: 88,
      matchStatus: "MATCHED" as const,
      matchScore: 0.91,
      matchTemplateId: "vr_1",
      processingStatus: "OCR_DONE" as const,
      diagnostics: { errors: [], warnings: [], notes: ["unit"] },
      createdAt: new Date().toISOString(),
      // 1x1 PNG
      screenshotDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      cropDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    };
    const frameB = {
      ...frameA,
      frameId: createPostDetailFrameId(2),
      frameIndex: 2,
      scrollY: 120,
      ocrText: "Second independent OCR frame",
    };

    const saved = await storage.saveRun({
      runId,
      sourceUrl: "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/",
      platform: "Facebook",
      visualReferences: [],
      frames: [frameA, frameB],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.frameCount, 2);

    await assert.rejects(
      () =>
        storage.saveRun({
          runId,
          sourceUrl: "https://example.com",
          visualReferences: [],
          frames: [frameA],
        }),
      /POST_DETAIL_RUN_EXISTS/,
    );

    const listed = await storage.listRuns();
    assert.equal(listed.some((r) => r.runId === runId), true);

    const loaded = await storage.loadRun(runId);
    assert.equal(loaded.frames.length, 2);
    assert.equal(loaded.frames[0]?.ocrText, "Hello OCR frame one");
    assert.equal(loaded.frames[1]?.ocrText, "Second independent OCR frame");
    assert.ok(loaded.frames[0]?.screenshotDataUrl?.startsWith("data:image/png"));
    assert.ok(loaded.frames[1]?.cropDataUrl?.startsWith("data:image/png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Post Detail POC reuses OCR IPC and does not mock OCR text in UI", () => {
  const ocrStep = read("src/renderer/post-detail-collector/OcrPreviewStep.tsx");
  assert.match(ocrStep, /visualMatchLabOcr/);
  assert.doesNotMatch(ocrStep, /mockOcr|fakeOcr|MOCK_OCR/i);

  const feed = read("src/renderer/feed-item-collector/FeedItemCollectorPage.tsx");
  assert.match(feed, /Feed Item Collector/);
  // Ensure Feed Item page file was not replaced by Post Detail.
  assert.doesNotMatch(feed, /Post Detail Collector/);
});

test("Post Detail host publish matches Feed Item (no sidebar clamp)", async () => {
  const publish = read("src/renderer/post-detail-collector/publish-browser-host.ts");
  assert.match(publish, /publishCollectorHostFromElement/);
  assert.doesNotMatch(publish, /clampHostLeftOfSidebar/);
  const shared = read("src/renderer/collectors/publish-collector-host.ts");
  assert.match(shared, /domRectToShellBounds/);
  assert.doesNotMatch(shared, /clampHostLeftOfSidebar/);

  const step1 = read("src/renderer/post-detail-collector/BrowserCaptureStep.tsx");
  assert.match(step1, /publishPostDetailBrowserHost/);
  assert.match(step1, /claimCollectorHostOwner/);
  const page = read("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx");
  // Page cleanup must not depend on refreshProbe (would tear down host while Step 1 is live).
  assert.doesNotMatch(page, /}, \[invoke, refreshProbe\]\)/);
  assert.match(page, /releaseCollectorHostOwner/);

  // Page CSS clears sidebar once (same as Feed Item); do not subtract nav again in publish.
  const css = read("src/renderer/post-detail-collector/post-detail-collector.css");
  assert.match(css, /margin-left:\s*var\(--app-nav-width\)/);
  const fic = read("src/renderer/feed-item-collector/feed-item-collector.css");
  assert.match(fic, /margin-left:\s*var\(--app-nav-width\)/);
});

test("Post Detail separates navigateToTarget from captureFromSocialPage", async () => {
  const {
    assertNavigateToSocialTarget,
    assertCaptureFromSocialPage,
    isSupportedSocialUrl,
  } = await import("../src/shared/post-detail-collector/social-url.js");

  assert.equal(isSupportedSocialUrl("https://www.facebook.com/groups/x/posts/1/"), true);
  assert.equal(isSupportedSocialUrl("https://example.com"), false);

  // navigateToTarget: destination must be social; current page is irrelevant.
  assert.equal(
    assertNavigateToSocialTarget(
      "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/",
    ).platform,
    "facebook",
  );
  assert.throws(() => assertNavigateToSocialTarget("https://example.com/post"), /UNSUPPORTED_PLATFORM/);

  // captureFromSocialPage: keeps BROWSER_NOT_FACEBOOK when current page is not social.
  assert.throws(() => assertCaptureFromSocialPage("about:blank"), /BROWSER_NOT_FACEBOOK/);
  assert.throws(() => assertCaptureFromSocialPage("https://google.com"), /BROWSER_NOT_FACEBOOK/);
  assert.equal(
    assertCaptureFromSocialPage("https://www.facebook.com/groups/seovamarketing/posts/1/").platform,
    "facebook",
  );

  const page = read("src/renderer/post-detail-collector/PostDetailCollectorPage.tsx");
  assert.match(page, /postDetailBrowserProbe/);
  assert.doesNotMatch(page, /visualMatchLabState/);

  const step1 = read("src/renderer/post-detail-collector/BrowserCaptureStep.tsx");
  assert.match(step1, /assertNavigateToSocialTarget/);
  assert.match(step1, /assertCaptureFromSocialPage/);
  assert.match(step1, /collector-capture-freeze snapshot/);
  assert.match(step1, /position:\s*"fixed"/);
  assert.match(step1, /collectorReportBrowserHost/);
  assert.match(step1, /data-browser-core-host=""/);

  const main = read("src/main/main.ts");
  assert.match(main, /case "postDetailBrowserProbe"/);
  // Lab facebook() guard remains for Lab capture ops.
  assert.match(read("src/main/visual-match-lab.ts"), /BROWSER_NOT_FACEBOOK/);
});
