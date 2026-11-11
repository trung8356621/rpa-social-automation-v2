import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { FacebookPermalinkAdapter, ThreadsPermalinkAdapter } from "../src/shared/permalink-adapter.js";
import {
  resolveBoundaryFromAncestors,
  type AncestorStep,
  type BoundaryDebugRecord,
  type BoundaryDebugReport,
} from "../src/shared/boundary-probe.js";

async function main() {
  const fbAdapter = new FacebookPermalinkAdapter();
  const runId = `run_audit_${Date.now()}`;
  const debugRecords: BoundaryDebugRecord[] = [];

  // Simulate realistic 20-frame scenario including typical group feed frames
  // Frame 5: Group Photo permalink with set=gm.{postId} (previously jumped 0->3 in live run)
  // Frame 8: Group Photo permalink with set=gm.{postId}
  // Frame 13: Multiple photos with same gm.{postId} deduplicating
  // Frame 18: Non-post link (demonstrating BOUNDARY_NOT_FOUND)
  const testScenarios = [
    { frame: 1, scrollY: 0, postUrl: "https://www.facebook.com/groups/mmo_community/posts/101589324789/", title: "Standard Group Post (Numeric ID)" },
    { frame: 2, scrollY: 364, postUrl: "https://www.facebook.com/groups/mmo_community/permalink/101589324790/", title: "Group Permalink Format" },
    { frame: 3, scrollY: 728, postUrl: "https://www.facebook.com/zuck/posts/10114881478201", title: "User Post (Numeric ID)" },
    { frame: 4, scrollY: 1092, postUrl: "https://www.facebook.com/vtv24.tintuc/posts/pfbid02RkWuJ5q7XyZ", title: "Page Post with pfbid" },
    { frame: 5, scrollY: 1456, postUrl: "https://www.facebook.com/photo/?fbid=10229817286489953&set=gm.29295208876831216&idorvanity=295931577185665&__cft__[0]=AZhge30STAoEB4", title: "Group Photo Post with set=gm.{postId} (Frame 5 exception)" },
    { frame: 6, scrollY: 1820, postUrl: "https://www.facebook.com/groups/mmo_community/permalink/pfbid088XkLmNoPq/?mibextid=oXZ", title: "Group Permalink with pfbid" },
    { frame: 7, scrollY: 2184, postUrl: "https://www.facebook.com/permalink.php?story_fbid=pfbid077QwertYuiOp&id=100085421&__cft__[0]=AZW", title: "Legacy permalink.php with pfbid & owner id" },
    { frame: 8, scrollY: 2548, postUrl: "https://www.facebook.com/photo/?fbid=10229814300455304&set=gm.29290501077301996&idorvanity=295931577185665&__cft__[0]=AZhq-tIozuey", title: "Group Photo Post with set=gm.{postId} (Frame 8)" },
    { frame: 9, scrollY: 2912, postUrl: "https://www.facebook.com/profile.php?id=100012345&story_fbid=pfbid055ZxcvBnm&ref=share", title: "Profile.php with story_fbid & id" },
    { frame: 10, scrollY: 3276, postUrl: "https://www.facebook.com/groups/mmo_community/posts/101589324799/", title: "Standard Group Post" },
    { frame: 11, scrollY: 3640, postUrl: "https://www.facebook.com/groups/mmo_community/posts/pfbid011AABBCCDDEE/?ref=share", title: "Group Post with pfbid" },
    { frame: 12, scrollY: 4004, postUrl: "https://www.facebook.com/meta/posts/10160000000001", title: "Meta Page Post" },
    { frame: 13, scrollY: 4368, postUrl: "https://www.facebook.com/photo/?fbid=999900001&set=gm.29295208876831216&idorvanity=295931577185665", title: "Group Photo matching post 29295208876831216 (deduplicated)" },
    { frame: 14, scrollY: 4732, postUrl: "https://www.facebook.com/groups/mmo_community/permalink/101589324814/", title: "Group Permalink" },
    { frame: 15, scrollY: 5096, postUrl: "https://www.facebook.com/story.php?story_fbid=pfbid066AsdfGhjkL&id=100012345&notif_t=feedback", title: "Story.php link" },
    { frame: 16, scrollY: 5460, postUrl: "https://www.facebook.com/groups/mmo_community/posts/101589324816/", title: "Group Post" },
    { frame: 17, scrollY: 5824, postUrl: "https://www.facebook.com/groups/mmo_community/posts/pfbid033XxYyZz/", title: "Group Post with pfbid" },
    { frame: 18, scrollY: 6188, postUrl: "https://www.facebook.com/photo/?fbid=123456789", title: "Regular Photo without set=gm (No permalink -> BOUNDARY_NOT_FOUND)" },
    { frame: 19, scrollY: 6552, postUrl: "https://www.facebook.com/groups/mmo_community/posts/101589324819/", title: "Group Post" },
    { frame: 20, scrollY: 6916, postUrl: "https://www.facebook.com/groups/mmo_community/posts/101589324820/", title: "Final Group Post" },
  ];

  for (const scen of testScenarios) {
    const postIdentity = fbAdapter.extractPostIdentity(scen.postUrl);
    const otherPostIdentity = fbAdapter.extractPostIdentity("https://www.facebook.com/groups/mmo_community/posts/999999999999/");

    // Construct ancestor tree simulating Facebook DOM
    // L0: Like button (0 posts)
    // L1: Action cell (0 posts)
    // L2: Action bar row (0 posts)
    // L3: Post body container (0 posts)
    // L4: Post Card (<div role="article">) containing the header timestamp anchor (1 post)
    // L5: Feed container (<div role="feed">) containing both this post and adjacent posts (>=2 posts)
    const ancestors: AncestorStep[] = [
      {
        level: 0,
        tag: "div",
        id: "",
        className: "x1i10hfl x6umtig x1b1mbnx like-button",
        role: "button",
        rect: { x: 120, y: 380, width: 85, height: 32 },
        rawUrls: [],
        postIdentities: [],
        uniqueKeys: [],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
      {
        level: 1,
        tag: "div",
        id: "",
        className: "x9f619 x1n2onr6 x1ja2u2z action-cell",
        role: null,
        rect: { x: 100, y: 375, width: 120, height: 42 },
        rawUrls: [],
        postIdentities: [],
        uniqueKeys: [],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
      {
        level: 2,
        tag: "div",
        id: "",
        className: "x78zum5 x1iyjqo2 x78zum5 action-row",
        role: null,
        rect: { x: 100, y: 370, width: 500, height: 46 },
        rawUrls: [],
        postIdentities: [],
        uniqueKeys: [],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
      {
        level: 3,
        tag: "div",
        id: "",
        className: "x1yztbdb x1n2onr6 post-body-wrapper",
        role: null,
        rect: { x: 90, y: 220, width: 520, height: 210 },
        rawUrls: ["https://www.facebook.com/zuck"], // Profile link (should be rejected)
        postIdentities: [],
        uniqueKeys: [],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
      {
        level: 4,
        tag: "div",
        id: `post-card-${scen.frame}`,
        className: "x1y1aw1k x1sxyh0 xwib8y2 post-card",
        role: "article",
        rect: { x: 80, y: 110, width: 540, height: 330 },
        rawUrls: [
          scen.postUrl,
          "https://www.facebook.com/groups/mmo_community/about/", // Subpage (rejected)
        ],
        postIdentities: postIdentity ? [postIdentity] : [],
        uniqueKeys: postIdentity ? [`${postIdentity.platform}:${postIdentity.postId}`] : [],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
      {
        level: 5,
        tag: "div",
        id: "group-feed-stream",
        className: "x1hc1fzr x1unhpq9 x6o7n8g feed-stream",
        role: "feed",
        rect: { x: 80, y: 0, width: 540, height: 1200 },
        rawUrls: [
          scen.postUrl,
          "https://www.facebook.com/groups/mmo_community/posts/999999999999/",
        ],
        postIdentities: [
          ...(postIdentity ? [postIdentity] : []),
          ...(otherPostIdentity ? [otherPostIdentity] : []),
        ],
        uniqueKeys: [
          ...(postIdentity ? [`${postIdentity.platform}:${postIdentity.postId}`] : []),
          ...(otherPostIdentity ? [`${otherPostIdentity.platform}:${otherPostIdentity.postId}`] : []),
        ],
        hasNestedArticle: false,
        hasQuoteOrReplyHint: false,
      },
    ];

    const actionRowRect = { x: 100, y: 370, width: 500, height: 46 };
    const boundary = resolveBoundaryFromAncestors(ancestors, { x: 160, y: 395 }, actionRowRect);

    debugRecords.push({
      runId,
      frameNumber: scen.frame,
      scrollY: scen.scrollY,
      browserWebContentsId: 1,
      rowIndex: 0,
      actionRowBbox: actionRowRect,
      matchingScore: 0.985,
      hitPoint: { x: 160, y: 395 },
      hitElement: {
        tag: "div",
        role: "button",
        id: "",
        className: "like-button",
        ariaLabel: "Thích",
        textSnippet: "Thích",
        rect: { x: 120, y: 380, width: 85, height: 32 },
      },
      ancestorDepth: ancestors.length,
      ancestors: ancestors.map(a => ({
        level: a.level,
        tag: a.tag,
        role: a.role,
        id: a.id,
        className: a.className,
        rect: a.rect,
        rawUrls: a.rawUrls ?? [],
        postIdentities: a.postIdentities,
        uniqueKeys: a.uniqueKeys,
        uniqueCount: a.uniqueKeys.length,
      })),
      transitions: {
        firstPermalinkLevel: boundary.firstPermalinkLevel,
        secondPermalinkLevel: boundary.secondPermalinkLevel,
        boundaryCrossedLevel: boundary.boundaryCrossedLevel,
        jumpedZeroToTwoPlus: Boolean(boundary.jumpedZeroToTwoPlus),
        jumpReason: boundary.jumpReason ?? null,
      },
      candidateContainer: boundary.candidateContainer,
      crossedContainer: boundary.crossedContainer,
      boundaryStatus: boundary.status,
      riskReason: boundary.riskReason,
      ownershipEvidence: boundary.ownershipEvidence,
    });
  }

  const report: BoundaryDebugReport = {
    runId,
    timestamp: new Date().toISOString(),
    environment: {
      width: 1024,
      height: 560,
      zoom: 1,
      platform: "facebook",
    },
    totalFrames: 20,
    records: debugRecords,
    summary: {
      totalProbed: debugRecords.length,
      boundaryFoundCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_FOUND").length,
      boundaryAmbiguousCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_AMBIGUOUS").length,
      boundaryNotFoundCount: debugRecords.filter(r => r.boundaryStatus === "BOUNDARY_NOT_FOUND").length,
      jumpedZeroToTwoPlusCount: debugRecords.filter(r => r.transitions.jumpedZeroToTwoPlus).length,
      jumpedFrames: [...new Set(debugRecords.filter(r => r.transitions.jumpedZeroToTwoPlus).map(r => r.frameNumber))],
    },
  };

  const scratchDir = path.resolve(process.cwd(), "scratch");
  await mkdir(scratchDir, { recursive: true });
  const latestPath = path.join(scratchDir, "visual-match-lab-boundary-debug.json");
  const runPath = path.join(scratchDir, `visual-match-lab-boundary-debug-${runId}.json`);

  await writeFile(latestPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(runPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Debug artifact written successfully:`);
  console.log(`- Latest: ${latestPath}`);
  console.log(`- Run specific: ${runPath}`);
  console.log(`- Total records: ${report.records.length}`);
  console.log(`- Summary:`, report.summary);
}

main().catch(console.error);
