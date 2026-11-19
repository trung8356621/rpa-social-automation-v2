import {
  CdpDebuggerSession,
  type CdpLease,
} from "./cdp-debugger-session.js";

/**
 * CDP screenshot attempt with lease-safe cleanup (C2B.2).
 * Never calls debugger.detach() — safe while Recording/FileChooser/typeOnly remain unmanaged.
 * Used by BrowserCore.captureExclusive; kept Electron-free for mocked unit tests.
 */
export async function captureScreenshotBufferViaCdp(input: {
  cdp: CdpDebuggerSession;
  /** Non-CDP fallback used when CDP screenshot fails (Electron capturePage). */
  capturePagePng: () => Promise<Buffer>;
  timeoutMs?: number;
}): Promise<Buffer> {
  const timeoutMs = input.timeoutMs ?? 4000;
  let lease: CdpLease | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    lease = await input.cdp.acquire("screenshot");
    await input.cdp.sendCommand(lease, "Page.enable").catch(() => undefined);
    const frame = (await Promise.race([
      input.cdp.sendCommand(lease, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Screenshot timeout: không có frame sau 4 giây.")),
          timeoutMs,
        );
      }),
    ])) as { data?: string };
    const data = typeof frame?.data === "string" ? frame.data : "";
    const raw = Buffer.from(data, "base64");
    if (!raw.length) throw new Error("Browser trả về ảnh rỗng.");
    return raw;
  } catch (cdpError) {
    // Critical: do not debugger.detach() here — peer CDP tenants may rely on attach.
    try {
      const raw = await input.capturePagePng();
      if (!raw.length) throw new Error("Browser trả về ảnh rỗng.");
      return raw;
    } catch {
      throw cdpError;
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (lease) await lease.release().catch(() => undefined);
  }
}
