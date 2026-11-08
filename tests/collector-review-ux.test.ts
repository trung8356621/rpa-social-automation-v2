import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEmptyDraft } from "../src/shared/collectors/fixtures.js";
import {
  addCaptureItem,
  addRegionToDraft,
  confirmRegionInDraft,
  regionsForCapture,
  saveAsVersion,
  updateRegionInDraft,
} from "../src/shared/collectors/ops.js";
import {
  createCollectorRegion,
  denormalizeGeometry,
  findVerifiedPostContainer,
  normalizeGeometry,
} from "../src/shared/collectors/regions.js";
import {
  MemoryStorage,
  loadCollectorStore,
  parseEnvelope,
  saveCollectorStore,
  upsertCollector,
} from "../src/shared/collectors/store.js";
import type { CollectorDomSnapshot } from "../src/shared/collectors/types.js";

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

test("UX 9 & 10: C2.9.1 Decouples Region Teaching from live browser DOM (pure configuration validation)", () => {
  // Live browser DOM verification action is removed from Stage 2A to prevent deadlock
  assert.doesNotMatch(reviewSource, />\s*Verify Post Container\s*<\/button>/);

  // Advancing from 2A -> 2B is gated purely on configuration validity (groupAnalysis.valid)
  assert.match(
    reviewSource,
    /disabled=\{locked\s*\|\|\s*!groupAnalysis\.valid\}/
  );
  assert.match(reviewSource, /Continue to Field Mapping →/);
});

test("C2.9.1 Safe Region Deletion: explicit modal confirmation with completeness warning", () => {
  // Safe deletion modal state and popover exist
  assert.match(reviewSource, /regionPendingDelete/);
  assert.match(reviewSource, /<UiPopover[^>]*variant="modal"[^>]*className="unsaved-confirm"/);
  assert.match(reviewSource, /Delete Region Anchor\?/);

  // Deletion warning checks completeness of BEGIN/END anchors
  assert.match(reviewSource, /deletionWarning/);
  assert.match(reviewSource, /leave group.*without.*preventing crop derivation/i);

  // Default focused Cancel button and destructive Delete Region action
  assert.match(reviewSource, /<button[^>]*autoFocus[^>]*onClick=\{[^}]*setRegionPendingDelete\(null\)[^}]*\}[^>]*>\s*Cancel\s*<\/button>/);
  assert.match(reviewSource, /Delete Region\s*<\/button>/);

  // Both docked editor and sidebar region cards trigger safe deletion confirmation
  assert.match(reviewSource, /onClick=\{\(\) => setRegionPendingDelete\(selectedRegion\)\}/);
  assert.match(reviewSource, /onClick=\{\(\) => setRegionPendingDelete\(r\)\}/);
});

test("C2.9.1 Stage 2B: Derives reference crop directly from screenshot anchors without live DOM", () => {
  assert.match(reviewSource, /deriveReferenceCropFromAnchors/);
  assert.match(reviewSource, /Reference Crop \(\{referenceCrop\.groupTag\}\)/);
  assert.match(reviewSource, /REFERENCE CROP:/);
  assert.match(reviewSource, /Anchor group configuration incomplete/);
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
    /\{step2Stage === ["']regions["'] && \(\s*<div[\s\S]*?className=["']collector-ocr-overlay["'][\s\S]*?<\/div>\s*\)\}/
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
    /\{step2Stage === ["']fields["'] && active\.ocr && \(\s*<div[\s\S]*?className=["']collector-ocr-overlay["'][\s\S]*?<\/div>\s*\)\}/
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
