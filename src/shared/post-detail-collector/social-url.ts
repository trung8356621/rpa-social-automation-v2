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
