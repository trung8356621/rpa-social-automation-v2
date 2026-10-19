import React, { useState } from "react";
import { UiPopover, usePopover } from "./ui-popover";
import { slugify } from "../shared/flow-model";
import type { State, Step, Command } from "../shared/contracts";
const EditIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" />
  </svg>
);
const MoreIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
const FolderIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M3 7V5h6l2 2h10v12H3Z" />
  </svg>
);
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
  const popup = usePopover(update);
  const [menu, setMenu] = useState<{
    step?: Step;
    groupId?: string;
    editing?: boolean;
  }>({});
  const [groupName, setGroupName] = useState(""),
    [groupSlug, setGroupSlug] = useState("");
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
  for (const g of groups.filter((g) => !g.stepIds.length))
    blocks.push({ group: g, refs: [] });
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
      <div
        className={`step-row${selected?.id === s.id ? " selected" : ""}`}
        key={s.id}
      >
        <button
          className={selected?.id === s.id ? "step active" : "step"}
          disabled={locked}
          onClick={() => select(s)}
          title={s.name}
        >
          <span className="step-number">
            {String(f.steps.indexOf(ref) + 1).padStart(2, "0")}
          </span>
          <b>{s.name}</b>
        </button>
        <button
          className="icon-button"
          aria-label={`Edit ${s.name}`}
          title="Edit"
          disabled={locked}
          onClick={() => edit(s)}
        >
          <EditIcon />
        </button>
        <button
          className="icon-button"
          aria-label={`Menu ${s.name}`}
          title="Step actions"
          aria-haspopup="dialog"
          disabled={locked}
          onClick={(e) => {
            setMenu({ step: s });
            void popup.show(e.currentTarget);
          }}
        >
          <MoreIcon />
        </button>
      </div>
    );
  };
  return (
    <div className="steps">
      {blocks.map((b) =>
        b.group ? (
          <section key={b.group.id} className="step-group">
            <div className="folder-row">
              <button
                className="folder-toggle"
                disabled={locked}
                aria-expanded={!b.group.collapsed}
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
                <span>{b.group.collapsed ? "▸" : "▾"}</span>
                <FolderIcon />
                <b>{b.group.name}</b>
                <small>{b.refs.length}</small>
              </button>
              <button
                className="icon-button"
                aria-label={`Group menu ${b.group.name}`}
                disabled={locked}
                onClick={(e) => {
                  setMenu({ groupId: b.group!.id });
                  setGroupName(b.group!.name);
                  setGroupSlug(b.group!.slug);
                  void popup.show(e.currentTarget);
                }}
              >
                <MoreIcon />
              </button>
            </div>
            {!b.group.collapsed && (
              <div className="group-steps">
                {b.refs.map(row)}
                {!b.refs.length && (
                  <p className="hint empty-group">Empty group</p>
                )}
              </div>
            )}
          </section>
        ) : (
          row(b.refs[0])
        ),
      )}
      {popup.anchor && (
        <UiPopover
          anchor={popup.anchor}
          label={menu.step ? "Step actions" : "Group actions"}
          close={() => void popup.close()}
          className="actions-popover"
        >
          <div className="popover-heading">
            <b>
              {menu.step?.name ??
                groups.find((g) => g.id === menu.groupId)?.name}
            </b>
            <button
              className="icon-button"
              aria-label="Close menu"
              onClick={() => void popup.close()}
            >
              ×
            </button>
          </div>
          {menu.step ? (
            <>
              <p className="menu-label">Move to</p>
              {[{ id: "", name: "Standalone" }, ...groups].map((g) => (
                <button
                  className="menu-item"
                  key={g.id}
                  disabled={
                    locked ||
                    (groups.find((x) => x.stepIds.includes(menu.step!.id))
                      ?.id ?? "") === g.id
                  }
                  onClick={() => {
                    move(menu.step!, g.id);
                    void popup.close();
                  }}
                >
                  {g.id ? "▱ " : ""}
                  {g.name}
                </button>
              ))}
            </>
          ) : (
            <>
              {menu.editing ? (
                <form
                  className="group-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void update({
                      type: "organize",
                      groups: groups.map((g) =>
                        g.id === menu.groupId
                          ? { ...g, name: groupName, slug: slugify(groupSlug) }
                          : g,
                      ),
                      stepIds: f.steps.map((s) => s.id),
                    }).then(() => popup.close());
                  }}
                >
                  <label>
                    Name
                    <input
                      aria-label="Group name"
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                    />
                  </label>
                  <label>
                    Slug
                    <input
                      aria-label="Group slug"
                      value={groupSlug}
                      onChange={(e) => setGroupSlug(e.target.value)}
                    />
                  </label>
                  <button type="submit" className="primary">
                    Save group
                  </button>
                </form>
              ) : (
                <button
                  className="menu-item"
                  onClick={() => setMenu({ ...menu, editing: true })}
                >
                  ✎ Edit name / slug
                </button>
              )}
              <button
                className="menu-item"
                disabled={
                  locked || groups.findIndex((g) => g.id === menu.groupId) === 0
                }
                onClick={() => {
                  const i = groups.findIndex((g) => g.id === menu.groupId),
                    g = groups[i],
                    gs = [...groups];
                  [gs[i - 1], gs[i]] = [gs[i], gs[i - 1]];
                  const previous = groups[i - 1],
                    remaining = f.steps
                      .map((s) => s.id)
                      .filter((id) => !g.stepIds.includes(id)),
                    at = previous.stepIds.length
                      ? remaining.indexOf(previous.stepIds[0])
                      : remaining.length;
                  remaining.splice(Math.max(0, at), 0, ...g.stepIds);
                  void update({
                    type: "organize",
                    groups: gs,
                    stepIds: remaining,
                  }).then(() => popup.close());
                }}
              >
                ↑ Move group up
              </button>
            </>
          )}
        </UiPopover>
      )}
    </div>
  );
}
