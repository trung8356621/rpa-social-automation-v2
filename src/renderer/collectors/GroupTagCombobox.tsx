import React, { useState, useRef, useEffect } from "react";
import type { GroupTagSuggestion } from "../../shared/collectors/types";

type Props = {
  value: string;
  onChange: (value: string) => void;
  suggestions: GroupTagSuggestion[];
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
  dropdownPlacement?: "top" | "bottom" | "auto";
};

export function GroupTagCombobox({
  value,
  onChange,
  suggestions,
  placeholder = "e.g. post-main",
  disabled = false,
  style,
  className = "",
  dropdownPlacement = "auto",
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && containerRef.current) {
      if (dropdownPlacement === "top") {
        setOpenUpward(true);
      } else if (dropdownPlacement === "bottom") {
        setOpenUpward(false);
      } else {
        const rect = containerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        setOpenUpward(spaceBelow < 200 && rect.top > 160);
      }
    }
  }, [isOpen, dropdownPlacement]);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  function handleSelect(tag: string) {
    onChange(tag);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(0);
      } else {
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0,
        );
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(suggestions.length - 1);
      } else {
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1,
        );
      }
    } else if (e.key === "Enter") {
      if (isOpen && highlightedIndex >= 0 && suggestions[highlightedIndex]) {
        e.preventDefault();
        handleSelect(suggestions[highlightedIndex].tag);
      } else {
        setIsOpen(false);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className={`collector-group-combobox ${className}`}
      style={{ position: "relative", display: "inline-block", ...style }}
    >
      <div className="collector-group-combobox-input-wrap" style={{ display: "flex", alignItems: "center", position: "relative" }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            if (!disabled && suggestions.length > 0) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="collector-group-combobox-input"
          style={{
            width: "140px",
            padding: "2px 22px 2px 6px",
            fontSize: "11px",
            background: "#0f172a",
            color: "#e2e8f0",
            border: "1px solid #334155",
            borderRadius: "3px",
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              setIsOpen((prev) => !prev);
              inputRef.current?.focus();
            }
          }}
          title="Toggle group tag suggestions"
          style={{
            position: "absolute",
            right: "2px",
            background: "transparent",
            border: "none",
            color: "#64748b",
            cursor: disabled ? "default" : "pointer",
            padding: "0 4px",
            fontSize: "10px",
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
          }}
        >
          ▾
        </button>
      </div>

      {isOpen && suggestions.length > 0 && (
        <div
          className="collector-group-combobox-dropdown"
          style={{
            position: "absolute",
            top: openUpward ? "auto" : "100%",
            bottom: openUpward ? "100%" : "auto",
            left: 0,
            zIndex: 9999,
            minWidth: "220px",
            maxWidth: "320px",
            background: "#0d1520",
            border: "1px solid #334155",
            borderRadius: "4px",
            boxShadow: openUpward ? "0 -6px 16px rgba(0,0,0,0.6)" : "0 6px 16px rgba(0,0,0,0.6)",
            marginTop: openUpward ? "0" : "4px",
            marginBottom: openUpward ? "4px" : "0",
            maxHeight: "220px",
            overflowY: "auto",
            padding: "3px 0",
          }}
        >
          {suggestions.map((item, idx) => {
            const isHighlighted = idx === highlightedIndex;
            const isSelected = item.tag === value;

            return (
              <div
                key={`${item.kind}-${item.tag}-${idx}`}
                onClick={() => handleSelect(item.tag)}
                onMouseEnter={() => setHighlightedIndex(idx)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 8px",
                  fontSize: "11px",
                  cursor: "pointer",
                  background: isHighlighted
                    ? "#1e293b"
                    : isSelected
                      ? "#172554"
                      : "transparent",
                  color: item.kind === "create_new" ? "#38bdf8" : "#e2e8f0",
                }}
              >
                {/* Distinct Icon: 🔗 for existing linked group, ➕ for creating new group */}
                <span style={{ fontSize: "12px", width: "16px", textAlign: "center" }}>
                  {item.kind === "create_new" ? "➕" : "🔗"}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontWeight: item.kind === "create_new" ? 600 : 500 }}>
                      {item.tag}
                    </span>
                    {item.kind === "unpaired_in_sample" && (
                      <span
                        style={{
                          fontSize: "9px",
                          background: "#854d0e",
                          color: "#fef08a",
                          padding: "1px 4px",
                          borderRadius: "2px",
                          fontWeight: 600,
                        }}
                      >
                        Needs END
                      </span>
                    )}
                    {item.kind === "other_sample" && (
                      <span
                        style={{
                          fontSize: "9px",
                          background: "#1e3a8a",
                          color: "#93c5fd",
                          padding: "1px 4px",
                          borderRadius: "2px",
                        }}
                      >
                        {item.sampleCount} {item.sampleCount === 1 ? "sample" : "samples"}
                      </span>
                    )}
                  </div>
                  {item.kind === "create_new" && (
                    <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                      Create new group tag
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
