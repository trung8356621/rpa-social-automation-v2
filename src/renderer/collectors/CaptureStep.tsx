import React, { useEffect, useMemo, useRef, useState } from "react";
import { previewSrc } from "../../shared/collectors/fixtures";
import {
  addCaptureItem,
  auditForCapture,
  captureLibraryCount,
  deleteCaptureItem,
} from "../../shared/collectors/ops";
import {
  ScrollExtendGate,
  userFacingExtendError,
  withTimeout,
} from "../../shared/collectors/scroll-extend-gate";
import {
  SCROLL_CAPTURE_LIMITS,
  isRoiEdgeAutoScrollArmed,
  shouldExtendFromPreviewScroll,
} from "../../shared/collectors/scrolling-capture";
import type { CaptureItem, CollectorDraft } from "../../shared/collectors/types";
import type { BrowserSession, Capture, Command, Rect, State } from "../../shared/contracts";
import {
  assertRoiFitsCapture,
  clientPointToCaptureCoords,
  domRectToShellBounds,
  dragToCaptureRoi,
  resizeCaptureRoi,
} from "../../shared/collector-browser-host";
import { readAdminUiZoom } from "../ui-zoom";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorLoadImageAsset,
  collectorNavigate,
  collectorReportBrowserHost,
  collectorScrollCaptureBegin,
  collectorScrollCaptureCancel,
  collectorScrollCaptureConfirm,
  collectorScrollCaptureExtend,
  collectorScrollCaptureMarkRoi,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
  roiToSampleRoi,
  type CollectorInvoke,
  type ScrollCaptureSession,
} from "./browser-capture";

type Props = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
};

type DragState =
  | { kind: "select"; startX: number; startY: number; currentX: number; currentY: number }
  | { kind: "resize"; edge: "right" | "bottom" | "corner"; original: Rect; currentX: number; currentY: number };
type HostClient = { left: number; top: number; width: number; height: number };

function CaptureLibraryDrawer({
  draft,
  items,
  locked,
  invoke,
  onClose,
  onDelete,
}: {
  draft: CollectorDraft;
  items: CaptureItem[];
  locked: boolean;
  invoke?: CollectorInvoke;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const item of items) {
        if (item.imageAsset && invoke && isElectronBrowserCoreAvailable()) {
          try {
            next[item.id] = await collectorLoadImageAsset(invoke, item.imageAsset);
          } catch {
            /* missing asset */
          }
        } else if (item.previewAssetId) {
          next[item.id] = previewSrc(item.previewAssetId);
        }
      }
      if (!cancelled) setSrcs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [items, invoke]);

  return (
    <div className="collector-capture-library-layer" role="dialog" aria-modal="true" aria-label="Capture Library">
      <button type="button" className="collector-versions-backdrop" aria-label="Close Capture Library" onClick={onClose} />
      <div className="collector-capture-library-drawer">
        <div className="collector-version-panel-head">
          <h3>Capture Library</h3>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <p className="hint">{items.length} item(s). Audit in Review &amp; Mapping.</p>
        {!items.length && <div className="empty-tags-box">No captures yet.</div>}
        <div className="collector-capture-library-grid">
          {items.map((item, index) => {
            const audit = auditForCapture(draft, item.id);
            const confirmed = audit.status === "confirmed";
            const real = Boolean(item.imageAsset) && item.simulatedCapture !== true;
            return (
              <div key={item.id} className="collector-library-card">
                <div className="collector-library-card-head">
                  <b>#{index + 1}</b>
                  <button
                    type="button"
                    disabled={locked}
                    aria-label={`Delete capture #${index + 1}`}
                    onClick={() => {
                      if (confirmed) {
                        if (!window.confirm("Confirmed capture — delete anyway?")) return;
                      }
                      onDelete(item.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
                {srcs[item.id] ? (
                  <img src={srcs[item.id]} alt="" className="collector-library-thumb" />
                ) : (
                  <div className="collector-sample-empty">No preview</div>
                )}
                <small>
                  {real ? "Real Browser Core" : "Preview"}
                  {item.roi ? ` · ${item.roi.width}×${item.roi.height}` : ""}
                  {audit.status ? ` · ${audit.status}` : ""}
                </small>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function StepCaptureSamples({
  draft,
  locked,
  onChange,
  invoke,
  state,
  onSelectSession,
}: Props) {
  const electron = isElectronBrowserCoreAvailable() && Boolean(invoke);
  const [url, setUrl] = useState(state?.url || "https://");
  const [opened, setOpened] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extending, setExtending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [shot, setShot] = useState<Capture>();
  const [scrollSession, setScrollSession] = useState<ScrollCaptureSession>();
  const [roi, setRoi] = useState<Rect>();
  const [anchor, setAnchor] = useState<{ x: number; y: number }>();
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const gateRef = useRef(new ScrollExtendGate<ScrollCaptureSession>());
  const lastEdgeExtendAt = useRef(0);
  const dragRef = useRef<DragState | undefined>(undefined);
  const sessionRef = useRef<ScrollCaptureSession | undefined>(undefined);
  const roiRef = useRef<Rect | undefined>(undefined);
  const anchorRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const shotRef = useRef<Capture | undefined>(undefined);

  dragRef.current = drag;
  sessionRef.current = scrollSession;
  roiRef.current = roi;
  anchorRef.current = anchor;
  shotRef.current = shot;

  const captures = draft.captures ?? [];
  const count = captureLibraryCount(draft);
  const sessions: BrowserSession[] = state?.browserSessions ?? [];
  const activeSessionId = state?.activeBrowserSessionId;

  const imageWidth = scrollSession?.width ?? shot?.width ?? 0;
  const imageHeight = scrollSession?.height ?? shot?.height ?? 0;
  const previewSrcUrl = scrollSession?.dataUrl ?? shot?.dataUrl;

  // Always use a real overflow:auto preview (screenshot FB scrollbar is not interactive).
  const imageBox = useMemo(() => {
    if (!hostClient || !imageWidth || !imageHeight) return null;
    const width = hostClient.width;
    const height = (imageHeight / imageWidth) * width;
    return { x: 0, y: 0, width, height };
  }, [hostClient, imageWidth, imageHeight]);

  const publishHost = React.useCallback(() => {
    if (!electron || !invoke) return;
    const el = hostRef.current;
    if (!el) {
      setHostClient(null);
      void collectorReportBrowserHost(invoke, null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setHostClient({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    const zoom = readAdminUiZoom();
    const next = domRectToShellBounds(rect, zoom);
    void collectorReportBrowserHost(invoke, { ...next, active: true });
  }, [electron, invoke]);

  useEffect(() => {
    if (!electron || !invoke) return;
    publishHost();
    const el = hostRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => publishHost()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", publishHost);
    const existingUrl = state?.url?.trim();
    if (existingUrl && existingUrl !== "about:blank" && /^https?:\/\//i.test(existingUrl)) {
      setUrl(existingUrl);
      setOpened(true);
      void collectorSetBrowserVisible(invoke, true).then(publishHost);
    }
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publishHost);
      gateRef.current.cancel();
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
      if (sessionRef.current?.sessionId) {
        void collectorScrollCaptureCancel(invoke, sessionRef.current.sessionId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount Capture host lifecycle only
  }, [electron, invoke, publishHost]);

  useEffect(() => {
    if (state?.url) setUrl(state.url);
  }, [state?.url]);

  function applySessionToShot(session: ScrollCaptureSession, base?: Capture) {
    setScrollSession(session);
    sessionRef.current = session;
    setShot({
      id: base?.id ?? session.sessionId,
      dataUrl: session.dataUrl,
      width: session.width,
      height: session.height,
      zoom: base?.zoom ?? 1,
      url: session.url || base?.url || url,
      timestamp: new Date().toISOString(),
      backend: "cdp-surface",
      bounds: base?.bounds,
    });
  }

  function growRoiForSession(session: ScrollCaptureSession, prevRoi: Rect | undefined, prevAnchor: { x: number; y: number } | undefined) {
    if (!prevRoi || !prevAnchor) return prevRoi;
    return {
      x: prevAnchor.x,
      y: prevAnchor.y,
      width: Math.min(prevRoi.width, session.width - prevAnchor.x),
      height: Math.max(4, Math.min(session.height - prevAnchor.y, Math.max(prevRoi.height, session.height - prevRoi.y))),
    };
  }

  async function runExtend(deltaCssPx: number, signal: AbortSignal): Promise<ScrollCaptureSession> {
    if (!invoke) throw new Error("Browser Core unavailable.");
    const session = sessionRef.current;
    if (!session) throw new Error("No scroll capture session.");
    if (!roiRef.current) throw new Error("Select an ROI before extending.");
    const previewEl = previewScrollRef.current;
    const keepScrollTop = previewEl?.scrollTop ?? 0;
    const next = await withTimeout(
      collectorScrollCaptureExtend(invoke, session.sessionId, deltaCssPx),
      SCROLL_CAPTURE_LIMITS.extendTimeoutMs,
      `Scroll extend timed out after ${SCROLL_CAPTURE_LIMITS.extendTimeoutMs}ms. Last valid image kept.`,
      signal,
    );
    if (signal.aborted) throw new Error("Extend cancelled.");
    applySessionToShot(next, shotRef.current);
    if (next.error || next.phase === "FAILED") {
      throw new Error(next.error || "Extend failed — last valid image kept.");
    }
    const grown = growRoiForSession(next, roiRef.current, anchorRef.current);
    if (grown) {
      setRoi(grown);
      roiRef.current = grown;
      const d = dragRef.current;
      if (d?.kind === "resize") {
        const updated: DragState = {
          ...d,
          original: { x: grown.x, y: grown.y, width: grown.width, height: grown.height },
        };
        dragRef.current = updated;
        setDrag(updated);
      }
    }
    // Preserve viewing position — do not jump to bottom or reset to 0.
    requestAnimationFrame(() => {
      const el = previewScrollRef.current;
      if (el) el.scrollTop = keepScrollTop;
    });
    setMessage(`Đã mở rộng · ${next.frameCount} khung · ${next.width}×${next.height}`);
    return next;
  }

  function beginExtendUi() {
    setError("");
    setExtending(true);
    setMessage("Đang mở rộng vùng chụp...");
  }

  function endExtendUi() {
    if (!gateRef.current.busy) setExtending(false);
  }

  /** Immediate extend (ROI edge). Drops while busy — no post-align queue. */
  async function requestExtend(deltaCssPx = SCROLL_CAPTURE_LIMITS.defaultScrollCssPx) {
    if (!invoke || locked || !frozen || !roiRef.current || !sessionRef.current) return;
    if (gateRef.current.busy) return;
    beginExtendUi();
    try {
      await gateRef.current.request(deltaCssPx, runExtend);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = userFacingExtendError(msg);
      if (friendly) {
        setError(friendly);
        setMessage("Không mở rộng thêm được. Có thể Confirm ảnh hiện tại hoặc thử cuộn lại.");
      }
    } finally {
      endExtendUi();
    }
  }

  /** Wheel-at-end: debounced one-per-burst; wheels during busy are dropped. */
  function scheduleWheelExtend(deltaCssPx = SCROLL_CAPTURE_LIMITS.defaultScrollCssPx) {
    if (!invoke || locked || !frozen || !roiRef.current || !sessionRef.current) return;
    gateRef.current.scheduleWheelExtend(
      deltaCssPx,
      async (d, signal) => {
        beginExtendUi();
        try {
          return await runExtend(d, signal);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const friendly = userFacingExtendError(msg);
          if (friendly) {
            setError(friendly);
            setMessage("Không mở rộng thêm được. Có thể Confirm ảnh hiện tại hoặc thử cuộn lại.");
          }
          throw e;
        } finally {
          endExtendUi();
        }
      },
      beginExtendUi,
    );
  }

  const requestExtendRef = useRef(requestExtend);
  requestExtendRef.current = requestExtend;
  const scheduleWheelExtendRef = useRef(scheduleWheelExtend);
  scheduleWheelExtendRef.current = scheduleWheelExtend;

  async function restoreBrowse(status: string) {
    if (!invoke) return;
    gateRef.current.cancel();
    setExtending(false);
    if (sessionRef.current?.sessionId) {
      try {
        await collectorScrollCaptureCancel(invoke, sessionRef.current.sessionId);
      } catch {
        /* session may already be gone */
      }
    }
    setScrollSession(undefined);
    sessionRef.current = undefined;
    setShot(undefined);
    setRoi(undefined);
    setAnchor(undefined);
    setDrag(undefined);
    setFrozen(false);
    await collectorSetBrowserVisible(invoke, true);
    publishHost();
    setMessage(status);
  }

  async function openUrl() {
    if (!invoke || locked || busy || frozen) return;
    setError("");
    setBusy(true);
    try {
      await collectorNavigate(invoke, url);
      setOpened(true);
      setFrozen(false);
      setShot(undefined);
      setScrollSession(undefined);
      setRoi(undefined);
      setAnchor(undefined);
      setMessage("Browser open — scroll normally, then Capture Region.");
      publishHost();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function captureRegion() {
    if (!invoke || locked || busy) return;
    setError("");
    if (!opened) {
      setError("Open a URL first.");
      return;
    }
    setBusy(true);
    try {
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      if (!image.bounds || image.bounds.width < 4 || image.bounds.height < 4) {
        throw new Error("Capture missing Browser Core viewport bounds — cannot freeze faithfully.");
      }
      const session = await collectorScrollCaptureBegin(invoke, image.id);
      applySessionToShot(session, image);
      setRoi(undefined);
      setAnchor(undefined);
      setFrozen(true);
      publishHost();
      setMessage(
        `Khung 1 · ${session.width}×${session.height}. Chọn vùng, rồi cuộn bánh xe hoặc kéo cạnh dưới để mở rộng.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFrozen(false);
      setShot(undefined);
      setScrollSession(undefined);
      try {
        await collectorSetBrowserVisible(invoke, true);
        publishHost();
      } catch {
        /* keep prior error */
      }
    } finally {
      setBusy(false);
    }
  }

  function pointerPos(e: { clientX: number; clientY: number }) {
    if (!hostClient || !imageWidth || !imageHeight || !imageBox) return { x: 0, y: 0 };
    const scroller = previewScrollRef.current;
    const display = scroller
      ? {
          left: scroller.getBoundingClientRect().left - scroller.scrollLeft,
          top: scroller.getBoundingClientRect().top - scroller.scrollTop,
          width: imageBox.width,
          height: imageBox.height,
        }
      : hostClient;
    return clientPointToCaptureCoords(
      e.clientX,
      e.clientY,
      display,
      imageWidth,
      imageHeight,
      { x: 0, y: 0, width: imageBox.width, height: imageBox.height },
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (locked || !frozen || !shot || roi || extending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    setDrag({ kind: "select", startX: p.x, startY: p.y, currentX: p.x, currentY: p.y });
  }

  function startResize(e: React.PointerEvent, edge: "right" | "bottom" | "corner") {
    e.stopPropagation();
    if (locked || !roi || !shot) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    surfaceRef.current?.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    const next: DragState = { kind: "resize", edge, original: roi, currentX: p.x, currentY: p.y };
    dragRef.current = next;
    setDrag(next);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = pointerPos(e);
    const next = { ...d, currentX: p.x, currentY: p.y } as DragState;
    dragRef.current = next;
    setDrag(next);

    if (
      d.kind === "resize" &&
      hostClient &&
      roiRef.current &&
      isRoiEdgeAutoScrollArmed({
        edge: d.edge,
        pointerClientY: e.clientY,
        viewportTop: hostClient.top,
        viewportHeight: hostClient.height,
      })
    ) {
      const now = Date.now();
      if (now - lastEdgeExtendAt.current >= SCROLL_CAPTURE_LIMITS.edgeAutoScrollMs) {
        lastEdgeExtendAt.current = now;
        void requestExtendRef.current(SCROLL_CAPTURE_LIMITS.defaultScrollCssPx);
      }
    }
  }

  async function commitRoi(next: Rect | undefined) {
    setDrag(undefined);
    dragRef.current = undefined;
    if (!next || !invoke || !sessionRef.current) {
      setRoi(next);
      roiRef.current = next;
      return;
    }
    const lockedRoi = anchorRef.current
      ? { x: anchorRef.current.x, y: anchorRef.current.y, width: next.width, height: next.height }
      : next;
    setRoi(lockedRoi);
    roiRef.current = lockedRoi;
    if (!anchorRef.current) {
      const a = { x: lockedRoi.x, y: lockedRoi.y };
      setAnchor(a);
      anchorRef.current = a;
    }
    try {
      const marked = await collectorScrollCaptureMarkRoi(invoke, sessionRef.current.sessionId);
      setScrollSession(marked);
      sessionRef.current = marked;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onPointerUp() {
    const d = dragRef.current;
    if (!d || !imageWidth || !imageHeight) return;
    const next = d.kind === "resize"
      ? resizeCaptureRoi(d.original, d.edge, d.currentX, d.currentY, imageWidth, imageHeight)
      : dragToCaptureRoi(d.startX, d.startY, d.currentX, d.currentY);
    void commitRoi(next ?? undefined);
  }

  // Passive:false wheel — prevent Creator page scroll; route to preview pan or extend.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!frozen || !surface) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (locked || !roiRef.current || !sessionRef.current) return;
      const el = previewScrollRef.current;
      const scrollTop = el?.scrollTop ?? 0;
      const clientHeight = el?.clientHeight ?? hostClient?.height ?? 0;
      const scrollHeight = el?.scrollHeight ?? imageBox?.height ?? 0;
      const action = shouldExtendFromPreviewScroll({
        deltaY: e.deltaY,
        scrollTop,
        clientHeight,
        scrollHeight,
      });
      if (action === "preview" && el) {
        el.scrollTop += e.deltaY;
        return;
      }
      if (action === "extend") {
        // Preview already at end — debounce burst; do not pan further (no overscroll queue).
        scheduleWheelExtendRef.current(SCROLL_CAPTURE_LIMITS.defaultScrollCssPx);
      }
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [frozen, locked, hostClient, imageBox]);

  // Scrollbar navigates preview only — reaching bottom does NOT auto-extend.
  useEffect(() => {
    const el = previewScrollRef.current;
    if (!frozen || !el) return;
    const onScroll = () => {
      if (!roiRef.current || gateRef.current.busy) return;
      const atEnd =
        el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_CAPTURE_LIMITS.previewEndEpsilonPx;
      if (atEnd) {
        setMessage((m) =>
          m.includes("cuộn bánh xe") || m.includes("Đang mở rộng")
            ? m
            : "Đã tới cuối vùng đã chụp — cuộn bánh xe xuống để mở rộng thêm.",
        );
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [frozen, scrollSession?.height]);

  async function confirmCapture() {
    if (!invoke || !sessionRef.current || !roiRef.current || !anchorRef.current || locked || busy) return;
    gateRef.current.cancel();
    setExtending(false);
    setBusy(true);
    setError("");
    try {
      const session = sessionRef.current;
      const fitted = assertRoiFitsCapture(
        {
          x: anchorRef.current.x,
          y: anchorRef.current.y,
          width: roiRef.current.width,
          height: roiRef.current.height,
        },
        session.width,
        session.height,
      );
      const cropped = await collectorScrollCaptureConfirm(invoke, session.sessionId, fitted);
      onChange(
        addCaptureItem(draft, {
          captureUrl: session.url || url,
          roi: roiToSampleRoi(cropped.roi, session.width, session.height),
          imageAsset: cropped.asset,
          browserSessionId: activeSessionId,
          simulatedCapture: false,
        }),
      );
      setScrollSession(undefined);
      sessionRef.current = undefined;
      await restoreBrowse("Capture saved (single PNG). Continue browsing or capture again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelFreeze() {
    if (!invoke) return;
    gateRef.current.cancel();
    setExtending(false);
    setBusy(true);
    setError("");
    try {
      await restoreBrowse("Cancelled — same page and scroll preserved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function resetRoi() {
    setRoi(undefined);
    roiRef.current = undefined;
    setAnchor(undefined);
    anchorRef.current = undefined;
    setDrag(undefined);
    dragRef.current = undefined;
    setMessage("ROI cleared — draw a new selection (top-left will lock again).");
  }

  const liveRoi = drag
    ? drag.kind === "resize" && imageWidth && imageHeight
      ? resizeCaptureRoi(drag.original, drag.edge, drag.currentX, drag.currentY, imageWidth, imageHeight)
      : drag.kind === "select" ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      } : roi
    : roi;

  if (!electron) {
    return (
      <div className="collector-step collector-capture-step">
        <div className="collector-banner warn" role="status">
          <b>UI-only preview</b> — {BROWSER_CORE_UNAVAILABLE}
        </div>
        <p className="hint">
          Open this Collector in Electron RPA Creator to capture with Browser Core.
        </p>
        <div className="collector-capture-tools">
          <span className="collector-capture-counter">
            Captures: <b>{count}</b>
          </span>
          <button type="button" disabled={locked} onClick={() => setLibraryOpen(true)}>
            Library ({count})
          </button>
        </div>
        {libraryOpen && (
          <CaptureLibraryDrawer
            draft={draft}
            items={captures}
            locked={locked}
            onClose={() => setLibraryOpen(false)}
            onDelete={(id) => onChange(deleteCaptureItem(draft, id))}
          />
        )}
      </div>
    );
  }

  return (
    <div className="collector-step collector-capture-step collector-capture-realtime">
      <div className="collector-capture-split">
        <div className="collector-capture-workspace collector-browser-workspace">
          <div
            ref={hostRef}
            className="collector-browser-host"
            aria-label="Browser Core capture workspace"
            data-browser-core-host=""
          >
            {!opened && !shot && (
              <div className="collector-sample-empty collector-browser-host-placeholder">
                Select a Browser Session, enter a URL, then Open URL.
              </div>
            )}
          </div>
        </div>

        <aside className="collector-capture-tools" aria-label="Capture tools">
          <label className="collector-session-select">
            <span className="sr-only">Browser Session</span>
            <select
              disabled={locked || busy || frozen}
              value={activeSessionId ?? ""}
              aria-label="Browser Session"
              onChange={(e) => onSelectSession?.(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="collector-capture-url">
            <span className="sr-only">URL</span>
            <input
              disabled={locked || busy || frozen}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              aria-label="URL"
            />
          </label>
          <button type="button" disabled={locked || busy || frozen} onClick={() => void openUrl()}>
            Open URL
          </button>
          <button
            type="button"
            className="primary"
            disabled={locked || busy || !opened || frozen}
            onClick={() => void captureRegion()}
          >
            Capture Region / Chụp vùng
          </button>
          <span className="collector-capture-counter" aria-live="polite">
            Captures: <b>{count}</b>
            {scrollSession ? ` · frames ${scrollSession.frameCount}` : ""}
          </span>
          <button type="button" disabled={locked || busy} onClick={() => setLibraryOpen(true)}>
            Library ({count})
          </button>

          {error && <p className="collector-banner warn collector-banner-compact" role="alert">{error}</p>}
          {message && <p className="hint collector-capture-status" role="status">{message}</p>}

          {frozen && shot && (
            <div className="collector-capture-freeze-actions" role="region" aria-label="Capture confirmation">
              <small>
                {roi && anchor
                  ? `Vùng ${roi.width}×${roi.height} · neo ${anchor.x},${anchor.y}`
                  : "Kéo trên khung đóng băng để chọn vùng"}
              </small>
              {roi && (
                <button type="button" disabled={locked || extending} onClick={resetRoi}>
                  Reset ROI
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={locked || busy || !roi || extending}
                onClick={() => void confirmCapture()}
              >
                Confirm Capture
              </button>
              <button type="button" disabled={locked || (busy && !frozen)} onClick={() => void cancelFreeze()}>
                Cancel
              </button>
            </div>
          )}
        </aside>
      </div>

      {frozen && shot && hostClient && imageBox && previewSrcUrl && (
        <div
          ref={surfaceRef}
          className="collector-capture-freeze snapshot collector-capture-freeze-tall"
          style={{
            position: "fixed",
            left: hostClient.left,
            top: hostClient.top,
            width: hostClient.width,
            height: hostClient.height,
            zIndex: 40,
            margin: 0,
            boxSizing: "border-box",
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="img"
          aria-label="Frozen browser capture for ROI"
        >
          <div
            ref={previewScrollRef}
            className="collector-capture-preview-scroll"
            aria-label="Accumulated capture preview scrollbar"
          >
            <div
              className="collector-capture-preview-canvas"
              style={{ width: imageBox.width, height: imageBox.height, position: "relative" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                src={previewSrcUrl}
                alt="Accumulated capture"
                draggable={false}
                style={{
                  display: "block",
                  width: imageBox.width,
                  height: imageBox.height,
                  maxWidth: "none",
                  maxHeight: "none",
                  objectFit: "fill",
                }}
              />
              {liveRoi && liveRoi.width > 0 && liveRoi.height > 0 && (
                <div
                  className="collector-roi-highlight"
                  style={{
                    left: (liveRoi.x / imageWidth) * imageBox.width,
                    top: (liveRoi.y / imageHeight) * imageBox.height,
                    width: (liveRoi.width / imageWidth) * imageBox.width,
                    height: (liveRoi.height / imageHeight) * imageBox.height,
                  }}
                >
                  {roi && !locked && (["right", "bottom", "corner"] as const).map((edge) => (
                    <span
                      key={edge}
                      className={`collector-roi-resize-handle collector-roi-resize-${edge}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`Resize ROI ${edge} edge`}
                      onPointerDown={(e) => startResize(e, edge)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          {extending && (
            <div className="collector-capture-extend-progress" role="status" aria-live="polite">
              Đang mở rộng vùng chụp...
            </div>
          )}
        </div>
      )}

      {libraryOpen && (
        <CaptureLibraryDrawer
          draft={draft}
          items={captures}
          locked={locked}
          invoke={invoke}
          onClose={() => setLibraryOpen(false)}
          onDelete={(id) => onChange(deleteCaptureItem(draft, id))}
        />
      )}
    </div>
  );
}

export type { Command };
