/** Stable error code when a Script/Test Case has no configured start URL. */
export const START_URL_REQUIRED =
  "START_URL_REQUIRED: cấu hình Start URL cho Script (Creator) hoặc Test Case trước khi Run.";

export function parseHttpStartUrl(raw: string | undefined | null): URL | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Compare path+host ignoring trailing slash and hash; query must match. */
export function isSameStartPage(current: string | undefined, start: string): boolean {
  const a = parseHttpStartUrl(current);
  const b = parseHttpStartUrl(start);
  if (!a || !b) return false;
  const norm = (url: URL) => {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host}${path}?${url.searchParams.toString()}`;
  };
  return norm(a) === norm(b);
}
