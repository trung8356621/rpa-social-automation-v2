import React, { useEffect, useState } from "react";
import type { State, Command, Variable, StepGroup } from "../shared/contracts";
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
    if (open)
      void update({ type: "browserVisible", visible: true })
        .then(() => setOpen(false))
        .catch((e) => setError(String(e)));
  }, [f?.id]);
  const [vars, setVars] = useState<Variable[]>([]),
    [values, setValues] = useState<Record<string, string | string[]>>({});
  return (
    <div className="variables">
      <button
        disabled={locked || !f}
        onClick={() => {
          if (!open) {
            setVars(structuredClone(f?.variables ?? []));
            setValues(structuredClone(f?.defaultPattern?.values ?? {}));
          }
          void update({ type: "browserVisible", visible: open })
            .then(() => setOpen(!open))
            .catch((e) => setError(String(e)));
        }}
      >
        Variables ▾
      </button>
      {open && (
        <div className="variables-popover">
          <b>Variables / Default Pattern</b>
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
                {["text", "file", "files"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <textarea
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
              />
              <button
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
          <p>
            Files: one local path per line. Values are used only by Default
            Pattern.
          </p>
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
                  void update({ type: "browserVisible", visible: true }).then(
                    () => setOpen(false),
                  );
                })
                .catch((e) => setError(String(e)))
            }
          >
            Save
          </button>
          <button
            onClick={() =>
              void update({ type: "browserVisible", visible: true }).then(() =>
                setOpen(false),
              )
            }
          >
            Close
          </button>
          <p role="alert">{error}</p>
        </div>
      )}
    </div>
  );
}
export function Groups({ state, update, locked }: Props) {
  const [name, setName] = useState(""),
    [error, setError] = useState("");
  const f = state.flow;
  if (!f) return null;
  const groups = f.groups ?? [],
    order = f.steps.map((s) => s.id);
  const save = (gs: StepGroup[], ids = order) =>
    void update({ type: "organize", groups: gs, stepIds: ids })
      .then(() => setError(""))
      .catch((e) => setError(String(e)));
  return (
    <section className="groups">
      <input
        aria-label="New group name"
        placeholder="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        disabled={locked || !name.trim()}
        onClick={() => {
          save([
            ...groups,
            {
              id: crypto.randomUUID(),
              name,
              slug: slugify(name),
              collapsed: false,
              stepIds: [],
            },
          ]);
          setName("");
        }}
      >
        + Group
      </button>
      {groups.map((g, i) => (
        <div key={g.id}>
          <input
            aria-label="Group name"
            defaultValue={g.name}
            key={g.id + g.name}
            onBlur={(e) => {
              if (e.target.value !== g.name)
                save(
                  groups.map((x) =>
                    x.id === g.id ? { ...x, name: e.target.value } : x,
                  ),
                );
            }}
          />
          <input
            aria-label="Group slug"
            defaultValue={g.slug}
            key={g.id + g.slug}
            onBlur={(e) => {
              if (e.target.value !== g.slug)
                save(
                  groups.map((x) =>
                    x.id === g.id ? { ...x, slug: slugify(e.target.value) } : x,
                  ),
                );
            }}
          />
          <button
            onClick={() =>
              save(
                groups.map((x) =>
                  x.id === g.id ? { ...x, collapsed: !x.collapsed } : x,
                ),
              )
            }
          >
            {g.collapsed ? "▸" : "▾"} {g.name} ({g.stepIds.length})
          </button>
          <button
            disabled={locked || i === 0}
            onClick={() => {
              const gs = [...groups];
              [gs[i - 1], gs[i]] = [gs[i], gs[i - 1]];
              const previous = groups[i - 1];
              const remaining = order.filter((id) => !g.stepIds.includes(id));
              const at = previous.stepIds.length
                ? remaining.indexOf(previous.stepIds[0])
                : remaining.length;
              remaining.splice(Math.max(0, at), 0, ...g.stepIds);
              save(gs, remaining);
            }}
          >
            ↑ Group
          </button>
        </div>
      ))}
      <p role="alert">{error}</p>
    </section>
  );
}
