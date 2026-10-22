/**
 * Encode JSON to match PHP json_encode(..., JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES).
 * Key order is insertion order — callers must build objects in digest order.
 */

export function phpCompatibleJsonEncode(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "number" && !Number.isFinite(val)) return null;
    return val;
  });
}

export function clonePlain<T>(value: T): T {
  return value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}
