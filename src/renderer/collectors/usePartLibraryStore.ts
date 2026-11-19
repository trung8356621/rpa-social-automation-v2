import { useCallback, useEffect, useState } from "react";
import type { CollectorPart, CollectorScriptDef, PartLibraryEnvelope } from "../../shared/collectors/part-library-types";
import type { VisualFeedAdoptionResult } from "../../shared/collectors/visual-feed-adoption";
import { getPartLibraryRepository } from "./active-part-session";

export function usePartLibraryStore() {
  const [envelope, setEnvelope] = useState<PartLibraryEnvelope>(() => getPartLibraryRepository().load());
  const [bootstrapped, setBootstrapped] = useState(false);
  const [adoption, setAdoption] = useState<VisualFeedAdoptionResult | null>(null);

  const reload = useCallback(() => {
    setEnvelope(getPartLibraryRepository().load());
  }, []);

  useEffect(() => {
    // Idempotent: reuse Part that already owns legacy fingerprint (e.g. imported "test"),
    // or create exactly one Part from legacy Feed Visual Counter data.
    const result = getPartLibraryRepository().adoptExistingVisualFeed();
    setAdoption(result);
    reload();
    setBootstrapped(true);
  }, [reload]);

  const savePart = useCallback(
    (part: CollectorPart) => {
      getPartLibraryRepository().upsertPart(part);
      reload();
    },
    [reload],
  );

  const saveScript = useCallback(
    (script: CollectorScriptDef) => {
      getPartLibraryRepository().upsertScript(script);
      reload();
    },
    [reload],
  );

  return {
    envelope,
    bootstrapped,
    adoption,
    adoptedPartId: envelope.visualFeedAdoption?.adoptedPartId,
    parts: envelope.parts.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    scripts: envelope.scripts.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    parseWarnings: envelope.parseWarnings,
    savePart,
    saveScript,
    reload,
    repository: getPartLibraryRepository(),
  };
}
