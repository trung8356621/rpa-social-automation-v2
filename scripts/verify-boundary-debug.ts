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

  // Simulate realistic 50-frame scenario including typical group feed frames
  // Including standard group posts, pfbid, permalinks, gm photos, pcb photos, custom rules, and negative links
  const sampleUrls = [
    (i: number) => ({ url: `https://www.facebook.com/groups/mmo_community/posts/${101589324780 + i}/`, title: `Standard Group Post ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/groups/mmo_community/permalink/${101589324780 + i}/`, title: `Group Permalink Format ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/zuck/posts/1011488147820${i % 10}`, title: `User Post ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/vtv24.tintuc/posts/pfbid02RkWuJ5q7Xy${i}`, title: `Page Post with pfbid ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/photo/?fbid=10229817286489953&set=gm.${29295208876831200 + i}&idorvanity=295931577185665`, title: `Group Photo Post with set=gm.{postId} ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/photo/?fbid=10229806370657064&set=pcb.${29279737605045000 + i}`, title: `Group Photo Post with set=pcb.{postId} ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/permalink.php?story_fbid=pfbid077QwertYui${i}&id=100085421`, title: `Legacy permalink.php ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/story.php?story_fbid=pfbid066AsdfGhjk${i}&id=100012345`, title: `Story.php link ${i}` }),
    (i: number) => ({ url: `https://www.facebook.com/photo/?fbid=${123456700 + i}`, title: `Regular Photo without set=gm/pcb (BOUNDARY_NOT_FOUND) ${i}` }),
  ];

  const testScenarios = Array.from({ length: 50 }, (_, idx) => {
    const frame = idx + 1;
    const scrollY = (frame - 1) * 364;
    // Every 10th frame (e.g. frame 10, 20, 30, 40, 50) simulate non-post link (BOUNDARY_NOT_FOUND)
    if (frame % 10 === 0) {
      return {
        frame,
        scrollY,
        postUrl: `https://www.facebook.com/photo/?fbid=${123456700 + frame}`,
        title: `Regular Photo without permalink (Frame ${frame})`,
      };
    }
    const sample = sampleUrls[(frame - 1) % (sampleUrls.length - 1)](frame);
    return {
      frame,
      scrollY,
      postUrl: sample.url,
      title: sample.title,
    };
  });

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
    totalFrames: 50,
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
