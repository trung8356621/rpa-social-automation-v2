import React, { useMemo, useState } from "react";
import { UiPopover } from "../ui-popover";
import type { AppPage } from "../../shared/contracts";
import type {
  CollectorPart,
  CollectorScriptDef,
  CollectorScriptPartRef,
} from "../../shared/collectors/part-library-types";
import {
  addPartRef,
  removePartRefAt,
  resolveScriptPartRefs,
} from "../../shared/collectors/script-part-refs";
import { setActiveCollectorPartId } from "./active-part-session";
import { bindFeedCollectorToPart } from "../feed-item-collector/store";
import { bindPostDetailCollectorToPart } from "../post-detail-collector/store";
import { usePartLibraryStore } from "./usePartLibraryStore";
import "./part-library.css";

type Props = {
  locked: boolean;
  navigate: (page: AppPage) => void;
};

type CreatePartForm = {
  name: string;
  partType: "visual" | "network";
  editor: "feed-item-visual" | "post-detail";
};

type CreateScriptForm = {
  name: string;
  partRefs: CollectorScriptPartRef[];
  addPartId: string;
};

export function CollectorsHome({ locked, navigate }: Props) {
  const store = usePartLibraryStore();
  const [createPartOpen, setCreatePartOpen] = useState(false);
  const [createScriptOpen, setCreateScriptOpen] = useState(false);
  const [editScript, setEditScript] = useState<CollectorScriptDef | null>(null);
  const [networkDraft, setNetworkDraft] = useState<CollectorPart | null>(null);
  const [partForm, setPartForm] = useState<CreatePartForm>({
    name: "",
    partType: "visual",
    editor: "feed-item-visual",
  });
  const [scriptForm, setScriptForm] = useState<CreateScriptForm>({
    name: "",
    partRefs: [],
    addPartId: "",
  });
  const [editAddPartId, setEditAddPartId] = useState("");
  const [formError, setFormError] = useState("");

  const sortedParts = store.parts;
  const defaultPartId = store.adoptedPartId ?? sortedParts[0]?.partId ?? "";
  const adoptedPartId = store.adoptedPartId;

  const partNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of sortedParts) map.set(p.partId, p.name);
    return map;
  }, [sortedParts]);

  const partsLookup = useMemo(() => {
    const map = new Map<
      string,
      { name: string; partType: "visual" | "network"; version: number } | undefined
    >();
    for (const p of sortedParts) {
      map.set(p.partId, { name: p.name, partType: p.partType, version: p.version });
    }
    return map;
  }, [sortedParts]);

  function openCreatePart() {
    setPartForm({ name: "", partType: "visual", editor: "feed-item-visual" });
    setFormError("");
    setCreatePartOpen(true);
  }

  function openCreateScript() {
    setScriptForm({ name: "", partRefs: [], addPartId: defaultPartId });
    setFormError("");
    setCreateScriptOpen(true);
  }

  function appendPartToScriptForm() {
    const part = store.repository.getPart(scriptForm.addPartId);
    if (!part) {
      setFormError("Select an existing Part to add.");
      return;
    }
    const result = addPartRef(scriptForm.partRefs, {
      partId: part.partId,
      partVersion: part.version,
    });
    if (!result.added) {
      setFormError("That Part version is already in this Collector Script.");
      return;
    }
    setFormError("");
    setScriptForm((f) => ({ ...f, partRefs: result.refs }));
  }

  function appendPartToEditScript() {
    if (!editScript) return;
    const part = store.repository.getPart(editAddPartId);
    if (!part) {
      setFormError("Select an existing Part to add.");
      return;
    }
    const result = addPartRef(editScript.partRefs, {
      partId: part.partId,
      partVersion: part.version,
    });
    if (!result.added) {
      setFormError("That Part version is already in this Collector Script.");
      return;
    }
    setFormError("");
    setEditScript({ ...editScript, partRefs: result.refs });
  }

  function openPart(part: CollectorPart) {
    if (part.editor === "feed-item-visual") {
      bindFeedCollectorToPart(part.partId);
      navigate("feed-item-collector");
      return;
    }
    if (part.editor === "post-detail") {
      bindPostDetailCollectorToPart(part.partId);
      navigate("post-detail-collector");
      return;
    }
    setActiveCollectorPartId(part.partId);
    setNetworkDraft(part);
  }

  function submitCreatePart() {
    if (!partForm.name.trim()) {
      setFormError("Part name is required.");
      return;
    }
    const repo = store.repository;
    let part: CollectorPart;
    if (partForm.partType === "network") {
      part = repo.createNetworkDraftPart(partForm.name);
    } else if (partForm.editor === "post-detail") {
      part = repo.createVisualPostDetailPart(partForm.name);
    } else {
      part = repo.createVisualFeedItemPart(partForm.name);
    }
    store.reload();
    setCreatePartOpen(false);
    openPart(part);
  }

  function submitCreateScript() {
    if (!scriptForm.name.trim()) {
      setFormError("Collector Script name is required.");
      return;
    }
    if (!scriptForm.partRefs.length) {
      setFormError("Add at least one Part.");
      return;
    }
    const created = store.repository.createCollectorScript(
      scriptForm.name,
      scriptForm.partRefs.map((r) => ({ ...r })),
    );
    store.reload();
    setCreateScriptOpen(false);
    setEditAddPartId(defaultPartId);
    setEditScript(created);
  }

  function saveScriptEdit() {
    if (!editScript) return;
    if (!editScript.name.trim()) {
      setFormError("Collector Script name is required.");
      return;
    }
    if (!editScript.partRefs.length) {
      setFormError("Select at least one Part.");
      return;
    }
    store.saveScript({ ...editScript, name: editScript.name.trim() });
    setEditScript(null);
    setFormError("");
  }

  if (networkDraft) {
    return (
      <section className="collectors-home" aria-label="Network Part Draft">
        <div className="collectors-home-actions">
          <button type="button" onClick={() => setNetworkDraft(null)}>
            ← Back to Collectors Home
          </button>
        </div>
        <div className="network-part-draft">
          <h2>{networkDraft.name}</h2>
          <p className="hint">
            Network Part · v{networkDraft.version} · status: {networkDraft.status}
          </p>
          <div className="warn-banner" role="status">
            Not ready — Network capture and extraction are not implemented. This is a saved Draft
            definition only.
          </div>
          <p>
            {networkDraft.config.kind === "network_draft"
              ? networkDraft.config.note
              : "Draft placeholder."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="collectors-home" aria-label="Collectors Home">
      <div className="collectors-home-heading page-heading">
        <small>RPA Social Automation V2 · Collector Library</small>
        <h1>Collector Library</h1>
        <p>
          Primary source for reusable Visual Parts and Collector Scripts. Existing Feed Visual Counter
          data is adopted once into Part Library (content-matched; never duplicated on reload). Sidebar
          Feed Visual Counter / Post Detail Extractor remain temporary debug access. Network Parts are
          Draft placeholders only. Legacy Collector V1 is not shown here.
        </p>
      </div>

      {adoptedPartId && store.adoption ? (
        <p className="collector-banner" role="status">
          Adopted Visual Part:{" "}
          <b>{partNameById.get(adoptedPartId) ?? adoptedPartId}</b>
          {store.adoption.status === "reused_existing_owner"
            ? " (reused existing Part that already owned the data)"
            : store.adoption.status === "created_initial_part"
              ? " (created from legacy Feed Visual Counter snapshot)"
              : store.adoption.status === "already_adopted"
                ? " (already adopted — no duplicate)"
                : ""}
          . New Visual Parts start empty and isolated.
        </p>
      ) : null}

      {store.parseWarnings?.length ? (
        <p className="collector-banner warn" role="status">
          Part Library recovery: {store.parseWarnings.join(" · ")}
        </p>
      ) : null}

      <div className="collectors-home-actions">
        <button type="button" className="primary" disabled={locked || !store.bootstrapped} onClick={openCreatePart}>
          Create Part
        </button>
        <button type="button" disabled={locked || !store.bootstrapped} onClick={openCreateScript}>
          Create Collector Script
        </button>
      </div>

      <div className="collectors-home-grid">
        <div className="collectors-home-panel" aria-label="Part Library">
          <h2>Part Library</h2>
          <p className="panel-hint">Independently saved Parts (visual | network).</p>
          {sortedParts.length === 0 ? (
            <p className="collectors-home-empty">No Parts yet. Create a Visual Part to open the existing editor.</p>
          ) : (
            <table className="collectors-home-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Editor</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedParts.map((part) => (
                  <tr key={part.partId}>
                    <td>
                      {part.name}
                      {part.partId === adoptedPartId ? (
                        <span className="part-status-pill ready" title="Adopted Feed Visual Counter data">
                          {" "}
                          adopted
                        </span>
                      ) : null}
                      <div className="hint">v{part.version}</div>
                    </td>
                    <td>
                      <span className={`part-type-pill ${part.partType}`}>{part.partType}</span>
                    </td>
                    <td className="hint">
                      {part.editor === "feed-item-visual"
                        ? "Feed Visual Counter"
                        : part.editor === "post-detail"
                          ? "Post Detail Extractor"
                          : "None (draft)"}
                    </td>
                    <td>
                      <span className={`part-status-pill ${part.status}`}>{part.status}</span>
                    </td>
                    <td>
                      <div className="collectors-home-row-actions">
                        <button type="button" disabled={locked} onClick={() => openPart(part)}>
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="collectors-home-panel" aria-label="Collector Scripts">
          <h2>Collector Scripts</h2>
          <p className="panel-hint">Compositions that reference Part IDs and versions. No execution engine.</p>
          {store.scripts.length === 0 ? (
            <p className="collectors-home-empty">No Collector Scripts yet.</p>
          ) : (
            <table className="collectors-home-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Parts</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {store.scripts.map((script) => (
                  <tr key={script.scriptId}>
                    <td>
                      {script.name}
                      <div className="hint">v{script.version}</div>
                    </td>
                    <td className="hint">
                      {script.partRefs
                        .map((ref) =>
                          partNameById.has(ref.partId)
                            ? `${partNameById.get(ref.partId)}@v${ref.partVersion}`
                            : `missing:${ref.partId}@v${ref.partVersion}`,
                        )
                        .join(", ") || "—"}
                    </td>
                    <td>
                      <span className="part-status-pill draft">{script.status}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          setFormError("");
                          setEditAddPartId(defaultPartId);
                          setEditScript({ ...script, partRefs: script.partRefs.map((r) => ({ ...r })) });
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {createPartOpen && (
        <UiPopover
          variant="modal"
          label="Create Part"
          className="unsaved-confirm collector-create-modal"
          close={() => setCreatePartOpen(false)}
        >
          <div className="popover-heading">
            <b>Create Part</b>
            <button type="button" onClick={() => setCreatePartOpen(false)}>
              ×
            </button>
          </div>
          <div className="collector-create-form">
            <label>
              Part name <span className="hint">(required)</span>
              <input
                autoFocus
                value={partForm.name}
                disabled={locked}
                maxLength={120}
                onChange={(e) => setPartForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label>
              Part type
              <select
                value={partForm.partType}
                disabled={locked}
                onChange={(e) => {
                  const partType = e.target.value as "visual" | "network";
                  setPartForm((f) => ({
                    ...f,
                    partType,
                    editor: partType === "network" ? f.editor : f.editor,
                  }));
                }}
              >
                <option value="visual">Visual</option>
                <option value="network">Network</option>
              </select>
            </label>
            {partForm.partType === "visual" ? (
              <label>
                Compatible editor
                <select
                  value={partForm.editor}
                  disabled={locked}
                  onChange={(e) =>
                    setPartForm((f) => ({
                      ...f,
                      editor: e.target.value as "feed-item-visual" | "post-detail",
                    }))
                  }
                >
                  <option value="feed-item-visual">Feed Visual Counter (3 steps)</option>
                  <option value="post-detail">Post Detail Extractor (existing)</option>
                </select>
              </label>
            ) : (
              <p className="hint">
                Network Parts save as Draft only. Capture / extraction UI is not available.
              </p>
            )}
            {formError && <p role="alert">{formError}</p>}
          </div>
          <div className="popover-footer">
            <button type="button" onClick={() => setCreatePartOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={locked} onClick={submitCreatePart}>
              Create
            </button>
          </div>
        </UiPopover>
      )}

      {createScriptOpen && (
        <UiPopover
          variant="modal"
          label="Create Collector Script"
          className="unsaved-confirm collector-create-modal"
          close={() => setCreateScriptOpen(false)}
        >
          <div className="popover-heading">
            <b>Create Collector Script</b>
            <button type="button" onClick={() => setCreateScriptOpen(false)}>
              ×
            </button>
          </div>
          <div className="collector-create-form">
            <label>
              Name <span className="hint">(required)</span>
              <input
                autoFocus
                value={scriptForm.name}
                disabled={locked}
                maxLength={120}
                onChange={(e) => setScriptForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <ScriptPartCompositionEditor
              locked={locked}
              parts={sortedParts}
              partRefs={scriptForm.partRefs}
              addPartId={scriptForm.addPartId}
              partsLookup={partsLookup}
              onAddPartIdChange={(id) => setScriptForm((f) => ({ ...f, addPartId: id }))}
              onAdd={appendPartToScriptForm}
              onRemove={(index) =>
                setScriptForm((f) => ({ ...f, partRefs: removePartRefAt(f.partRefs, index) }))
              }
            />
            {formError && <p role="alert">{formError}</p>}
          </div>
          <div className="popover-footer">
            <button type="button" onClick={() => setCreateScriptOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={locked || sortedParts.length === 0}
              onClick={submitCreateScript}
            >
              Save
            </button>
          </div>
        </UiPopover>
      )}

      {editScript && (
        <UiPopover
          variant="modal"
          label="Collector Script"
          className="unsaved-confirm collector-create-modal"
          close={() => setEditScript(null)}
        >
          <div className="popover-heading">
            <b>Collector Script</b>
            <button type="button" onClick={() => setEditScript(null)}>
              ×
            </button>
          </div>
          <div className="collector-create-form">
            <label>
              Name
              <input
                value={editScript.name}
                disabled={locked}
                maxLength={120}
                onChange={(e) => setEditScript({ ...editScript, name: e.target.value })}
              />
            </label>
            <ScriptPartCompositionEditor
              locked={locked}
              parts={sortedParts}
              partRefs={editScript.partRefs}
              addPartId={editAddPartId}
              partsLookup={partsLookup}
              onAddPartIdChange={setEditAddPartId}
              onAdd={appendPartToEditScript}
              onRemove={(index) =>
                setEditScript({
                  ...editScript,
                  partRefs: removePartRefAt(editScript.partRefs, index),
                })
              }
            />
            {formError && <p role="alert">{formError}</p>}
          </div>
          <div className="popover-footer">
            <button type="button" onClick={() => setEditScript(null)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={locked} onClick={saveScriptEdit}>
              Save
            </button>
          </div>
        </UiPopover>
      )}
    </section>
  );
}

function ScriptPartCompositionEditor({
  locked,
  parts,
  partRefs,
  addPartId,
  partsLookup,
  onAddPartIdChange,
  onAdd,
  onRemove,
}: {
  locked: boolean;
  parts: CollectorPart[];
  partRefs: CollectorScriptPartRef[];
  addPartId: string;
  partsLookup: Map<
    string,
    { name: string; partType: "visual" | "network"; version: number } | undefined
  >;
  onAddPartIdChange: (partId: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const resolved = resolveScriptPartRefs(partRefs, partsLookup);
  return (
    <div className="script-part-composition" aria-label="Selected Parts">
      <div className="script-part-composition-heading">Selected Parts</div>
      {resolved.length === 0 ? (
        <p className="collectors-home-empty">No Parts selected yet.</p>
      ) : (
        <ul className="script-part-ref-list">
          {resolved.map((ref, index) => (
            <li
              key={`${ref.partId}@${ref.partVersion}@${index}`}
              className={ref.resolved ? undefined : "missing"}
            >
              <div className="script-part-ref-meta">
                {ref.resolved ? (
                  <>
                    <b>{ref.name}</b>
                    <span className={`part-type-pill ${ref.partType}`}>{ref.partType}</span>
                    <span className="hint">v{ref.partVersion}</span>
                  </>
                ) : (
                  <>
                    <b>Missing Part</b>
                    <span className="hint" role="status">
                      unresolved · {ref.partId}@v{ref.partVersion}
                    </span>
                  </>
                )}
              </div>
              <button type="button" disabled={locked} onClick={() => onRemove(index)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="script-part-add-row">
        <select
          aria-label="Part to add"
          value={addPartId}
          disabled={locked || parts.length === 0}
          onChange={(e) => onAddPartIdChange(e.target.value)}
        >
          {parts.length === 0 ? (
            <option value="">No Parts available</option>
          ) : (
            parts.map((p) => (
              <option key={p.partId} value={p.partId}>
                {p.name} ({p.partType}) v{p.version}
              </option>
            ))
          )}
        </select>
        <button type="button" disabled={locked || parts.length === 0} onClick={onAdd}>
          Add Part
        </button>
      </div>
      <p className="hint">
        Composition only — display order is not execution order. Multiple Parts of the same type are
        allowed.
      </p>
    </div>
  );
}
