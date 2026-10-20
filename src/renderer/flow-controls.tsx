import React, { useEffect, useState } from "react";
import type { State, Command, Variable } from "../shared/contracts";
import { UiPopover, usePopover } from "./ui-popover";
import { slugify } from "../shared/flow-model";
type Props = {
  state: State;
  update: (c: Command) => Promise<void>;
  locked: boolean;
};
export function Variables({ state, update, locked }: Props) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const f = state.flow;
  useEffect(() => {
    setOpen(false);
  }, [f?.id]);
  const [vars, setVars] = useState<Variable[]>([]),
    [values, setValues] = useState<Record<string, string | string[] | number>>({});
  return (
    <div className="variables">
      <button
        disabled={locked || !f}
        onClick={() => {
          if (!open) {
            setVars(structuredClone(f?.variables ?? []));
            setValues(structuredClone(f?.defaultPattern?.values ?? {}));
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
            <span>Default Pattern</span>
            <button
              className="icon-button"
              aria-label="Close Variables"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="variable-table">
            <div className="variable-columns">
              <b>Key</b>
              <b>Type</b>
              <b>Value</b>
              <span />
            </div>
            <div className="variable-table-body">
              {vars.map((v) => (
                <div className="variable-row" key={v.id}>
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
                    {["text", "file", "files", "integer"].map((t) => (
                      <option key={t} value={t}>
                        {t[0].toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                  {v.type === "integer" ? <input
                    type="number" step={1}
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
                  <button
                    className="icon-button"
                    aria-label={`Delete ${v.key}`}
                    onClick={() => {
                      setVars(vars.filter((x) => x.id !== v.id));
                      const next = { ...values };
                      delete next[v.id];
                      setValues(next);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
          <p className="hint">
            Files: one local path per line. Values are used only by Default
            Pattern.
            Integer: số nguyên; QUICK_TAG dùng 1–10, không vượt số hàng ROI.
          </p>
          <div className="popover-footer">
            <button
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
            <button
              disabled={locked}
              onClick={() =>
                void update({ type: "variables", variables: vars, values })
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
