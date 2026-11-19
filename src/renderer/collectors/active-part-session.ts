/**
 * Ephemeral which-Part-is-open pointer for Collector editors.
 * Not Part configuration — config lives in PartLibraryRepository.
 */
import { ACTIVE_COLLECTOR_PART_SESSION_KEY } from "../../shared/collectors/part-library-types";
import {
  PartLibraryRepository,
  createBrowserPartLibraryRepository,
} from "../../shared/collectors/part-library-repository";
import type { CollectorPart } from "../../shared/collectors/part-library-types";

let injectedRepo: PartLibraryRepository | null = null;

export function setPartLibraryRepositoryForTests(repo: PartLibraryRepository | null): void {
  injectedRepo = repo;
}

export function getPartLibraryRepository(): PartLibraryRepository {
  return injectedRepo ?? createBrowserPartLibraryRepository();
}

function sessionStore(): Storage | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

export function getActiveCollectorPartId(): string | null {
  try {
    return sessionStore()?.getItem(ACTIVE_COLLECTOR_PART_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setActiveCollectorPartId(partId: string | null): void {
  try {
    const store = sessionStore();
    if (!store) return;
    if (!partId) store.removeItem(ACTIVE_COLLECTOR_PART_SESSION_KEY);
    else store.setItem(ACTIVE_COLLECTOR_PART_SESSION_KEY, partId);
  } catch {
    /* ignore */
  }
}

export function getActiveCollectorPart(): CollectorPart | undefined {
  const id = getActiveCollectorPartId();
  if (!id) return undefined;
  return getPartLibraryRepository().getPart(id);
}

export function clearActiveCollectorPart(): void {
  setActiveCollectorPartId(null);
}
