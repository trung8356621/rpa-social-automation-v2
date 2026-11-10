import type { DomMetadata, LiveCapture } from './types';
type DomResponse = { webContentsId: number; element: DomMetadata | null };
declare global {
  interface Window {
    liveDomLab?: {
      state(): Promise<{ connected: boolean; webContentsId: number; url: string; loggedIn: boolean }>;
      capture(): Promise<LiveCapture>;
      inspect(request: { webContentsId: number; point: { x: number; y: number } }): Promise<DomResponse>;
      highlight(request: { webContentsId: number; point: { x: number; y: number } }): Promise<{ webContentsId: number; highlighted: boolean }>;
      inspectParent(request: { webContentsId: number; point: { x: number; y: number } }): Promise<DomResponse>;
      scroll(request: { webContentsId: number; deltaY: number }): Promise<{ webContentsId: number; scrolled: boolean }>;
    };
  }
}
export {};
