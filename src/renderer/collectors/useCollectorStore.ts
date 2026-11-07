import { useCallback, useEffect, useState } from "react";
import {
  loadCollectorStore,
  saveCollectorStore,
  upsertCollector,
  removeCollector,
  type StorageLike,
} from "../../shared/collectors/store";
import type { CollectorDraft, CollectorStoreEnvelope, CollectorTestCase } from "../../shared/collectors/types";

function browserStorage(): StorageLike {
  return window.localStorage;
}

export function useCollectorStore() {
  const [envelope, setEnvelope] = useState<CollectorStoreEnvelope>(() => loadCollectorStore(browserStorage()));
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    setEnvelope(loadCollectorStore(browserStorage()));
    setBootstrapped(true);
  }, []);

  const persist = useCallback((next: CollectorStoreEnvelope) => {
    saveCollectorStore(browserStorage(), next);
    setEnvelope(loadCollectorStore(browserStorage()));
  }, []);

  const saveCollector = useCallback(
    (collector: CollectorDraft) => {
      persist(upsertCollector(envelope, { ...collector, dirty: false, updatedAt: new Date().toISOString() }));
    },
    [envelope, persist],
  );

  const deleteCollector = useCallback(
    (id: string) => {
      persist(removeCollector(envelope, id));
    },
    [envelope, persist],
  );

  const saveTestCase = useCallback(
    (testCase: CollectorTestCase) => {
      const others = envelope.testCases.filter((t) => t.id !== testCase.id);
      persist({ ...envelope, testCases: [...others, testCase] });
    },
    [envelope, persist],
  );

  const addClassification = useCallback(
    (label: string) => {
      const trimmed = label.trim();
      if (!trimmed || envelope.classifications.includes(trimmed)) return;
      persist({ ...envelope, classifications: [...envelope.classifications, trimmed] });
    },
    [envelope, persist],
  );

  return {
    envelope,
    bootstrapped,
    collectors: envelope.collectors,
    classifications: envelope.classifications,
    testCases: envelope.testCases,
    parseWarnings: envelope.parseWarnings,
    saveCollector,
    deleteCollector,
    saveTestCase,
    addClassification,
    reload: () => setEnvelope(loadCollectorStore(browserStorage())),
  };
}
