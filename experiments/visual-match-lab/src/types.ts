export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CandidateType = 'icon' | 'text' | 'reaction-distractor' | 'unknown';

export type MatchMethod = 'normxcorr' | 'grayscale' | 'edge' | 'masked';

export interface CandidateFeatures {
  area: number;
  aspectRatio: number; // width / height
  fillRatio: number; // foreground pixels / (width * height)
  strokeVariance: number;
  horizontalHoles: number;
  verticalHoles: number;
  colorVariation: number;
  cx: number;
  cy: number;
}

export interface Candidate {
  id: string;
  bbox: Rect;
  type: CandidateType;
  confidence: number;
  features: CandidateFeatures;
  reasons: string[];
  pixelCount: number;
  cropDataUrl?: string;
  sourceComponentIds: number[];
}

export interface RecognizedGroupItem {
  iconCandidate: Candidate;
  textCandidate?: Candidate;
  horizontalGap: number;
}

export interface RecognizedGroup {
  id: string;
  bbox: Rect;
  items: RecognizedGroupItem[];
  confidence: number;
  pattern: string;
  isActionGroup: boolean;
  reasons: string[];
}

export interface MatchCandidate {
  id: string;
  bbox: Rect;
  score: number;
  method: 'normxcorr' | 'grayscale' | 'edge' | 'masked';
  isBest: boolean;
}

export interface MatchRunReport {
  targetImageName: string;
  templateName: string;
  method: string;
  timeMs: number;
  threshold: number;
  matches: MatchCandidate[];
}

export interface PipelineExecutionResult {
  width: number;
  height: number;
  grayscaleCanvas: HTMLCanvasElement;
  edgeCanvas: HTMLCanvasElement;
  binaryCanvas: HTMLCanvasElement;
  componentsCanvas: HTMLCanvasElement;
  candidatesCanvas: HTMLCanvasElement;
  candidates: Candidate[];
  groups: RecognizedGroup[];
  processingTimeMs: number;
  thresholdUsed: number;
}

export interface EvaluationMetrics {
  detectionPrecision: number | 'NOT_MEASURED';
  detectionRecall: number | 'NOT_MEASURED';
  matchingPrecision: number | 'NOT_MEASURED';
  matchingRecall: number | 'NOT_MEASURED';
  groupAccuracy: number | 'NOT_MEASURED';
  avgProcessingTimeMs: number;
  status: string;
}

export interface LiveCapture {
  id: string;
  webContentsId: number;
  width: number;
  height: number;
  dataUrl: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; dpr: number; url: string };
  timestamp?: string;
}

export interface DomMetadata {
  selector: string;
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string;
  title: string | null;
  rect: Rect;
  clickable: null | { tag: string; role: string | null; ariaLabel: string; rect: Rect };
  context: 'post' | 'comment' | 'unknown';
  point: { x: number; y: number };
  scroll: { x: number; y: number };
  url: string;
}

export type LabCandidate = MatchCandidate & { dom?: DomMetadata | null; status?: string };
