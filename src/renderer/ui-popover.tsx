import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Command } from "../shared/contracts";
export function usePopover(_update: (c: Command) => Promise<void>) {
  const [anchor, setAnchor] = useState<DOMRect>();
  const show = async (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor(rect);
  };
  const close = async () => {
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
  variant = "popover",
}: {
  variant?: "popover" | "drawer" | "modal";
  anchor?: DOMRect;
  label: string;
  close: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [host, setHost] = useState<Window>();
  const closeRef = useRef(close);
  closeRef.current = close;
  const returnFocus = useRef(document.activeElement as HTMLElement);
  const ref = useRef<HTMLDivElement>(null),
    [position, setPosition] = useState({
      left: anchor?.left ?? 8,
      top: (anchor?.bottom ?? 2) + 6,
    });
  useLayoutEffect(() => {
    const name = `creator-ui-overlay-${crypto.randomUUID()}`;
    const preferInPage = Boolean(window.__RPA_WEB_DEV__);
    const overlay = preferInPage ? null : window.open("about:blank", name, "popup=yes");
    // Web-dev (and popup-blocked) use the same document so Collectors modals still work.
    if (!overlay) {
      setHost(window);
      return () => {
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
      };
    }
    const doc = overlay.document;
    doc.title = label;
    const base = doc.createElement("base");
    base.href = document.baseURI;
    doc.head.append(base);
    for (const node of document.querySelectorAll('link[rel="stylesheet"],style')) doc.head.append(node.cloneNode(true));
    doc.body.dataset.panel = "ui-overlay";
    doc.documentElement.style.background = "transparent";
    doc.body.style.cssText = "margin:0;width:100vw;height:100vh;overflow:hidden;background:transparent";
    const closed = () => closeRef.current();
    overlay.addEventListener("beforeunload", closed);
    setHost(overlay);
    return () => {
      overlay.removeEventListener("beforeunload", closed);
      void window.creator.invoke({ type: "closeUiOverlay", name }).catch(console.error);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);
  const anchorLeft = anchor?.left;
  const anchorTop = anchor?.top;
  const anchorBottom = anchor?.bottom;
  useLayoutEffect(() => {
    if (
      !host
      || variant !== "popover"
      || anchorLeft == null
      || anchorTop == null
      || anchorBottom == null
    ) return;
    const place = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const width = Math.max(r.width, 1);
      const height = Math.max(r.height, 1);
      const left = Math.max(8, Math.min(anchorLeft, host.innerWidth - width - 8));
      const below = anchorBottom + 6;
      const above = anchorTop - height - 6;
      const top =
        below + height <= host.innerHeight - 8
          ? below
          : above >= 8
            ? above
            : Math.max(8, Math.min(below, host.innerHeight - height - 8));
      setPosition({ left, top });
    };
    place();
    // Re-measure after paint when content (search/list) finishes layout.
    const raf = host.requestAnimationFrame(() => place());
    const observer = new ResizeObserver(place);
    observer.observe(ref.current!);
    host.addEventListener("resize", place);
    return () => {
      host.cancelAnimationFrame(raf);
      observer.disconnect();
      host.removeEventListener("resize", place);
    };
    // Geometry primitives — avoid re-running when callers pass a fresh DOMRect each render.
  }, [host, variant, anchorLeft, anchorTop, anchorBottom]);
  // Focus once when the overlay host mounts — never on content re-renders (typing).
  useLayoutEffect(() => {
    if (!host) return;
    const firstField =
      ref.current?.querySelector<HTMLElement>("input,textarea,select") ??
      ref.current?.querySelector<HTMLElement>("button:not(:disabled)");
    firstField?.focus();
  }, [host]);
  useEffect(() => {
    if (!host) return;
    const doc = host.document;
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
        if (!ref.current?.contains(doc.activeElement)) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && doc.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && doc.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    host.addEventListener("keydown", key);
    return () => {
      document.documentElement.style.overflow = overflow;
      host.removeEventListener("keydown", key);
      if (before?.isConnected) before.focus();
    };
  }, [host]);
  if (!host || host.closed) return null;
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
        className={`${variant === "drawer" ? "ui-drawer" : variant === "modal" ? "ui-modal" : "ui-popover"} ${className}`}
        style={variant === "popover" ? position : undefined}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    host.document.body,
  );
}
