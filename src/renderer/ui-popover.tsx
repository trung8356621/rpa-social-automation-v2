import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Command } from "../shared/contracts";
export function usePopover(update: (c: Command) => Promise<void>) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const show = async (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    await update({ type: "browserVisible", visible: false });
    setAnchor(rect);
  };
  const close = async () => {
    await update({ type: "browserVisible", visible: true });
    setAnchor(undefined);
  };
  return { anchor, show, close };
}
export function UiPopover({
  anchor,
  label,
  close,
  children,
  className = "",
}: {
  anchor: DOMRect;
  label: string;
  close: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const returnFocus = useRef(document.activeElement as HTMLElement);
  const ref = useRef<HTMLDivElement>(null),
    [position, setPosition] = useState({
      left: anchor.left,
      top: anchor.bottom + 6,
    });
  useLayoutEffect(() => {
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(anchor.left, innerWidth - r.width - 8)),
        top: Math.max(
          8,
          Math.min(anchor.bottom + 6, innerHeight - r.height - 8),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(ref.current!);
    window.addEventListener("resize", place);
    const firstField =
      ref.current?.querySelector<HTMLElement>("input,textarea,select") ??
      ref.current?.querySelector<HTMLElement>("button:not(:disabled)");
    firstField?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, []);
  useEffect(() => {
    const before = returnFocus.current;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const all = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
          ) ?? [],
        );
        const first = all[0],
          last = all.at(-1);
        if (!ref.current?.contains(document.activeElement)) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.documentElement.style.overflow = overflow;
      window.removeEventListener("keydown", key);
      if (before?.isConnected) before.focus();
    };
  }, []);
  return createPortal(
    <div
      className="ui-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`ui-popover ${className}`}
        style={position}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
