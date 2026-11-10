import type { PipelineExecutionResult } from '../types';
import type { FixtureItem } from '../fixtures/fixture-manager';
import { ImageProcessor } from './image-processor';
import { CandidateClassifier } from './candidate-classifier';
import { GroupRecognizer } from './group-recognizer';

/** Shared Stage A–D engine used by both the original Lab UI and live captures. */
export async function runRecognitionPipeline(fixture: FixtureItem): Promise<PipelineExecutionResult> {
  const startTime = performance.now();
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = fixture.dataUrl;
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('PIPELINE_IMAGE_LOAD_FAILED')); });
  const w = img.width, h = img.height;
  const origCanvas = document.createElement('canvas'); origCanvas.width = w; origCanvas.height = h;
  const origCtx = origCanvas.getContext('2d', { willReadFrequently: true })!; origCtx.drawImage(img, 0, 0);
  const origData = origCtx.getImageData(0, 0, w, h);

  const grayData = ImageProcessor.toGrayscale(origData); const grayCanvas = document.createElement('canvas'); grayCanvas.width = w; grayCanvas.height = h; grayCanvas.getContext('2d')!.putImageData(grayData, 0, 0);
  const edgeData = ImageProcessor.computeEdgeMap(grayData); const edgeCanvas = document.createElement('canvas'); edgeCanvas.width = w; edgeCanvas.height = h; edgeCanvas.getContext('2d')!.putImageData(edgeData, 0, 0);
  const { threshold, isDarkOnLight } = ImageProcessor.computeOtsuThreshold(grayData);
  const binData = ImageProcessor.toBinaryMask(grayData, threshold, isDarkOnLight); const binaryCanvas = document.createElement('canvas'); binaryCanvas.width = w; binaryCanvas.height = h; binaryCanvas.getContext('2d')!.putImageData(binData, 0, 0);
  const { components, labeledImage } = ImageProcessor.extractConnectedComponents(binData, origData, 4); const componentsCanvas = document.createElement('canvas'); componentsCanvas.width = w; componentsCanvas.height = h; componentsCanvas.getContext('2d')!.putImageData(labeledImage, 0, 0);
  const candidates = CandidateClassifier.classifyCandidates(components, w, h);
  for (const candidate of candidates) { const crop = document.createElement('canvas'); crop.width = candidate.bbox.width; crop.height = candidate.bbox.height; crop.getContext('2d')!.drawImage(origCanvas, candidate.bbox.x, candidate.bbox.y, candidate.bbox.width, candidate.bbox.height, 0, 0, candidate.bbox.width, candidate.bbox.height); candidate.cropDataUrl = crop.toDataURL('image/png'); }
  const groups = GroupRecognizer.recognizeGroups(candidates, w, h);
  const candidatesCanvas = document.createElement('canvas'); candidatesCanvas.width = w; candidatesCanvas.height = h; candidatesCanvas.getContext('2d')!.drawImage(origCanvas, 0, 0);
  return { width: w, height: h, grayscaleCanvas: grayCanvas, edgeCanvas, binaryCanvas, componentsCanvas, candidatesCanvas, candidates, groups, processingTimeMs: Math.round((performance.now() - startTime) * 10) / 10, thresholdUsed: threshold };
}
