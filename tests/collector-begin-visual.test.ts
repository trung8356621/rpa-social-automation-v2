import test from "node:test";
import assert from "node:assert/strict";
import sharp, { type OverlayOptions } from "sharp";
import {
  matchBeginLayout,
  extractBeginStructuralFeatures,
  buildLearnedLayoutFamily,
  computeWeightedGridCorrelation,
  computeCosineSimilarity,
  CANON_W,
  CANON_H,
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
 * - Avatar on left
 * - Wide rounded input pill spanning > 75% width
 * - Single centered placeholder text
 * - NO top-right menu button
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
 * - Miniature avatar (26px)
 * - Single comment bubble
 * - No top-right post header menu
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
 * - No avatar on left
 * - Plain section title text
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
 * Builds a synthetic screenshot (1200x800) containing various placed sections.
 */
async function createSyntheticPageScreenshot(
  elements: Array<{
    type: "GENUINE_HEADER" | "COMPOSER" | "COMMENT" | "FEATURED";
    x: number;
    y: number;
    width?: number;
    height?: number;
    opts?: { authorName?: string; timestamp?: string; avatarColor?: string };
  }>,
  canvasW = 1200,
  canvasH = 800,
): Promise<Buffer> {
  const composites: OverlayOptions[] = [];

  for (const el of elements) {
    const w = el.width ?? 560;
    const h = el.height ?? 60;
    let buf: Buffer;

    if (el.type === "GENUINE_HEADER") {
      buf = await sharp(createGenuineHeaderSvg(w, h, el.opts)).png().toBuffer();
    } else if (el.type === "COMPOSER") {
      buf = await sharp(createComposerSvg(w, h)).png().toBuffer();
    } else if (el.type === "COMMENT") {
      buf = await sharp(createCommentHeaderSvg(w, h)).png().toBuffer();
    } else {
      buf = await sharp(createFeaturedSectionSvg(w, h)).png().toBuffer();
    }

    composites.push({
      input: buf,
      left: el.x,
      top: el.y,
    });
  }

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

/** Helper to generate a confirmed reference BEGIN crop buffer. */
async function createReferenceBeginBuffer(
  width = 560,
  height = 60,
  opts?: { authorName?: string; timestamp?: string; avatarColor?: string },
): Promise<Buffer> {
  return sharp(createGenuineHeaderSvg(width, height, opts)).png().toBuffer();
}

// ---------------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------------

test("Phase 2: extractBeginStructuralFeatures captures canonical grid, dual-band text & menu", async () => {
  const refBuf = await createReferenceBeginBuffer(560, 60);
  const f = await extractBeginStructuralFeatures(refBuf);

  assert.equal(f.width, 560);
  assert.equal(f.height, 60);
  assert.equal(f.grid.length, 6, "Must produce 6 grid rows");
  assert.equal(f.grid[0]!.length, 24, "Must produce 24 grid columns");
  assert.equal(f.verticalProjection.length, 16, "Must produce 16 vertical projection bins");
  assert.equal(f.horizontalProjection.length, 24, "Must produce 24 horizontal projection bins");

  // Avatar zone must have strong edge density
  assert.ok(f.avatarDensity > 0.08, `Avatar density should be strong, got ${f.avatarDensity}`);
  assert.ok(f.avatarSquareness > 0.5, `Avatar squareness should be near 1.0, got ${f.avatarSquareness}`);

  // Dual-band text: upper and lower lines have higher density than interline gap
  assert.ok(
    f.textBimodalContrast > 1.25,
    `Dual-band contrast should be > 1.25, got ${f.textBimodalContrast}`,
  );

  // Top-right menu contrast: upper has dots, lower void is clear
  assert.ok(
    f.menuContrast > 0.05,
    `Menu contrast should be > 0.05, got ${f.menuContrast}`,
  );

  assert.equal(f.isWideSinglePill, false, "Genuine header must NOT be detected as wide single pill");
});

test("Phase 2: Multi-sample learning aggregates layout family and downweights variant cells", async () => {
  const ref1 = await createReferenceBeginBuffer(560, 60, {
    authorName: "Alice Smith",
    timestamp: "1 giờ",
    avatarColor: "#ef4444",
  });
  const ref2 = await createReferenceBeginBuffer(560, 60, {
    authorName: "Bob Johnson - Community Lead",
    timestamp: "Vừa xong • 🌐",
    avatarColor: "#3b82f6",
  });

  const references: ReferenceBeginCrop[] = [
    { sampleId: "sample_1", groupTag: "post-main", imageBuffer: ref1 },
    { sampleId: "sample_2", groupTag: "post-main", imageBuffer: ref2 },
  ];

  const family = await buildLearnedLayoutFamily(references, "post-main");

  assert.equal(family.sampleCount, 2);
  assert.equal(family.groupTag, "post-main");
  assert.equal(family.nominalWidth, 560);
  assert.equal(family.nominalHeight, 60);
  assert.equal(family.meanGrid.length, 6);
  assert.equal(family.varianceGrid.length, 6);

  // Invariant avatar and menu cells should have learned positive expectations
  assert.ok(family.expectedAvatarDensity > 0.08);
  assert.ok(family.expectedBimodalContrast > 1.2);
  assert.ok(family.expectedMenuContrast > 0.05);
});

test("Phase 5 Case A: Genuine post header -> MATCHED with high similarity score", async () => {
  const ref = await createReferenceBeginBuffer(560, 60, {
    authorName: "Teaching Reference Author",
  });

  const screenshot = await createSyntheticPageScreenshot([
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 120,
      width: 560,
      height: 60,
      opts: { authorName: "Teaching Reference Author" },
    },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedHeaders.length, 1);
  const match = result.matchedHeaders[0]!;
  assert.ok(match.confidence >= 75, `Expected score >= 75%, got ${match.confidence}%`);
  assert.ok(Math.abs(match.rect.x - 320) <= 24);
  assert.ok(Math.abs(match.rect.y - 120) <= 8);
  assert.equal(match.features.avatarFound, true);
  assert.equal(match.features.dualBandTextFound, true);
  assert.equal(match.features.menuFound, true);
});

test("Phase 5 Case B: Nested comment header -> REJECTED (score lower than genuine post header)", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  const screenshot = await createSyntheticPageScreenshot([
    { type: "COMMENT", x: 320, y: 150, width: 560, height: 50 },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "NO_MATCH", "Comment should NOT be accepted as post header");
  assert.equal(result.matchedHeaders.length, 0);

  // Rejected candidates should list comment pattern
  const rej = result.rejectedCandidates.find((r) => Math.abs(r.rect.y - 150) <= 25);
  assert.ok(rej, "Comment region should be captured in rejected pool");
  assert.ok(
    rej.confidence < 70,
    `Comment similarity score (${rej.confidence}%) should be distinctly lower than genuine post header (>= 75%)`,
  );
  assert.ok(rej.rejectionReason?.toLowerCase().includes("comment") || rej.rejectionReason?.toLowerCase().includes("menu"));
});

test("Phase 5 Case C: Post composer ('Bạn viết gì đi...') -> REJECTED", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  const screenshot = await createSyntheticPageScreenshot([
    { type: "COMPOSER", x: 320, y: 100, width: 560, height: 60 },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "NO_MATCH", "Composer should NOT be matched as post header");
  assert.equal(result.matchedHeaders.length, 0);

  const rej = result.rejectedCandidates.find((r) => Math.abs(r.rect.y - 100) <= 25);
  assert.ok(rej, "Composer region should be captured in rejected candidates");
  assert.ok(
    rej.rejectionReason?.toLowerCase().includes("composer") ||
      rej.rejectionReason?.toLowerCase().includes("threshold") ||
      rej.confidence < 60,
  );
});

test("Phase 5 Case D: 'Đáng chú ý' / Featured section -> REJECTED (missing avatar & header layout)", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  const screenshot = await createSyntheticPageScreenshot([
    { type: "FEATURED", x: 320, y: 140, width: 560, height: 48 },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "NO_MATCH", "Featured section should NOT be matched");
  assert.equal(result.matchedHeaders.length, 0);
});

test("Phase 5 Case E: Genuine post with different author/avatar/time -> comparable layout similarity", async () => {
  const ref = await createReferenceBeginBuffer(560, 60, {
    authorName: "Original Author",
    timestamp: "10 phút",
    avatarColor: "#ef4444",
  });

  const screenshot = await createSyntheticPageScreenshot([
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 120,
      width: 560,
      height: 60,
      opts: {
        authorName: "Hoàn Toàn Khác - Tin Tức Công Nghệ 24h",
        timestamp: "Hôm qua lúc 15:30 • Đã chỉnh sửa",
        avatarColor: "#10b981",
      },
    },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedHeaders.length, 1);
  const match = result.matchedHeaders[0]!;
  assert.ok(
    match.confidence >= 70,
    `Different author/avatar header should retain high layout similarity, got ${match.confidence}%`,
  );
});

test("Phase 5 Case F: Multiple genuine posts visible -> 2 distinct candidate windows", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  const screenshot = await createSyntheticPageScreenshot([
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 80,
      width: 560,
      height: 60,
      opts: { authorName: "Post 1 Author" },
    },
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 420,
      width: 560,
      height: 60,
      opts: { authorName: "Post 2 Author" },
    },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedHeaders.length, 2, "Must detect exactly 2 distinct post headers");

  const [post1, post2] = result.matchedHeaders;
  assert.ok(Math.abs(post1!.rect.y - 80) <= 8);
  assert.ok(Math.abs(post2!.rect.y - 420) <= 8);
  assert.ok(post2!.rect.y > post1!.rect.y + 200, "Headers must be vertically separated");
});

test("Phase 5 Case G: Scrolled screenshot with partially visible header at viewport top/bottom -> PARTIAL / REJECTED", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  // Post truncated at viewport bottom: y = 770 in 800px canvas (only 30px visible < 60px)
  const screenshot = await createSyntheticPageScreenshot([
    {
      type: "GENUINE_HEADER",
      x: 320,
      y: 770,
      width: 560,
      height: 60,
    },
  ]);

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  // Must not claim full match
  assert.notEqual(result.status, "MATCHED");
  assert.equal(result.matchedHeaders.length, 0);

  const partial = result.rejectedCandidates.find(
    (c) => c.status === "PARTIAL" || c.rejectionReason?.includes("boundary") || c.rejectionReason?.includes("truncated"),
  );
  assert.ok(partial, "Truncated boundary header must be marked PARTIAL or rejected with boundary notice");
});

test("Phase 5 Case H: Short-text post vs Image/Video post -> BEGIN detection unaffected by content below", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  // Header 1: Short text post
  // Header 2: Image post (simulate dark media banner directly below header at y=480)
  const composites: OverlayOptions[] = [];

  const h1 = await sharp(createGenuineHeaderSvg(560, 60, { authorName: "Short Text Post" })).png().toBuffer();
  composites.push({ input: h1, left: 320, top: 80 });

  const h2 = await sharp(createGenuineHeaderSvg(560, 60, { authorName: "Media Video Post" })).png().toBuffer();
  composites.push({ input: h2, left: 320, top: 420 });

  // Add dark image box directly below Header 2
  const darkMediaBox = await sharp({
    create: { width: 560, height: 180, channels: 3, background: { r: 15, g: 23, b: 42 } },
  }).png().toBuffer();
  composites.push({ input: darkMediaBox, left: 320, top: 480 });

  const screenshot = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 240, g: 242, b: 245 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const result = await matchBeginLayout(
    screenshot,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedHeaders.length, 2);

  const score1 = result.matchedHeaders[0]!.confidence;
  const score2 = result.matchedHeaders[1]!.confidence;
  assert.ok(
    Math.abs(score1 - score2) <= 8,
    `Both short text (${score1}%) and media post (${score2}%) headers must achieve comparable scores`,
  );
});

test("Phase 6: Offline Benchmark on synthetic & real fixture regions", async () => {
  const ref = await createReferenceBeginBuffer(560, 60);

  // Mixed page: 2 genuine posts, 1 composer, 1 comment, 1 featured section
  const benchmarkScreen = await createSyntheticPageScreenshot([
    { type: "COMPOSER", x: 320, y: 30, width: 560, height: 60 },
    { type: "FEATURED", x: 320, y: 110, width: 560, height: 48 },
    { type: "GENUINE_HEADER", x: 320, y: 180, width: 560, height: 60, opts: { authorName: "Bench Positive 1" } },
    { type: "COMMENT", x: 320, y: 440, width: 560, height: 50 },
    { type: "GENUINE_HEADER", x: 320, y: 530, width: 560, height: 60, opts: { authorName: "Bench Positive 2" } },
  ]);

  const result = await matchBeginLayout(
    benchmarkScreen,
    [{ sampleId: "ref_1", imageBuffer: ref }],
    { scaleVariants: [1.0] },
  );

  // Ground truth:
  // Positive regions: y in [170, 200] (Bench 1), y in [520, 550] (Bench 2)
  // Negative regions: Composer (y=30), Featured (y=110), Comment (y=440)

  let truePositives = 0;
  let falsePositives = 0;

  for (const m of result.matchedHeaders) {
    const isAtPositive1 = Math.abs(m.rect.y - 180) <= 15;
    const isAtPositive2 = Math.abs(m.rect.y - 530) <= 15;
    if (isAtPositive1 || isAtPositive2) {
      truePositives++;
    } else {
      falsePositives++;
    }
  }

  const falseNegatives = 2 - truePositives;
  const precision =
    truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;
  const recall = 2 > 0 ? truePositives / 2 : 0;

  assert.equal(truePositives, 2, "Must detect both positive genuine headers");
  assert.equal(falsePositives, 0, "Must not have any false positives from composer, comment, or featured");
  assert.equal(falseNegatives, 0, "Must have zero false negatives");
  assert.equal(precision, 1.0, "Precision should be 100%");
  assert.equal(recall, 1.0, "Recall should be 100%");
});
