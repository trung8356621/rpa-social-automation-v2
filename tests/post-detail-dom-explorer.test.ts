import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const explorer = () => readFileSync("src/renderer/post-detail-collector/SavedParentHtmlStep.tsx", "utf8");
const extraction = () => readFileSync("src/renderer/post-detail-collector/extract-parent-data.ts", "utf8");

test("Step 3 defaults to extracted values and keeps deep DOM under Advanced Debug", () => {
  const source = explorer();
  assert.match(source, /Step 3 — Extracted Data Review/);
  assert.match(source, /Extracted values/);
  assert.match(source, /<details className="pdc-advanced-debug"><summary>Advanced Debug<\/summary>/);
  assert.match(source, /Auto Mapped/);
  assert.match(source, /Unmapped/);
  assert.match(source, /Needs Attention/);
  assert.match(source, /className="pdc-extracted-detail"/);
  assert.doesNotMatch(source, /<aside className="pdc-data-mapper"/);
});

test("single-pass extraction emits direct text and semantic values without ancestor textContent", () => {
  const source = extraction();
  assert.match(source, /One DFS pass for generic values/);
  assert.match(source, /node\.nodeType === Node\.TEXT_NODE/);
  assert.match(source, /tag === "a"/);
  assert.match(source, /tag === "img"/);
  assert.match(source, /tag === "time"/);
  assert.doesNotMatch(source, /kind: "text"[^\n]*element\.textContent/);
});

test("semantic extraction uses post identity accessibility metadata and structural body boundaries", () => {
  const source = extraction();
  assert.match(source, /aria-describedby/);
  assert.match(source, /findPrimaryTimestampAnchor/);
  assert.match(source, /semanticField: "created_at"/);
  assert.match(source, /findPostContentRoot/);
  assert.match(source, /semanticField: "content"/);
  assert.match(source, /content_text/);
  assert.match(source, /content_html/);
  assert.match(source, /isComment/);
  assert.doesNotMatch(source, /OCR|parent\.textContent/);
});

test("links expose text and href outputs from one locator", () => {
  const source = extraction();
  assert.match(source, /outputs\.push\(\{ key: "text"/);
  assert.match(source, /outputs\.push\(\{ key: "href"/);
  assert.match(source, /sourcePaths: \[path\]/);
});

test("Step 3 supports output mapping, persisted hide and hidden-noise review", () => {
  const source = explorer();
  const store = readFileSync("src/renderer/post-detail-collector/store.ts", "utf8");
  assert.match(source, /Save Mapping/);
  assert.match(source, /Unmap Output/);
  assert.match(source, /Show Hidden/);
  assert.match(source, /Restore/);
  assert.match(source, /pdc-data-hide/);
  assert.match(source, /outputKey: selectedOutput\.key/);
  assert.match(store, /hiddenExtractedData: state\.hiddenExtractedData/);
});

test("extraction preserves structural context and refuses ambiguous locators", () => {
  const extractSource = extraction();
  const uiSource = explorer();
  assert.match(extractSource, /getAttribute\("role"\) === "article"/);
  assert.match(extractSource, /isComment\(element, root\) \? "comment"/);
  assert.match(uiSource, /selectedData\.sourcePaths\.length !== 1/);
  assert.match(uiSource, /sourceContext: selectedData\.context/);
  assert.match(uiSource, /postDetailClearParentNodeHighlight/);
});

test("Step 3 DOM Explorer supports lazy focus, breadcrumb and expanded view", () => {
  const source = explorer();
  assert.match(source, /onDoubleClick=\{\(\) => onFocus\(node\)\}/);
  assert.match(source, /Reset Focus/);
  assert.match(source, /pdc-dom-breadcrumb/);
  assert.match(source, /isExpanded/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /Tree width/);
  assert.match(source, /Collapse Browser Preview/);
  assert.match(source, /const children = open \?/);
  assert.doesNotMatch(source, /children: ExplorerNode\[\]/);
});

test("Inspector separates readable content, selectors and live highlight", () => {
  const source = explorer();
  for (const label of ["Attributes", "Text", "Selector", "Variables", "Copy XPath", "Copy Selector", "Copy Text"]) assert.match(source, new RegExp(label));
  assert.match(source, /onMouseEnter=\{\(\) => onHover\(node\)\}/);
  assert.match(source, /Full text/);
  assert.match(source, /outerHTML/);
});

test("Step 3 reuses Collector variable schema and persists only verified mappings", () => {
  const source = explorer();
  const store = readFileSync("src/renderer/post-detail-collector/store.ts", "utf8");
  assert.match(source, /COLLECTOR_STORAGE_KEY/);
  assert.match(source, /CollectorStoreEnvelope/);
  assert.match(source, /DOM_TEXT/);
  assert.match(source, /DOM_ATTRIBUTE/);
  assert.match(source, /selectedMatchCount !== 1/);
  assert.match(source, /Missing/);
  assert.match(source, /Needs Attention/);
  assert.match(store, /variableMappings: state\.variableMappings/);
  assert.doesNotMatch(source, /like_count|comment_count|share_count/);
});

test("AUTO remains strict and Customize does not run visual scan", () => {
  const source = explorer();
  assert.match(source, /AUTO · Parent Matched/);
  assert.match(source, /Customize · Rematch Parent/);
  assert.doesNotMatch(source, /runPostDetailAutoScan|Auto Scan|OpenCV/);
});
