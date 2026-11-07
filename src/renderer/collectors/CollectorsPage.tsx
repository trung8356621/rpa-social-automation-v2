import React, { useMemo, useState } from "react";
import { UiPopover } from "../ui-popover";
import { createEmptyDraft } from "../../shared/collectors/fixtures";
import type { AppPage, Command, State } from "../../shared/contracts";
import type { CollectorDraft } from "../../shared/collectors/types";
import { CollectorEditor } from "./CollectorEditor";
import { CollectorList } from "./CollectorList";
import { CollectorTestLab } from "./CollectorTestLab";
import { useCollectorStore } from "./useCollectorStore";
import type { CollectorInvoke } from "./browser-capture";

type Props = {
  page: "collectors" | "collector-test-lab";
  locked: boolean;
  navigate: (page: AppPage) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
};

export function CollectorsPage({
  page,
  locked,
  navigate,
  invoke,
  state,
  onSelectSession,
}: Props) {
  const store = useCollectorStore();
  const [editingId, setEditingId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [testFocusId, setTestFocusId] = useState<string>();
  const [form, setForm] = useState({ name: "", description: "" });
  const [formError, setFormError] = useState("");

  const editing = useMemo(
    () => store.collectors.find((c) => c.id === editingId),
    [store.collectors, editingId],
  );

  function openCreate() {
    setForm({ name: "", description: "" });
    setFormError("");
    setCreateOpen(true);
  }

  function submitCreate() {
    if (!form.name.trim()) {
      setFormError("Collector Name is required.");
      return;
    }
    const draft = createEmptyDraft({
      name: form.name,
      description: form.description,
    });
    store.saveCollector(draft);
    setCreateOpen(false);
    setEditingId(draft.id);
  }

  function openEditor(id: string) {
    setEditingId(id);
  }

  function openTest(id: string) {
    setTestFocusId(id);
    setEditingId(undefined);
    navigate("collector-test-lab");
  }

  if (editing) {
    return (
      <section className="app-page collectors-page collectors-editor-host" aria-label="Collector Editor">
        <CollectorEditor
          initial={editing}
          locked={locked}
          classifications={store.classifications}
          storageWarnings={store.parseWarnings}
          onAddClassification={store.addClassification}
          onSave={(draft) => {
            store.saveCollector(draft);
            setEditingId(draft.id);
          }}
          onClose={() => setEditingId(undefined)}
          invoke={invoke}
          state={state}
          onSelectSession={onSelectSession}
        />
      </section>
    );
  }

  return (
    <section className="app-page collectors-page" aria-label={page === "collectors" ? "Collectors" : "Collector Test Lab"}>
      <div className="scripts-top-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={page === "collectors"}
          className={`scripts-tab-btn${page === "collectors" ? " active" : ""}`}
          onClick={() => navigate("collectors")}
        >
          Collectors
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

      {store.parseWarnings?.length ? (
        <p className="collector-banner warn" role="status">
          Storage recovery warnings: {store.parseWarnings.join(" · ")} (raw payload retained)
        </p>
      ) : null}

      {page === "collectors" ? (
        <CollectorList
          collectors={store.collectors}
          locked={locked || !store.bootstrapped}
          onCreate={openCreate}
          onOpen={openEditor}
          onTest={openTest}
          onDuplicate={(draft: CollectorDraft) => {
            store.saveCollector(draft);
          }}
          onDelete={(id) => store.deleteCollector(id)}
        />
      ) : (
        <CollectorTestLab
          collectors={store.collectors}
          testCases={store.testCases}
          locked={locked || !store.bootstrapped}
          initialCollectorId={testFocusId}
          onSaveCollector={(draft) => store.saveCollector(draft)}
          onSaveTestCase={(testCase) => store.saveTestCase(testCase)}
        />
      )}

      {createOpen && (
        <UiPopover
          variant="modal"
          label="Create Collector"
          className="unsaved-confirm collector-create-modal"
          close={() => setCreateOpen(false)}
        >
          <div className="popover-heading">
            <b>Create Collector</b>
            <button onClick={() => setCreateOpen(false)}>×</button>
          </div>
          <div className="collector-create-form">
            <p className="hint collector-create-defer-hint">
              Strategy, platform, and classification are deferred — Capture → Teach → Discovery → Audit.
            </p>
            <label>
              Collector Name <span className="hint">(required)</span>
              <input
                autoFocus
                value={form.name}
                disabled={locked}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label>
              Description <span className="hint">(optional)</span>
              <textarea
                value={form.description}
                disabled={locked}
                rows={2}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </label>
            {formError && <p role="alert">{formError}</p>}
          </div>
          <div className="popover-footer">
            <button onClick={() => setCreateOpen(false)}>Hủy</button>
            <button className="primary" disabled={locked} onClick={submitCreate}>Create</button>
          </div>
        </UiPopover>
      )}
    </section>
  );
}
