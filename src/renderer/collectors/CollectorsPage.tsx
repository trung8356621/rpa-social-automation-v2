import React from "react";
import type { AppPage, State } from "../../shared/contracts";
import type { CollectorEditorHandle } from "./CollectorEditor";
import { CollectorTestLab } from "./CollectorTestLab";
import { CollectorsHome } from "./CollectorsHome";
import { useCollectorStore } from "./useCollectorStore";
import type { CollectorInvoke } from "./browser-capture";

type Props = {
  page: "collectors" | "collector-test-lab";
  locked: boolean;
  navigate: (page: AppPage) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
  reportEditor?: (handle: CollectorEditorHandle | undefined) => void;
};

/**
 * Collectors → Collector Library (Parts / Scripts).
 * Legacy Collector V1 (five-stage CollectorEditor) is not surfaced in normal UI.
 * Source + drafts remain preserved for explicit recovery later.
 */
export function CollectorsPage({
  page,
  locked,
  navigate,
  reportEditor,
}: Props) {
  const store = useCollectorStore();

  React.useEffect(() => {
    reportEditor?.(undefined);
  }, [reportEditor]);

  return (
    <section
      className="app-page collectors-page"
      aria-label={page === "collectors" ? "Collector Library" : "Collector Test Lab"}
    >
      <div className="scripts-top-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={page === "collectors"}
          className={`scripts-tab-btn${page === "collectors" ? " active" : ""}`}
          onClick={() => navigate("collectors")}
        >
          Collector Library
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={page === "collector-test-lab"}
          className={`scripts-tab-btn${page === "collector-test-lab" ? " active" : ""}`}
          onClick={() => navigate("collector-test-lab")}
        >
          Test Lab
        </button>
      </div>

      {page === "collectors" ? (
        <CollectorsHome locked={locked || !store.bootstrapped} navigate={navigate} />
      ) : (
        <CollectorTestLab
          collectors={store.collectors}
          testCases={store.testCases}
          locked={locked || !store.bootstrapped}
          onSaveCollector={(draft) => store.saveCollector(draft)}
          onSaveTestCase={(testCase) => store.saveTestCase(testCase)}
        />
      )}
    </section>
  );
}
