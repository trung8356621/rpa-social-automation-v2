import sharp from "sharp";
import type { Rect } from "../shared/contracts.js";
import type {
  BeginLayoutCandidate,
  BeginLayoutFeatureScores,
  BeginLayoutMatchResult,
  BeginLayoutTemplateInfo,
  BeginLayoutInspectionReport,
  BeginGroupTemplateInspection,
  BeginSampleTemplateInspection,
} from "../shared/collectors/types.js";

export type ReferenceBeginCrop = {
  sampleId?: string;
  regionId?: string;
  groupTag?: string;
  imageBuffer: Buffer;
  roi?: Rect;
  originalDataUrl?: string;
  error?: string;
};

export type BeginLayoutMatcherOptions = {
  scaleVariants?: number[];
  minConfidence?: number;
};

export const CANON_W = 240;
export const CANON_H = 48;
export const GRID_COLS = 24;
export const GRID_ROWS = 6;
export const CELL_W = 10; // 240 / 24
export const CELL_H = 8; // 48 / 6

export type StructuralGrid = {
  cols: number;
  rows: number;
  cells: number[][]; // [row][col] normalized [0, 1]
};

export type BeginStructuralFeatures = {
  width: number;
  height: number;
  aspectRatio: number;
  grid: number[][]; // [GRID_ROWS][GRID_COLS]
  verticalProjection: number[]; // 16 bins
  horizontalProjection: number[]; // 24 bins
  avatarDensity: number;
  avatarSquareness: number;
  avatarBounds: { x: number; y: number; width: number; height: number };
  textUpperDensity: number;
  textGapDensity: number;
  textLowerDensity: number;
  textBimodalContrast: number;
  textBounds: { x: number; y: number; width: number; height: number };
  menuDensity: number;
  menuVoidDensity: number;
  menuContrast: number;
  menuBounds: { x: number; y: number; width: number; height: number };
  isWideSinglePill: boolean;
};

export type LearnedLayoutFamily = {
  groupTag: string;
  sampleCount: number;
  sampleIds: string[];
  nominalWidth: number;
  nominalHeight: number;
  nominalAspectRatio: number;
  meanGrid: number[][];
  varianceGrid: number[][];
  meanVerticalProjection: number[];
  meanHorizontalProjection: number[];
  avatarBounds: { x: number; y: number; width: number; height: number };
  textBounds: { x: number; y: number; width: number; height: number };
  menuBounds: { x: number; y: number; width: number; height: number };
  expectedAvatarDensity: number;
  expectedBimodalContrast: number;
  expectedMenuContrast: number;
};

/**
 * Computes grayscale variance for a pixel buffer (used for coarse contrast check).
 */
export function computeGrayscaleVariance(pixels: Buffer | Uint8Array): number {
  if (pixels.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    sum += pixels[i]!;
  }
  const mean = sum / pixels.length;
  let varSum = 0;
  for (let i = 0; i < pixels.length; i++) {
    const diff = pixels[i]! - mean;
    varSum += diff * diff;
  }
  return varSum / pixels.length;
}

/**
 * Phase 2: Extracts normalized structural visual features from a header image crop.
 * Uses edge gradients, spatial density grid, vertical & horizontal projection profiles,
 * and extracts relative landmark geometry for avatar, dual-line text, and action menu.
 */
export async function extractBeginStructuralFeatures(
  imageBuffer: Buffer,
): Promise<BeginStructuralFeatures> {
  const meta = await sharp(imageBuffer).metadata();
  const rawW = meta.width || CANON_W;
  const rawH = meta.height || CANON_H;
  const aspectRatio = rawH > 0 ? rawW / rawH : 5.0;

  // Convert to grayscale and resize to canonical representation
  const { data: pixels } = await sharp(imageBuffer)
    .grayscale()
    .resize(CANON_W, CANON_H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute spatial gradient magnitude (edges)
  const edges = new Uint8Array(CANON_W * CANON_H);
  for (let y = 1; y < CANON_H - 1; y++) {
    const rowOffset = y * CANON_W;
    for (let x = 1; x < CANON_W - 1; x++) {
      const idx = rowOffset + x;
      const dx = Math.abs(pixels[idx + 1]! - pixels[idx - 1]!);
      const dy = Math.abs(pixels[idx + CANON_W]! - pixels[idx - CANON_W]!);
      const mag = dx + dy;
      edges[idx] = mag >= 26 ? 1 : 0;
    }
  }

  // 1. Compute 24x6 Structural Density Grid
  const grid: number[][] = [];
  const cellArea = CELL_W * CELL_H;
  for (let r = 0; r < GRID_ROWS; r++) {
    const rowCells: number[] = [];
    const rStart = r * CELL_H;
    for (let c = 0; c < GRID_COLS; c++) {
      const cStart = c * CELL_W;
      let edgeCount = 0;
      for (let py = 0; py < CELL_H; py++) {
        const lineOffset = (rStart + py) * CANON_W;
        for (let px = 0; px < CELL_W; px++) {
          if (edges[lineOffset + (cStart + px)] === 1) {
            edgeCount++;
          }
        }
      }
      rowCells.push(edgeCount / cellArea);
    }
    grid.push(rowCells);
  }

  // 2. Compute Vertical Projection Profile (16 bins, 3 rows each)
  const verticalProjection: number[] = [];
  for (let b = 0; b < 16; b++) {
    let binEdges = 0;
    const yStart = b * 3;
    for (let py = 0; py < 3; py++) {
      const lineOffset = (yStart + py) * CANON_W;
      for (let px = 0; px < CANON_W; px++) {
        if (edges[lineOffset + px] === 1) binEdges++;
      }
    }
    verticalProjection.push(binEdges / (CANON_W * 3));
  }

  // 3. Compute Horizontal Projection Profile (24 bins, 10 cols each)
  const horizontalProjection: number[] = [];
  for (let b = 0; b < GRID_COLS; b++) {
    let binEdges = 0;
    const xStart = b * CELL_W;
    for (let py = 0; py < CANON_H; py++) {
      const lineOffset = py * CANON_W;
      for (let px = 0; px < CELL_W; px++) {
        if (edges[lineOffset + (xStart + px)] === 1) binEdges++;
      }
    }
    horizontalProjection.push(binEdges / (CANON_H * CELL_W));
  }

  // 4. Structural Landmark Analysis: Left Avatar Zone (relX ~0.01 to 0.16 -> cols 0..3, rows 1..4)
  let avatarEdgeSum = 0;
  let avatarCellCount = 0;
  let minAvatarX = CANON_W;
  let maxAvatarX = 0;
  let minAvatarY = CANON_H;
  let maxAvatarY = 0;

  for (let r = 1; r <= 4; r++) {
    for (let c = 0; c <= 3; c++) {
      avatarEdgeSum += grid[r]![c]!;
      avatarCellCount++;
    }
  }
  const avatarDensity = avatarCellCount > 0 ? avatarEdgeSum / avatarCellCount : 0;

  // Bounding box of avatar cluster in canonical coordinates
  for (let y = 6; y < 42; y++) {
    const lineOffset = y * CANON_W;
    for (let x = 3; x < 40; x++) {
      if (edges[lineOffset + x] === 1) {
        if (x < minAvatarX) minAvatarX = x;
        if (x > maxAvatarX) maxAvatarX = x;
        if (y < minAvatarY) minAvatarY = y;
        if (y > maxAvatarY) maxAvatarY = y;
      }
    }
  }

  const avatarBoxW = Math.max(1, maxAvatarX - minAvatarX);
  const avatarBoxH = Math.max(1, maxAvatarY - minAvatarY);
  const avatarSquareness =
    avatarDensity > 0.05
      ? Math.min(avatarBoxW, avatarBoxH) / Math.max(avatarBoxW, avatarBoxH)
      : 0;

  // 5. Structural Landmark Analysis: Text Zone (cols 4..19, x: 40..190)
  // Dual-band vertical profile across 16 bins
  const textBins: number[] = [];
  for (let b = 0; b < 16; b++) {
    let count = 0;
    const yStart = b * 3;
    for (let py = 0; py < 3; py++) {
      const row = (yStart + py) * CANON_W;
      for (let x = 40; x < 190; x++) {
        if (edges[row + x] === 1) count++;
      }
    }
    textBins.push(Math.round((count / (150 * 3)) * 100));
  }

  const peak1 = Math.max(...textBins.slice(3, 7));
  const valley = Math.min(...textBins.slice(7, 9));
  const peak2 = Math.max(...textBins.slice(9, 13));
  const textBimodalContrast =
    (peak1 + peak2) / (2 * Math.max(1, valley));

  const textUpperDensity = peak1 / 100;
  const textGapDensity = valley / 100;
  const textLowerDensity = peak2 / 100;

  // 6. Structural Landmark Analysis: Action Menu Zone (cols 21..23, x: 205..238)
  // Top-right menu button cluster (y: 6..26)
  let menuEdges = 0;
  for (let y = 6; y < 26; y++) {
    const lineOffset = y * CANON_W;
    for (let x = 205; x < 238; x++) {
      if (edges[lineOffset + x] === 1) menuEdges++;
    }
  }
  const menuDensity = menuEdges / (33 * 20);

  // Void margin below menu button (y: 28..46)
  let voidEdges = 0;
  for (let y = 28; y < 46; y++) {
    const lineOffset = y * CANON_W;
    for (let x = 205; x < 238; x++) {
      if (edges[lineOffset + x] === 1) voidEdges++;
    }
  }
  const menuVoidDensity = voidEdges / (33 * 18);
  const menuContrast = menuDensity - menuVoidDensity;

  // 7. Wide Horizontal Run & Single Pill Check (Post Composer signature)
  // In a composer, a rounded input pill border forms a continuous horizontal edge > 50px
  let maxHorizontalRun = 0;
  for (let y = 1; y < CANON_H - 1; y++) {
    let currentRun = 0;
    const rowOffset = y * CANON_W;
    for (let x = 40; x < CANON_W - 10; x++) {
      if (edges[rowOffset + x] === 1) {
        currentRun++;
        if (currentRun > maxHorizontalRun) maxHorizontalRun = currentRun;
      } else {
        currentRun = 0;
      }
    }
  }

  const isWideSinglePill =
    maxHorizontalRun >= 55 ||
    (maxHorizontalRun >= 35 && textBimodalContrast < 1.35 && menuContrast < 0.05);

  return {
    width: rawW,
    height: rawH,
    aspectRatio,
    grid,
    verticalProjection,
    horizontalProjection,
    avatarDensity,
    avatarSquareness,
    avatarBounds: {
      x: 0.02,
      y: 0.15,
      width: 0.12,
      height: 0.7,
    },
    textUpperDensity,
    textGapDensity,
    textLowerDensity,
    textBimodalContrast,
    textBounds: {
      x: 0.16,
      y: 0.15,
      width: 0.65,
      height: 0.7,
    },
    menuDensity,
    menuVoidDensity,
    menuContrast,
    menuBounds: {
      x: 0.86,
      y: 0.15,
      width: 0.12,
      height: 0.45,
    },
    isWideSinglePill,
  };
}

/**
 * Phase 2 Step 6-7: Aggregates multiple confirmed BEGIN samples from the same Anchor Group
 * into a single unified LearnedLayoutFamily. Reduces dependence on changing names,
 * timestamps and avatars by computing cell-level variance and invariant relative bounds.
 */
export async function buildLearnedLayoutFamily(
  references: ReferenceBeginCrop[],
  groupTag = "default",
): Promise<LearnedLayoutFamily> {
  const valid = references.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);
  if (valid.length === 0) {
    throw new Error("Cannot build layout family: no valid reference BEGIN crops provided.");
  }

  const sampleIds: string[] = [];
  const featureList: BeginStructuralFeatures[] = [];

  for (const ref of valid) {
    const sId = ref.sampleId || `sample_${featureList.length + 1}`;
    if (!sampleIds.includes(sId)) sampleIds.push(sId);
    const f = await extractBeginStructuralFeatures(ref.imageBuffer);
    featureList.push(f);
  }

  const N = featureList.length;

  // Nominal geometric dimensions
  const nominalWidth = Math.round(
    featureList.reduce((acc, f) => acc + f.width, 0) / N,
  );
  const nominalHeight = Math.round(
    featureList.reduce((acc, f) => acc + f.height, 0) / N,
  );
  const nominalAspectRatio =
    featureList.reduce((acc, f) => acc + f.aspectRatio, 0) / N;

  // Mean & Variance Grid
  const meanGrid: number[][] = [];
  const varianceGrid: number[][] = [];

  for (let r = 0; r < GRID_ROWS; r++) {
    const meanRow: number[] = [];
    const varRow: number[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      let sum = 0;
      for (const f of featureList) {
        sum += f.grid[r]![c]!;
      }
      const mean = sum / N;
      meanRow.push(mean);

      let varSum = 0;
      for (const f of featureList) {
        const diff = f.grid[r]![c]! - mean;
        varSum += diff * diff;
      }
      varRow.push(varSum / N);
    }
    meanGrid.push(meanRow);
    varianceGrid.push(varRow);
  }

  // Mean Projections
  const meanVerticalProjection: number[] = [];
  for (let b = 0; b < 16; b++) {
    const sum = featureList.reduce(
      (acc, f) => acc + (f.verticalProjection[b] || 0),
      0,
    );
    meanVerticalProjection.push(sum / N);
  }

  const meanHorizontalProjection: number[] = [];
  for (let b = 0; b < GRID_COLS; b++) {
    const sum = featureList.reduce(
      (acc, f) => acc + (f.horizontalProjection[b] || 0),
      0,
    );
    meanHorizontalProjection.push(sum / N);
  }

  const expectedAvatarDensity =
    featureList.reduce((acc, f) => acc + f.avatarDensity, 0) / N;
  const expectedBimodalContrast =
    featureList.reduce((acc, f) => acc + f.textBimodalContrast, 0) / N;
  const expectedMenuContrast =
    featureList.reduce((acc, f) => acc + f.menuContrast, 0) / N;

  return {
    groupTag,
    sampleCount: N,
    sampleIds,
    nominalWidth,
    nominalHeight,
    nominalAspectRatio,
    meanGrid,
    varianceGrid,
    meanVerticalProjection,
    meanHorizontalProjection,
    avatarBounds: { x: 0.02, y: 0.15, width: 0.12, height: 0.7 },
    textBounds: { x: 0.16, y: 0.15, width: 0.65, height: 0.7 },
    menuBounds: { x: 0.86, y: 0.15, width: 0.12, height: 0.45 },
    expectedAvatarDensity,
    expectedBimodalContrast,
    expectedMenuContrast,
  };
}

/**
 * Computes cosine similarity between two 1D vectors.
 */
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

/**
 * Computes weighted layout correlation between candidate grid and learned family grid.
 * Downweights cells with high sample variance (e.g., variable author name lengths).
 */
export function computeWeightedGridCorrelation(
  candGrid: number[][],
  meanGrid: number[][],
  varGrid: number[][],
): number {
  let cov = 0;
  let varC = 0;
  let varM = 0;
  let count = 0;

  let sumC = 0;
  let sumM = 0;
  let totalW = 0;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const w = 1.0 / (0.05 + Math.sqrt(varGrid[r]![c]!));
      const cVal = candGrid[r]![c]!;
      const mVal = meanGrid[r]![c]!;
      sumC += cVal * w;
      sumM += mVal * w;
      totalW += w;
      count++;
    }
  }

  if (totalW <= 0) return 0;
  const meanC = sumC / totalW;
  const meanM = sumM / totalW;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const w = 1.0 / (0.05 + Math.sqrt(varGrid[r]![c]!));
      const diffC = candGrid[r]![c]! - meanC;
      const diffM = meanGrid[r]![c]! - meanM;
      cov += w * diffC * diffM;
      varC += w * diffC * diffC;
      varM += w * diffM * diffM;
    }
  }

  const denom = Math.sqrt(varC * varM);
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(1, cov / denom));
}

/**
 * Evaluates a candidate window crop against the learned layout family.
 * Returns similarity score, feature breakdown, candidate status, and rejection reason.
 */
export async function evaluateCandidateWindow(
  cropBuffer: Buffer,
  family: LearnedLayoutFamily,
  rect: Rect,
  screenHeight: number,
  minConfidence: number,
  scale: number,
): Promise<BeginLayoutCandidate> {
  const f = await extractBeginStructuralFeatures(cropBuffer);

  // 1. Grid Structural Correlation (weighted by cell variance)
  const sGrid = computeWeightedGridCorrelation(
    f.grid,
    family.meanGrid,
    family.varianceGrid,
  );

  // 2. Vertical Projection Profile Similarity
  const sProjY = computeCosineSimilarity(
    f.verticalProjection,
    family.meanVerticalProjection,
  );

  // 3. Aspect Ratio Consistency
  const arDiff = Math.abs(f.aspectRatio - family.nominalAspectRatio);
  const sAR = Math.max(0, 1 - arDiff / Math.max(1, family.nominalAspectRatio));

  // 4. Avatar Structural Score
  let sAvatar = 0;
  if (f.avatarDensity >= 0.05) {
    const densityRatio = Math.min(
      1.0,
      f.avatarDensity / Math.max(0.08, family.expectedAvatarDensity * 0.7),
    );
    const sqScore = Math.min(1.0, f.avatarSquareness / 0.65);
    sAvatar = 0.6 * densityRatio + 0.4 * sqScore;
  }

  // 5. Dual-Band Text Bimodal Score
  let sDualBand = 0;
  if (f.textBimodalContrast >= 1.0) {
    sDualBand = Math.min(1.0, (f.textBimodalContrast - 1.0) / 2.0);
  }

  // 6. Action Menu Button Score
  let sMenu = 0;
  if (f.menuContrast > 0) {
    sMenu = Math.min(
      1.0,
      f.menuContrast / Math.max(0.04, family.expectedMenuContrast * 0.7),
    );
  }

  // Composite Whole-Region Layout Similarity Score
  const compositeScore =
    0.35 * sGrid +
    0.20 * sProjY +
    0.15 * sAvatar +
    0.15 * sDualBand +
    0.15 * sMenu;

  const confidence = Math.round(compositeScore * 100);

  const features: BeginLayoutFeatureScores = {
    avatarFound: sAvatar >= 0.45,
    avatarConfidence: Math.round(sAvatar * 100),
    dualBandTextFound: sDualBand >= 0.35,
    dualBandConfidence: Math.round(sDualBand * 100),
    menuFound: sMenu >= 0.35,
    menuConfidence: Math.round(sMenu * 100),
    structuralGridSimilarity: Math.round(sGrid * 100),
    verticalProfileSimilarity: Math.round(sProjY * 100),
    aspectRatioSimilarity: Math.round(sAR * 100),
  };

  const isTruncated =
    rect.y + rect.height > screenHeight - 6 || rect.y < 4;

  let status: "MATCHED" | "REJECTED" | "PARTIAL" = "REJECTED";
  let rejectionReason: string | undefined;

  if (isTruncated && compositeScore >= 0.35) {
    status = "PARTIAL";
    rejectionReason = `Partial header truncated at viewport boundary (${screenHeight - rect.y}px visible < ${rect.height}px full height)`;
  } else if (sAvatar < 0.30) {
    status = "REJECTED";
    rejectionReason = `Missing left avatar cluster (score ${Math.round(sAvatar * 100)}% < 30%); flat or non-header region`;
  } else if (f.isWideSinglePill) {
    status = "REJECTED";
    rejectionReason =
      "Composer pattern detected: wide continuous input pill without dual-line text or menu";
  } else if (sMenu < 0.25 || f.menuDensity < 0.02) {
    status = "REJECTED";
    rejectionReason =
      `Comment or section pattern: missing top-right action menu (score ${Math.round(sMenu * 100)}% < 25%)`;
  } else if (sDualBand < 0.25 || f.textBimodalContrast < 1.25) {
    status = "REJECTED";
    rejectionReason =
      "Non-header text profile: missing dual-line stacked author + timestamp structure";
  } else if (confidence >= minConfidence && sAvatar >= 0.45 && sDualBand >= 0.30 && sMenu >= 0.30) {
    status = "MATCHED";
  } else {
    status = "REJECTED";
    rejectionReason = `Layout similarity (${confidence}%) below acceptance threshold (${minConfidence}%)`;
  }

  return {
    id: `begin_cand_${Math.round(Math.random() * 100000)}`,
    rect,
    confidence,
    score: compositeScore,
    status,
    rejectionReason,
    features,
    referenceSampleIds: family.sampleIds,
    cropDimensions: { width: family.nominalWidth, height: family.nominalHeight },
    scale,
  };
}

/**
 * Phase 3: Isolated B3 BEGIN Layout Matching Engine.
 *
 * Scans screenshot for whole-region visual layout matches against confirmed BEGIN templates:
 * - Deterministic image processing using edge density grid, vertical projections, and landmark geometry.
 * - Multi-sample learning: combines multiple confirmed samples into one learned layout family.
 * - Distinguishes genuine post headers from composers, comment headers, and featured sections.
 * - Non-maximum suppression along y-axis to return distinct candidate rectangles.
 */
export async function matchBeginLayout(
  screenshotBuffer: Buffer,
  referenceCrops: ReferenceBeginCrop[],
  options?: BeginLayoutMatcherOptions,
): Promise<BeginLayoutMatchResult> {
  const startTime = performance.now();
  const scaleVariants = options?.scaleVariants ?? [1.0, 0.95, 1.05];
  const minConfidence = options?.minConfidence ?? 65;

  const screenMeta = await sharp(screenshotBuffer).metadata();
  const screenWidth = screenMeta.width || 1280;
  const screenHeight = screenMeta.height || 800;

  const validReferences = referenceCrops.filter(
    (r) => r.imageBuffer && r.imageBuffer.length > 0,
  );

  if (validReferences.length === 0) {
    return {
      testedAt: new Date().toISOString(),
      technique: "Structural Geometry & Relative Layout Correlation (Sharp)",
      screenshotDimensions: { width: screenWidth, height: screenHeight },
      scale: 1.0,
      referenceBeginCount: 0,
      referenceSampleIds: [],
      status: "NO_REFERENCES",
      matchedHeaders: [],
      rejectedCandidates: [],
      diagnostics: {
        referenceCropDimensions: [],
        totalEvaluated: 0,
        durationMs: Math.round(performance.now() - startTime),
        summary:
          "No valid confirmed BEGIN reference crops provided. Ensure at least one BEGIN anchor is confirmed in Review 2A.",
      },
    };
  }

  // 1. Build Learned Layout Family from confirmed reference crops
  const family = await buildLearnedLayoutFamily(
    validReferences,
    validReferences[0]?.groupTag || "post-main",
  );

  const referenceSampleIds = family.sampleIds;
  const referenceCropDimensions = validReferences.map((r, idx) => ({
    width: family.nominalWidth,
    height: family.nominalHeight,
    sampleId: r.sampleId || `sample_${idx + 1}`,
    groupTag: r.groupTag,
  }));

  const templateInfo: BeginLayoutTemplateInfo = {
    sampleCount: family.sampleCount,
    groupTag: family.groupTag,
    nominalDimensions: {
      width: family.nominalWidth,
      height: family.nominalHeight,
    },
    aspectRatio: Math.round(family.nominalAspectRatio * 100) / 100,
    avatarRelBounds: family.avatarBounds,
    textRelBounds: family.textBounds,
    menuRelBounds: family.menuBounds,
  };

  // Convert full screenshot to raw grayscale for fast sliding window inspection
  const screenRaw = await sharp(screenshotBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const screenData = screenRaw.data;

  const rawCandidates: BeginLayoutCandidate[] = [];
  let totalEvaluated = 0;

  for (const scale of scaleVariants) {
    const candW = Math.round(family.nominalWidth * scale);
    const candH = Math.round(family.nominalHeight * scale);

    if (candW > screenWidth || candH > screenHeight) continue;

    // Viewport search bounds (post headers are typically in the main content stream)
    const xStartMin = 20;
    const xStartMax = Math.max(xStartMin + 20, screenWidth - candW - 20);
    const xStep = 24;
    const yStep = 6;

    for (let y = 10; y <= screenHeight - Math.round(candH * 0.4); y += yStep) {
      for (let x = xStartMin; x <= xStartMax; x += xStep) {
        totalEvaluated++;

        // Quick coarse rejection: check contrast in avatar area (relX ~0..0.15)
        const avW = Math.max(10, Math.round(candW * 0.15));
        const avH = Math.max(10, Math.min(candH, screenHeight - y));

        let avSum = 0;
        let count = 0;
        const stride = 4;
        for (let py = 0; py < avH; py += stride) {
          const rowStart = (y + py) * screenWidth;
          for (let px = 0; px < avW; px += stride) {
            avSum += screenData[rowStart + (x + px)]!;
            count++;
          }
        }

        const avMean = count > 0 ? avSum / count : 0;
        let avVar = 0;
        for (let py = 0; py < avH; py += stride) {
          const rowStart = (y + py) * screenWidth;
          for (let px = 0; px < avW; px += stride) {
            const diff = screenData[rowStart + (x + px)]! - avMean;
            avVar += diff * diff;
          }
        }
        const avatarVariance = count > 0 ? avVar / count : 0;

        // Flat or low variance regions cannot be a post header avatar
        if (avatarVariance < 16) {
          continue;
        }

        const effH = Math.min(candH, screenHeight - y);
        const candCropBuffer = await sharp(screenshotBuffer)
          .extract({
            left: x,
            top: y,
            width: candW,
            height: effH,
          })
          .toBuffer();

        const candRect: Rect = { x, y, width: candW, height: candH };
        const evaluated = await evaluateCandidateWindow(
          candCropBuffer,
          family,
          candRect,
          screenHeight,
          minConfidence,
          scale,
        );

        if (
          evaluated.status === "MATCHED" ||
          evaluated.status === "PARTIAL" ||
          evaluated.score >= 0.35
        ) {
          rawCandidates.push(evaluated);
        }
      }
    }
  }

  // Non-Maximum Suppression (NMS) for MATCHED candidates
  const matchedPool = rawCandidates.filter((c) => c.status === "MATCHED");
  matchedPool.sort((a, b) => b.score - a.score);

  const matchedHeaders: BeginLayoutCandidate[] = [];
  for (const cand of matchedPool) {
    const isNearby = matchedHeaders.some(
      (m) =>
        Math.abs(m.rect.y - cand.rect.y) <= Math.max(25, cand.rect.height * 0.70) &&
        Math.abs(m.rect.x - cand.rect.x) <= Math.max(80, cand.rect.width * 0.40),
    );
    if (!isNearby) {
      matchedHeaders.push(cand);
    }
  }

  // Sort matched headers top to bottom strictly by Y coordinate
  matchedHeaders.sort((a, b) => a.rect.y - b.rect.y);

  // Group and deduplicate rejected/partial candidates for diagnostic display
  const nonMatchedPool = rawCandidates.filter((c) => c.status !== "MATCHED");
  nonMatchedPool.sort((a, b) => b.score - a.score);

  const rejectedCandidates: BeginLayoutCandidate[] = [];
  for (const cand of nonMatchedPool) {
    const isNearMatch = matchedHeaders.some(
      (m) =>
        Math.abs(m.rect.y - cand.rect.y) <= Math.max(25, cand.rect.height * 0.70),
    );
    const isNearRejected = rejectedCandidates.some(
      (r) =>
        Math.abs(r.rect.y - cand.rect.y) <= Math.max(25, cand.rect.height * 0.70),
    );
    if (!isNearMatch && !isNearRejected && rejectedCandidates.length < 15) {
      rejectedCandidates.push(cand);
    }
  }

  let overallStatus: "MATCHED" | "NO_MATCH" | "PARTIAL" = "NO_MATCH";
  if (matchedHeaders.length > 0) {
    overallStatus = "MATCHED";
  } else if (rawCandidates.some((c) => c.status === "PARTIAL")) {
    overallStatus = "PARTIAL";
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    testedAt: new Date().toISOString(),
    technique: "Structural Geometry & Relative Layout Correlation (Sharp)",
    screenshotDimensions: { width: screenWidth, height: screenHeight },
    scale: 1.0,
    referenceBeginCount: validReferences.length,
    referenceSampleIds,
    templateInfo,
    status: overallStatus,
    matchedHeaders,
    rejectedCandidates,
    diagnostics: {
      referenceCropDimensions,
      totalEvaluated,
      durationMs,
      summary:
        overallStatus === "MATCHED"
          ? `Detected ${matchedHeaders.length} B3 BEGIN visual candidate(s) using structural layout correlation.`
          : overallStatus === "PARTIAL"
            ? "Detected partial header truncated at viewport boundary; insufficient complete evidence."
            : "No post header matching reference structural layout template found in screenshot.",
    },
  };
}

/**
 * Phase 4 & Task C2.11.14: Inspects real B3 layout template data for confirmed BEGIN references.
 * Uses the exact same feature extraction and multi-sample aggregation mathematics as runtime matching.
 * Returns normalized preview images, edge maps, density grids, and multi-sample variance info.
 */
export async function inspectBeginLayoutTemplate(
  references: ReferenceBeginCrop[],
  targetGroupTag?: string,
): Promise<BeginLayoutInspectionReport> {
  const groups: Record<string, BeginGroupTemplateInspection> = {};
  const allGroupTagsSet = new Set<string>();

  const byGroup = new Map<string, ReferenceBeginCrop[]>();
  for (const ref of references) {
    const tag = ref.groupTag || "default";
    allGroupTagsSet.add(tag);
    const list = byGroup.get(tag) ?? [];
    list.push(ref);
    byGroup.set(tag, list);
  }

  if (targetGroupTag) {
    allGroupTagsSet.add(targetGroupTag);
    if (!byGroup.has(targetGroupTag)) {
      byGroup.set(targetGroupTag, []);
    }
  }

  const allGroupTags = Array.from(allGroupTagsSet);

  for (const [tag, groupRefs] of byGroup.entries()) {
    const validRefs = groupRefs.filter((r) => r.imageBuffer && r.imageBuffer.length > 0);

    if (validRefs.length === 0) {
      groups[tag] = {
        groupTag: tag,
        sampleCount: 0,
        sampleIds: groupRefs.map((r) => r.sampleId || "").filter(Boolean),
        canonicalDimensions: { width: CANON_W, height: CANON_H },
        nominalDimensions: { width: CANON_W, height: CANON_H },
        nominalAspectRatio: Math.round((CANON_W / CANON_H) * 100) / 100,
        meanGrid: Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0)),
        varianceGrid: Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0)),
        dynamicLowWeightCellsCount: 0,
        avatarBounds: { x: 0.02, y: 0.15, width: 0.12, height: 0.7 },
        textBounds: { x: 0.16, y: 0.15, width: 0.65, height: 0.7 },
        menuBounds: { x: 0.86, y: 0.15, width: 0.12, height: 0.45 },
        expectedAvatarDensity: 0,
        expectedBimodalContrast: 0,
        expectedMenuContrast: 0,
        samples: groupRefs.map((r) => ({
          sampleId: r.sampleId || "unknown",
          regionId: r.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: r.originalDataUrl,
          normalizedDataUrl: "",
          edgesDataUrl: "",
          grid: Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0)),
          verticalProjection: Array(16).fill(0),
          horizontalProjection: Array(GRID_COLS).fill(0),
          avatar: { density: 0, squareness: 0, bounds: { x: 0.02, y: 0.15, width: 0.12, height: 0.7 } },
          text: { upperDensity: 0, gapDensity: 0, lowerDensity: 0, bimodalContrast: 0, bounds: { x: 0.16, y: 0.15, width: 0.65, height: 0.7 } },
          menu: { density: 0, voidDensity: 0, contrast: 0, bounds: { x: 0.86, y: 0.15, width: 0.12, height: 0.45 } },
          isWideSinglePill: false,
          error: r.error || "Reference crop image buffer is empty or unavailable.",
        })),
        status: "NO_CONFIRMED_SAMPLES",
        error: "No usable confirmed BEGIN reference crops in this Anchor Group.",
      };
      continue;
    }

    const sampleInspections: BeginSampleTemplateInspection[] = [];
    for (const ref of groupRefs) {
      if (!ref.imageBuffer || ref.imageBuffer.length === 0) {
        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: ref.originalDataUrl,
          normalizedDataUrl: "",
          edgesDataUrl: "",
          grid: Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0)),
          verticalProjection: Array(16).fill(0),
          horizontalProjection: Array(GRID_COLS).fill(0),
          avatar: { density: 0, squareness: 0, bounds: { x: 0.02, y: 0.15, width: 0.12, height: 0.7 } },
          text: { upperDensity: 0, gapDensity: 0, lowerDensity: 0, bimodalContrast: 0, bounds: { x: 0.16, y: 0.15, width: 0.65, height: 0.7 } },
          menu: { density: 0, voidDensity: 0, contrast: 0, bounds: { x: 0.86, y: 0.15, width: 0.12, height: 0.45 } },
          isWideSinglePill: false,
          error: ref.error || "Reference crop image buffer is empty or unreadable.",
        });
        continue;
      }

      try {
        const meta = await sharp(ref.imageBuffer).metadata();
        const rawW = meta.width || CANON_W;
        const rawH = meta.height || CANON_H;

        const originalCropDataUrl =
          ref.originalDataUrl ||
          `data:image/png;base64,${(await sharp(ref.imageBuffer).png().toBuffer()).toString("base64")}`;

        const normBuf = await sharp(ref.imageBuffer)
          .grayscale()
          .resize(CANON_W, CANON_H, { fit: "fill" })
          .png()
          .toBuffer();
        const normalizedDataUrl = `data:image/png;base64,${normBuf.toString("base64")}`;

        const features = await extractBeginStructuralFeatures(ref.imageBuffer);

        const { data: pixels } = await sharp(ref.imageBuffer)
          .grayscale()
          .resize(CANON_W, CANON_H, { fit: "fill" })
          .raw()
          .toBuffer({ resolveWithObject: true });

        const edgeBytes = Buffer.alloc(CANON_W * CANON_H);
        for (let y = 1; y < CANON_H - 1; y++) {
          const rowOffset = y * CANON_W;
          for (let x = 1; x < CANON_W - 1; x++) {
            const idx = rowOffset + x;
            const dx = Math.abs(pixels[idx + 1]! - pixels[idx - 1]!);
            const dy = Math.abs(pixels[idx + CANON_W]! - pixels[idx - CANON_W]!);
            if (dx + dy >= 26) {
              edgeBytes[idx] = 255;
            }
          }
        }
        const edgePng = await sharp(edgeBytes, {
          raw: { width: CANON_W, height: CANON_H, channels: 1 },
        })
          .png()
          .toBuffer();
        const edgesDataUrl = `data:image/png;base64,${edgePng.toString("base64")}`;

        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: rawW, height: rawH },
          aspectRatio: Math.round(features.aspectRatio * 100) / 100,
          originalCropDataUrl,
          normalizedDataUrl,
          edgesDataUrl,
          grid: features.grid,
          verticalProjection: features.verticalProjection,
          horizontalProjection: features.horizontalProjection,
          avatar: {
            density: Math.round(features.avatarDensity * 100) / 100,
            squareness: Math.round(features.avatarSquareness * 100) / 100,
            bounds: features.avatarBounds,
          },
          text: {
            upperDensity: Math.round(features.textUpperDensity * 100) / 100,
            gapDensity: Math.round(features.textGapDensity * 100) / 100,
            lowerDensity: Math.round(features.textLowerDensity * 100) / 100,
            bimodalContrast: Math.round(features.textBimodalContrast * 100) / 100,
            bounds: features.textBounds,
          },
          menu: {
            density: Math.round(features.menuDensity * 100) / 100,
            voidDensity: Math.round(features.menuVoidDensity * 100) / 100,
            contrast: Math.round(features.menuContrast * 100) / 100,
            bounds: features.menuBounds,
          },
          isWideSinglePill: features.isWideSinglePill,
        });
      } catch (err) {
        sampleInspections.push({
          sampleId: ref.sampleId || "unknown",
          regionId: ref.regionId,
          groupTag: tag,
          rawDimensions: { width: 0, height: 0 },
          aspectRatio: 1.0,
          originalCropDataUrl: ref.originalDataUrl,
          normalizedDataUrl: "",
          edgesDataUrl: "",
          grid: Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0)),
          verticalProjection: Array(16).fill(0),
          horizontalProjection: Array(GRID_COLS).fill(0),
          avatar: { density: 0, squareness: 0, bounds: { x: 0.02, y: 0.15, width: 0.12, height: 0.7 } },
          text: { upperDensity: 0, gapDensity: 0, lowerDensity: 0, bimodalContrast: 0, bounds: { x: 0.16, y: 0.15, width: 0.65, height: 0.7 } },
          menu: { density: 0, voidDensity: 0, contrast: 0, bounds: { x: 0.86, y: 0.15, width: 0.12, height: 0.45 } },
          isWideSinglePill: false,
          error: `Feature extraction error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const family = await buildLearnedLayoutFamily(validRefs, tag);
    let dynamicLowWeightCount = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (family.varianceGrid[r]![c]! > 0.04) {
          dynamicLowWeightCount++;
        }
      }
    }

    groups[tag] = {
      groupTag: tag,
      sampleCount: family.sampleCount,
      sampleIds: family.sampleIds,
      canonicalDimensions: { width: CANON_W, height: CANON_H },
      nominalDimensions: { width: family.nominalWidth, height: family.nominalHeight },
      nominalAspectRatio: Math.round(family.nominalAspectRatio * 100) / 100,
      meanGrid: family.meanGrid,
      varianceGrid: family.varianceGrid,
      dynamicLowWeightCellsCount: dynamicLowWeightCount,
      avatarBounds: family.avatarBounds,
      textBounds: family.textBounds,
      menuBounds: family.menuBounds,
      expectedAvatarDensity: Math.round(family.expectedAvatarDensity * 100) / 100,
      expectedBimodalContrast: Math.round(family.expectedBimodalContrast * 100) / 100,
      expectedMenuContrast: Math.round(family.expectedMenuContrast * 100) / 100,
      samples: sampleInspections,
      status: "READY",
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    canonicalDimensions: { width: CANON_W, height: CANON_H },
    groups,
    allGroupTags,
  };
}
