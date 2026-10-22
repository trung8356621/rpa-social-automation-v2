const FORBIDDEN_KEYS = new Set([
  "cookie",
  "cookies",
  "password",
  "passwords",
  "token",
  "secret",
  "authorization",
  "api_key",
  "bearer",
  "service_key",
  "credentials",
  "credential",
  "profile_path",
  "user_data_dir",
  "userDataDir",
  "account_switch",
  "switch_account",
  "change_account",
  "account_id",
]);

export function stripSecrets(
  input: unknown,
  path = "",
): { value: unknown; stripped: string[] } {
  const stripped: string[] = [];

  if (Array.isArray(input)) {
    const out: unknown[] = [];
    input.forEach((item, index) => {
      const nested = stripSecrets(item, `${path}[${index}]`);
      out.push(nested.value);
      stripped.push(...nested.stripped);
    });
    return { value: out, stripped };
  }

  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (
        FORBIDDEN_KEYS.has(String(key).toLowerCase()) ||
        FORBIDDEN_KEYS.has(String(key))
      ) {
        stripped.push(keyPath);
        continue;
      }
      const nested = stripSecrets(val, keyPath);
      out[key] = nested.value;
      stripped.push(...nested.stripped);
    }
    return { value: out, stripped };
  }

  return { value: input, stripped };
}
