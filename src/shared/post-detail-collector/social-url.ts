/**
 * Post Detail navigation vs capture guards.
 * navigateToTarget: validate destination before BrowserCore.navigate (any current page OK).
 * captureFromSocialPage: require current BrowserCore URL already on a supported platform.
 */

export type SocialPlatform = "facebook" | "threads";

export function parseHttpUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("URL must be http:// or https://");
  }
  try {
    return new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
}

export function detectSocialPlatform(url: string): SocialPlatform | null {
  let host: string;
  try {
    host = parseHttpUrl(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
    return "facebook";
  }
  if (
    host === "threads.net" ||
    host.endsWith(".threads.net") ||
    host === "threads.com" ||
    host.endsWith(".threads.com")
  ) {
    return "threads";
  }
  return null;
}

export function isSupportedSocialUrl(url: string): boolean {
  return detectSocialPlatform(url) != null;
}

/** Guard for Open URL / navigateToTarget — current page may be about:blank or any site. */
export function assertNavigateToSocialTarget(rawUrl: string): { url: string; platform: SocialPlatform } {
  const parsed = parseHttpUrl(rawUrl);
  const platform = detectSocialPlatform(parsed.href);
  if (!platform) {
    throw new Error(
      `UNSUPPORTED_PLATFORM: Target must be Facebook or Threads (got ${parsed.hostname}).`,
    );
  }
  return { url: parsed.href, platform };
}

/**
 * Guard for Capture / OCR on the live page.
 * Keeps BROWSER_NOT_FACEBOOK semantics without blocking navigateToTarget.
 */
/** True when actual BrowserCore host matches the intended social platform. */
export function socialHostsCompatible(expectedUrl: string, actualUrl: string): boolean {
  let expectedHost = "";
  let actualHost = "";
  try {
    expectedHost = new URL(expectedUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  try {
    actualHost = new URL(actualUrl).hostname.toLowerCase();
  } catch {
    actualHost = (actualUrl || "").toLowerCase();
  }
  if (!actualHost) return false;
  if (actualHost === expectedHost) return true;
  const stripWww = (h: string) => h.replace(/^www\./, "");
  const e = stripWww(expectedHost);
  const a = stripWww(actualHost);
  if (a === e || a.endsWith(`.${e}`) || e.endsWith(`.${a}`)) return true;
  const expectedPlatform = detectSocialPlatform(expectedUrl);
  if (expectedPlatform === "facebook") {
    return actualHost.includes("facebook.com") || actualHost.includes("fb.com");
  }
  if (expectedPlatform === "threads") {
    return actualHost.includes("threads.net") || actualHost.includes("threads.com");
  }
  return false;
}

/**
 * After BrowserCore navigation: treat ERR_ABORTED / redirect as OK when final URL is still social.
 * Hard fail only when load truly failed and final page is not a supported social URL.
 */
export function resolvePostDetailNavigationOutcome(input: {
  requestedUrl: string;
  finalUrl: string;
  navOk: boolean;
  navStatus: string;
  navError?: string;
}): { ok: boolean; warning?: string; error?: string; browserUrl: string } {
  const browserUrl = (input.finalUrl || "").trim() || input.requestedUrl;
  const socialOk = socialHostsCompatible(input.requestedUrl, browserUrl);
  const aborted =
    Boolean(input.navError) &&
    (/ERR_ABORTED/i.test(input.navError!) || /\(-3\)|-3\b/.test(input.navError!));

  if (input.navOk && socialOk) {
    if (input.navStatus === "REDIRECTED") {
      return {
        ok: true,
        browserUrl,
        warning: `Điều hướng hoàn tất với redirect · Browser URL: ${browserUrl}`,
      };
    }
    return { ok: true, browserUrl };
  }

  if ((!input.navOk || aborted) && socialOk) {
    return {
      ok: true,
      browserUrl,
      warning: `Navigation aborted/redirect nhưng BrowserCore đang ở trang social: ${browserUrl}`,
    };
  }

  return {
    ok: false,
    browserUrl,
    error:
      input.navError ||
      `NAVIGATION_FAILED: expected social page near ${input.requestedUrl} but BrowserCore is at ${browserUrl || "(empty)"}`,
  };
}

export function assertCaptureFromSocialPage(currentUrl: string): { url: string; platform: SocialPlatform } {
  const trimmed = (currentUrl || "").trim();
  if (!trimmed || trimmed === "about:blank") {
    throw new Error(
      "BROWSER_NOT_FACEBOOK: Mở Facebook hoặc Threads trong BrowserCore của Creator V2 trước.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "BROWSER_NOT_FACEBOOK: Mở Facebook hoặc Threads trong BrowserCore của Creator V2 trước.",
    );
  }
  const platform = detectSocialPlatform(parsed.href);
  if (!platform) {
    throw new Error(
      "BROWSER_NOT_FACEBOOK: Mở Facebook hoặc Threads trong BrowserCore của Creator V2 trước.",
    );
  }
  return { url: parsed.href, platform };
}
