import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildHighlightSavedParentNodeJs,
  buildPostDetailActionAnchorProbeJs,
  buildPostDetailParentProbeJs,
  buildResolveSavedParentJs,
  classifyDualXPathResolution,
  classifyActionControlDescriptor,
  CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS,
  dedupeNestedActionRows,
  orderProgressiveCandidates,
  structuralActionRowsMatch,
} from "../src/main/post-detail-parent-probe.js";

test("calibration checks exact level before ±1 and full fallback", () => {
  const rows = [
    { parentLevel: 7, descendantCount: 900 },
    { parentLevel: 8, descendantCount: 100 },
    { parentLevel: 9, descendantCount: 800 },
    { parentLevel: 12, descendantCount: 1200 },
  ];
  assert.deepEqual(orderProgressiveCandidates(rows, 8), {
    items: [rows[1], rows[3], rows[0], rows[2]],
    mode: "EXACT",
  });
  assert.deepEqual(
    orderProgressiveCandidates(
      rows.filter((x) => x.parentLevel !== 8),
      8,
    ).items.slice(0, 2),
    [rows[0], rows[2]],
  );
  assert.equal(orderProgressiveCandidates(rows, 4).mode, "FULL_PROGRESSIVE");
});
test("progressive probe includes URL queries, second-row stop, root guard and cleanup", () => {
  const source = buildPostDetailParentProbeJs({
    sourceUrl: "https://www.facebook.com/groups/g/permalink/42/",
    runId: "r",
    expectedWebContentsId: 1,
    frameId: "f",
    screenshot: { width: 100, height: 100 },
    anchors: [],
    expectedParentLevel: 8,
  });
  assert.doesNotThrow(() => new Function(`return ${source}`));
  assert.match(source, /multi_permalinks/);
  assert.match(source, /SECOND_ACTION_ROW_FOUND/);
  assert.match(source, /document\.body/);
  assert.match(source, /pointer-events:none/);
  assert.match(source, /const overlay=document\.createElement/);
  assert.doesNotMatch(source, /overlays=valid\.map/);
  assert.match(CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS, /dispose/);
  const anchorSource = buildPostDetailActionAnchorProbeJs({
    sourceUrl: "https://www.facebook.com/groups/g/permalink/42/",
    runId: "r",
    expectedWebContentsId: 1,
    frameId: "f",
    screenshot: { width: 100, height: 100 },
    anchors: [],
  });
  assert.doesNotThrow(() => new Function(`return ${anchorSource}`));
  assert.match(anchorSource, /elementsFromPoint/);
  assert.match(anchorSource, /pointer-events:none/);
  assert.match(anchorSource, /debugVisible=Boolean\(input\.debugAnchors\)/);
  assert.match(anchorSource, /alwaysVisible\|\|debugVisible/);
});

test("action controls ignore descendant container text and structural rows dedupe nested nodes", () => {
  assert.equal(classifyActionControlDescriptor({ ariaLabel: "Like" }), "LIKE");
  assert.equal(
    classifyActionControlDescriptor({
      directText: "Post container",
      descendantText: "Like Comment Share",
    } as never),
    null,
  );
  const signature = {
    tag: "DIV",
    role: "",
    childCount: 3,
    svgCount: 3,
    buttonCount: 3,
    anchorCount: 0,
    directPattern: "DIV:|DIV:|DIV:",
  };
  assert.equal(structuralActionRowsMatch(signature, { ...signature }), true);
  const parent: Record<string, string[]> = {
    original: ["nested"],
    nested: [],
    second: [],
    third: [],
  };
  const rows = dedupeNestedActionRows(
    "original",
    ["nested", "second", "second", "third"],
    (a, b) => parent[a]?.includes(b) || false,
  );
  assert.deepEqual(rows, ["original", "second", "third"]);
});

test("Confirm Action Row starts one controlled DOM-to-parent pipeline without technical buttons", () => {
  const ui = readFileSync(
    "src/renderer/post-detail-collector/VisualRegionStep.tsx",
    "utf8",
  );
  const confirmBody =
    /function confirmActionRow\(\)[\s\S]*?\n  }\n\n  function confirmContainer/.exec(
      ui,
    )?.[0] || "";
  assert.equal((confirmBody.match(/runParentPipeline\(/g) || []).length, 1);
  assert.doesNotMatch(
    ui,
    /1\. Highlight Like \/ Comment \/ Share|2\. Find & Highlight Parent Containers/,
  );
  assert.match(ui, /Retry Parent Probe/);
  assert.match(ui, /Show extra DOM debug/);
  assert.match(ui, /onMouseEnter/);
  assert.match(ui, /onMouseLeave/);
  assert.doesNotMatch(confirmBody, /startAutoScan|runPostDetailAutoScan/);
});

test("saved parent resolver rejects legacy config without an exact Action Row locator", () => {
  const source = buildResolveSavedParentJs({
    version: 1,
    platform: "facebook",
    parentLevel: 8,
    fingerprint: "DIV::3:3",
    tag: "DIV",
    role: null,
    descendantCount: 120,
    locatorStrategy: "POST_IDENTITY_ASCEND_STRUCTURAL",
    actionRowSignature: {
      tag: "DIV",
      role: "",
      childCount: 3,
      svgCount: 3,
      buttonCount: 0,
      anchorCount: 3,
      directPattern: "DIV:|DIV:|DIV:",
    },
    updatedAt: new Date(0).toISOString(),
  });
  assert.doesNotThrow(() => new Function(`return ${source}`));
  assert.match(source, /Legacy V1 locator is preserved/);
  assert.match(source, /'NOT_FOUND'/);
  assert.match(source, /'AMBIGUOUS'/);
  assert.match(source, /'PARENT_MISMATCH'/);
  assert.match(source, /locatorVersion/);
  assert.match(source, /innerHTML:parent\.innerHTML/);
  assert.doesNotMatch(source, /outerHTML/);
  assert.doesNotMatch(source, /config\.fingerprint|config\.actionRowSignature/);
  const page = readFileSync(
    "src/renderer/post-detail-collector/PostDetailCollectorPage.tsx",
    "utf8",
  );
  const step = readFileSync(
    "src/renderer/post-detail-collector/SavedParentHtmlStep.tsx",
    "utf8",
  );
  assert.match(page, /postDetailResolveSavedParent/);
  assert.match(page, /navigationEpoch\.current !== startedAtEpoch/);
  assert.match(page, /savedParentResolution\.status !== "PARENT_MATCHED"/);
  assert.match(step, /Rematch Parent/);
  assert.match(step, /DOMParser/);
  assert.match(step, /DOM Explorer/);
  assert.match(step, /Raw HTML/);
  assert.match(step, /postDetailHighlightParentNode/);
  const highlight = buildHighlightSavedParentNodeJs([0, 2, 1]);
  assert.doesNotThrow(() => new Function(`return ${highlight}`));
  assert.match(highlight, /parent\.contains\(node\)/);
  assert.match(highlight, /__rpaPdcExplorerHighlight/);
  assert.match(highlight, /requestAnimationFrame/);
});

test("saved V2 action row locator is XPath-only, post-scoped and never ranks Parent candidates", () => {
  const located = buildResolveSavedParentJs({
    version: 2,
    platform: "facebook",
    parentLevel: 26,
    locatorStrategy: "POST_IDENTITY_ACTION_ROW_LEVEL",
    actionRowLocator: {
      version: 2,
      strategy: "POST_SCOPED_RELATIVE_XPATH",
      postIdentityAnchor: {
        platform: "facebook",
        reason: "facebook-permalink-path",
        xpathTemplate: "//a[@href and contains(@href, {{POST_ID}}) and not(contains(@href, 'comment_id='))]",
      },
      absoluteXPath: "/html[1]/body[1]/article[1]/div[1]",
      relativeXPath: "ancestor::article[1]//div[@role='group']",
      diagnosticXPathPrefixes: ["ancestor::article[1]", "ancestor::article[1]//div[@role='group']"],
      actionRowTag: "DIV",
      actionRowRole: "group",
      actionRowStructure: {
        childCount: 3,
        svgCount: 3,
        buttonCount: 3,
        directPattern: "DIV:|DIV:|DIV:",
      },
      confirmedParentLevel: 3,
      teachingEvidence: {
        anchorTag: "A",
        anchorReason: "facebook-permalink-path",
        anchorHrefPattern: "/permalink/42/",
        absoluteMatchCount: 1,
        relativeMatchCount: 1,
        sameNode: true,
        confirmedRowMatched: true,
        confirmedParentMatched: true,
      },
    },
    updatedAt: new Date(0).toISOString(),
  });
  assert.doesNotThrow(() => new Function(`return ${located}`));
  assert.match(located, /config\.actionRowLocator/);
  assert.match(located, /document\.evaluate/);
  assert.match(located, /locator\.absoluteXPath/);
  assert.match(located, /locator\.relativeXPath/);
  assert.match(located, /confirmedParentLevel/);
  assert.match(located, /absoluteUnique\.length>1\|\|relativeUnique\.length>1/);
  assert.match(located, /sameReason/);
  assert.match(located, /facebook-\(\?:permalink\|posts\)-path/);
  assert.match(located, /failureCode:code/);
  assert.doesNotMatch(located, /identityCount|descendantCount|rankedParents/);
  assert.doesNotMatch(located, /locator\.anchorUp|locator\.rowPath/);
  assert.doesNotMatch(located, /runPostDetailAutoScan|LIKE|COMMENT|SHARE/);
  assert.doesNotMatch(located, /querySelectorAll\('button,\[role=button\],a'\)/);
  assert.match(located, /postIdentityVerified/);
  assert.match(located, /actionRowVerified/);
  assert.match(located, /parentVerified/);
});

test("teaching verifies the generated XPath and confirmed Parent before returning V2", () => {
  const source = buildPostDetailParentProbeJs({
    sourceUrl: "https://www.facebook.com/groups/g/permalink/42/",
    runId: "r",
    expectedWebContentsId: 1,
    frameId: "f",
    screenshot: { width: 100, height: 100 },
    anchors: [],
  });
  assert.match(source, /POST_SCOPED_RELATIVE_XPATH/);
  assert.match(source, /document\.evaluate\(candidate\.relativeXPath/);
  assert.match(source, /absoluteXPathOf/);
  assert.match(source, /absoluteExact\[0\]!==row/);
  assert.match(source, /not\(contains\(@href, 'comment_id='\)\)/);
  assert.match(source, /structuralRowPredicate/);
  assert.match(source, /diagnosticXPathPrefixes/);
  assert.match(source, /relativeExact\[0\]!==row/);
  assert.match(source, /resolvedParent!==parent/);
  assert.match(source, /DUAL_XPATH_DID_NOT_VERIFY_CONFIRMED_ACTION_ROW/);
  assert.doesNotMatch(source, /anchorUp|rowPath/);
});

test("dual XPath strict resolution handles agreement, missing evidence, conflict and ambiguity", () => {
  const rowA = { id: "post-a-row" };
  const rowB = { id: "post-b-row" };
  const verified = { postIdentityVerified: true, actionRowVerified: true, parentVerified: true };
  assert.equal(classifyDualXPathResolution([rowA], [rowA], verified), "MATCHED");
  assert.equal(
    classifyDualXPathResolution([], [rowA], { ...verified, postIdentityVerified: false }),
    "REMATCH_REQUIRED",
  );
  assert.equal(classifyDualXPathResolution([rowA], [rowB], verified), "CONFLICT");
  assert.equal(classifyDualXPathResolution([rowA, rowB], [], verified), "AMBIGUOUS");
  assert.equal(classifyDualXPathResolution([], [], verified), "NOT_FOUND");
});

test("Step 3 remains read-only and excludes comment/reply anchors", () => {
  const source = buildResolveSavedParentJs({
    version: 2,
    platform: "facebook",
    parentLevel: 26,
    locatorStrategy: "POST_IDENTITY_ACTION_ROW_LEVEL",
    actionRowLocator: {
      version: 2,
      strategy: "POST_SCOPED_RELATIVE_XPATH",
      postIdentityAnchor: { platform: "facebook", reason: "facebook-posts-path", xpathTemplate: "//a[contains(@href, {{POST_ID}}) and not(contains(@href, 'comment_id=')) and not(contains(@href, 'reply_comment_id='))]" },
      absoluteXPath: "/html[1]/body[1]/div[1]",
      relativeXPath: "ancestor::div[@role='dialog'][1]/descendant::div[count(*)=3]",
      diagnosticXPathPrefixes: ["ancestor::div[@role='dialog'][1]"],
      actionRowTag: "DIV",
      actionRowRole: null,
      actionRowStructure: { childCount: 3, svgCount: 3, buttonCount: 3, directPattern: "DIV:|DIV:|DIV:" },
      confirmedParentLevel: 26,
      teachingEvidence: { anchorTag: "A", anchorReason: "facebook-posts-path", anchorHrefPattern: "/posts/42", absoluteMatchCount: 1, relativeMatchCount: 1, sameNode: true, confirmedRowMatched: true, confirmedParentMatched: true },
    },
    updatedAt: new Date(0).toISOString(),
  });
  assert.match(source, /comment_id/);
  assert.match(source, /reply_comment_id/);
  assert.match(source, /'CONFLICT'/);
  assert.doesNotMatch(source, /runPostDetailAutoScan|postDetailSave|rankedParents|LIKE|COMMENT|SHARE/);
});
