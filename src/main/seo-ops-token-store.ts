import { safeStorage } from "electron";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Persist RPA Admin session token via Electron safeStorage (encrypted).
 * Never writes plaintext token or password to SQLite / Script packages.
 */
export function createSeoOpsTokenStore(userDataPath: string) {
  const filePath = path.join(userDataPath, "seo-ops-rpa-admin.token");
  let memory: string | null = null;

  return {
    getToken(): string | null {
      return memory;
    },
    setToken(token: string | null): void {
      memory = token;
      void persist(token);
    },
    async hydrate(): Promise<string | null> {
      try {
        const raw = await readFile(filePath);
        if (!safeStorage.isEncryptionAvailable()) {
          return null;
        }
        memory = safeStorage.decryptString(raw);
        return memory;
      } catch {
        memory = null;
        return null;
      }
    },
  };

  async function persist(token: string | null): Promise<void> {
    try {
      if (!token) {
        await unlink(filePath).catch(() => undefined);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        // Refuse plaintext disk persistence.
        return;
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      const buf = safeStorage.encryptString(token);
      await writeFile(filePath, buf);
    } catch {
      // Non-fatal — in-memory token still works for the session.
    }
  }
}
