import React, { useEffect, useMemo, useRef, useState } from "react";
import { previewSrc } from "../../shared/collectors/fixtures";
import {
  addCaptureItem,
  auditForCapture,
  captureLibraryCount,
  deleteCaptureItem,
} from "../../shared/collectors/ops";
import type { CaptureItem, CollectorDraft } from "../../shared/collectors/types";
import type { BrowserSession, Capture, Command, Rect, State } from "../../shared/contracts";
import {
  assertRoiFitsCapture,
  clientPointToCaptureCoords,
  domRectToShellBounds,
  dragToCaptureRoi,
  fitCaptureImageInDisplay,
} from "../../shared/collector-browser-host";
import { readAdminUiZoom } from "../ui-zoom";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorCropRoi,
  collectorFreezeFrame,
  collectorLoadImageAsset,
  collectorNavigate,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
  roiToSampleRoi,
  type CollectorInvoke,
} from "./browser-capture";

type Props = {
  draft: CollectorDraft;
  locked: boolean;
  onChange: (next: CollectorDraft) => void;
  invoke?: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
};

type DragState = { startX: number; startY: number; currentX: number; currentY: number };
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
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [shot, setShot] = useState<Capture>();
  const [roi, setRoi] = useState<Rect>();
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const captures = draft.captures ?? [];
  const count = captureLibraryCount(draft);
  const sessions: BrowserSession[] = state?.browserSessions ?? [];
  const activeSessionId = state?.activeBrowserSessionId;

  const imageBox = useMemo(() => {
    if (!hostClient || !shot) return null;
    return fitCaptureImageInDisplay(
      hostClient.width,
      hostClient.height,
      shot.width,
      shot.height,
    );
  }, [hostClient, shot]);

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
      void collectorReportBrowserHost(invoke, null);
      void collectorSetBrowserVisible(invoke, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount Capture host lifecycle only
  }, [electron, invoke, publishHost]);

  useEffect(() => {
    if (state?.url) setUrl(state.url);
  }, [state?.url]);

  async function restoreBrowse(status: string) {
    if (!invoke) return;
    setShot(undefined);
    setRoi(undefined);
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
      setRoi(undefined);
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
      // Sync host → Browser Core bounds before CDP capture so freeze matches the live view.
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      if (!image.bounds || image.bounds.width < 4 || image.bounds.height < 4) {
        throw new Error("Capture missing Browser Core viewport bounds — cannot freeze faithfully.");
      }
      setShot(image);
      setRoi(undefined);
      setFrozen(true);
      publishHost();
      setMessage(
        `Select ROI on frozen viewport ${image.bounds.width}×${image.bounds.height} (image ${image.width}×${image.height}).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFrozen(false);
      setShot(undefined);
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

  function pointerPos(e: React.PointerEvent) {
    if (!hostClient || !shot || !imageBox) return { x: 0, y: 0 };
    return clientPointToCaptureCoords(
      e.clientX,
      e.clientY,
      hostClient,
      shot.width,
      shot.height,
      imageBox,
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (locked || !frozen || !shot) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    setRoi(undefined);
    setDrag({ startX: p.x, startY: p.y, currentX: p.x, currentY: p.y });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = pointerPos(e);
    setDrag({ ...drag, currentX: p.x, currentY: p.y });
  }

  function onPointerUp() {
    if (!drag || !shot) return;
    const next = dragToCaptureRoi(drag.startX, drag.startY, drag.currentX, drag.currentY);
    setDrag(undefined);
    setRoi(next ?? undefined);
  }

  async function confirmCapture() {
    if (!invoke || !shot || !roi || locked || busy) return;
    setBusy(true);
    setError("");
    try {
      const fitted = assertRoiFitsCapture(roi, shot.width, shot.height);
      const cropped = await collectorCropRoi(invoke, shot.id, fitted);
      onChange(
        addCaptureItem(draft, {
          captureUrl: shot.url || url,
          roi: roiToSampleRoi(cropped.roi, shot.width, shot.height),
          imageAsset: cropped.asset,
          browserSessionId: activeSessionId,
          simulatedCapture: false,
        }),
      );
      // Visibility only — do not navigate; preserves scroll position.
      await restoreBrowse("Capture saved. Continue browsing or capture again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelFreeze() {
    if (!invoke || busy) return;
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

  const liveRoi = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
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
          </span>
          <button type="button" disabled={locked || busy} onClick={() => setLibraryOpen(true)}>
            Library ({count})
          </button>

          {error && <p className="collector-banner warn collector-banner-compact" role="alert">{error}</p>}
          {message && <p className="hint collector-capture-status" role="status">{message}</p>}

          {frozen && shot && (
            <div className="collector-capture-freeze-actions" role="region" aria-label="Capture confirmation">
              <small>
                {roi
                  ? `ROI ${roi.width}×${roi.height} at ${roi.x},${roi.y}`
                  : "Drag on the frozen frame to select a region"}
              </small>
              <button
                type="button"
                className="primary"
                disabled={locked || busy || !roi}
                onClick={() => void confirmCapture()}
              >
                Confirm Capture
              </button>
              <button type="button" disabled={locked || busy} onClick={() => void cancelFreeze()}>
                Cancel
              </button>
            </div>
          )}
        </aside>
      </div>

      {/*
        Pixel-faithful freeze: hide WebContentsView, paint screenshot in the exact host
        client rectangle. React cannot stack above a native view — freeze is required.
      */}
      {frozen && shot && hostClient && imageBox && (
        <div
          ref={surfaceRef}
          className="collector-capture-freeze snapshot"
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
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="img"
          aria-label="Frozen browser capture for ROI"
        >
          <img
            src={shot.dataUrl}
            alt="Frozen browser frame"
            draggable={false}
            style={{
              position: "absolute",
              left: imageBox.x,
              top: imageBox.y,
              width: imageBox.width,
              height: imageBox.height,
              display: "block",
              maxWidth: "none",
              maxHeight: "none",
              objectFit: "fill",
            }}
          />
          {liveRoi && liveRoi.width > 0 && liveRoi.height > 0 && (
            <div
              className="collector-roi-highlight"
              style={{
                left: imageBox.x + (liveRoi.x / shot.width) * imageBox.width,
                top: imageBox.y + (liveRoi.y / shot.height) * imageBox.height,
                width: (liveRoi.width / shot.width) * imageBox.width,
                height: (liveRoi.height / shot.height) * imageBox.height,
              }}
            />
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
