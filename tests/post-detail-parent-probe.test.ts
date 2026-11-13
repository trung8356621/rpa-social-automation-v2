import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildHighlightSavedParentNodeJs,
  buildPostDetailActionAnchorProbeJs,
  buildPostDetailParentProbeJs,
  buildResolveSavedParentJs,
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

test("saved parent resolver uses action row plus confirmed level and supports legacy config", () => {
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
  assert.match(source, /config\.parentLevel/);
  assert.match(source, /__rpaPdcActionProbe/);
  assert.match(source, /ACTION_ROW_SELECTOR_NOT_FOUND/);
  assert.match(source, /ACTION_ROW_AMBIGUOUS/);
  assert.match(source, /PARENT_LEVEL_NOT_FOUND/);
  assert.match(source, /validParentCandidateCount/);
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

test("saved action row locator is post-relative and remains optional for legacy configs", () => {
  const located = buildResolveSavedParentJs({
    version: 1,
    platform: "facebook",
    parentLevel: 26,
    locatorStrategy: "POST_IDENTITY_ACTION_ROW_LEVEL",
    actionRowLocator: {
      version: 1,
      strategy: "POST_IDENTITY_ANCHOR_RELATIVE_PATH",
      anchorReason: "facebook-permalink-path",
      anchorUp: 4,
      rowPath: [1, 2],
      rowTag: "DIV",
      rowRole: null,
    },
    updatedAt: new Date(0).toISOString(),
  });
  assert.doesNotThrow(() => new Function(`return ${located}`));
  assert.match(located, /config\.actionRowLocator/);
  assert.match(located, /locator\.anchorUp/);
  assert.match(located, /locator\.rowPath/);
  assert.match(located, /validRow/);
  assert.match(
    located,
    /common\.querySelectorAll\('button,\[role=button\],a'\)/,
  );
  assert.match(located, /while\(candidate&&candidate!==common\)/);
  assert.match(located, /sameReason/);
  assert.match(located, /facebook-\(\?:permalink\|posts\)-path/);
  assert.match(located, /diagnosticMeta:meta/);
  assert.match(located, /validParentCandidateCount/);
  assert.match(located, /preferredExactRowCount/);
  assert.match(located, /parentCandidateScores/);
  assert.match(
    located,
    /const uniqueParents=Array\.from\(new Set\(parents\)\)/,
  );
  assert.match(located, /innerHTMLLength/);
});
