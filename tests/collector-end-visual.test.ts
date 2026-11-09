import test from "node:test";
import assert from "node:assert/strict";
import sharp, { type OverlayOptions } from "sharp";
import {
  matchEndVisual,
  computeVariance,
  computePatchSimilarity,
  extractVisualSubPatches,
} from "../src/main/end-visual-matcher.js";

/**
 * Helper to build an SVG pattern representing the 3 action icons:
 * - Like thumb (left, ~15%)
 * - Comment speech bubble (middle, ~50%)
 * - Share arrow (right, ~85%)
 */
function createFooterSvg(width = 500, height = 40, opts?: { omitShare?: boolean; narrow?: boolean }): Buffer {
  const w = opts?.narrow ? 260 : width;
  const h = height;
  const likeX = Math.round(w * 0.18);
  const commentX = Math.round(w * 0.50);
  const shareX = Math.round(w * 0.82);

  const shareSvg = opts?.omitShare
    ? ""
    : `<path d="M ${shareX - 8} 20 L ${shareX + 6} 20 M ${shareX} 14 L ${shareX + 6} 20 L ${shareX} 26" stroke="#65676B" stroke-width="2.5" fill="none" />
       <text x="${shareX + 12}" y="24" font-family="sans-serif" font-size="12" fill="#65676B">Chia sẻ</text>`;

  const svg = `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${w}" height="${h}" fill="#FFFFFF" />
      <line x1="0" y1="1" x2="${w}" y2="1" stroke="#E4E6EB" stroke-width="1" />
      
      <!-- Like cluster -->
      <path d="M ${likeX - 10} 24 L ${likeX - 10} 16 L ${likeX - 4} 16 L ${likeX - 1} 12 L ${likeX + 2} 12 L ${likeX + 2} 17 L ${likeX + 8} 17 L ${likeX + 6} 24 Z" fill="#65676B" />
      <text x="${likeX + 12}" y="24" font-family="sans-serif" font-size="12" fill="#65676B">Thích</text>

      <!-- Comment cluster -->
      <path d="M ${commentX - 8} 14 C ${commentX - 12} 14 ${commentX - 12} 24 ${commentX - 8} 24 L ${commentX - 8} 27 L ${commentX - 4} 24 L ${commentX + 6} 24 C ${commentX + 10} 24 ${commentX + 10} 14 ${commentX + 6} 14 Z" fill="#65676B" />
      <text x="${commentX + 12}" y="24" font-family="sans-serif" font-size="12" fill="#65676B">Bình luận</text>

      <!-- Share cluster -->
      ${shareSvg}
      
      <line x1="0" y1="${h - 1}" x2="${w}" y2="${h - 1}" stroke="#E4E6EB" stroke-width="1" />
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a canvas (1200x800) simulating a Facebook web page screenshot.
 */
async function createSyntheticScreenshot(
  footers: Array<{ x: number; y: number; width?: number; height?: number; omitShare?: boolean; narrow?: boolean; extraCountRow?: boolean }>,
  canvasW = 1200,
  canvasH = 800,
): Promise<Buffer> {
  const composites: OverlayOptions[] = [];

  for (const f of footers) {
    const fW = f.width ?? 500;
    const fH = f.height ?? 40;

    // Optional engagement counts row above footer
    if (f.extraCountRow) {
      const countsSvg = Buffer.from(`
        <svg width="${fW}" height="28" xmlns="http://www.w3.org/2000/svg">
          <rect width="${fW}" height="28" fill="#FFFFFF" />
          <circle cx="15" cy="14" r="8" fill="#1877F2" />
          <circle cx="28" cy="14" r="8" fill="#FA383E" />
          <text x="42" y="18" font-family="sans-serif" font-size="11" fill="#65676B">1,4K • 325 bình luận • 48 lượt chia sẻ</text>
        </svg>
      `);
      const countsPng = await sharp(countsSvg).png().toBuffer();
      composites.push({
        input: countsPng,
        left: f.x,
        top: Math.max(0, f.y - 28),
      });
    }

    const footerSvgBuf = createFooterSvg(fW, fH, { omitShare: f.omitShare, narrow: f.narrow });
    const footerPng = await sharp(footerSvgBuf).png().toBuffer();
    composites.push({
      input: footerPng,
      left: f.x,
      top: f.y,
    });
  }

  // Base canvas: light background
  return sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 240, g: 242, b: 245 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * Creates an END reference crop buffer (500x40).
 */
async function createReferenceEndBuffer(width = 500, height = 40): Promise<Buffer> {
  const svgBuf = createFooterSvg(width, height);
  return sharp(svgBuf).png().toBuffer();
}

// =============================================================================
// EXPERIMENT TEST CASES (Tests A - F)
// =============================================================================

test("Test A: Post engagement footer with Like, Comment, Share icons -> MATCHED", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  const screenBuffer = await createSyntheticScreenshot([
    { x: 100, y: 220, width: 500, height: 40 },
  ]);

  const result = await matchEndVisual(screenBuffer, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedFooters.length, 1);
  const footer = result.matchedFooters[0]!;
  assert.equal(footer.status, "MATCHED");
  assert.ok(footer.confidence >= 55);
  assert.ok(Math.abs(footer.rect.y - 220) <= 6, `Expected y near 220, got ${footer.rect.y}`);
  assert.ok(Math.abs(footer.rect.x - 100) <= 24, `Expected x near 100, got ${footer.rect.x}`);
  assert.equal(footer.features.likeFound, true);
  assert.equal(footer.features.commentFound, true);
  assert.equal(footer.features.shareFound, true);
  assert.equal(footer.features.tripartiteLayout, true);
});

test("Test B: Comment area with Like and Reply (no Share icon, narrow) -> REJECTED", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  // Viewport has a comment area with Like + Reply but NO Share icon
  const screenBuffer = await createSyntheticScreenshot([
    { x: 120, y: 350, width: 280, height: 36, omitShare: true, narrow: true },
  ]);

  const result = await matchEndVisual(screenBuffer, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);

  // Must NOT match as a valid post footer
  assert.equal(result.status, "NO_MATCH");
  assert.equal(result.matchedFooters.length, 0);

  // Comment candidate must be correctly detected and flagged/rejected
  const commentRejection = result.rejectedCandidates.find((c) =>
    c.rejectionReason?.toLowerCase().includes("comment area detected") ||
    c.rejectionReason?.toLowerCase().includes("missing share"),
  );
  assert.ok(commentRejection, "Expected comment candidate to be rejected due to missing Share cluster");
  assert.equal(commentRejection.features.shareFound, false);
});

test("Test C: Same footer with different engagement counts row -> MATCHED", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  // Footer preceded by a counts row (1,4K Likes, 325 comments)
  const screenBuffer = await createSyntheticScreenshot([
    { x: 100, y: 300, width: 500, height: 40, extraCountRow: true },
  ]);

  const result = await matchEndVisual(screenBuffer, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedFooters.length, 1);
  const footer = result.matchedFooters[0]!;
  assert.equal(footer.status, "MATCHED");
  assert.ok(footer.confidence >= 55);
  // Matches the action buttons row at y=300 regardless of count variations above
  assert.ok(Math.abs(footer.rect.y - 300) <= 6);
  assert.equal(footer.features.tripartiteLayout, true);
});

test("Test D: Multiple visible post footers in one screenshot -> 2 distinct matches", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  // Two distinct posts visible at y=160 and y=560
  const screenBuffer = await createSyntheticScreenshot([
    { x: 100, y: 160, width: 500, height: 40 },
    { x: 100, y: 560, width: 500, height: 40 },
  ]);

  const result = await matchEndVisual(screenBuffer, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedFooters.length, 2);

  const [first, second] = result.matchedFooters;
  assert.ok(Math.abs(first!.rect.y - 160) <= 6);
  assert.ok(Math.abs(second!.rect.y - 560) <= 6);
  assert.notEqual(first!.id, second!.id);
});

test("Test E: Partial footer truncated at viewport bottom boundary -> PARTIAL / rejected", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  // Footer placed near bottom boundary (y=776 in 800px viewport, only ~24px visible)
  const screenBuffer = await createSyntheticScreenshot(
    [{ x: 100, y: 776, width: 500, height: 40 }],
    1200,
    800,
  );

  const result = await matchEndVisual(screenBuffer, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);

  // Must not treat a half-cut footer as a completed MATCHED footer
  assert.ok(result.status === "PARTIAL" || result.status === "NO_MATCH");
  assert.equal(result.matchedFooters.length, 0);

  // Must identify the boundary truncation
  const partialCand = result.rejectedCandidates.find(
    (c) => c.status === "PARTIAL" || c.rejectionReason?.toLowerCase().includes("truncated"),
  );
  assert.ok(partialCand, "Partial footer at viewport bottom boundary must be recognized as truncated");
});

test("Test F: Scrolled screenshot -> coordinates update to new position", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);

  // Position at scroll offset 1: y = 480
  const screenBeforeScroll = await createSyntheticScreenshot([
    { x: 100, y: 480, width: 500, height: 40 },
  ]);
  const resBefore = await matchEndVisual(screenBeforeScroll, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);
  assert.equal(resBefore.status, "MATCHED");
  assert.ok(Math.abs(resBefore.matchedFooters[0]!.rect.y - 480) <= 6);

  // After scrolling 260px down: the same footer appears at y = 220
  const screenAfterScroll = await createSyntheticScreenshot([
    { x: 100, y: 220, width: 500, height: 40 },
  ]);
  const resAfter = await matchEndVisual(screenAfterScroll, [
    { sampleId: "sample_ref_1", imageBuffer: refBuffer },
  ]);
  assert.equal(resAfter.status, "MATCHED");
  assert.ok(Math.abs(resAfter.matchedFooters[0]!.rect.y - 220) <= 6);

  // Coordinate delta matches scroll delta
  const delta = resBefore.matchedFooters[0]!.rect.y - resAfter.matchedFooters[0]!.rect.y;
  assert.ok(Math.abs(delta - 260) <= 12, `Expected delta near 260px, got ${delta}`);
});

test("Utility: computeVariance and extractVisualSubPatches correctly segment 3 action clusters", async () => {
  const refBuffer = await createReferenceEndBuffer(500, 40);
  const patches = await extractVisualSubPatches(refBuffer);

  assert.ok(patches, "extractVisualSubPatches must succeed on valid reference");
  assert.ok(patches.likePatch.variance > 0, "Like patch must have non-zero variance");
  assert.ok(patches.commentPatch.variance > 0, "Comment patch must have non-zero variance");
  assert.ok(patches.sharePatch.variance > 0, "Share patch must have non-zero variance");
});
