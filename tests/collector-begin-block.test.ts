import test from "node:test";
import assert from "node:assert/strict";
import sharp, { type OverlayOptions } from "sharp";
import {
  extractBeginBlocks,
  buildLearnedBlockVariants,
  matchBeginBlockLayout,
  inspectBeginBlockTemplate,
  getBlockColor,
} from "../src/main/begin-block-matcher.js";
import {
  matchBeginLayout,
  type ReferenceBeginCrop,
} from "../src/main/begin-layout-matcher.js";

/**
 * Creates a synthetic SVG representing a genuine Facebook post header (BEGIN region):
 * - Avatar on left (~40x40)
 * - Author name line (top)
 * - Timestamp / privacy line (bottom)
 * - Three-dot menu button on right
 */
function createGenuineHeaderSvg(
  width = 560,
  height = 60,
  opts?: {
    authorName?: string;
    timestamp?: string;
    avatarColor?: string;
  },
): Buffer {
  const author = opts?.authorName ?? "Nguyễn Văn A";
  const time = opts?.timestamp ?? "2 giờ trước • 🌐";
  const avColor = opts?.avatarColor ?? "#3b82f6";
  const menuX = width - 28;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" />
      
      <!-- Avatar cluster (Left, circle with contrast inside) -->
      <circle cx="32" cy="${Math.round(height / 2)}" r="20" fill="${avColor}" />
      <circle cx="32" cy="${Math.round(height / 2) - 4}" r="8" fill="#FFFFFF" opacity="0.85" />
      <path d="M 18 ${Math.round(height / 2) + 16} Q 32 ${Math.round(height / 2) + 4} 46 ${Math.round(height / 2) + 16}" fill="#FFFFFF" opacity="0.85" />

      <!-- Text Block: Dual-band stacked lines -->
      <!-- Line 1: Author title line -->
      <text x="64" y="24" font-family="sans-serif" font-weight="bold" font-size="14" fill="#050505">${author}</text>
      
      <!-- Line 2: Timestamp / Privacy metadata line -->
      <text x="64" y="44" font-family="sans-serif" font-size="12" fill="#65676B">${time}</text>

      <!-- Action Menu Button (Three-dot ellipsis at top-right) -->
      <circle cx="${menuX}" cy="22" r="2.5" fill="#65676B" />
      <circle cx="${menuX - 7}" cy="22" r="2.5" fill="#65676B" />
      <circle cx="${menuX + 7}" cy="22" r="2.5" fill="#65676B" />
      <line x1="${menuX - 10}" y1="22" x2="${menuX + 10}" y2="22" stroke="#65676B" stroke-width="1.5" opacity="0.3" />
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a synthetic SVG representing a Composer ("Bạn viết gì đi...") section.
 */
function createComposerSvg(width = 560, height = 60): Buffer {
  const pillW = width - 80;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" />
      
      <!-- Avatar on left -->
      <circle cx="32" cy="${Math.round(height / 2)}" r="20" fill="#10b981" />
      <circle cx="32" cy="${Math.round(height / 2) - 4}" r="8" fill="#FFFFFF" opacity="0.85" />
      
      <!-- Wide single input pill with continuous rounded border -->
      <rect x="64" y="10" width="${pillW}" height="40" rx="20" fill="#F0F2F5" stroke="#CED0D4" stroke-width="1.5" />
      <text x="84" y="34" font-family="sans-serif" font-size="14" fill="#65676B">Bạn viết gì đi...</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a synthetic SVG representing a Nested Comment header.
 */
function createCommentHeaderSvg(width = 560, height = 50): Buffer {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" />
      
      <!-- Miniature comment avatar -->
      <circle cx="24" cy="22" r="13" fill="#8b5cf6" />
      
      <!-- Comment bubble box -->
      <rect x="46" y="6" width="340" height="36" rx="16" fill="#F0F2F5" />
      <text x="60" y="22" font-family="sans-serif" font-weight="bold" font-size="12" fill="#050505">Trần Văn B</text>
      <text x="60" y="36" font-family="sans-serif" font-size="11" fill="#050505">Nội dung bình luận mẫu</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a synthetic SVG representing a "Đáng chú ý" / Featured section header.
 */
function createFeaturedSectionSvg(width = 560, height = 48): Buffer {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" />
      <text x="16" y="30" font-family="sans-serif" font-weight="bold" font-size="17" fill="#050505">Đáng chú ý</text>
      <line x1="16" y1="46" x2="${width - 16}" y2="46" stroke="#E4E6EB" stroke-width="1" />
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a synthetic SVG representing a Body Text paragraph.
 */
function createBodyTextSvg(width = 560, height = 60): Buffer {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" />
      <text x="16" y="20" font-family="sans-serif" font-size="13" fill="#050505">Hôm nay thời tiết Hà Nội rất đẹp và trong lành.</text>
      <text x="16" y="38" font-family="sans-serif" font-size="13" fill="#050505">Mọi người cùng ra đường dạo phố và thưởng thức cafe cuối tuần nhé.</text>
      <text x="16" y="54" font-family="sans-serif" font-size="13" fill="#050505">Chúc cả nhà một ngày mới vui vẻ tràn ngập năng lượng tích cực!</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Creates a synthetic SVG representing a Large Media / Video Texture.
 */
function createMediaTextureSvg(width = 560, height = 60): Buffer {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mediaGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e1b4b" />
          <stop offset="50%" stop-color="#312e81" />
          <stop offset="100%" stop-color="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#mediaGrad)" />
      <circle cx="${Math.round(width / 2)}" cy="${Math.round(height / 2)}" r="20" fill="#ffffff" opacity="0.8" />
      <polygon points="${Math.round(width / 2) - 6},${Math.round(height / 2) - 10} ${Math.round(width / 2) + 10},${Math.round(height / 2)} ${Math.round(width / 2) - 6},${Math.round(height / 2) + 10}" fill="#0f172a" />
    </svg>
  `;
  return Buffer.from(svg);
}

async function createReferenceBeginBuffer(
  width = 560,
  height = 60,
  opts?: { authorName?: string; timestamp?: string; avatarColor?: string },
): Promise<Buffer> {
  const svgBuf = createGenuineHeaderSvg(width, height, opts);
  return sharp(svgBuf).png().toBuffer();
}

async function createSyntheticPageScreenshot(
  elements: Array<{
    type: "GENUINE_HEADER" | "COMPOSER" | "COMMENT" | "FEATURED" | "BODY_TEXT" | "MEDIA";
    x: number;
    y: number;
    width?: number;
    height?: number;
    opts?: { authorName?: string; timestamp?: string; avatarColor?: string };
  }>,
  canvasW = 1200,
  canvasH = 800,
): Promise<Buffer> {
  const overlays: OverlayOptions[] = [];

  for (const el of elements) {
    const w = el.width ?? 560;
    const h = el.height ?? 60;
    let svgBuf: Buffer;

    switch (el.type) {
      case "GENUINE_HEADER":
        svgBuf = createGenuineHeaderSvg(w, h, el.opts);
        break;
      case "COMPOSER":
        svgBuf = createComposerSvg(w, h);
        break;
      case "COMMENT":
        svgBuf = createCommentHeaderSvg(w, el.height ?? 50);
        break;
      case "FEATURED":
        svgBuf = createFeaturedSectionSvg(w, el.height ?? 48);
        break;
      case "BODY_TEXT":
        svgBuf = createBodyTextSvg(w, h);
        break;
      case "MEDIA":
        svgBuf = createMediaTextureSvg(w, h);
        break;
    }

    const pngBuf = await sharp(svgBuf).png().toBuffer();
    overlays.push({ input: pngBuf, left: el.x, top: el.y });
  }

  return sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 240, g: 242, b: 245, alpha: 1 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}

test("B3 V2 Phase 2: extractBeginBlocks segments abstract layout blocks", async () => {
  const ref = await createReferenceBeginBuffer(560, 60, {
    authorName: "Nguyễn Văn A",
    timestamp: "1 giờ trước • 🌐",
  });

  const seg = await extractBeginBlocks(ref, { generateSegmentedOverlay: true });
  assert.ok(seg.blocks.length >= 3, `Must segment at least 3 blocks, found ${seg.blocks.length}`);
  assert.ok(seg.segmentedPngBuffer, "Should generate segmented overlay PNG");

  const avatar = seg.blocks.find((b) => b.type === "image_avatar");
  assert.ok(avatar, "Must find image_avatar block on left");
  assert.ok(avatar.normalizedBounds.x < 0.20, "Avatar must be on left");
  assert.ok(avatar.required, "Avatar should be required");

  const primaryText = seg.blocks.find((b) => b.type === "primary_text");
  assert.ok(primaryText, "Must find primary_text block");
  assert.ok(primaryText.normalizedBounds.y < 0.50, "Primary text should be in upper band");

  const secondaryText = seg.blocks.find((b) => b.type === "secondary_text");
  assert.ok(secondaryText, "Must find secondary_text block");

  const menu = seg.blocks.find((b) => b.type === "action_menu");
  assert.ok(menu, "Must find action_menu block on right");
  assert.ok(menu.normalizedBounds.x > 0.70, "Menu must be on right side");
});

test("B3 V2 Phase 4: buildLearnedBlockVariants multi-sample learning", async () => {
  const ref1 = await createReferenceBeginBuffer(560, 60, {
    authorName: "Nguyễn Văn A",
    timestamp: "1 giờ trước • 🌐",
    avatarColor: "#ef4444",
  });
  const ref2 = await createReferenceBeginBuffer(540, 58, {
    authorName: "Trần Thị Bích Ngọc - Yêu Bếp",
    timestamp: "Vừa xong • 👥",
    avatarColor: "#10b981",
  });

  const variants = await buildLearnedBlockVariants([
    { sampleId: "s1", imageBuffer: ref1 },
    { sampleId: "s2", imageBuffer: ref2 },
  ]);

  assert.equal(variants.length, 1, "Compatible samples should cluster into 1 layout variant");
  const v = variants[0]!;
  assert.equal(v.sampleCount, 2);
  assert.equal(v.nominalDimensions.width, 550);
  assert.equal(v.nominalDimensions.height, 59);

  const reqBlocks = v.blocks.filter((b) => b.required);
  assert.ok(reqBlocks.some((b) => b.type === "image_avatar"), "Avatar must be stable and required");
  assert.ok(reqBlocks.some((b) => b.type === "primary_text"), "Primary text must be stable and required");
});

test("B3 V2 Phase 5 Case A: Genuine post header -> MATCHED with high similarity score", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);
  const screenshot = await createSyntheticPageScreenshot([
    { type: "GENUINE_HEADER", x: 320, y: 120, width: 560, height: 60 },
  ]);

  const result = await matchBeginBlockLayout(screenshot, [{ sampleId: "ref1", imageBuffer: ref }]);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedCandidates.length, 1);

  const match = result.matchedCandidates[0]!;
  assert.ok(match.confidence >= 70, `Confidence should be >= 70%, was ${match.confidence}%`);
  assert.equal(match.rect.x, 320);
  assert.equal(match.rect.y, 120);
  assert.equal(match.missingRequiredBlocks.length, 0);
  assert.ok(match.matchedBlocksCount >= 3);
});

test("B3 V2 Phase 5 Case E: Invariance across different author, avatar and timestamp", async () => {
  const ref = await createReferenceBeginBuffer(560, 60, {
    authorName: "Admin Cửa Hàng",
    timestamp: "Hôm qua lúc 14:00",
    avatarColor: "#3b82f6",
  });

  const screenshot = await createSyntheticPageScreenshot([
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 150,
      width: 560,
      height: 60,
      opts: {
        authorName: "Hoàng Minh Tuấn - Review Công Nghệ",
        timestamp: "5 phút trước • 🌐",
        avatarColor: "#f59e0b",
      },
    },
  ]);

  const result = await matchBeginBlockLayout(screenshot, [{ sampleId: "ref1", imageBuffer: ref }]);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedCandidates.length, 1);
  assert.ok(result.matchedCandidates[0]!.confidence >= 70, "Should match despite changed author and avatar");
});

test("B3 V2 Negative Cases: Rejects Composer, Comment, Featured, Body Text, and Media", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  // Negative 1: Composer ("Bạn viết gì đi...")
  const composerScreen = await createSyntheticPageScreenshot([
    { type: "COMPOSER", x: 320, y: 100, width: 560, height: 60 },
  ]);
  const compRes = await matchBeginBlockLayout(composerScreen, [{ sampleId: "ref", imageBuffer: ref }]);
  assert.equal(compRes.status, "NO_MATCH", "Composer must be rejected");
  assert.equal(compRes.matchedCandidates.length, 0);

  // Negative 2: Comment header
  const commentScreen = await createSyntheticPageScreenshot([
    { type: "COMMENT", x: 320, y: 100, width: 560, height: 50 },
  ]);
  const commentRes = await matchBeginBlockLayout(commentScreen, [{ sampleId: "ref", imageBuffer: ref }]);
  assert.equal(commentRes.status, "NO_MATCH", "Comment header must be rejected");
  assert.equal(commentRes.matchedCandidates.length, 0);

  // Negative 3: Featured section
  const featScreen = await createSyntheticPageScreenshot([
    { type: "FEATURED", x: 320, y: 100, width: 560, height: 48 },
  ]);
  const featRes = await matchBeginBlockLayout(featScreen, [{ sampleId: "ref", imageBuffer: ref }]);
  assert.equal(featRes.status, "NO_MATCH", "Featured section must be rejected");
  assert.equal(featRes.matchedCandidates.length, 0);

  // Negative 4: Body text paragraph
  const textScreen = await createSyntheticPageScreenshot([
    { type: "BODY_TEXT", x: 320, y: 100, width: 560, height: 60 },
  ]);
  const textRes = await matchBeginBlockLayout(textScreen, [{ sampleId: "ref", imageBuffer: ref }]);
  assert.equal(textRes.status, "NO_MATCH", "Body text must be rejected (no avatar/header layout)");
  assert.equal(textRes.matchedCandidates.length, 0);

  // Negative 5: Media texture
  const mediaScreen = await createSyntheticPageScreenshot([
    { type: "MEDIA", x: 320, y: 100, width: 560, height: 60 },
  ]);
  const mediaRes = await matchBeginBlockLayout(mediaScreen, [{ sampleId: "ref", imageBuffer: ref }]);
  assert.equal(mediaRes.status, "NO_MATCH", "Media texture must be rejected");
  assert.equal(mediaRes.matchedCandidates.length, 0);
});

test("B3 V2 Benchmark & Comparison: B3 V1 vs B3 V2 on mixed feed", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  // Mixed page: 2 genuine posts, 1 composer, 1 comment, 1 body text, 1 media
  const mixedScreenshot = await createSyntheticPageScreenshot([
    { type: "COMPOSER", x: 320, y: 40, width: 560, height: 60 },
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 130,
      width: 560,
      height: 60,
      opts: { authorName: "Bài viết 1" },
    },
    { type: "BODY_TEXT", x: 320, y: 220, width: 560, height: 60 },
    { type: "MEDIA", x: 320, y: 310, width: 560, height: 60 },
    { type: "COMMENT", x: 320, y: 400, width: 560, height: 50 },
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 480,
      width: 560,
      height: 60,
      opts: { authorName: "Bài viết 2" },
    },
  ]);

  const refs: ReferenceBeginCrop[] = [{ sampleId: "ref_1", imageBuffer: ref }];

  // 1. Run B3 V1
  const t0_v1 = performance.now();
  const v1Res = await matchBeginLayout(mixedScreenshot, refs, { scaleVariants: [1.0] });
  const dur_v1 = performance.now() - t0_v1;

  // 2. Run B3 V2
  const t0_v2 = performance.now();
  const v2Res = await matchBeginBlockLayout(mixedScreenshot, refs, { scaleVariants: [1.0] });
  const dur_v2 = performance.now() - t0_v2;

  // Ground truth: 2 genuine posts (y=130 and y=480)
  assert.equal(v2Res.matchedCandidates.length, 2, "B3 V2 must detect exactly 2 genuine posts");
  const yCoords = v2Res.matchedCandidates.map((c) => c.rect.y).sort((a, b) => a - b);
  assert.equal(yCoords[0], 130);
  assert.equal(yCoords[1], 480);

  // Performance assertions
  assert.ok(v2Res.diagnostics.totalDurationMs > 0, "B3 V2 must report total duration");
  assert.ok(v2Res.diagnostics.evaluatedWindowsCount > 0, "B3 V2 must report evaluated windows");

  console.info(
    `[BENCHMARK] B3 V1 Duration: ${Math.round(dur_v1)}ms (matched: ${v1Res.matchedHeaders.length}) | B3 V2 Duration: ${Math.round(dur_v2)}ms (matched: ${v2Res.matchedCandidates.length})`,
  );
});

test("B3 V2 Review 2C: inspectBeginBlockTemplate returns structured block inspection report", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  const report = await inspectBeginBlockTemplate([
    {
      sampleId: "sample_1",
      regionId: "reg_1",
      groupTag: "post-main",
      imageBuffer: ref,
    },
  ]);

  assert.ok(report.groups["post-main"]);
  const grp = report.groups["post-main"]!;
  assert.equal(grp.status, "READY");
  assert.equal(grp.sampleCount, 1);
  assert.equal(grp.variants.length, 1);

  const sample = grp.samples[0]!;
  assert.ok(sample.blocks.length >= 3);
  assert.ok(sample.originalCropDataUrl?.startsWith("data:image/png;base64,"));
  assert.ok(sample.segmentedCropDataUrl?.startsWith("data:image/png;base64,"));
});

test("Task C2.11.15a: Pipeline Reference Diagnostic - distinguishes NO_REFERENCES from NO_MATCH and logs reasons", async () => {
  const dummyScreen = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 4,
      background: { r: 240, g: 242, b: 245, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Case 1: Empty reference list -> NO_REFERENCES
  const emptyRes = await matchBeginBlockLayout(dummyScreen, []);
  assert.equal(emptyRes.status, "NO_REFERENCES");
  assert.equal(emptyRes.referenceBeginCount, 0);
  assert.equal(emptyRes.inputReferenceCount, 0);
  assert.equal(emptyRes.validReferenceCount, 0);

  // Case 2: Reference provided but corrupted/empty buffer -> NO_REFERENCES (never silently reported as NO_MATCH)
  const invalidRes = await matchBeginBlockLayout(dummyScreen, [
    {
      sampleId: "bad_ref",
      regionId: "reg_bad",
      imageBuffer: Buffer.alloc(0),
      error: "Corrupted asset file",
    },
  ]);
  assert.equal(invalidRes.status, "NO_REFERENCES", "Invalid references must return NO_REFERENCES, not NO_MATCH");
  assert.equal(invalidRes.referenceBeginCount, 0);
  assert.equal(invalidRes.inputReferenceCount, 1);
  assert.equal(invalidRes.validReferenceCount, 0);
  assert.equal(invalidRes.skippedReferenceCount, 1);
  assert.ok(invalidRes.skipReasons && invalidRes.skipReasons.length === 1);
  assert.equal(invalidRes.skipReasons[0]?.sampleId, "bad_ref");

  // Case 3: Valid reference provided, but viewport does not contain post -> NO_MATCH
  const ref = await createReferenceBeginBuffer(560, 60);
  const noMatchRes = await matchBeginBlockLayout(dummyScreen, [
    { sampleId: "good_ref", imageBuffer: ref },
  ]);
  assert.equal(noMatchRes.status, "NO_MATCH", "Valid reference on blank page must return NO_MATCH");
  assert.equal(noMatchRes.referenceBeginCount, 1);
  assert.equal(noMatchRes.inputReferenceCount, 1);
  assert.equal(noMatchRes.validReferenceCount, 1);
  assert.equal(noMatchRes.skippedReferenceCount, 0);
});
