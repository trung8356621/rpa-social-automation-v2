export type MatchMethod = "normxcorr" | "grayscale" | "edge" | "masked";
export type Rect = { x: number; y: number; width: number; height: number };
export type MatchCandidate = { id: string; bbox: Rect; score: number; method: MatchMethod; isBest: boolean; dom?: DomElement | null };
export type DomElement = { tag: string; role: string | null; ariaLabel: string; text: string; rect: Rect; clickable: null | { tag: string; role: string | null; ariaLabel: string; rect: Rect }; context: "post" | "comment" | "unknown" };
export type LiveCapture = { id: string; webContentsId: number; width: number; height: number; dataUrl: string; url: string; viewport: { width: number; height: number; scrollX: number; scrollY: number; dpr: number; url: string } };
