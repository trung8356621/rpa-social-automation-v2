import React, { useEffect, useState } from "react";
import type { State, Command, Variable } from "../shared/contracts";
import { UiPopover, usePopover } from "./ui-popover";
import { slugify } from "../shared/flow-model";
import { FileValidation, validateFileValues } from "./file-validation";
type Props = {
  state: State;
  update: (c: Command) => Promise<void>;
  locked: boolean;
  focusVariableId?: string;
  onFocusHandled?: () => void;
};
export function Variables({ state, update, locked, focusVariableId, onFocusHandled }: Props) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const f = state.flow;
  useEffect(() => {
    setOpen(false);
  }, [f?.id]);
  const [activeTab, setActiveTab] = useState<"values" | "placeholders">("values");
  const [vars, setVars] = useState<Variable[]>([]),
    [values, setValues] = useState<Record<string, string | string[] | number>>({}),
    [placeholders, setPlaceholders] = useState<Record<string, string | string[] | number>>({}),
    [fileCheckRevision, setFileCheckRevision] = useState(0);
  useEffect(() => {
    if (!f || !focusVariableId) return;
    setVars(structuredClone(f.variables ?? []));
    setValues(structuredClone(f.defaultPattern?.values ?? {}));
    setPlaceholders(structuredClone(f.placeholders ?? {}));
    setOpen(true);
    setTimeout(() => document.querySelector(`[data-variable-id="${focusVariableId}"]`)?.scrollIntoView({ block: "center" }), 0);
    onFocusHandled?.();
  }, [f?.id, focusVariableId]);
  return (
    <div className="variables">
      <button
        disabled={locked || !f}
        onClick={() => {
          if (!open) {
            setVars(structuredClone(f?.variables ?? []));
            setValues(structuredClone(f?.defaultPattern?.values ?? {}));
            setPlaceholders(structuredClone(f?.placeholders ?? {}));
          }
          setOpen(!open);
        }}
      >
        Variables ▾
      </button>
      {open && (
        <UiPopover
          anchor={document
            .querySelector(".variables > button")!
            .getBoundingClientRect()}
          variant="drawer"
          label="Variables"
          close={() => setOpen(false)}
          className="variables-drawer"
        >
          <div className="popover-heading">
            <b>Variables</b>
            <div className="variables-tab-bar" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "values"}
                className={`variable-tab-btn ${activeTab === "values" ? "active" : ""}`}
                onClick={() => setActiveTab("values")}
              >
                Values
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "placeholders"}
                className={`variable-tab-btn ${activeTab === "placeholders" ? "active" : ""}`}
                onClick={() => setActiveTab("placeholders")}
              >
                Placeholders
              </button>
            </div>
            <button
              className="icon-button"
              aria-label="Close Variables"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          {activeTab === "values" ? (
            <div className="variable-table">
              <div className="variable-columns">
                <b>Key</b>
                <b>Type</b>
                <b>Value</b>
                <span />
              </div>
              <div className="variable-table-body">
                {vars.map((v) => (
                  <div className="variable-row" data-variable-id={v.id} key={v.id}>
                    <input
                      aria-label="Variable key"
                      value={v.key}
                      onChange={(e) =>
                        setVars(
                          vars.map((x) =>
                            x.id === v.id ? { ...x, key: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <select
                      aria-label="Variable type"
                      value={v.type}
                      onChange={(e) => {
                        setVars(
                          vars.map((x) =>
                            x.id === v.id
                              ? { ...x, type: e.target.value as Variable["type"] }
                              : x,
                          ),
                        );
                        setValues({
                          ...values,
                          [v.id]: e.target.value === "files" ? [] : "",
                        });
                      }}
                    >
                      {["text", "file", "files", "integer", "number"].map((t) => (
                        <option key={t} value={t}>
                          {t[0].toUpperCase() + t.slice(1)}
                        </option>
                      ))}
                    </select>
                    <div className="variable-value">{v.type === "integer" || v.type === "number" ? <input
                      type="number" step={v.type === "integer" ? 1 : "any"}
                      aria-label={`Default value ${v.key}`}
                      value={typeof values[v.id] === "number" ? values[v.id] as number : ""}
                      onChange={e => setValues({ ...values, [v.id]: e.target.value === "" ? "" : Number(e.target.value) })}
                    /> : <textarea
                      aria-label={`Default value ${v.key}`}
                      value={
                        Array.isArray(values[v.id])
                          ? (values[v.id] as string[]).join("\n")
                          : (values[v.id] ?? "")
                      }
                      onChange={(e) =>
                        setValues({
                          ...values,
                          [v.id]:
                            v.type === "files"
                              ? e.target.value.split("\n").filter(Boolean)
                              : e.target.value,
                        })
                      }
                    />}
                    {(v.type === "file" || v.type === "files") && <FileValidation value={values[v.id]} disabled={locked}
                      refreshKey={fileCheckRevision}
                      onChange={picked => setValues({ ...values, [v.id]: v.type === "file" ? picked[0] ?? "" : picked })} />}
                    </div>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${v.key}`}
                      onClick={() => {
                        setVars(vars.filter((x) => x.id !== v.id));
                        const nextVal = { ...values };
                        delete nextVal[v.id];
                        setValues(nextVal);
                        const nextPl = { ...placeholders };
                        delete nextPl[v.id];
                        setPlaceholders(nextPl);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="variable-table variable-table-placeholders">
              <div className="variable-columns variable-columns-placeholders">
                <b>Key</b>
                <b>Placeholder</b>
              </div>
              <div className="variable-table-body">
                {vars.map((v) => (
                  <div className="variable-row variable-row-placeholder" data-variable-id={v.id} key={v.id}>
                    <input
                      aria-label="Variable key (read-only)"
                      value={v.key}
                      disabled
                      readOnly
                      title="Key được định nghĩa tại tab Values"
                    />
                    <div className="variable-value">
                      <textarea
                        aria-label={`Placeholder ${v.key}`}
                        value={
                          Array.isArray(placeholders[v.id])
                            ? (placeholders[v.id] as string[]).join("\n")
                            : (placeholders[v.id] !== undefined && placeholders[v.id] !== null ? String(placeholders[v.id]) : "")
                        }
                        onChange={(e) =>
                          setPlaceholders({
                            ...placeholders,
                            [v.id]: e.target.value,
                          })
                        }
                        placeholder="Giá trị placeholder cho Manual Test"
                      />
                    </div>
                  </div>
                ))}
                {!vars.length && (
                  <p className="page-empty" style={{ margin: "12px 0" }}>
                    Chưa có Variable. Thêm Variable mới tại tab Values.
                  </p>
                )}
              </div>
            </div>
          )}

          <p className="hint">
            {activeTab === "values"
              ? "Files: one local path per line. Values are used by Default Pattern. Integer: 1–10 cho QUICK_TAG."
              : "Placeholders chỉ phục vụ Manual Test và Test Lab. Không đưa vào payload publish Production."}
          </p>
          <div className="popover-footer">
            {activeTab === "values" && (
              <button
                type="button"
                onClick={() =>
                  setVars([
                    ...vars,
                    {
                      id: crypto.randomUUID(),
                      key: `variable_${vars.length + 1}`,
                      type: "text",
                    },
                  ])
                }
              >
                + Variable
              </button>
            )}
            <button
              disabled={locked}
              className="primary"
              onClick={() =>
                void (setFileCheckRevision(value => value + 1), validateFileValues(vars, values).then(checks => {
                  const invalid = checks.find(check => check.report.status === "INVALID");
                  if (invalid) throw new Error(`Variable ${invalid.variable.key}: ${invalid.report.invalidCount} file không hợp lệ.`);
                  return update({ type: "variables", variables: vars, values, placeholders });
                }))
                  .then(() => {
                    setError("");
                    setOpen(false);
                  })
                  .catch((e) => setError(String(e)))
              }
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <p role="alert">{error}</p>
        </UiPopover>
      )}
    </div>
  );
}
export function Groups({
  state,
  update,
  locked,
  newStep,
  playAll,
}: Props & { newStep: () => void; playAll: () => void }) {
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [customSlug, setCustomSlug] = useState(false),
    [error, setError] = useState("");
  const popup = usePopover(update),
    f = state.flow;
  return (
    <>
      <div className="step-heading">
        <b>Steps</b>
        <button
          className="play-all"
          aria-label="Play All"
          disabled={locked || !f?.steps.length}
          onClick={playAll}
        >
          ▶ Play All
        </button>
        <button
          disabled={locked || !f}
          onClick={(e) => {
            setName("");
            setSlug("");
            setCustomSlug(false);
            setError("");
            void popup.show(e.currentTarget);
          }}
        >
          + Group
        </button>
        <button aria-label="+ Step mới" disabled={locked} onClick={newStep}>
          + Step
        </button>
      </div>
      {popup.anchor && (
        <UiPopover
          anchor={popup.anchor}
          label="New group"
          close={() => void popup.close()}
          className="group-popover"
        >
          <div className="popover-heading">
            <b>New group</b>
            <button
              className="icon-button"
              aria-label="Close group form"
              onClick={() => void popup.close()}
            >
              ×
            </button>
          </div>
          <form
            className="group-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!f) return;
              void update({
                type: "organize",
                groups: [
                  ...(f.groups ?? []),
                  {
                    id: crypto.randomUUID(),
                    name,
                    slug: slugify(slug),
                    collapsed: false,
                    stepIds: [],
                  },
                ],
                stepIds: f.steps.map((s) => s.id),
              })
                .then(() => popup.close())
                .catch((e) => setError(String(e)));
            }}
          >
            <label>
              Name
              <input
                aria-label="New group name"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!customSlug) setSlug(slugify(e.target.value));
                }}
              />
            </label>
            <label>
              Slug
              <input
                aria-label="New group slug"
                required
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setCustomSlug(true);
                }}
              />
            </label>
            <div className="popover-footer">
              <button type="button" onClick={() => void popup.close()}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={locked || !name.trim()}
              >
                Create group
              </button>
            </div>
            <p role="alert">{error}</p>
          </form>
        </UiPopover>
      )}
    </>
  );
}
