import { CandidateFeatures, Rect } from '../types';

export interface ComponentData {
  id: number;
  bbox: Rect;
  pixelCount: number;
  pixels: { x: number; y: number }[];
  features: CandidateFeatures;
  avgColor: [number, number, number];
}

export class ImageProcessor {
  /**
   * Convert an ImageData to a Grayscale ImageData.
   */
  public static toGrayscale(src: ImageData): ImageData {
    const width = src.width;
    const height = src.height;
    const output = new ImageData(width, height);
    const data = src.data;
    const outData = output.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      outData[i] = gray;
      outData[i + 1] = gray;
      outData[i + 2] = gray;
      outData[i + 3] = 255;
    }
    return output;
  }

  /**
   * Calculate Sobel Edge / Gradient map.
   */
  public static computeEdgeMap(grayImg: ImageData): ImageData {
    const width = grayImg.width;
    const height = grayImg.height;
    const src = grayImg.data;
    const output = new ImageData(width, height);
    const dst = output.data;

    // Sobel kernels
    // Kx: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]
    // Ky: [[-1, -2, -1], [0, 0, 0], [1, 2, 1]]

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;

        const p00 = src[((y - 1) * width + (x - 1)) * 4];
        const p01 = src[((y - 1) * width + x) * 4];
        const p02 = src[((y - 1) * width + (x + 1)) * 4];

        const p10 = src[(y * width + (x - 1)) * 4];
        const p12 = src[(y * width + (x + 1)) * 4];

        const p20 = src[((y + 1) * width + (x - 1)) * 4];
        const p21 = src[((y + 1) * width + x) * 4];
        const p22 = src[((y + 1) * width + (x + 1)) * 4];

        const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
        const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

        const mag = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
        dst[idx] = mag;
        dst[idx + 1] = mag;
        dst[idx + 2] = mag;
        dst[idx + 3] = 255;
      }
    }
    return output;
  }

  /**
   * Otsu automated threshold calculation for binary mask.
   */
  public static computeOtsuThreshold(grayImg: ImageData): { threshold: number; isDarkOnLight: boolean } {
    const src = grayImg.data;
    const hist = new Int32Array(256);
    let total = 0;

    for (let i = 0; i < src.length; i += 4) {
      hist[src[i]]++;
      total++;
    }

    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];

    let sumB = 0;
    let wB = 0;
    let wF = 0;
    let varMax = 0;
    let threshold = 128;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;

      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) {
        varMax = varBetween;
        threshold = t;
      }
    }

    // Determine polarity: sample the border perimeter to find dominant background luminance
    let borderSum = 0;
    let borderCount = 0;
    const w = grayImg.width;
    const h = grayImg.height;

    for (let x = 0; x < w; x++) {
      borderSum += src[x * 4];
      borderSum += src[((h - 1) * w + x) * 4];
      borderCount += 2;
    }
    for (let y = 0; y < h; y++) {
      borderSum += src[(y * w) * 4];
      borderSum += src[(y * w + (w - 1)) * 4];
      borderCount += 2;
    }
    const borderAvg = borderSum / Math.max(1, borderCount);
    // If border is light (> threshold), foreground objects are darker than threshold
    const isDarkOnLight = borderAvg >= threshold;

    return { threshold, isDarkOnLight };
  }

  /**
   * Produce Binary Mask where foreground = 255, background = 0.
   */
  public static toBinaryMask(grayImg: ImageData, threshold: number, isDarkOnLight: boolean): ImageData {
    const width = grayImg.width;
    const height = grayImg.height;
    const output = new ImageData(width, height);
    const src = grayImg.data;
    const dst = output.data;

    for (let i = 0; i < src.length; i += 4) {
      const val = src[i];
      const isForeground = isDarkOnLight ? val < threshold : val >= threshold;
      const bin = isForeground ? 255 : 0;
      dst[i] = bin;
      dst[i + 1] = bin;
      dst[i + 2] = bin;
      dst[i + 3] = 255;
    }
    return output;
  }

  /**
   * Two-pass 8-connected component labeling with Union-Find.
   */
  public static extractConnectedComponents(
    binaryImg: ImageData,
    originalImg: ImageData,
    minArea: number = 4
  ): { components: ComponentData[]; labeledImage: ImageData } {
    const width = binaryImg.width;
    const height = binaryImg.height;
    const bin = binaryImg.data;
    const orig = originalImg.data;

    const labels = new Int32Array(width * height);
    const parent: number[] = [0]; // label 0 is background

    function find(i: number): number {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      let curr = i;
      while (curr !== root) {
        const next = parent[curr];
        parent[curr] = root;
        curr = next;
      }
      return root;
    }

    function union(i: number, j: number) {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) {
        if (rootI < rootJ) parent[rootJ] = rootI;
        else parent[rootI] = rootJ;
      }
    }

    let nextLabel = 1;

    // First pass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (bin[idx * 4] === 0) continue; // background

        // Check 8-neighbors that were already visited
        const neighbors: number[] = [];
        // Left
        if (x > 0 && labels[idx - 1] > 0) neighbors.push(labels[idx - 1]);
        // Top-left
        if (x > 0 && y > 0 && labels[idx - width - 1] > 0) neighbors.push(labels[idx - width - 1]);
        // Top
        if (y > 0 && labels[idx - width] > 0) neighbors.push(labels[idx - width]);
        // Top-right
        if (x < width - 1 && y > 0 && labels[idx - width + 1] > 0) neighbors.push(labels[idx - width + 1]);

        if (neighbors.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          nextLabel++;
        } else {
          let minL = neighbors[0];
          for (let k = 1; k < neighbors.length; k++) {
            if (neighbors[k] < minL) minL = neighbors[k];
          }
          labels[idx] = minL;
          for (const n of neighbors) {
            union(minL, n);
          }
        }
      }
    }

    // Second pass: flatten labels and map to canonical IDs
    const labelMap = new Map<number, number>();
    let canonicalCount = 0;

    for (let i = 0; i < labels.length; i++) {
      if (labels[i] > 0) {
        const root = find(labels[i]);
        if (!labelMap.has(root)) {
          canonicalCount++;
          labelMap.set(root, canonicalCount);
        }
        labels[i] = labelMap.get(root)!;
      }
    }

    // Accumulate bounding boxes and pixel stats
    interface CompAcc {
      id: number;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      pixels: { x: number; y: number }[];
      colorR: number;
      colorG: number;
      colorB: number;
    }
    const accum = new Map<number, CompAcc>();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const l = labels[idx];
        if (l === 0) continue;

        let acc = accum.get(l);
        if (!acc) {
          acc = {
            id: l,
            minX: x,
            minY: y,
            maxX: x,
            maxY: y,
            pixels: [],
            colorR: 0,
            colorG: 0,
            colorB: 0,
          };
          accum.set(l, acc);
        }
        if (x < acc.minX) acc.minX = x;
        if (x > acc.maxX) acc.maxX = x;
        if (y < acc.minY) acc.minY = y;
        if (y > acc.maxY) acc.maxY = y;
        acc.pixels.push({ x, y });

        const pIdx = idx * 4;
        acc.colorR += orig[pIdx];
        acc.colorG += orig[pIdx + 1];
        acc.colorB += orig[pIdx + 2];
      }
    }

    // Generate output components & color-coded preview
    const components: ComponentData[] = [];
    const labeledImage = new ImageData(width, height);
    const labData = labeledImage.data;

    // Palette generator for distinct component visualization
    const getCompColor = (id: number): [number, number, number] => {
      const hue = (id * 137.5) % 360;
      // Convert HSV to RGB (S=0.8, V=0.95)
      const c = 0.95 * 0.8;
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
      const m = 0.95 - c;
      let r = 0, g = 0, b = 0;
      if (hue < 60) { r = c; g = x; b = 0; }
      else if (hue < 120) { r = x; g = c; b = 0; }
      else if (hue < 180) { r = 0; g = c; b = x; }
      else if (hue < 240) { r = 0; g = x; b = c; }
      else if (hue < 300) { r = x; g = 0; b = c; }
      else { r = c; g = 0; b = x; }
      return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    };

    accum.forEach((acc) => {
      if (acc.pixels.length < minArea) {
        // filter out small noise
        return;
      }
      const w = acc.maxX - acc.minX + 1;
      const h = acc.maxY - acc.minY + 1;
      const area = w * h;
      const fillRatio = acc.pixels.length / Math.max(1, area);
      const aspectRatio = w / Math.max(1, h);

      // Centroid
      let sumX = 0, sumY = 0;
      for (const p of acc.pixels) {
        sumX += p.x;
        sumY += p.y;
      }
      const cx = sumX / acc.pixels.length;
      const cy = sumY / acc.pixels.length;

      // Color variation and average
      const avgR = Math.round(acc.colorR / acc.pixels.length);
      const avgG = Math.round(acc.colorG / acc.pixels.length);
      const avgB = Math.round(acc.colorB / acc.pixels.length);

      // Hole and topological features: slice horizontally across center
      let hHoles = 0;
      const midY = Math.round(cy);
      let inFwd = false;
      let transitions = 0;
      for (let x = acc.minX; x <= acc.maxX; x++) {
        const isSet = labels[midY * width + x] === acc.id;
        if (isSet !== inFwd) {
          transitions++;
          inFwd = isSet;
        }
      }
      hHoles = Math.max(0, Math.floor((transitions - 2) / 2));

      components.push({
        id: acc.id,
        bbox: { x: acc.minX, y: acc.minY, width: w, height: h },
        pixelCount: acc.pixels.length,
        pixels: acc.pixels,
        avgColor: [avgR, avgG, avgB],
        features: {
          area,
          aspectRatio,
          fillRatio,
          strokeVariance: 0,
          horizontalHoles: hHoles,
          verticalHoles: 0,
          colorVariation: 0,
          cx,
          cy,
        },
      });

      // Paint to labeled image
      const [cr, cg, cb] = getCompColor(acc.id);
      for (const p of acc.pixels) {
        const pIdx = (p.y * width + p.x) * 4;
        labData[pIdx] = cr;
        labData[pIdx + 1] = cg;
        labData[pIdx + 2] = cb;
        labData[pIdx + 3] = 255;
      }
    });

    return { components, labeledImage };
  }
}
