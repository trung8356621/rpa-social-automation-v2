/**
 * Collector ↔ Browser Core adapter.
 * Reuses existing navigate / capture / crop / browserVisible / targetImage IPC.
 * Does not create a second browser engine or session store.
 */
import type { Capture, Command, Rect } from "../../shared/contracts";
import type { SampleRoi } from "../../shared/collectors/types";
import { WEB_HEIGHT, WEB_WIDTH } from "../../shared/geometry";

declare global {
  interface Window {
    __RPA_WEB_DEV__?: boolean;
  }
}

export type CollectorInvoke = <T>(command: Command) => Promise<T>;

export function isElectronBrowserCoreAvailable(): boolean {
  return Boolean(window.creator) && window.__RPA_WEB_DEV__ !== true;
}

export const BROWSER_CORE_UNAVAILABLE =
  "Real Browser Core is unavailable in this preview. Use the Electron RPA Creator app to open a Browser Session, navigate, and capture. Web-dev does not embed authenticated webContents.";

export async function collectorNavigate(invoke: CollectorInvoke, url: string): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("URL must be http:// or https://");
  await invoke({ type: "navigate", url: trimmed });
  await invoke({ type: "browserVisible", visible: true });
}

export async function collectorSetBrowserVisible(
  invoke: CollectorInvoke,
  visible: boolean,
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "browserVisible", visible });
}

export async function collectorReportBrowserHost(
  invoke: CollectorInvoke,
  host: null | { x: number; y: number; width: number; height: number; active: boolean },
): Promise<void> {
  if (!isElectronBrowserCoreAvailable()) return;
  await invoke({ type: "collectorBrowserHost", host });
}

export async function collectorFreezeFrame(invoke: CollectorInvoke): Promise<Capture> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  const image = await invoke<Capture>({ type: "capture" });
  await invoke({ type: "browserVisible", visible: false });
  return image;
}

export async function collectorCropRoi(
  invoke: CollectorInvoke,
  captureId: string,
  roi: Rect,
): Promise<{ asset: string; roi: Rect; dataUrl: string }> {
  if (!isElectronBrowserCoreAvailable()) throw new Error(BROWSER_CORE_UNAVAILABLE);
  if (roi.width < 4 || roi.height < 4) throw new Error("ROI too small (min 4×4 DIP).");
  return invoke({ type: "crop", captureId, roi });
}

export async function collectorLoadImageAsset(
  invoke: CollectorInvoke,
  asset: string,
): Promise<string> {
  if (!isElectronBrowserCoreAvailable()) {
    throw new Error(BROWSER_CORE_UNAVAILABLE);
  }
  if (!/^[a-f0-9-]+\.png$/i.test(asset)) throw new Error("Invalid image asset id.");
  return invoke<string>({ type: "targetImage", asset });
}

export function roiToSampleRoi(
  roi: Rect,
  containerW: number = WEB_WIDTH,
  containerH: number = WEB_HEIGHT,
): SampleRoi {
  return {
    x: roi.x,
    y: roi.y,
    width: roi.width,
    height: roi.height,
    containerWidth: containerW,
    containerHeight: containerH,
  };
}
