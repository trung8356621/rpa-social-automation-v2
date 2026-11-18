import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActionTag } from "../shared/contracts";
import { UiPopover } from "./ui-popover";

type Props = {
  tags: ActionTag[];
  value?: string;
  disabled?: boolean;
  onChange: (tagKey: string | undefined) => void;
  onOpen?: () => void;
};

export function ActionTagCombobox({ tags, value, disabled, onChange, onOpen }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<DOMRect>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = tags.find((t) => t.tag_key === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? tags.filter((t) =>
          t.tag_key.toLowerCase().includes(q)
          || (t.name || "").toLowerCase().includes(q))
      : tags;
    return [{ tag_key: "", name: "— Chưa gắn Tag —" } as ActionTag, ...rows];
  }, [tags, query]);

  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, filtered.findIndex((t) => t.tag_key === (value ?? ""))));
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, filtered, value]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function openMenu() {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor(rect);
    setOpen(true);
    onOpen?.();
  }

  function closeMenu() {
    setOpen(false);
    setQuery("");
    setAnchor(undefined);
  }

  function commit(tagKey: string | undefined) {
    onChange(tagKey || undefined);
    closeMenu();
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (i + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (i <= 0 ? filtered.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = filtered[highlight];
      if (row) commit(row.tag_key || undefined);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  }

  return (
    <div className="action-tag-combobox" style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        disabled={disabled}
        title={selected ? `${selected.tag_key}${selected.name ? ` — ${selected.name}` : ""}` : "Chọn Action Tag"}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKey}
        className="action-tag-combobox-trigger"
      >
        <code>{selected?.tag_key || "— Chưa gắn Tag —"}</code>
        <span aria-hidden="true">▾</span>
      </button>

      {open && anchor && (
        <UiPopover
          variant="popover"
          anchor={anchor}
          label="Chọn Action Tag"
          className="action-tag-combobox-overlay"
          close={closeMenu}
        >
          <div className="action-tag-combobox-menu" role="presentation" onKeyDown={onListKey}>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Tìm Tag…"
              aria-label="Tìm Action Tag"
              className="action-tag-combobox-search"
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
            />
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Action Tags"
              className="action-tag-combobox-list"
            >
              {filtered.length === 0 ? (
                <div className="action-tag-combobox-empty">Không có Tag khớp.</div>
              ) : (
                filtered.map((tag, index) => {
                  const active = (tag.tag_key || "") === (value ?? "");
                  const hi = index === highlight;
                  return (
                    <div
                      key={tag.tag_key || "__none__"}
                      role="option"
                      aria-selected={active}
                      data-index={index}
                      className={`action-tag-combobox-option${hi ? " highlight" : ""}${active ? " selected" : ""}`}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(tag.tag_key || undefined)}
                    >
                      <code>{tag.tag_key || "— Chưa gắn Tag —"}</code>
                      {tag.name && tag.tag_key ? <small>{tag.name}</small> : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </UiPopover>
      )}
    </div>
  );
}
