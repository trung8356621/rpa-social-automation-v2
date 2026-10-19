import React from "react";
import type { State, Step, Command } from "../shared/contracts";
export function StepList({
  state,
  selected,
  locked,
  select,
  edit,
  update,
}: {
  state: State;
  selected?: Step;
  locked: boolean;
  select: (s: Step) => void;
  edit: (s: Step) => void;
  update: (c: Command) => Promise<void>;
}) {
  const f = state.flow;
  if (!f) return null;
  const groups = f.groups ?? [];
  const blocks: { group?: (typeof groups)[number]; refs: typeof f.steps }[] =
    [];
  for (const ref of f.steps) {
    const g = groups.find((g) => g.stepIds.includes(ref.id));
    if (g) {
      if (!blocks.some((b) => b.group?.id === g.id))
        blocks.push({
          group: g,
          refs: g.stepIds.map((id) => f.steps.find((s) => s.id === id)!),
        });
    } else blocks.push({ refs: [ref] });
  }
  const move = (s: Step, groupId: string) => {
    const gs = groups.map((g) => ({
        ...g,
        stepIds: g.stepIds.filter((id) => id !== s.id),
      })),
      dest = gs.find((g) => g.id === groupId);
    const order = f.steps.map((r) => r.id).filter((id) => id !== s.id);
    const after = dest?.stepIds.at(-1);
    if (dest) dest.stepIds.push(s.id);
    order.splice(after ? order.indexOf(after) + 1 : order.length, 0, s.id);
    void update({ type: "organize", groups: gs, stepIds: order });
  };
  const row = (ref: (typeof f.steps)[number]) => {
    const s = state.steps.find(
      (s) => s.id === ref.id && s.version === ref.version,
    )!;
    return (
      <div className="step-row" key={s.id}>
        <button
          className={selected?.id === s.id ? "step active" : "step"}
          disabled={locked}
          onClick={() => select(s)}
        >
          <span>{String(f.steps.indexOf(ref) + 1).padStart(2, "0")}</span>
          <b>{s.name}</b>
        </button>
        <button disabled={locked} onClick={() => edit(s)}>
          Edit
        </button>
        <select
          aria-label={`Group for ${s.name}`}
          disabled={locked}
          value={groups.find((g) => g.stepIds.includes(s.id))?.id ?? ""}
          onChange={(e) => move(s, e.target.value)}
        >
          <option value="">Standalone</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
    );
  };
  return (
    <div className="steps">
      {blocks.map((b) =>
        b.group ? (
          <fieldset key={b.group.id} className="step-group">
            <legend>
              <button
                disabled={locked}
                onClick={() =>
                  void update({
                    type: "organize",
                    groups: groups.map((g) =>
                      g.id === b.group!.id
                        ? { ...g, collapsed: !g.collapsed }
                        : g,
                    ),
                    stepIds: f.steps.map((s) => s.id),
                  })
                }
              >
                {b.group.collapsed ? "▸" : "▾"} {b.group.name}
              </button>
            </legend>
            {!b.group.collapsed && b.refs.map(row)}
          </fieldset>
        ) : (
          row(b.refs[0])
        ),
      )}
    </div>
  );
}
