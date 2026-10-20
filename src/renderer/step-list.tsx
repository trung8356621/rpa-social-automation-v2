import { effectiveMatchTo, matchToLabel } from "../shared/match-to";
import type { StepPlayback } from "./playback";
import React, { useEffect, useRef, useState } from "react";
import { UiPopover, usePopover } from "./ui-popover";
import { slugify } from "../shared/flow-model";
import { defaultNetworkSettings, NETWORK_LABELS } from "../shared/network-mode";
import type { State, Step, Command, StepGroup } from "../shared/contracts";
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
type SortItem = { id: string; scope: string };
type DropPosition = SortItem & { after: boolean };
export function StepList({
  state,
  selected,
  locked,
  select,
  edit,
  update,
  play,
  playback,
  activeStepId,
  blockedSteps,
  toggleBlocked,
}: {
  play: (step: Step) => void;
  playback: Record<string, StepPlayback>;
  activeStepId: string;
  blockedSteps: ReadonlySet<string>;
  toggleBlocked: (stepId: string) => void;
  state: State;
  selected?: Step;
  locked: boolean;
  select: (s: Step) => void;
  edit: (s: Step) => void;
  update: (c: Command) => Promise<void>;
}) {
  const [revealedGroup, setRevealedGroup] = useState("");
  const [dragging, setDragging] = useState<SortItem>();
  const dragRef = useRef<SortItem | undefined>(undefined);
  const [dropPosition, setDropPosition] = useState<DropPosition>();
  const [savingOrder, setSavingOrder] = useState(false);
  const orderLock = useRef(false);
  const clearDrag = () => {
    dragRef.current = undefined;
    setDragging(undefined);
    setDropPosition(undefined);
  };
  useEffect(() => {
    clearDrag();
  }, [state.flow, locked]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") clearDrag(); };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", clearDrag);
    };
  }, []);
  useEffect(() => {
    setRevealedGroup("");
  }, [state.flow?.id]);
  useEffect(() => {
    if (playback[activeStepId]?.status === "running")
      setRevealedGroup(
        state.flow?.groups?.find((g) => g.stepIds.includes(activeStepId))?.id ??
          "",
      );
  }, [activeStepId, playback[activeStepId]?.status]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = list.current,
      row = container?.querySelector<HTMLElement>(
        `[data-step-id="${CSS.escape(activeStepId)}"]`,
      );
    if (!container || !row) return;
    const r = row.getBoundingClientRect(),
      bounds = container.getBoundingClientRect();
    if (r.top < bounds.top + 4) container.scrollTop += r.top - bounds.top - 4;
    else if (r.bottom > bounds.bottom - 4)
      container.scrollTop += r.bottom - bounds.bottom + 4;
  }, [activeStepId, playback[activeStepId]?.status, revealedGroup]);
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
  const expanded = (g: StepGroup) =>
    !g.collapsed ||
    revealedGroup === g.id ||
    (g.stepIds.includes(activeStepId) &&
      playback[activeStepId]?.status === "running");
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
  // Existing flows without position metadata keep their original empty-at-end layout.
  for (const g of groups.filter(g => !g.stepIds.length && g.emptyPosition !== undefined)
    .sort((a, b) => a.emptyPosition! - b.emptyPosition!)) {
    const index = blocks.findIndex(b => b.group?.id === g.id);
    const [block] = blocks.splice(index, 1);
    blocks.splice(Math.min(g.emptyPosition!, blocks.length), 0, block);
  }
  const rootScope = "root";
  const blockId = (b: typeof blocks[number]) => b.group ? `group:${b.group.id}` : `step:${b.refs[0].id}`;
  const itemForStep = (id: string): SortItem => {
    const group = groups.find(g => g.stepIds.includes(id));
    return { id: group ? id : `step:${id}`, scope: group ? `children:${group.id}` : rootScope };
  };
  const siblings = (item: SortItem) => item.scope === rootScope
    ? blocks.map(blockId)
    : groups.find(g => `children:${g.id}` === item.scope)?.stepIds ?? [];
  const saveOrder = async (item: SortItem, targetId: string, after: boolean) => {
    if (locked || orderLock.current || item.id === targetId) return;
    const original = siblings(item);
    if (!original.includes(item.id) || !original.includes(targetId)) return;
    const order = original.filter(id => id !== item.id);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, item.id);
    if (order.every((id, i) => id === original[i])) return;
    let gs = groups;
    let stepIds: string[];
    if (item.scope === rootScope) {
      const sorted = order.map(id => blocks.find(b => blockId(b) === id)!);
      stepIds = sorted.flatMap(b => b.refs.map(ref => ref.id));
      gs = sorted.filter(b => b.group).map((b) => ({ ...b.group!,
        emptyPosition: b.refs.length ? undefined : sorted.indexOf(b) }));
    } else {
      gs = groups.map(g => `children:${g.id}` === item.scope ? { ...g, stepIds: order } : g);
      stepIds = blocks.flatMap(b => b.group && `children:${b.group.id}` === item.scope ? order : b.refs.map(ref => ref.id));
    }
    orderLock.current = true;
    setSavingOrder(true);
    try { await update({ type: "organize", groups: gs, stepIds }); }
    finally { orderLock.current = false; setSavingOrder(false); }
  };
  const moveOne = async (item: SortItem, direction: -1 | 1) => {
    const order = siblings(item), index = order.indexOf(item.id), target = order[index + direction];
    if (index >= 0 && target) await saveOrder(item, target, direction === 1);
    await popup.close();
  };
  const handle = (item: SortItem, name: string) => <button
    type="button" className="sort-handle" aria-label={`Kéo sắp xếp ${name}`} title="Kéo để sắp xếp"
    disabled={locked || savingOrder} draggable={!locked && !savingOrder}
    onClick={event => event.stopPropagation()}
    onDragStart={event => {
      if (locked || orderLock.current) { event.preventDefault(); return; }
      event.stopPropagation();
      dragRef.current = item;
      setDragging(item);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-rpa-sort", item.id);
    }}
    onDragEnd={clearDrag}>⋮⋮</button>;
  const dropEvents = (item: SortItem) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      const source = dragRef.current;
      if (!source) return;
      if (source.scope !== item.scope || locked || savingOrder) {
        setDropPosition(undefined);
        return;
      }
      event.stopPropagation();
      if (source.id === item.id) { setDropPosition(undefined); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const container = list.current;
      if (container) {
        const bounds = container.getBoundingClientRect();
        if (event.clientY < bounds.top + 28) container.scrollTop -= 12;
        else if (event.clientY > bounds.bottom - 28) container.scrollTop += 12;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setDropPosition({ ...item, after: event.clientY >= rect.top + rect.height / 2 });
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const source = dragRef.current;
      if (!source || source.scope !== item.scope) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      clearDrag();
      void saveOrder(source, item.id, event.clientY >= rect.top + rect.height / 2);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPosition(undefined);
    },
  });
  const sortClass = (item: SortItem) =>
    `${dragging?.id === item.id && dragging.scope === item.scope ? " is-dragging" : ""}${dropPosition?.id === item.id && dropPosition.scope === item.scope ? dropPosition.after ? " drop-after" : " drop-before" : ""}`;
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
  const row = (ref: (typeof f.steps)[number], number: string) => {
    const s = state.steps.find(
      (s) => s.id === ref.id && s.version === ref.version,
    )!;
    const text = s.payload.target?.ocr?.text;
    const customName = s.name !== s.payload.action && s.name !== "WAIT / VERIFY";
    let sleepText = "";
    if (s.payload.action === "SLEEP") {
      const network = state.networkSettings ?? defaultNetworkSettings();
      sleepText = `Chờ ${(network.presets[network.mode].sleepDelayMs / 1000).toLocaleString("vi-VN")} giây · ${NETWORK_LABELS[network.mode]}`;
    }
    const title = customName ? s.name : sleepText || text || ({
      CLICK_TARGET: "Bấm target", CLICK_AND_TYPE: "Bấm và nhập chữ", UPLOAD_FILE: "Chọn ảnh upload",
      TYPE_ONLY: "Nhập nội dung", WAIT_VERIFY: "Chờ xác nhận", SCROLL: "Cuộn trang",
      QUICK_TAG: "Gắn thẻ theo vị trí",
      SLEEP: "Chờ",
    }[s.payload.action]);
    return (
      <div
        className={`step-row${sortClass(itemForStep(s.id))}${selected?.id === s.id ? " selected" : ""}${blockedSteps.has(s.id) ? " is-blocked-for-all" : ""}${playback[s.id]?.status === "running" ? " is-running" : ""}`}
        {...dropEvents(itemForStep(s.id))}
        data-step-id={s.id}
        data-play-status={playback[s.id]?.status ?? "idle"}
        key={s.id}
      >
        {handle(itemForStep(s.id), s.name)}
        <span className="step-number" aria-label={`Step ${number}`}>
          {number}
        </span>
        <button
          className={selected?.id === s.id ? "step active" : "step"}
          disabled={locked}
          onClick={() => select(s)}
          title={[title, text, s.payload.action].filter(Boolean).join(" · ")}
        >
          <span className="step-label">
            <b>{blockedSteps.has(s.id) && <span className="step-block-flag" title="Blocked for Play All">⊘ </span>}{title}</b>
            {text && text !== title && <span className="step-target-text">{text}</span>}
            {sleepText && customName && <span className="step-target-text">{sleepText}</span>}
            <small>{s.payload.action} · v{s.version} · {matchToLabel(effectiveMatchTo(s.payload))}{blockedSteps.has(s.id) && <span className="step-block-flag"> · BLOCKED (All)</span>}</small>
            {playback[s.id] && (
              <small
                className={`step-status ${playback[s.id].status}`}
                title={`${playback[s.id].resultStatus ?? ""} ${playback[s.id].message}`}
              >
                {playback[s.id].status === "skipped" ? "SKIPPED" : playback[s.id].status}
                {playback[s.id].status === "pass" &&
                playback[s.id].resultStatus === "ACTION_SENT"
                  ? " · sent"
                  : ""}
              </small>
            )}
          </span>
        </button>
        <button
          className="icon-button step-play"
          aria-label={`Play ${s.name}`}
          title={`Play Base v${s.version} · Match To ${matchToLabel(effectiveMatchTo(s.payload))}`}
          disabled={locked}
          onClick={() => play(s)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M7 4v16l14-8Z" />
          </svg>
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
        <button className="icon-button step-block" disabled={locked}
          aria-label={`${blockedSteps.has(s.id) ? "Unblock" : "Block"} ${s.name}`}
          aria-pressed={blockedSteps.has(s.id)}
          title={blockedSteps.has(s.id) ? "Unblock for Play All" : "Block for Play All (memory only)"}
          onClick={() => toggleBlocked(s.id)}>{blockedSteps.has(s.id) ? "↺" : "⊘"}</button>
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
    <div className="steps" ref={list}>
      {blocks.map((b, blockIndex) =>
        b.group ? (
          <section key={b.group.id} className={`step-group${sortClass({ id: blockId(b), scope: rootScope })}`}
            {...dropEvents({ id: blockId(b), scope: rootScope })}>
            <div className="folder-row">
              {handle({ id: blockId(b), scope: rootScope }, b.group.name)}
              <span className="step-number">
                {String(blockIndex + 1).padStart(2, "0")}
              </span>
              <button
                className="folder-toggle"
                disabled={locked}
                aria-expanded={expanded(b.group)}
                onClick={() => {
                  if (b.group!.collapsed && revealedGroup === b.group!.id) {
                    setRevealedGroup("");
                    return;
                  }
                  setRevealedGroup("");
                  void update({
                    type: "organize",
                    groups: groups.map((g) =>
                      g.id === b.group!.id
                        ? { ...g, collapsed: !g.collapsed }
                        : g,
                    ),
                    stepIds: f.steps.map((s) => s.id),
                  });
                }}
              >
                <span>{expanded(b.group) ? "▾" : "▸"}</span>
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
            {expanded(b.group) && (
              <div className="group-steps">
                {b.refs.map((ref, i) =>
                  row(
                    ref,
                    `${String(blockIndex + 1).padStart(2, "0")}.${i + 1}`,
                  ),
                )}
                {!b.refs.length && (
                  <p className="hint empty-group">Empty group</p>
                )}
              </div>
            )}
          </section>
        ) : (
          row(b.refs[0], String(blockIndex + 1).padStart(2, "0"))
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
          {!menu.editing && (() => {
            const item = menu.step ? itemForStep(menu.step.id) : { id: `group:${menu.groupId}`, scope: rootScope };
            const order = siblings(item), index = order.indexOf(item.id);
            return <>
              <button className="menu-item" disabled={locked || savingOrder || index <= 0}
                onClick={() => void moveOne(item, -1)}>↑ Move Up</button>
              <button className="menu-item" disabled={locked || savingOrder || index < 0 || index >= order.length - 1}
                onClick={() => void moveOne(item, 1)}>↓ Move Down</button>
            </>;
          })()}
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
            </>
          )}
        </UiPopover>
      )}
    </div>
  );
}
