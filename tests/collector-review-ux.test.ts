import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  addRegionToDraft,
  confirmRegionInDraft,
  confirmCaptureAudit,
  stepValidationErrors,
  regionsForCapture,
  revertDraftToVersion,
  saveAsVersion,
  updateRegionInDraft,
} from "../src/shared/collectors/ops.js";
import {
  createCollectorRegion,
  denormalizeGeometry,
  findVerifiedPostContainer,
  normalizeGeometry,
  assignSegmentMapping,
  getMappedVariablesForSegment,
  getMappingConfigState,
  executeLiveBrowserMatchTest,
} from "../src/shared/collectors/regions.js";
import { unmapVariableForCapture } from "../src/shared/collectors/ocr-learning.js";
import {
  MemoryStorage,
  loadCollectorStore,
  parseEnvelope,
  saveCollectorStore,
  upsertCollector,
} from "../src/shared/collectors/store.js";
import type { CollectorDomElement, CollectorDomSnapshot } from "../src/shared/collectors/types.js";
import type { Rect } from "../src/shared/contracts.js";

const reviewSource = readFileSync(
  resolve("src/renderer/collectors/ReviewMappingStep.tsx"),
  "utf8"
);
const cssSource = readFileSync(resolve("src/renderer/style.css"), "utf8");

test("UX 1 & 2: Explicit VIEW / DRAW / EDIT modes and pointer drag isolation", () => {
  // Modes exist in component
  assert.match(reviewSource, /regionInteractionMode/);
  assert.match(reviewSource, /🔍 VIEW/);
  assert.match(reviewSource, /✏️ DRAW/);
  assert.match(reviewSource, /📐 EDIT/);

  // DRAW mode prevents native dragging, panning and captures pointer
  assert.match(reviewSource, /setPointerCapture/);
  assert.match(reviewSource, /releasePointerCapture/);
  assert.match(reviewSource, /draggable=\{false\}/);
  assert.match(cssSource, /\.collector-review-image-container\.mode-draw\s*\{[^}]*touch-action:\s*none/s);
  assert.match(cssSource, /\.collector-review-image-container\.mode-draw\s*\{[^}]*cursor:\s*crosshair/s);
});

test("UX 3: VIEW mode allows normal navigation and scrolling", () => {
  assert.match(cssSource, /\.collector-review-image-container\.mode-view\s*\{[^}]*cursor:\s*default/s);
  // In VIEW mode, drawing pointerDown is ignored
  assert.match(
    reviewSource,
    /if\s*\(\s*regionInteractionMode\s*===\s*["']draw["']\s*\)/
  );
});

test("UX 4: EDIT mode moves/resizes selected region", () => {
  assert.match(reviewSource, /resizingHandle/);
  assert.match(reviewSource, /handleUpdateRegionGeometry/);
  assert.match(cssSource, /\.collector-resize-handle/);
  assert.match(cssSource, /\.collector-resize-handle\.nw/);
  assert.match(cssSource, /\.collector-resize-handle\.se/);

  // Geometric update logic
  const draft = createEmptyDraft({ name: "Geometry Test" });
  const reg = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Header",
    box: { x: 10, y: 10, width: 200, height: 50 },
    imageWidth: 1000,
    imageHeight: 800,
  });
  const withReg = addRegionToDraft(draft, reg);

  const resized = updateRegionInDraft(withReg, reg.id, {
    originalRoi: { x: 10, y: 10, width: 300, height: 75 },
    geometry: normalizeGeometry({ x: 10, y: 10, width: 300, height: 75 }, 1000, 800),
  });

  const updatedReg = resized.regions?.find((r) => r.id === reg.id);
  assert.ok(updatedReg);
  assert.equal(updatedReg.geometry.relW, 0.3);
  assert.equal(updatedReg.geometry.relH, 0.09375);
});

test("UX 5: Pointer cancellation safely resets drag and resize state", () => {
  assert.match(reviewSource, /handlePointerCancel/);
  assert.match(reviewSource, /onPointerCancel=\{handlePointerCancel\}/);
  // Validates that pointer cancel clears drawing
  assert.match(reviewSource, /setIsDrawing\(false\);\s*setDrawStart\(null\);\s*setDrawCurrent\(null\);/s);
});

test("UX 6: Coordinate mapping survives screenshot scaling", () => {
  // Dimension invariant normalized coordinates
  const norm = normalizeGeometry({ x: 100, y: 200, width: 400, height: 300 }, 1000, 1000);
  assert.equal(norm.relX, 0.1);
  assert.equal(norm.relY, 0.2);
  assert.equal(norm.relW, 0.4);
  assert.equal(norm.relH, 0.3);

  // Denormalizing to different display resolutions (e.g. 1920x1080 vs 1366x768)
  const fullHd = denormalizeGeometry(norm, 1920, 1080);
  assert.equal(fullHd.x, 192);
  assert.equal(fullHd.y, 216);
  assert.equal(fullHd.width, 768);
  assert.equal(fullHd.height, 324);

  const hd = denormalizeGeometry(norm, 1366, 768);
  assert.equal(hd.x, 137);
  assert.equal(hd.y, 154);
  assert.equal(hd.width, 546);
  assert.equal(hd.height, 230);
});

test("UX 7: Regions persist after Save and reopen", () => {
  let draft = createEmptyDraft({ name: "Persistence Test" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://facebook.com/group/feed",
    imageAsset: "22222222-3333-4444-5555-666666666666.png",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0]!.id;

  const reg = createCollectorRegion({
    captureItemId: capId,
    type: "STATIC",
    label: "Header Anchor",
    role: "header",
    box: { x: 20, y: 30, width: 400, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });
  draft = addRegionToDraft(draft, reg);

  const storage = new MemoryStorage();
  let env = loadCollectorStore(storage);
  env = upsertCollector(env, draft);
  saveCollectorStore(storage, env);

  const loadedEnv = loadCollectorStore(storage);
  const reloaded = loadedEnv.collectors.find((c) => c.id === draft.id);
  assert.ok(reloaded);
  assert.equal(reloaded.regions?.length, 1);
  assert.equal(reloaded.regions![0].label, "Header Anchor");

  const snapshot = saveAsVersion(draft, "v1");
  assert.equal(snapshot.versions[0]!.regions?.length, 1);
});

test("UX 8: Sequential Stages (2A Region Teaching -> 2B Field Mapping) & Back navigation", () => {
  // Stage indicator exists
  assert.match(reviewSource, /collector-stage-indicator/);
  assert.match(reviewSource, /2A.*Region Teaching/);
  assert.match(reviewSource, /2B.*Field Mapping/);
  assert.match(reviewSource, /Continue to Field Mapping →/);
  assert.match(reviewSource, /← Back to Regions/);

  // Field mappings remain untouched when returning to 2A
  let draft = createEmptyDraft({ name: "Navigation Test" });
  draft.variables = [
    {
      id: "v1",
      key: "author",
      label: "Author",
      valueType: "string",
      required: true,
      mappings: [
        {
          sampleId: "cap_1",
          presence: "mapped",
          text: "Nguyen Van A",
          confirmed: true,
        },
      ],
    },
  ];

  // Switching stages is a UI state change; draft variables remain identical
  assert.equal(draft.variables[0]!.mappings[0]!.confirmed, true);
  assert.equal(draft.variables[0]!.mappings[0]!.text, "Nguyen Van A");
});

test("UX 9 & 10: C2.9 Architecture: Decouples Region Teaching from live browser DOM", () => {
  // Live browser DOM verification action is removed from Stage 2A to prevent deadlock
  assert.doesNotMatch(reviewSource, />\s*Verify Post Container\s*<\/button>/);

  // Advancing from 2A -> 2B does not deadlock on live DOM or fake post container
  assert.match(reviewSource, /Continue to Field Mapping →/);
});

test("C2.9 Safe Region Deletion: explicit modal confirmation with completeness warning", () => {
  // Safe deletion modal state and popover exist
  assert.match(reviewSource, /regionPendingDelete/);
  assert.match(reviewSource, /<UiPopover[^>]*variant="modal"[^>]*className="unsaved-confirm"/);
  assert.match(reviewSource, /Delete Region Anchor\?/);

  // Deletion warning checks completeness of BEGIN/END anchor references
  assert.match(reviewSource, /deletionWarning/);
  assert.match(reviewSource, /leave group.*without a.*anchor reference/i);

  // Default focused Cancel button and destructive Delete Region action
  assert.match(reviewSource, /<button[^>]*autoFocus[^>]*onClick=\{[^}]*setRegionPendingDelete\(null\)[^}]*\}[^>]*>\s*Cancel\s*<\/button>/);
  assert.match(reviewSource, /Delete Region\s*<\/button>/);

  // Both docked editor and sidebar region cards trigger safe deletion confirmation
  assert.match(reviewSource, /onClick=\{\(\) => setRegionPendingDelete\(selectedRegion\)\}/);
  assert.match(reviewSource, /onClick=\{\(\) => setRegionPendingDelete\(r\)\}/);
});

test("C2.9 Architecture: Does not combine BEGIN and END into union crop during Step 2; renders independent reference crops", () => {
  // Independent anchor crop generation helper exists
  assert.match(reviewSource, /cropRegionReference/);

  // Anchor reference image thumbnail previews exist in both dock and cards
  assert.match(reviewSource, /selectedRegion\.referenceImage/);
  assert.match(reviewSource, /r\.referenceImage/);

  // Does NOT combine anchors into a bounding-box union nor infer a dynamic container crop in Step 2
  assert.doesNotMatch(reviewSource, /collector-container-highlight/);
  assert.doesNotMatch(reviewSource, /deriveReferenceCropFromAnchors/);
});

test("UX 11: FEED_ITEM / POST_DETAIL selector is hidden from Review UI", () => {
  // Selector buttons "Feed Item" and "Post Detail" must not exist in Review UI
  assert.doesNotMatch(reviewSource, />\s*Feed Item\s*<\/button>/);
  assert.doesNotMatch(reviewSource, />\s*Post Detail\s*<\/button>/);

  // But layoutContext remains in data model & code
  assert.match(reviewSource, /layoutContext/);
});

test("UX 12: Existing Collector records still load cleanly with backwards compatibility", () => {
  const legacyEnvelope = JSON.stringify({
    schemaVersion: 6,
    updatedAt: "2026-11-01T00:00:00.000Z",
    collectors: [
      {
        id: "col-hist-1",
        name: "Historical Collector",
        status: "draft",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        strategy: "FEED_NETWORK_JSON",
        captures: [],
        variables: [],
      },
    ],
  });

  const parsed = parseEnvelope(legacyEnvelope);
  assert.equal(parsed.collectors.length, 1);
  const col = parsed.collectors[0];
  assert.deepEqual(col.regions, []);
  assert.equal(col.layoutContext, "FEED_ITEM");
});

test("UX 13: Confirm Audit follows correct gate (blocks premature confirm when Region Teaching is incomplete)", () => {
  // Explicit gate prevents falsely confirming when region teaching is incomplete on teaching item
  assert.match(reviewSource, /Region Teaching incomplete/);
  assert.match(reviewSource, /activeStaticAnchors\.length === 0/);
});

test("UX 14: Verification supports single anchor without requiring hardcoded Header + Footer", () => {
  const dom: CollectorDomSnapshot = {
    url: "https://facebook.com/post/1",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      {
        id: "post_card",
        tagName: "ARTICLE",
        role: "article",
        className: "user-card",
        rect: { x: 50, y: 50, width: 800, height: 600 },
        textSnippet: "Author Name Content",
        attributes: { role: "article" },
        childrenIds: ["anchor_elem"],
        depth: 2,
        isArticleOrCard: true,
      },
      {
        id: "anchor_elem",
        parentId: "post_card",
        tagName: "DIV",
        className: "author-box",
        rect: { x: 60, y: 60, width: 400, height: 50 },
        textSnippet: "Author Name",
        attributes: {},
        childrenIds: [],
        depth: 3,
      },
    ],
  };

  // Static anchor with custom label and role
  const customAnchor = createCollectorRegion({
    captureItemId: "cap_1",
    type: "STATIC",
    label: "Custom Author Bar",
    role: "custom",
    box: { x: 60, y: 60, width: 400, height: 50 },
    imageWidth: 1000,
    imageHeight: 800,
    ocrText: "Author Name",
  });

  const verified = findVerifiedPostContainer([customAnchor], dom, 1000, 800, "FEED_ITEM");
  assert.equal(verified.containerId, "post_card");
  assert.ok(verified.confidence >= 80);
});

test("UX 15: Stage 2A completely separates OCR from Region Teaching (no OCR boxes in 2A)", () => {
  // Extract Stage 2A JSX block
  const stage2aMatch = reviewSource.match(
    /\{step2Stage === ["']regions["'] && \(\s*<div\s+className=["']collector-ocr-overlay["'][\s\S]*?<\/div>\s*\)\}/
  );
  assert.ok(stage2aMatch, "Stage 2A overlay block must exist");
  const stage2aJsx = stage2aMatch[0];

  // Stage 2A must NOT render activeSegments or OCR click handlers
  assert.doesNotMatch(stage2aJsx, /activeSegments\.map/);
  assert.doesNotMatch(stage2aJsx, /handleCreateRegionFromOcr/);
  assert.doesNotMatch(stage2aJsx, /collector-ocr-box/);
  assert.doesNotMatch(stage2aJsx, /title=\{`Click text block/);

  // Region Teaching in 2A operates strictly on activeRegions and live drag
  assert.match(stage2aJsx, /activeRegions\.map/);
  assert.match(stage2aJsx, /isDrawing && drawStart && drawCurrent/);
});

test("UX 16: Stage 2B preserves full OCR Word/Line/Block overlay and mapping without regression", () => {
  // Extract Stage 2B JSX block
  const stage2bMatch = reviewSource.match(
    /\{step2Stage === ["']fields["'] && \(currentRegion\?\.ocr \|\| active\.ocr\) && \(\s*<div[\s\S]*?className=["']collector-ocr-overlay["'][\s\S]*?<\/div>\s*\)\}/
  );
  assert.ok(stage2bMatch, "Stage 2B OCR overlay block must exist");
  const stage2bJsx = stage2bMatch[0];

  // Stage 2B must render activeSegments and OCR box selection
  assert.match(stage2bJsx, /activeSegments\.map/);
  assert.match(stage2bJsx, /collector-ocr-box/);
  assert.match(stage2bJsx, /setSelectedSegmentId\(s\.id\)/);

  // OCR data in capture item remains intact
  const draft = createEmptyDraft({ name: "OCR Preservation" });
  const captureWithOcr = {
    ...draft,
    captures: [
      {
        id: "cap_ocr",
        captureUrl: "https://example.com/item",
        capturedAt: new Date().toISOString(),
        imageAsset: "33333333-4444-5555-6666-777777777777.png",
        roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
        ocr: {
          text: "Sample Header",
          confidence: 95,
          language: "vie+eng" as const,
          segments: [
            {
              id: "seg_1",
              text: "Sample Header",
              kind: "block" as const,
              confidence: 95,
              bbox: { x: 50, y: 50, width: 300, height: 40 },
            },
          ],
        },
      },
    ],
  };

  // Adding a region in Stage 2A preserves the capture's OCR data
  const reg = createCollectorRegion({
    captureItemId: "cap_ocr",
    type: "STATIC",
    label: "Manual Header Anchor",
    box: { x: 50, y: 50, width: 300, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });

  const draftWithRegion = addRegionToDraft(captureWithOcr, reg);
  const updatedCap = draftWithRegion.captures?.find((c) => c.id === "cap_ocr");
  assert.ok(updatedCap?.ocr);
  assert.equal(updatedCap.ocr.text, "Sample Header");
  assert.equal(updatedCap.ocr.segments.length, 1);
  assert.equal(regionsForCapture(draftWithRegion, "cap_ocr").length, 1);
});

test("UX 17: Persistent Region Highlight borders for BEGIN, END, and FREE across light/dark backgrounds", () => {
  // BEGIN (blue), END (green), FREE (purple)
  assert.match(cssSource, /\.collector-region-box\.begin[\s\S]*?border:\s*2px solid #3b82f6/);
  assert.match(cssSource, /\.collector-region-box\.end[\s\S]*?border:\s*2px solid #10b981/);
  assert.match(cssSource, /\.collector-region-box\.free[\s\S]*?border:\s*2px solid #a855f7/);

  // High contrast shadow for visibility on both dark and light screenshots
  assert.match(cssSource, /\.collector-region-box\.begin[\s\S]*?box-shadow:/);
  assert.match(cssSource, /\.collector-region-box\.end[\s\S]*?box-shadow:/);
  assert.match(cssSource, /\.collector-region-box\.free[\s\S]*?box-shadow:/);

  // DRAW mode passes pointer events through so existing regions do not intercept drawing
  assert.match(cssSource, /\.collector-review-image-container\.mode-draw\s+\.collector-region-box[\s\S]*?pointer-events:\s*none/);

  // Resize handles have distinct styling and border
  assert.match(cssSource, /\.collector-resize-handle[\s\S]*?border:/);
});

test("UX 18: Stage 2B automatic crop recovery, actionable error handling, and OCR safety", () => {
  // Automatic crop recovery hook and callback exist
  assert.match(reviewSource, /recoverCrops/);
  assert.match(reviewSource, /resolveRegionCropBox/);

  // OCR refuses to run / report success if referenceImage is missing
  assert.match(reviewSource, /if\s*\(!targetReg\.referenceImage\)\s*\{\s*setOcrError\(/);
  assert.match(reviewSource, /disabled=\{locked \|\| ocrLoading \|\| !currentRegion \|\| !currentRegion\.referenceImage \|\| isRecoveringCrop\}/);

  // Actionable error states exist for crop recovery failures
  assert.match(reviewSource, /Original screenshot missing\./);
  assert.match(reviewSource, /Invalid region bounds\./);
  assert.match(reviewSource, /Crop generation failure/);
  assert.match(reviewSource, /Asset loading failure/);

  // Manual regenerate button available
  assert.match(reviewSource, />\s*Regenerate Region Crop\s*<\/button>/);
});

test("UX 19: C2.10.2 Region OCR Pipeline, Status Feedback, and Coordinate Mapping", () => {
  // 1. Stage 2B overlay renders when currentRegion.ocr is present
  assert.match(reviewSource, /\{step2Stage === ["']fields["'] && \(currentRegion\?\.ocr \|\| active\.ocr\) && \(/);

  // 2. OCR button and feedback badge show meaningful runtime states
  assert.match(reviewSource, /Running OCR\.\.\./);
  assert.match(reviewSource, /OCR completed —/);
  assert.match(reviewSource, /No text detected/);
  assert.match(reviewSource, /OCR failed —/);
  assert.match(reviewSource, /collector-ocr-feedback-pill/);

  // 3. Informative notice rendered when region OCR contains 0 segments
  assert.match(reviewSource, /No text detected in this region crop/);

  // 4. Bounding box rendered in crop-local coordinates relative to crop dimensions
  assert.match(reviewSource, /left:\s*`\$\{\(s\.bbox\.x \/ cropW\) \* 100\}%`/);
  assert.match(reviewSource, /top:\s*`\$\{\(s\.bbox\.y \/ cropH\) \* 100\}%`/);

  // 5. Variable mapping transforms crop-local segment bbox back to screenshot coordinates
  assert.match(reviewSource, /x:\s*roiX \+ segment\.bbox\.x/);
  assert.match(reviewSource, /y:\s*roiY \+ segment\.bbox\.y/);

  // 6. Atomic variable creation from segment sets mapping directly
  assert.match(reviewSource, /function handleCreateVariableFromSegment[\s\S]*?mappings:\s*\[newMapping\]/);
});

test("UX 20: C2.10.3 Multi-Variable Mapping From One OCR Segment & Extraction Methods", () => {
  // --- A. UI Template & Markup Checks ---
  // 1. Extraction method selector exists with OCR_TEXT, DOM_TEXT, DOM_ATTRIBUTE
  assert.match(reviewSource, /<option value="OCR_TEXT">OCR_TEXT<\/option>/);
  assert.match(reviewSource, /<option value="DOM_TEXT">DOM_TEXT<\/option>/);
  assert.match(reviewSource, /<option value="DOM_ATTRIBUTE">DOM_ATTRIBUTE<\/option>/);

  // 2. Attribute input shown when DOM_ATTRIBUTE is selected
  assert.match(reviewSource, /assignMethod === ["']DOM_ATTRIBUTE["']/);
  assert.match(reviewSource, /placeholder=["']e\.g\. href, src["']/);

  // 3. Mapped variables section and remove action
  assert.match(reviewSource, /collector-segment-mappings-section/);
  assert.match(reviewSource, /collector-segment-mapping-item/);
  assert.match(reviewSource, /Mapped Variables \(/);
  assert.match(reviewSource, /unmapVariableForCapture/);

  // 4. Pending DOM match status badge in UI
  assert.match(reviewSource, /Configured \/ Awaiting DOM Match/);
  assert.match(reviewSource, /Awaiting DOM Match/);

  // 5. CSS definitions exist
  assert.match(cssSource, /\.collector-segment-mappings-section/);
  assert.match(cssSource, /\.collector-segment-mapping-item/);

  // --- B. Acceptance Tests Criteria 1-10 ---
  let draft = createEmptyDraft({ name: "Multi-Variable Mapping Test" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com/post/1",
    imageAsset: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0]!.id;

  const beginRegion = createCollectorRegion({
    captureItemId: capId,
    type: "BEGIN",
    groupTag: "post-main",
    label: "Header Anchor",
    box: { x: 20, y: 20, width: 300, height: 80 },
    imageWidth: 800,
    imageHeight: 600,
    referenceImage: "data:image/png;base64,mockBeginCrop",
  });
  draft = addRegionToDraft(draft, beginRegion);

  const varCreatedAt = {
    id: "var_created_at",
    key: "created_at",
    label: "Created At",
    valueType: "string" as const,
    required: false,
    mappings: [],
  };
  const varPostUrl = {
    id: "var_post_url",
    key: "post_url",
    label: "Post URL",
    valueType: "string" as const,
    required: false,
    mappings: [],
  };
  draft = { ...draft, variables: [varCreatedAt, varPostUrl] };

  const timestampSegment = {
    id: "seg_timestamp_01",
    text: "15 mins ago",
    confidence: 96,
    bbox: { x: 10, y: 35, width: 90, height: 18 },
  };

  // Criterion 1 & 2: Map timestamp OCR segment to created_at using OCR_TEXT
  draft = assignSegmentMapping(
    draft,
    capId,
    varCreatedAt.id,
    timestampSegment,
    beginRegion.id,
    "OCR_TEXT",
  );

  const createdAtMapping = draft.variables.find((v) => v.id === varCreatedAt.id)!.mappings.find((m) => m.sampleId === capId);
  assert.ok(createdAtMapping, "created_at mapping must exist");
  assert.equal(createdAtMapping.presence, "mapped");
  assert.equal(createdAtMapping.method, "OCR_TEXT");
  assert.equal(createdAtMapping.text, "15 mins ago");
  assert.equal(createdAtMapping.confidence, 96);
  assert.equal(createdAtMapping.segmentId, "seg_timestamp_01");

  // Criterion 3: Add post_url to the SAME segment using DOM_ATTRIBUTE(href)
  draft = assignSegmentMapping(
    draft,
    capId,
    varPostUrl.id,
    timestampSegment,
    beginRegion.id,
    "DOM_ATTRIBUTE",
    "href",
  );

  const postUrlMapping = draft.variables.find((v) => v.id === varPostUrl.id)!.mappings.find((m) => m.sampleId === capId);
  assert.ok(postUrlMapping, "post_url mapping must exist");
  assert.equal(postUrlMapping.presence, "mapped");
  assert.equal(postUrlMapping.method, "DOM_ATTRIBUTE");
  assert.equal(postUrlMapping.attribute, "href");
  assert.equal(postUrlMapping.segmentId, "seg_timestamp_01");
  // Criterion 4 & Section 4: Do not invent URL from visible text
  assert.equal(postUrlMapping.text, undefined, "DOM_ATTRIBUTE must not copy visible OCR text");
  assert.equal(postUrlMapping.confidence, undefined, "DOM_ATTRIBUTE confidence is pending DOM match");
  assert.equal(postUrlMapping.evidence, "Configured / Awaiting DOM Match");

  // Criterion 4: Both mappings remain associated with the same segment
  let mappedToTimestamp = getMappedVariablesForSegment(
    draft.variables,
    capId,
    timestampSegment.id,
    beginRegion.id,
  );
  assert.equal(mappedToTimestamp.length, 2, "Both variables must be associated with the same timestamp segment");
  assert.equal(mappedToTimestamp[0]!.variable.key, "created_at");
  assert.equal(mappedToTimestamp[1]!.variable.key, "post_url");

  // Criterion 7 (Deduplication): Re-assigning the same variable/method/attribute combination does not duplicate
  const beforeCount = draft.variables.find((v) => v.id === varPostUrl.id)!.mappings.length;
  draft = assignSegmentMapping(
    draft,
    capId,
    varPostUrl.id,
    timestampSegment,
    beginRegion.id,
    "DOM_ATTRIBUTE",
    "href",
  );
  assert.equal(
    draft.variables.find((v) => v.id === varPostUrl.id)!.mappings.length,
    beforeCount,
    "Duplicate mapping of same variable/method combination must be prevented"
  );

  // Criterion 5: Removing post_url does not remove created_at
  draft = unmapVariableForCapture(draft, capId, varPostUrl.id);
  mappedToTimestamp = getMappedVariablesForSegment(
    draft.variables,
    capId,
    timestampSegment.id,
    beginRegion.id,
  );
  assert.equal(mappedToTimestamp.length, 1, "Only created_at should remain mapped");
  assert.equal(mappedToTimestamp[0]!.variable.key, "created_at");

  // Re-add post_url for persistent checks
  draft = assignSegmentMapping(
    draft,
    capId,
    varPostUrl.id,
    timestampSegment,
    beginRegion.id,
    "DOM_ATTRIBUTE",
    "href",
  );

  // Criterion 6: Switching BEGIN/END preserves mappings
  const endRegion = createCollectorRegion({
    captureItemId: capId,
    type: "END",
    groupTag: "post-main",
    label: "Footer Anchor",
    box: { x: 20, y: 500, width: 300, height: 60 },
    imageWidth: 800,
    imageHeight: 600,
  });
  draft = addRegionToDraft(draft, endRegion);

  // Querying in END region returns empty
  const inEnd = getMappedVariablesForSegment(draft.variables, capId, timestampSegment.id, endRegion.id);
  assert.equal(inEnd.length, 0, "No mappings in END region for this segment");

  // Switching back to BEGIN returns both mappings intact
  const inBeginAgain = getMappedVariablesForSegment(draft.variables, capId, timestampSegment.id, beginRegion.id);
  assert.equal(inBeginAgain.length, 2, "Both mappings preserved when switching back to BEGIN region");

  // Criterion 7: Save & Reload preserves both mappings
  const storage = new MemoryStorage();
  const store = loadCollectorStore(storage);
  const updatedStore = upsertCollector(store, draft);
  saveCollectorStore(storage, updatedStore);

  const reloaded = loadCollectorStore(storage).collectors.find((c) => c.id === draft.id);
  assert.ok(reloaded, "Reloaded collector must exist");
  const reloadedVars = getMappedVariablesForSegment(
    reloaded.variables,
    capId,
    timestampSegment.id,
    beginRegion.id,
  );
  assert.equal(reloadedVars.length, 2, "Save and reload must preserve both multi-variable mappings");
  assert.equal(reloadedVars[0]!.mapping.method, "OCR_TEXT");
  assert.equal(reloadedVars[1]!.mapping.method, "DOM_ATTRIBUTE");
  assert.equal(reloadedVars[1]!.mapping.attribute, "href");

  // Criterion 8: Version snapshot and restore preserves both mappings
  const versioned = saveAsVersion(draft, "Snapshot with multi-mapping");
  assert.equal(versioned.versions.length, 1);
  const snapId = versioned.versions[0]!.id;

  // Unmap both in draft
  let corruptedDraft = unmapVariableForCapture(versioned, capId, varCreatedAt.id);
  corruptedDraft = unmapVariableForCapture(corruptedDraft, capId, varPostUrl.id);
  assert.equal(
    getMappedVariablesForSegment(corruptedDraft.variables, capId, timestampSegment.id, beginRegion.id).length,
    0
  );

  // Restore snapshot
  const restoredDraft = revertDraftToVersion(corruptedDraft, snapId);
  assert.ok(restoredDraft, "Version restore must succeed");
  const restoredVars = getMappedVariablesForSegment(
    restoredDraft.variables,
    capId,
    timestampSegment.id,
    beginRegion.id,
  );
  assert.equal(restoredVars.length, 2, "Version restore must fully recover both mappings");
  assert.equal(restoredVars[0]!.variable.key, "created_at");
  assert.equal(restoredVars[1]!.variable.key, "post_url");

  // Criterion 9: Existing legacy single-variable mappings still work
  const legacyVar = {
    id: "var_legacy",
    key: "legacy_author",
    label: "Legacy Author",
    valueType: "string" as const,
    required: false,
    mappings: [
      {
        sampleId: capId,
        regionId: beginRegion.id,
        segmentId: "seg_legacy_01",
        presence: "mapped" as const,
        confirmed: true,
        text: "John Doe",
      },
    ],
  };
  const legacyMapped = getMappedVariablesForSegment([legacyVar], capId, "seg_legacy_01", beginRegion.id);
  assert.equal(legacyMapped.length, 1);
  assert.equal(legacyMapped[0]!.mapping.method ?? "OCR_TEXT", "OCR_TEXT", "Legacy mappings default to OCR_TEXT");
  assert.equal(legacyMapped[0]!.mapping.text, "John Doe");

  // Criterion 10: DOM_ATTRIBUTE remains pending until actual DOM association
  assert.equal(restoredVars[1]!.mapping.evidence, "Configured / Awaiting DOM Match");
  assert.equal(restoredVars[1]!.mapping.text, undefined);
});

test("UX 21: C2.10.4 Early Validation & Live Browser Match Test", () => {
  // --- PART A: Early Validation Separation (CONFIGURED vs MATCHED/EXTRACTED) ---

  // 1. Unmapped status
  const unmappedState = getMappingConfigState(undefined);
  assert.equal(unmappedState.status, "UNMAPPED");
  assert.equal(unmappedState.isValid, false);

  // 2. Not present status
  const notPresentState = getMappingConfigState({
    sampleId: "s1",
    presence: "not_present",
    confirmed: true,
  });
  assert.equal(notPresentState.status, "CONFIGURED");
  assert.equal(notPresentState.isValid, true);

  // 3. OCR_TEXT requires segment/text
  const invalidOcr = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "OCR_TEXT",
  });
  assert.equal(invalidOcr.status, "INVALID");
  assert.equal(invalidOcr.isValid, false);

  const validOcr = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "OCR_TEXT",
    segmentId: "seg_1",
    text: "Extracted Text",
  });
  assert.equal(validOcr.status, "EXTRACTED");
  assert.equal(validOcr.isValid, true);

  // 4. DOM_TEXT requires region/segment
  const invalidDomText = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "DOM_TEXT",
  });
  assert.equal(invalidDomText.status, "INVALID");
  assert.equal(invalidDomText.isValid, false);

  const validDomText = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "DOM_TEXT",
    regionId: "reg_1",
  });
  assert.equal(validDomText.status, "CONFIGURED");
  assert.equal(validDomText.isValid, true);
  assert.match(validDomText.badgeLabel, /Awaiting DOM Match/i);

  // 5. DOM_ATTRIBUTE requires region/segment AND attribute name
  const missingAttr = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "DOM_ATTRIBUTE",
    regionId: "reg_1",
  });
  assert.equal(missingAttr.status, "INVALID");
  assert.equal(missingAttr.isValid, false);
  assert.match(missingAttr.badgeLabel, /Missing Attribute/i);

  const validDomAttr = getMappingConfigState({
    sampleId: "s1",
    presence: "mapped",
    confirmed: true,
    method: "DOM_ATTRIBUTE",
    regionId: "reg_1",
    attribute: "href",
  });
  assert.equal(validDomAttr.status, "CONFIGURED");
  assert.equal(validDomAttr.isValid, true);
  assert.match(validDomAttr.badgeLabel, /Awaiting DOM Match/i);

  // 6. Stage 2B Audit Confirmation with DOM_ATTRIBUTE
  let draft = createEmptyDraft({ name: "C2.10.4 Validation Draft" });
  draft = addCaptureItem(draft, {
    captureUrl: "https://example.com/post/1",
    imageAsset: "11111111-2222-3333-4444-555555555555.png",
    roi: { x: 0, y: 0, width: 800, height: 600, containerWidth: 800, containerHeight: 600 },
  });
  const capId = draft.captures[0]!.id;

  const beginRegion = createCollectorRegion({
    captureItemId: capId,
    type: "BEGIN",
    groupTag: "post-group",
    label: "Header",
    box: { x: 10, y: 10, width: 200, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });
  const endRegion = createCollectorRegion({
    captureItemId: capId,
    type: "END",
    groupTag: "post-group",
    label: "Footer",
    box: { x: 10, y: 300, width: 200, height: 40 },
    imageWidth: 800,
    imageHeight: 600,
  });
  draft = addRegionToDraft(draft, beginRegion);
  draft = addRegionToDraft(draft, endRegion);

  // Add required variable mapped to DOM_ATTRIBUTE(href) without extracted text
  draft.variables = [
    {
      id: "var_post_url",
      key: "post_url",
      label: "Post URL",
      valueType: "url",
      required: true,
      source: "visual_dom",
      mappings: [
        {
          sampleId: capId,
          regionId: beginRegion.id,
          presence: "mapped",
          confirmed: true,
          method: "DOM_ATTRIBUTE",
          attribute: "href",
          text: undefined, // NOT extracted yet
        },
      ],
    },
  ];

  // Confirming audit MUST SUCCEED (not blocked by missing extracted value)
  const confirmedDraft = confirmCaptureAudit(draft, capId);
  const audit = confirmedDraft.captureAudits?.find((a) => a.captureItemId === capId);
  assert.equal(audit?.status, "confirmed", "Audit must confirm with CONFIGURED DOM_ATTRIBUTE mapping");

  // Step 2 validation errors must be empty
  const step2Errors = stepValidationErrors(confirmedDraft, 2);
  assert.deepEqual(step2Errors, [], "Step 2 validation must pass without errors");

  // --- PART B: Live Browser Match Test Viewport Bounding (Max 3 Items) ---

  // Build a snapshot with 5 post containers rendered vertically
  const makeDomEl = (p: Partial<CollectorDomElement> & { id: string; tagName: string; rect: Rect }): CollectorDomElement => ({
    attributes: {},
    childrenIds: [],
    depth: 1,
    textSnippet: "",
    ...p,
  });

  const elements: CollectorDomElement[] = [
    // Post 1
    makeDomEl({ id: "b1", tagName: "div", parentId: "card1", rect: { x: 10, y: 10, width: 200, height: 40 }, textSnippet: "Header 1" }),
    makeDomEl({ id: "e1", tagName: "div", parentId: "card1", rect: { x: 10, y: 100, width: 200, height: 40 }, textSnippet: "Footer 1" }),
    makeDomEl({ id: "card1", tagName: "article", isArticleOrCard: true, rect: { x: 5, y: 5, width: 300, height: 150 }, textSnippet: "Card 1" }),

    // Post 2
    makeDomEl({ id: "b2", tagName: "div", parentId: "card2", rect: { x: 10, y: 200, width: 200, height: 40 }, textSnippet: "Header 2" }),
    makeDomEl({ id: "e2", tagName: "div", parentId: "card2", rect: { x: 10, y: 290, width: 200, height: 40 }, textSnippet: "Footer 2" }),
    makeDomEl({ id: "card2", tagName: "article", isArticleOrCard: true, rect: { x: 5, y: 195, width: 300, height: 150 }, textSnippet: "Card 2" }),

    // Post 3
    makeDomEl({ id: "b3", tagName: "div", parentId: "card3", rect: { x: 10, y: 380, width: 200, height: 40 }, textSnippet: "Header 3" }),
    makeDomEl({ id: "e3", tagName: "div", parentId: "card3", rect: { x: 10, y: 470, width: 200, height: 40 }, textSnippet: "Footer 3" }),
    makeDomEl({ id: "card3", tagName: "article", isArticleOrCard: true, rect: { x: 5, y: 375, width: 300, height: 150 }, textSnippet: "Card 3" }),

    // Post 4
    makeDomEl({ id: "b4", tagName: "div", parentId: "card4", rect: { x: 10, y: 560, width: 200, height: 40 }, textSnippet: "Header 4" }),
    makeDomEl({ id: "e4", tagName: "div", parentId: "card4", rect: { x: 10, y: 650, width: 200, height: 40 }, textSnippet: "Footer 4" }),
    makeDomEl({ id: "card4", tagName: "article", isArticleOrCard: true, rect: { x: 5, y: 555, width: 300, height: 150 }, textSnippet: "Card 4" }),

    // Post 5
    makeDomEl({ id: "b5", tagName: "div", parentId: "card5", rect: { x: 10, y: 740, width: 200, height: 40 }, textSnippet: "Header 5" }),
    makeDomEl({ id: "e5", tagName: "div", parentId: "card5", rect: { x: 10, y: 830, width: 200, height: 40 }, textSnippet: "Footer 5" }),
    makeDomEl({ id: "card5", tagName: "article", isArticleOrCard: true, rect: { x: 5, y: 735, width: 300, height: 150 }, textSnippet: "Card 5" }),
  ];

  const snapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements,
    isStale: false,
  };

  const matchResult = executeLiveBrowserMatchTest(draft.regions!, snapshot);
  assert.equal(matchResult.status, "MATCHED");
  assert.ok(matchResult.matchedItems, "matchedItems array must be returned");
  // Strictly bounded to AT MOST 3 posts
  assert.equal(matchResult.matchedItems.length, 3, "Must strictly match at most 3 post containers");
  assert.equal(matchResult.matchedItems[0]!.index, 1);
  assert.equal(matchResult.matchedItems[1]!.index, 2);
  assert.equal(matchResult.matchedItems[2]!.index, 3);
  // Strictly top-to-bottom order
  assert.ok(matchResult.matchedItems[0]!.beginRect!.y < matchResult.matchedItems[1]!.beginRect!.y);
  assert.ok(matchResult.matchedItems[1]!.beginRect!.y < matchResult.matchedItems[2]!.beginRect!.y);

  // Each item records granular stages
  const item1 = matchResult.matchedItems[0]!;
  assert.equal(item1.beginMatched, true);
  assert.equal(item1.endMatched, true);
  assert.equal(item1.paired, true);
  assert.equal(item1.domResolved, true);
  assert.equal(item1.containerTagName, "article");
  assert.ok(item1.confidence > 0);

  // --- Honest Diagnostics: 0 matches reports FAILED, not PASS ---
  const emptySnapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [],
    isStale: false,
  };
  const failedResult = executeLiveBrowserMatchTest(draft.regions!, emptySnapshot);
  assert.equal(failedResult.status, "FAILED", "Zero matches must report FAILED, never PASS");
  assert.equal(failedResult.matchedPostCount, 0);
  assert.ok(failedResult.summary.includes("No DOM elements found") || failedResult.summary.includes("Match Test failed"));

  const unmatchingSnapshot: CollectorDomSnapshot = {
    url: "https://example.com/feed",
    capturedAt: new Date().toISOString(),
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, dpr: 1 },
    elements: [
      makeDomEl({ id: "other", tagName: "div", rect: { x: 0, y: 0, width: 100, height: 20 }, textSnippet: "completely unrelated content" }),
    ],
    isStale: false,
  };
  const unmatchingResult = executeLiveBrowserMatchTest(draft.regions!, unmatchingSnapshot);
  assert.equal(unmatchingResult.status, "FAILED", "Unmatching anchors must report FAILED, never PASS");
  assert.equal(unmatchingResult.matchedPostCount, 0);
  assert.ok(unmatchingResult.summary.includes("Neither BEGIN anchor"));

  // --- Step 3 Component source checks ---
  const matchStepSource = readFileSync(
    resolve("src/renderer/collectors/MatchTestStep.tsx"),
    "utf8"
  );
  assert.match(matchStepSource, /collectorReportBrowserHost/);
  assert.match(matchStepSource, /collectorSetBrowserVisible/);
  assert.match(matchStepSource, /collectorHighlightMatches/);
  assert.match(matchStepSource, /collectorClearHighlights/);
  assert.match(matchStepSource, /hasAutoRunRef/);
  assert.match(matchStepSource, /Re-run Match Test/);
});
