import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserCoreNavigationResult, Rect, State } from "../../shared/contracts";
import { dragToCaptureRoi } from "../../shared/collector-browser-host";
import { clientToImageCoords } from "../../shared/collectors/roi-preview-interaction";
import { DEFAULT_POST_DETAIL_FIXTURE_URL } from "../../shared/post-detail-collector/types";
import {
  assertCaptureFromSocialPage,
  assertNavigateToSocialTarget,
  resolvePostDetailNavigationOutcome,
} from "../../shared/post-detail-collector/social-url";
import {
  BROWSER_CORE_UNAVAILABLE,
  collectorFreezeFrame,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
} from "../collectors/browser-capture";
import {
  claimCollectorHostOwner,
  isCollectorHostOwner,
  releaseCollectorHostOwner,
} from "../collectors/collector-host-owner";
import { cropDataUrl } from "./image-utils";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import type { BrowserProbe, Invoke, VisualReferenceSample } from "./types";

type Props = {
  invoke: Invoke;
  state?: State | null;
  sourceUrl: string;
  browserUrl: string;
  visualReferences: VisualReferenceSample[];
  onSourceUrl: (url: string) => void;
  onBrowserUrl: (url: string) => void;
  onUpdateReferences: (samples: VisualReferenceSample[]) => void;
  onScreenshot: (shot: { id: string; dataUrl: string; width: number; height: number } | null) => void;
  onProbeRefresh: () => Promise<BrowserProbe | null>;
  onNext: () => void;
};

type DragState = { kind: "select"; startX: number; startY: number; currentX: number; currentY: number };
type HostClient = { left: number; top: number; width: number; height: number };

function sameRect(a: Rect, b: Rect, tol = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

export function BrowserCaptureStep({
  invoke,
  state,
  sourceUrl,
  browserUrl,
  visualReferences,
  onSourceUrl,
  onBrowserUrl,
  onUpdateReferences,
  onScreenshot,
  onProbeRefresh,
  onNext,
}: Props) {
  const electron = isElectronBrowserCoreAvailable();
  /** Source URL = user intent. Never assume BrowserCore is already here. */
  const [sourceDraft, setSourceDraft] = useState(sourceUrl || DEFAULT_POST_DETAIL_FIXTURE_URL);
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [message, setMessage] = useState("");
  const [shot, setShot] = useState<{ id: string; dataUrl: string; width: number; height: number }>();
  /** Step 1 ROI = visual reference / action-row anchor — NOT OCR content ROI. */
  const [anchorRoi, setAnchorRoi] = useState<Rect | undefined>();
  const [drag, setDrag] = useState<DragState>();
  const [hostClient, setHostClient] = useState<HostClient | null>(null);
  const [sampleLabel, setSampleLabel] = useState("like");

  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const shotRef = useRef<typeof shot>(undefined);
  const hostClientRef = useRef<HostClient | null>(null);
  const frozenRef = useRef(frozen);
  const imageBoxRef = useRef<{ width: number; height: number } | null>(null);
  const imageSizeRef = useRef({ width: 0, height: 0 });
  const confirmingRef = useRef(false);

  const imageWidth = shot?.width ?? 0;
  const imageHeight = shot?.height ?? 0;
  imageSizeRef.current = { width: imageWidth, height: imageHeight };
  frozenRef.current = frozen;

  const imageBox = useMemo(() => {
    if (!hostClient || !imageWidth || !imageHeight) return null;
    const width = hostClient.width;
    const height = (imageHeight / imageWidth) * width;
    return { width, height };
  }, [hostClient, imageWidth, imageHeight]);
  imageBoxRef.current = imageBox;

  const publishHost = React.useCallback(() => {
    if (!electron || !invoke) return;
    const client = publishPostDetailBrowserHost(invoke, hostRef.current);
    if (client) setHostClient(client);
    else if (!hostRef.current) setHostClient(null);
  }, [electron, invoke]);

  useEffect(() => {
    if (!electron || !invoke) return;
    const { ownerId } = claimCollectorHostOwner("pdc-step1");
    const safePublish = () => {
      if (!isCollectorHostOwner(ownerId)) return;
      publishHost();
    };
    safePublish();
    const rafIds = [
      requestAnimationFrame(safePublish),
      requestAnimationFrame(() => requestAnimationFrame(safePublish)),
    ];
    const el = hostRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => safePublish()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", safePublish);
    window.addEventListener("scroll", safePublish, true);
    void collectorSetBrowserVisible(invoke, true).then(() => {
      requestAnimationFrame(safePublish);
    });
    return () => {
      for (const id of rafIds) cancelAnimationFrame(id);
      ro?.disconnect();
      window.removeEventListener("resize", safePublish);
      window.removeEventListener("scroll", safePublish, true);
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
  }, [electron, invoke, publishHost]);

  // Sync browser URL from live BrowserCore / parent state — do not overwrite Source URL.
  useEffect(() => {
    const live = state?.url && state.url !== "about:blank" && /^https?:\/\//i.test(state.url) ? state.url : "";
    if (live) onBrowserUrl(live);
  }, [state?.url, onBrowserUrl]);

  useEffect(() => {
    setSourceDraft(sourceUrl || DEFAULT_POST_DETAIL_FIXTURE_URL);
  }, [sourceUrl]);

  async function openUrl() {
    if (!invoke || busy || frozen) return;
    setError("");
    setWarning("");
    setBusy(true);
    try {
      const target = assertNavigateToSocialTarget(sourceDraft);
      onSourceUrl(target.url);
      setSourceDraft(target.url);

      const nav = await invoke<BrowserCoreNavigationResult>({
        type: "postDetailNavigate",
        url: target.url,
      });
      const probe = await onProbeRefresh();
      const finalUrl = (probe?.url || nav.finalUrl || "").trim();
      const outcome = resolvePostDetailNavigationOutcome({
        requestedUrl: target.url,
        finalUrl,
        navOk: Boolean(nav.ok),
        navStatus: nav.status,
        navError: nav.error,
      });
      onBrowserUrl(outcome.browserUrl);

      if (!outcome.ok) {
        throw new Error(outcome.error || "Navigation failed.");
      }
      if (outcome.warning) setWarning(outcome.warning);
      setMessage(`Browser URL: ${outcome.browserUrl}. Browser Live Mode — có thể tương tác bình thường.`);
      publishHost();
    } catch (e) {
      // Last-chance: if BrowserCore already landed on social despite thrown ERR_ABORTED.
      try {
        const probe = await onProbeRefresh();
        const actual = probe?.url || "";
        if (probe?.isSocialPage && actual) {
          const recovered = resolvePostDetailNavigationOutcome({
            requestedUrl: sourceDraft,
            finalUrl: actual,
            navOk: false,
            navStatus: "FAILED",
            navError: e instanceof Error ? e.message : String(e),
          });
          if (recovered.ok) {
            onBrowserUrl(recovered.browserUrl);
            setWarning(recovered.warning || "Navigation aborted nhưng trang social đã sẵn sàng.");
            setError("");
            setMessage(`Browser URL: ${recovered.browserUrl}`);
            publishHost();
            return;
          }
        }
      } catch {
        /* fall through */
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function enterCaptureMode() {
    if (!invoke || busy) return;
    setError("");
    setWarning("");
    setBusy(true);
    setMessage("Đang kiểm tra trang social rồi đóng băng screenshot...");
    try {
      const probe = await onProbeRefresh();
      if (probe?.url) onBrowserUrl(probe.url);
      assertCaptureFromSocialPage(probe?.url || browserUrl || state?.url || "");
      publishHost();
      const image = await collectorFreezeFrame(invoke);
      if (!image.bounds || image.bounds.width < 4 || image.bounds.height < 4) {
        throw new Error("Không lấy được kích thước viewport BrowserCore.");
      }
      setShot(image);
      shotRef.current = image;
      onScreenshot(image);
      setAnchorRoi(undefined);
      setDrag(undefined);
      setFrozen(true);
      frozenRef.current = true;
      publishHost();
      setMessage(
        "Capture Mode ON · Kéo ROI visual reference (Like/Comment/Share). Confirm sẽ tự lưu reference — không phải OCR content ROI.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFrozen(false);
      frozenRef.current = false;
      setShot(undefined);
      try {
        await collectorSetBrowserVisible(invoke, true);
        publishHost();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function exitCaptureMode(status = "Đã quay lại Browser Live Mode. Giữ nguyên trang và scroll.") {
    if (!invoke) return;
    setBusy(true);
    setError("");
    setDrag(undefined);
    setShot(undefined);
    setAnchorRoi(undefined);
    setFrozen(false);
    frozenRef.current = false;
    try {
      await collectorSetBrowserVisible(invoke, true);
      publishHost();
      setMessage(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pointerPos(e: { clientX: number; clientY: number }) {
    const box = imageBoxRef.current;
    const { width: iw, height: ih } = imageSizeRef.current;
    if (!box || !iw || !ih) return { x: 0, y: 0 };
    const scroller = previewScrollRef.current;
    if (!scroller) {
      const host = hostClientRef.current;
      if (!host) return { x: 0, y: 0 };
      return clientToImageCoords(
        e.clientX,
        e.clientY,
        { left: host.left, top: host.top, scrollLeft: 0, scrollTop: 0 },
        box,
        iw,
        ih,
      );
    }
    const rect = scroller.getBoundingClientRect();
    return clientToImageCoords(
      e.clientX,
      e.clientY,
      { left: rect.left, top: rect.top, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop },
      box,
      iw,
      ih,
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!frozen || !shot || anchorRoi) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    const next: DragState = { kind: "select", startX: p.x, startY: p.y, currentX: p.x, currentY: p.y };
    setDrag(next);
    dragRef.current = next;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = pointerPos(e);
    const next: DragState = { ...d, currentX: p.x, currentY: p.y };
    setDrag(next);
    dragRef.current = next;
  }

  function onPointerUp(e: React.PointerEvent) {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const d = dragRef.current;
    if (!d) return;
    setDrag(undefined);
    dragRef.current = undefined;
    const nextRoi = dragToCaptureRoi(d.startX, d.startY, d.currentX, d.currentY);
    if (nextRoi && nextRoi.width >= 4 && nextRoi.height >= 4) {
      setAnchorRoi(nextRoi);
      setMessage(
        `Đã chọn visual reference ROI ${Math.round(nextRoi.width)}×${Math.round(nextRoi.height)}px. Confirm để lưu.`,
      );
    } else {
      setAnchorRoi(undefined);
    }
  }

  async function buildReferenceFromRoi(
    image: { id: string; dataUrl: string; width: number; height: number },
    roi: Rect,
    existing: VisualReferenceSample[],
  ): Promise<VisualReferenceSample[]> {
    const dup = existing.find((s) => sameRect(s.bbox, roi));
    if (dup) return existing;
    const cropped = await cropDataUrl(image.dataUrl, roi);
    const sample: VisualReferenceSample = {
      sampleId: `vr_${Date.now().toString(36)}`,
      label: sampleLabel.trim() || `sample-${existing.length + 1}`,
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
      sourceCaptureId: image.id,
      bbox: roi,
      createdAt: new Date().toISOString(),
    };
    return [...existing, sample];
  }

  async function confirmAndLive() {
    if (confirmingRef.current) return;
    if (!anchorRoi) {
      setError("Cần kéo chọn ROI visual reference trước khi Confirm.");
      return;
    }
    if (!shot) {
      setError("Thiếu screenshot evidence — bật Capture Mode lại.");
      return;
    }
    confirmingRef.current = true;
    setBusy(true);
    setError("");
    setWarning("");
    try {
      const nextRefs = await buildReferenceFromRoi(shot, anchorRoi, visualReferences);
      if (nextRefs === visualReferences) {
        setWarning("Reference trùng ROI đã có — không tạo duplicate.");
      }
      onUpdateReferences(nextRefs);
      onScreenshot(shot);
      // contentRoi is Step 2 OCR region — never set from action-row ROI here.
      await exitCaptureMode(
        `Đã lưu ${nextRefs.length} visual reference · quay lại Browser Live Mode.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    } finally {
      confirmingRef.current = false;
    }
  }

  hostClientRef.current = hostClient;
  shotRef.current = shot;

  const liveRoi = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : anchorRoi;

  const canNext = visualReferences.length > 0;
  const browserLive = Boolean(browserUrl && browserUrl !== "about:blank");

  if (!electron) {
    return <div className="pdc-alert pdc-alert-warn">{BROWSER_CORE_UNAVAILABLE}</div>;
  }

  return (
    <div className="pdc-step pdc-step-calibration">
      <div className="pdc-section-header">
        <div>
          <h2>Step 1 — Browser & Detail Capture</h2>
          <p className="pdc-subtitle">
            Confirm tự lưu visual reference (action row), không phải OCR content ROI.
          </p>
        </div>
        <button
          type="button"
          className={`pdc-btn ${frozen ? "pdc-btn-warn" : "pdc-btn-primary"}`}
          disabled={busy}
          onClick={() => {
            if (frozen) void exitCaptureMode();
            else void enterCaptureMode();
          }}
        >
          {frozen ? "Thoát Capture → Live" : "Capture Mode ON"}
        </button>
      </div>

      <div className="pdc-toolbar pdc-toolbar-stack">
        <label className="pdc-field pdc-url-field">
          Source URL
          <input
            className="pdc-url-input"
            readOnly
            value={sourceDraft}
            placeholder={DEFAULT_POST_DETAIL_FIXTURE_URL}
            aria-label="Source URL"
          />
        </label>
        <button type="button" className="pdc-btn pdc-btn-secondary" disabled={busy || frozen} onClick={() => void openUrl()}>
          Open URL
        </button>
        <span className={`pdc-mode ${frozen ? "frozen" : "live"}`}>
          {frozen ? "CAPTURE MODE" : "BROWSER LIVE"}
        </span>
      </div>
      {error && <div className="pdc-alert pdc-alert-error">{error}</div>}
      {warning && <div className="pdc-alert pdc-alert-warn">{warning}</div>}
      {message && <div className="pdc-alert pdc-alert-info">{message}</div>}

      <div className="pdc-calibration-workspace">
        <div className="pdc-crop-container">
          <div className="collector-capture-workspace collector-browser-workspace">
            <div
              ref={hostRef}
              className="collector-browser-host"
              data-browser-core-host=""
              aria-label="Browser Core live workspace"
            >
              {!browserLive && !frozen && (
                <div className="collector-sample-empty collector-browser-host-placeholder">
                  Nhập Source URL rồi bấm Open URL. BrowserCore Default sẽ điều hướng vào khung này.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="pdc-side-panel">
          <h3>Visual References</h3>
          <p className="pdc-panel-desc">
            Confirm = lưu reference từ ROI vừa chọn rồi về Live. OCR content ROI chọn ở Step 2.
          </p>
          <label className="pdc-field">
            Sample label
            <input value={sampleLabel} disabled={!frozen || busy} onChange={(e) => setSampleLabel(e.target.value)} />
          </label>
          <div className="pdc-btn-row">
            <button
              type="button"
              className="pdc-btn pdc-btn-primary"
              disabled={!frozen || !anchorRoi || busy}
              onClick={() => void confirmAndLive()}
            >
              Confirm → Save ref → Live
            </button>
          </div>
          <p className="pdc-panel-desc">References: {visualReferences.length}</p>
          <ul className="pdc-sample-list">
            {visualReferences.map((s) => (
              <li key={s.sampleId}>
                {s.dataUrl ? <img src={s.dataUrl} alt={s.label} /> : null}
                <span>
                  {s.label} · {s.width}×{s.height}
                </span>
                <button
                  type="button"
                  className="pdc-btn pdc-btn-tiny"
                  onClick={() => onUpdateReferences(visualReferences.filter((x) => x.sampleId !== s.sampleId))}
                >
                  Remove
                </button>
              </li>
            ))}
            {!visualReferences.length && <li className="pdc-muted">Chưa có visual reference — Confirm sau khi kéo ROI.</li>}
          </ul>
          <button
            type="button"
            className="pdc-btn pdc-btn-primary"
            disabled={!canNext}
            title={canNext ? undefined : "Cần ≥1 visual reference trước khi sang Step 2"}
            onClick={onNext}
          >
            Next: Visual Region →
          </button>
        </div>
      </div>

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
          aria-label="Frozen browser capture for visual reference crop"
        >
          <div
            ref={previewScrollRef}
            className="collector-capture-preview-scroll"
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
          >
            <div style={{ width: imageBox.width, height: imageBox.height, position: "relative" }}>
              <img
                src={shot.dataUrl}
                alt="Frozen capture"
                draggable={false}
                style={{
                  display: "block",
                  width: imageBox.width,
                  height: imageBox.height,
                  maxWidth: "none",
                  maxHeight: "none",
                  objectFit: "fill",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
              {liveRoi && liveRoi.width > 0 && liveRoi.height > 0 && (
                <div
                  className="collector-roi-highlight"
                  style={{
                    left: (liveRoi.x / shot.width) * imageBox.width,
                    top: (liveRoi.y / shot.height) * imageBox.height,
                    width: (liveRoi.width / shot.width) * imageBox.width,
                    height: (liveRoi.height / shot.height) * imageBox.height,
                    border: "2px solid #34d399",
                    background: "rgba(52, 211, 153, 0.2)",
                    position: "absolute",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
