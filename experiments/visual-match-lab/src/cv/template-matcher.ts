import { MatchCandidate, Rect } from '../types';
import { ImageProcessor } from './image-processor';

declare const cv: any;

export type MatchMethod = 'normxcorr' | 'grayscale' | 'edge' | 'masked';

export class TemplateMatcher {
  /**
   * Check if OpenCV.js runtime is ready.
   */
  public static isOpenCvReady(): boolean {
    return typeof cv !== 'undefined' && typeof cv.Mat === 'function';
  }

  /**
   * Run template matching across target image with selected method.
   * Returns all candidates above threshold after non-maximum suppression.
   */
  public static async match(
    templateCanvas: HTMLCanvasElement,
    targetCanvas: HTMLCanvasElement,
    method: MatchMethod = 'grayscale',
    threshold: number = 0.65
  ): Promise<{ matches: MatchCandidate[]; timeMs: number }> {
    const startTime = performance.now();

    if (this.isOpenCvReady()) {
      try {
        const result = this.matchWithOpenCv(templateCanvas, targetCanvas, method, threshold);
        const timeMs = Math.round((performance.now() - startTime) * 10) / 10;
        return { matches: result, timeMs };
      } catch (err) {
        console.warn('OpenCV matching failed, falling back to pure JS matcher:', err);
      }
    }

    // Fallback: Pure JS normalized cross-correlation
    const result = this.matchPureJs(templateCanvas, targetCanvas, method, threshold);
    const timeMs = Math.round((performance.now() - startTime) * 10) / 10;
    return { matches: result, timeMs };
  }

  /**
   * OpenCV.js matching implementation
   */
  private static matchWithOpenCv(
    templateCanvas: HTMLCanvasElement,
    targetCanvas: HTMLCanvasElement,
    method: MatchMethod,
    threshold: number
  ): MatchCandidate[] {
    const srcMat = cv.imread(targetCanvas);
    const templMat = cv.imread(templateCanvas);

    let srcProcessed: any;
    let templProcessed: any;

    if (method === 'grayscale') {
      srcProcessed = new cv.Mat();
      templProcessed = new cv.Mat();
      cv.cvtColor(srcMat, srcProcessed, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(templMat, templProcessed, cv.COLOR_RGBA2GRAY);
    } else if (method === 'edge') {
      const srcGray = new cv.Mat();
      const templGray = new cv.Mat();
      srcProcessed = new cv.Mat();
      templProcessed = new cv.Mat();
      cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(templMat, templGray, cv.COLOR_RGBA2GRAY);
      cv.Canny(srcGray, srcProcessed, 50, 150);
      cv.Canny(templGray, templProcessed, 50, 150);
      srcGray.delete();
      templGray.delete();
    } else {
      // Raw / Masked
      srcProcessed = srcMat.clone();
      templProcessed = templMat.clone();
    }

    const dstCols = targetCanvas.width - templateCanvas.width + 1;
    const dstRows = targetCanvas.height - templateCanvas.height + 1;

    if (dstCols <= 0 || dstRows <= 0) {
      srcMat.delete();
      templMat.delete();
      srcProcessed.delete();
      templProcessed.delete();
      return [];
    }

    const resultMat = new cv.Mat();
    cv.matchTemplate(srcProcessed, templProcessed, resultMat, cv.TM_CCOEFF_NORMED);

    // Extract all candidate peaks
    const rawMatches: { x: number; y: number; score: number }[] = [];
    const tW = templateCanvas.width;
    const tH = templateCanvas.height;

    for (let y = 0; y < dstRows; y++) {
      for (let x = 0; x < dstCols; x++) {
        const score = resultMat.floatAt(y, x);
        if (score >= threshold) {
          rawMatches.push({ x, y, score });
        }
      }
    }

    // Cleanup OpenCV mats
    srcMat.delete();
    templMat.delete();
    srcProcessed.delete();
    templProcessed.delete();
    resultMat.delete();

    // Sort descending by score and apply Non-Maximum Suppression (NMS)
    rawMatches.sort((a, b) => b.score - a.score);
    return this.applyNMS(rawMatches, tW, tH, method);
  }

  /**
   * Pure JS fallback for Normalized Cross-Correlation (NCC)
   */
  private static matchPureJs(
    templateCanvas: HTMLCanvasElement,
    targetCanvas: HTMLCanvasElement,
    method: MatchMethod,
    threshold: number
  ): MatchCandidate[] {
    const tCtx = templateCanvas.getContext('2d', { willReadFrequently: true })!;
    const sCtx = targetCanvas.getContext('2d', { willReadFrequently: true })!;

    const tImg = tCtx.getImageData(0, 0, templateCanvas.width, templateCanvas.height);
    const sImg = sCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);

    let tGray: ImageData;
    let sGray: ImageData;

    if (method === 'edge') {
      tGray = ImageProcessor.computeEdgeMap(ImageProcessor.toGrayscale(tImg));
      sGray = ImageProcessor.computeEdgeMap(ImageProcessor.toGrayscale(sImg));
    } else {
      tGray = ImageProcessor.toGrayscale(tImg);
      sGray = ImageProcessor.toGrayscale(sImg);
    }

    const tW = templateCanvas.width;
    const tH = templateCanvas.height;
    const sW = targetCanvas.width;
    const sH = targetCanvas.height;

    // Compute template mean and variance
    const tData = tGray.data;
    let tSum = 0;
    const tCount = tW * tH;
    for (let i = 0; i < tData.length; i += 4) tSum += tData[i];
    const tMean = tSum / tCount;

    let tVar = 0;
    for (let i = 0; i < tData.length; i += 4) {
      const diff = tData[i] - tMean;
      tVar += diff * diff;
    }
    const tStd = Math.sqrt(tVar) || 1;

    const rawMatches: { x: number; y: number; score: number }[] = [];
    const sData = sGray.data;

    // Sliding window cross-correlation
    for (let sy = 0; sy <= sH - tH; sy += 1) {
      for (let sx = 0; sx <= sW - tW; sx += 1) {
        let sSum = 0;
        for (let ty = 0; ty < tH; ty++) {
          const sRowIdx = ((sy + ty) * sW + sx) * 4;
          for (let tx = 0; tx < tW; tx++) {
            sSum += sData[sRowIdx + tx * 4];
          }
        }
        const sMean = sSum / tCount;

        let num = 0;
        let sVar = 0;

        for (let ty = 0; ty < tH; ty++) {
          const sRowIdx = ((sy + ty) * sW + sx) * 4;
          const tRowIdx = (ty * tW) * 4;
          for (let tx = 0; tx < tW; tx++) {
            const tDiff = tData[tRowIdx + tx * 4] - tMean;
            const sDiff = sData[sRowIdx + tx * 4] - sMean;
            num += tDiff * sDiff;
            sVar += sDiff * sDiff;
          }
        }

        const sStd = Math.sqrt(sVar) || 1;
        const ncc = num / (tStd * sStd);

        if (ncc >= threshold) {
          rawMatches.push({ x: sx, y: sy, score: Math.round(ncc * 1000) / 1000 });
        }
      }
    }

    rawMatches.sort((a, b) => b.score - a.score);
    return this.applyNMS(rawMatches, tW, tH, method);
  }

  /**
   * Non-Maximum Suppression (NMS) to eliminate duplicate overlapping boxes
   */
  private static applyNMS(
    rawMatches: { x: number; y: number; score: number }[],
    width: number,
    height: number,
    method: MatchMethod
  ): MatchCandidate[] {
    const kept: MatchCandidate[] = [];
    const suppressionOverlapThreshold = 0.35;

    for (let i = 0; i < rawMatches.length; i++) {
      const cur = rawMatches[i];
      let suppressed = false;

      for (const k of kept) {
        // Calculate IoU with already accepted candidate
        const interX1 = Math.max(cur.x, k.bbox.x);
        const interY1 = Math.max(cur.y, k.bbox.y);
        const interX2 = Math.min(cur.x + width, k.bbox.x + width);
        const interY2 = Math.min(cur.y + height, k.bbox.y + height);

        const interW = Math.max(0, interX2 - interX1);
        const interH = Math.max(0, interY2 - interY1);
        const interArea = interW * interH;

        const unionArea = 2 * (width * height) - interArea;
        const iou = interArea / unionArea;

        if (iou > suppressionOverlapThreshold) {
          suppressed = true;
          break;
        }
      }

      if (!suppressed) {
        kept.push({
          id: `match_${kept.length + 1}`,
          bbox: { x: cur.x, y: cur.y, width, height },
          score: Math.round(cur.score * 1000) / 1000,
          method,
          isBest: kept.length === 0,
        });
      }

      if (kept.length >= 20) break; // Limit top 20 candidates
    }

    return kept;
  }
}
