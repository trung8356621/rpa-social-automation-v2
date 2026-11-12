import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildBrowserContextMenuSpec, isCopyableLinkUrl } from "../src/shared/browser-context-menu.js";
import { buildHrefClassifierJs, buildPermalinkDiagnosticScript } from "../src/shared/permalink-diagnostic.js";
import { FacebookPermalinkAdapter } from "../src/shared/permalink-adapter.js";
import { resolveBoundaryFromAncestors } from "../src/shared/boundary-probe.js";

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ANH_THO_PERMALINK = "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/";
const RUN = "scratch/runs/fic_run_1794455493713_vpksx/frames/frame-002/attempts";
const hasEvidence = fs.existsSync(new URL(`../${RUN}/attempt-001/attempt.json`, import.meta.url));

// Evaluate the in-page classifier in Node with a fake `location`.
const classify = new Function(
  "location",
  `${buildHrefClassifierJs()}; return classifyDiagnosticHref;`,
)({ origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/295931577185665/" }) as (
  raw: string,
  base: string,
) => { classification: string; post: { postId: string } | null; normalizedHref: string };
const BASE = "https://www.facebook.com/groups/295931577185665/";

test("Task A: context menu offers Copy link address only from params.linkURL", () => {
  const nav = { canGoBack: false, canGoForward: false };
  const onLink = buildBrowserContextMenuSpec({ linkURL: ANH_THO_PERMALINK }, nav);
  assert.equal(onLink[0]!.type === "action" && onLink[0]!.id, "copy-link");

  const onText = buildBrowserContextMenuSpec({ linkURL: "", selectionText: "SEO Content", editFlags: { canCopy: true } }, nav);
  assert.ok(!onText.some(i => i.type === "action" && i.id === "copy-link"));
  assert.ok(onText.some(i => i.type === "action" && i.id === "copy" && i.enabled));

  assert.equal(isCopyableLinkUrl("javascript:alert(1)"), false);
  assert.equal(isCopyableLinkUrl("?__cft__[0]=x"), false);
  assert.equal(isCopyableLinkUrl(ANH_THO_PERMALINK), true);

  const core = read("src/main/browser-core.ts");
  assert.match(core, /wc\.on\("context-menu"/);
  assert.match(core, /await clipboard\.writeText\(params\.linkURL\)/);
  // Single menu, attached inside createView (same BrowserCore webContents, no new partition).
  assert.equal((core.match(/"context-menu"/g) ?? []).length, 1);
});

test("Task B: parser recognises the PO-verified Anh Tho Group Post permalink", () => {
  const id = new FacebookPermalinkAdapter().extractPostIdentity(ANH_THO_PERMALINK);
  assert.equal(id?.postId, "29327016206983816");
  assert.equal(id?.scope, "seovamarketing");
  const c = classify(ANH_THO_PERMALINK, BASE);
  assert.equal(c.classification, "ACCEPTED_POST");
  assert.equal(c.post?.postId, "29327016206983816");
});

test("Task B: diagnostic classifier separates placeholder/member/hashtag hrefs", () => {
  assert.equal(classify("?__cft__[0]=AZjr63", BASE).classification, "QUERY_ONLY_PLACEHOLDER");
  assert.equal(classify("?__cft__[0]=AZjr63", BASE).post, null);
  assert.equal(classify("#", BASE).classification, "PLACEHOLDER_HASH");
  assert.equal(classify("/groups/295931577185665/user/100004014782444/?__cft__[0]=x", BASE).classification, "GROUP_MEMBER");
  assert.equal(classify("https://www.facebook.com/hashtag/40m?__cft__[0]=x", BASE).classification, "HASHTAG");
  assert.equal(classify("https://www.facebook.com/groups/seovamarketing/posts/1/?comment_id=2", BASE).classification, "ACCEPTED_COMMENT_PERMALINK");
  // Script is read-only: no click / navigation / DOM mutation APIs.
  const script = buildPermalinkDiagnosticScript();
  assert.doesNotMatch(script, /\.click\(|location\.assign|location\.href\s*=|appendChild|setAttribute|removeChild/);
});

test("Task B evidence: Anh Tho permalink is absent from raw DOM evidence; card holds only a query-only placeholder", { skip: !hasEvidence }, () => {
  const att = JSON.parse(read(`${RUN}/attempt-001/attempt.json`));
  const row = att.rows[0];
  assert.equal(row.candidateId, "f002_r000");
  assert.equal(row.boundaryStatus, "BOUNDARY_NOT_FOUND");
  const all = JSON.stringify(att);
  assert.ok(!all.includes("29327016206983816"), "permalink must not exist anywhere in saved evidence");

  // Card container = L13..L26 (same rect 680x369, contains the action row). Its anchors:
  const card = row.ancestors.find((a: any) => a.level === 13);
  const classes = card.rawUrls.map((u: string) => classify(u, BASE).classification);
  assert.ok(classes.includes("QUERY_ONLY_PLACEHOLDER"));
  assert.ok(!classes.includes("ACCEPTED_POST"));
  assert.ok(classes.every((c: string) => ["GROUP_MEMBER", "QUERY_ONLY_PLACEHOLDER", "HASHTAG"].includes(c)));
  // 6 anchors < 15 cap → not a truncation issue (Case A ruled out).
  assert.ok(card.rawUrls.length < 15);
  // Hit point lies inside the card rect → action row belongs to this card (Case D ruled out).
  const r = card.rect;
  assert.ok(row.hitPoint.y >= r.y && row.hitPoint.y <= r.y + r.height);
  // Post extraction is uncapped (only rawUrls storage is capped). Entire attempt has zero
  // identities for Anh Tho → permalink was not present in feed DOM (Case B ruled out).
  const allPostIds = row.ancestors.flatMap((a: any) => (a.postIdentities || []).map((p: any) => p.postId));
  assert.ok(!allPostIds.includes("29327016206983816"));
  // Neighbor cards in the same feed DO expose /posts/ URLs (comment permalinks) — so absence
  // on this card is card-local lazy href, not a global parser failure (Case C).
  assert.ok(all.includes("/groups/seovamarketing/posts/"), "other posts in feed have real /posts/ hrefs");

  // Resolver replay on saved trajectory is deterministic: 0 → 3 jump at feed → NOT_FOUND (correct, not loosened).
  const steps = row.ancestors.map((a: any) => ({ ...a, hasNestedArticle: false, hasQuoteOrReplyHint: false }));
  const replay = resolveBoundaryFromAncestors(steps, row.hitPoint, row.actionRowBbox);
  assert.equal(replay.status, "BOUNDARY_NOT_FOUND");
  assert.equal(replay.jumpedZeroToTwoPlus, true);
});

test("Task C regression: previously FOUND candidate in same run remains FOUND on replay", { skip: !hasEvidence }, () => {
  const att = JSON.parse(read(`${RUN}/attempt-004/attempt.json`));
  const row = att.rows.find((r: any) => r.boundaryStatus === "BOUNDARY_FOUND");
  assert.ok(row);
  const steps = row.ancestors.map((a: any) => ({ ...a, hasNestedArticle: false, hasQuoteOrReplyHint: false }));
  const replay = resolveBoundaryFromAncestors(steps, row.hitPoint, row.actionRowBbox);
  assert.equal(replay.status, "BOUNDARY_FOUND");
  assert.ok(replay.postIdentities.some(p => p.postId === "29326980710320699"));
});
