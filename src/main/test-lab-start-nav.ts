import { isSameStartPage } from "../shared/start-url.js";

/** Minimal WebContents surface used by Test Lab Start URL ensure. */
export type TestLabNavWebContents = {
  getURL: () => string;
  isLoading: () => boolean;
  isDestroyed?: () => boolean;
  stop: () => void;
  // Electron WebContents uses overloaded event names; keep this loose for mocks + Electron.
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
};

export type TestLabNavEvent = {
  type:
    | "skip-already-ready"
    | "wait-in-flight"
    | "navigate-start"
    | "did-fail-load"
    | "did-navigate"
    | "dom-ready"
    | "did-finish-load"
    | "abort-ignored"
    | "timeout"
    | "ready";
  url?: string;
  errorCode?: number;
  errorDescription?: string;
  httpResponseCode?: number;
};

export type EnsureTestLabStartUrlResult = {
  skipped: boolean;
  finalUrl: string;
  events: TestLabNavEvent[];
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 500;

export function isNavigationAbortError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /ERR_ABORTED|\(-3\)|error\s*-?3\b/i.test(msg);
}

function assertFinalStartUrl(finalUrl: string, startHref: string, ready: boolean, loading: boolean) {
  if (!isSameStartPage(finalUrl, startHref)) {
    throw new Error(
      `Start URL chưa tới đích sau điều hướng (abort/redirect). Kỳ vọng ${startHref}; hiện tại ${finalUrl || "(trống)"}. Case chưa gửi thao tác.`,
    );
  }
  if (loading && !ready) {
    throw new Error("Start URL chưa sẵn sàng (main frame vẫn đang tải); Case chưa gửi thao tác.");
  }
}

/**
 * Ensure Browser is on Start URL and main-frame ready before Test Lab Step 1.
 * - Skip reload when already on the same page and not loading.
 * - Treat ERR_ABORTED (-3) as cancellation/redirect noise: verify final URL + readiness.
 * - Real network/HTTP failures still ERROR.
 */
export async function ensureTestLabStartUrl(options: {
  wc: TestLabNavWebContents;
  startHref: string;
  navigate: (url: string) => Promise<void>;
  timeoutMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<EnsureTestLabStartUrlResult> {
  const {
    wc,
    startHref,
    navigate,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    settleMs = DEFAULT_SETTLE_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const events: TestLabNavEvent[] = [];

  if (wc.isDestroyed?.()) {
    throw new Error("Start URL: Browser WebContents đã bị hủy trước khi điều hướng.");
  }

  const currentUrl = wc.getURL() ?? "";
  if (isSameStartPage(currentUrl, startHref) && !wc.isLoading()) {
    events.push({ type: "skip-already-ready", url: currentUrl });
    events.push({ type: "ready", url: currentUrl });
    return { skipped: true, finalUrl: currentUrl, events };
  }

  let hardFail: string | undefined;
  let mainFrameReady = false;
  let mainFrameNavigated = false;

  const onFailLoad = (
    _e: unknown,
    errorCode: unknown,
    errorDescription: unknown,
    validatedURL: unknown,
    isMainFrame: unknown,
  ) => {
    if (!isMainFrame) return;
    const code = Number(errorCode);
    const desc = String(errorDescription ?? "");
    const url = String(validatedURL ?? startHref);
    events.push({ type: "did-fail-load", url, errorCode: code, errorDescription: desc });
    // ERR_ABORTED (-3): SPA/redirect cancellation — not success or failure by itself.
    if (code === -3) {
      events.push({ type: "abort-ignored", url, errorCode: code });
      return;
    }
    hardFail = `Start URL tải thất bại (${code} ${desc || "unknown"}) tại ${url}`;
  };

  const onNavigate = (_e: unknown, url: unknown, httpResponseCode: unknown) => {
    mainFrameNavigated = true;
    const href = String(url ?? "");
    const status = Number(httpResponseCode);
    events.push({
      type: "did-navigate",
      url: href,
      httpResponseCode: Number.isFinite(status) ? status : undefined,
    });
    if (Number.isFinite(status) && status >= 400) {
      hardFail = hardFail ?? `Start URL trả HTTP ${status} tại ${href || startHref}`;
    }
  };

  const onDomReady = () => {
    mainFrameReady = true;
    events.push({ type: "dom-ready", url: wc.getURL() });
  };

  const onFinishLoad = () => {
    mainFrameReady = true;
    events.push({ type: "did-finish-load", url: wc.getURL() });
  };

  wc.on("did-fail-load", onFailLoad);
  wc.on("did-navigate", onNavigate);
  wc.on("dom-ready", onDomReady);
  wc.on("did-finish-load", onFinishLoad);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const alreadySame = isSameStartPage(currentUrl, startHref);
  if (alreadySame) events.push({ type: "wait-in-flight", url: currentUrl });
  else events.push({ type: "navigate-start", url: startHref });

  try {
    const work = alreadySame
      ? Promise.resolve()
      : navigate(startHref).catch((error: unknown) => {
          if (hardFail) throw new Error(hardFail);
          if (isNavigationAbortError(error)) {
            events.push({
              type: "abort-ignored",
              url: wc.getURL(),
              errorDescription: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          throw error;
        });

    await Promise.race([
      (async () => {
        await work;
        // After loadURL settles (or abort ignored), wait until not loading or ready signal.
        const deadline = Date.now() + Math.min(timeoutMs, 5_000);
        while (Date.now() < deadline) {
          if (hardFail) throw new Error(hardFail);
          if (!wc.isLoading() || mainFrameReady || mainFrameNavigated) break;
          await sleep(25);
        }
      })(),
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          events.push({ type: "timeout", url: wc.getURL() });
          if (hardFail) {
            reject(new Error(hardFail));
          } else if (
            mainFrameNavigated ||
            mainFrameReady ||
            (isSameStartPage(wc.getURL(), startHref) && !wc.isLoading())
          ) {
            resolve();
          } else {
            wc.stop();
            reject(new Error("Start URL chưa tải xong sau 30 giây; Case chưa gửi thao tác."));
          }
        }, timeoutMs);
      }),
    ]);

    if (settleMs > 0) await sleep(settleMs);
    if (hardFail) throw new Error(hardFail);

    const finalUrl = wc.getURL() ?? "";
    assertFinalStartUrl(
      finalUrl,
      startHref,
      mainFrameReady || mainFrameNavigated || !wc.isLoading(),
      wc.isLoading(),
    );
    events.push({ type: "ready", url: finalUrl });
    return { skipped: false, finalUrl, events };
  } finally {
    if (timer) clearTimeout(timer);
    wc.removeListener("did-fail-load", onFailLoad);
    wc.removeListener("did-navigate", onNavigate);
    wc.removeListener("dom-ready", onDomReady);
    wc.removeListener("did-finish-load", onFinishLoad);
  }
}
