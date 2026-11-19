import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppPage, State } from "../../shared/contracts";
import type {
  CollectorCaptureSessionRecord,
  CollectorCaptureStatus,
  NetworkRequestMetaRecord,
} from "../../shared/collectors/capture-session-types";
import type { VisualObservationRecord } from "../../shared/collectors/visual-observation-types";
import { resolveScriptPartRefs } from "../../shared/collectors/script-part-refs";
import {
  networkPartOptionKey,
  resolveNetworkPartBinding,
  type NetworkPartOption,
} from "../../shared/collectors/network-part-binding";
import {
  activeVisualPartFromBinding,
  resolveVisualPartBinding,
  visualPartOptionKey,
} from "../../shared/collectors/visual-part-binding";
import { WEB_HEIGHT, WEB_WIDTH } from "../../shared/geometry";
import {
  collectorNavigate,
  collectorReportBrowserHost,
  collectorSetBrowserVisible,
  isElectronBrowserCoreAvailable,
  type CollectorInvoke,
} from "./browser-capture";
import {
  claimCollectorHostOwner,
  isCollectorHostOwner,
  releaseCollectorHostOwner,
} from "./collector-host-owner";
import { publishCollectorHostFromElement } from "./publish-collector-host";
import { createRafHostPublishScheduler } from "../post-detail-collector/publish-browser-host";
import { getActiveCollectorScriptId, setActiveCollectorScriptId } from "./active-script-session";
import {
  createVisualRuntimeSeenState,
  observeVisualFeedOnce,
  type VisualRuntimeSeenState,
} from "./visual-runtime-observe";
import { usePartLibraryStore } from "./usePartLibraryStore";
import "./part-library.css";

type Props = {
  locked: boolean;
  navigate: (page: AppPage) => void;
  invoke: CollectorInvoke;
  state?: State | null;
  onSelectSession?: (id: string) => void;
};

type CaptureStatusResponse = {
  status: CollectorCaptureStatus | "idle";
  session: CollectorCaptureSessionRecord | null;
  browserSessionId?: string;
  browserUrl?: string;
  cdpGeneration?: number;
};

type BodyPreviewResponse = {
  ok: boolean;
  truncated: boolean;
  contentTypeHint: "json" | "text" | "binary";
  preview: string;
  bytes: number;
  error?: string;
};

const PREVIEW_MAX_BYTES = 48_000;

/** In-memory Visual evidence keyed by captureSessionId (disk write awaits IPC approval). */
const visualEvidenceBySession = new Map<string, VisualObservationRecord[]>();

export function getVisualEvidenceForSession(captureSessionId: string): VisualObservationRecord[] {
  return visualEvidenceBySession.get(captureSessionId)?.slice() ?? [];
}

export function clearVisualEvidenceForSession(captureSessionId: string): void {
  visualEvidenceBySession.delete(captureSessionId);
}

function appendVisualEvidence(record: VisualObservationRecord): void {
  const list = visualEvidenceBySession.get(record.captureSessionId) ?? [];
  list.push(record);
  visualEvidenceBySession.set(record.captureSessionId, list);
}

export function CollectorScriptWorkspace({
  locked,
  navigate,
  invoke,
  state,
  onSelectSession,
}: Props) {
  const store = usePartLibraryStore();
  const scriptId = getActiveCollectorScriptId();
  const script = scriptId ? store.repository.getScript(scriptId) : undefined;

  const [selectedNetworkKey, setSelectedNetworkKey] = useState<string | null>(null);
  const [selectedVisualKey, setSelectedVisualKey] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatusResponse>({
    status: "idle",
    session: null,
  });
  const [sessions, setSessions] = useState<CollectorCaptureSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<NetworkRequestMetaRecord[]>([]);
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  const [visualObservations, setVisualObservations] = useState<VisualObservationRecord[]>([]);
  const [visualSeen, setVisualSeen] = useState<VisualRuntimeSeenState>(() => createVisualRuntimeSeenState());
  const [selectedArtifact, setSelectedArtifact] = useState<NetworkRequestMetaRecord | null>(null);
  const [preview, setPreview] = useState<BodyPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [visualBusy, setVisualBusy] = useState(false);
  const [error, setError] = useState("");
  const [visualMessage, setVisualMessage] = useState("");
  const [urlInput, setUrlInput] = useState(state?.url ?? "");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const electron = isElectronBrowserCoreAvailable();
  const captureBrowserSessionRef = useRef<string | null>(null);

  const partsLookup = useMemo(() => {
    const map = new Map<
      string,
      { name: string; partType: "visual" | "network"; version: number } | undefined
    >();
    for (const p of store.parts) {
      map.set(p.partId, { name: p.name, partType: p.partType, version: p.version });
    }
    return map;
  }, [store.parts]);

  const resolvedRefs = useMemo(
    () => (script ? resolveScriptPartRefs(script.partRefs, partsLookup) : []),
    [script, partsLookup],
  );

  const networkBinding = useMemo(
    () =>
      script
        ? resolveNetworkPartBinding(script.partRefs, store.parts, selectedNetworkKey)
        : {
            kind: "none" as const,
            reason: "No Collector Script selected.",
            options: [] as [],
          },
    [script, store.parts, selectedNetworkKey],
  );

  const visualBinding = useMemo(
    () =>
      script
        ? resolveVisualPartBinding(script.partRefs, store.parts, selectedVisualKey)
        : {
            kind: "none" as const,
            reason: "No Collector Script selected.",
            options: [] as [],
          },
    [script, store.parts, selectedVisualKey],
  );

  const activeNetworkPart: NetworkPartOption | undefined =
    networkBinding.kind === "single"
      ? networkBinding.selected
      : networkBinding.kind === "multiple"
        ? networkBinding.options.find((o) => networkPartOptionKey(o) === selectedNetworkKey)
        : undefined;

  const activeVisualPart = activeVisualPartFromBinding(visualBinding);
  const visualReady =
    Boolean(activeVisualPart?.templatesComplete) &&
    (visualBinding.kind === "single" ||
      (visualBinding.kind === "multiple" && Boolean(visualBinding.selected)));

  const capturing =
    captureStatus.status === "running" || captureStatus.status === "stopping";

  const refreshStatus = useCallback(async () => {
    if (!electron) return;
    try {
      const next = await invoke<CaptureStatusResponse>({ type: "collectorNetworkCaptureStatus" });
      setCaptureStatus(next);
      if (next.browserUrl) setUrlInput(next.browserUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [electron, invoke]);

  const refreshSessions = useCallback(async () => {
    if (!electron || !scriptId) return;
    try {
      const list = await invoke<CollectorCaptureSessionRecord[]>({
        type: "collectorNetworkCaptureListSessions",
        scriptId,
        limit: 40,
      });
      setSessions(list);
      if (!selectedSessionId && list[0]) setSelectedSessionId(list[0].captureSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [electron, invoke, scriptId, selectedSessionId]);

  const loadEvidence = useCallback(
    async (captureSessionId: string) => {
      if (!electron || !captureSessionId) return;
      try {
        const result = await invoke<{
          total: number;
          offset: number;
          items: NetworkRequestMetaRecord[];
        }>({
          type: "collectorNetworkCaptureListRequests",
          captureSessionId,
          limit: 200,
          offset: 0,
        });
        setEvidence(result.items);
        setEvidenceTotal(result.total);
        setVisualObservations(getVisualEvidenceForSession(captureSessionId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [electron, invoke],
  );

  useEffect(() => {
    void refreshStatus();
    void refreshSessions();
  }, [refreshStatus, refreshSessions]);

  useEffect(() => {
    if (!capturing) return;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 1500);
    return () => window.clearInterval(id);
  }, [capturing, refreshStatus]);

  useEffect(() => {
    const liveId = captureStatus.session?.captureSessionId;
    if (capturing && liveId) {
      setSelectedSessionId(liveId);
      void loadEvidence(liveId);
      return;
    }
    if (selectedSessionId) void loadEvidence(selectedSessionId);
  }, [
    capturing,
    captureStatus.session?.captureSessionId,
    selectedSessionId,
    loadEvidence,
  ]);

  // Browser Session switch while capturing: Network controller stops ownership; reset Visual seen.
  useEffect(() => {
    const activeId = state?.activeBrowserSessionId ?? null;
    const owned = captureBrowserSessionRef.current;
    if (capturing && owned && activeId && owned !== activeId) {
      captureBrowserSessionRef.current = activeId;
      setVisualSeen(createVisualRuntimeSeenState());
      setVisualMessage(
        "Browser Session changed — Visual dedupe reset. Network capture ownership stopped for the previous session.",
      );
      void refreshStatus();
      void refreshSessions();
    }
  }, [state?.activeBrowserSessionId, capturing, refreshStatus, refreshSessions]);

  useEffect(() => {
    if (!electron) return;
    let cancelled = false;
    const { ownerId } = claimCollectorHostOwner("collector-script-workspace");
    const publish = () => {
      if (cancelled || !isCollectorHostOwner(ownerId)) return;
      publishCollectorHostFromElement(invoke, hostRef.current);
    };
    const scheduler = createRafHostPublishScheduler(publish);
    publish();
    const rafId = requestAnimationFrame(publish);
    const el = hostRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduler.schedule()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", scheduler.schedule);
    window.addEventListener("scroll", scheduler.schedule, true);
    void collectorSetBrowserVisible(invoke, true).then(() => scheduler.schedule());
    return () => {
      cancelled = true;
      scheduler.cancel();
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener("resize", scheduler.schedule);
      window.removeEventListener("scroll", scheduler.schedule, true);
      releaseCollectorHostOwner(ownerId, () => {
        void collectorReportBrowserHost(invoke, null);
        void collectorSetBrowserVisible(invoke, false);
      });
    };
  }, [electron, invoke]);

  async function startCapture() {
    if (!script || !activeNetworkPart || busy || capturing) return;
    setBusy(true);
    setError("");
    setVisualMessage("");
    try {
      const session = await invoke<CollectorCaptureSessionRecord>({
        type: "collectorNetworkCaptureStart",
        scriptId: script.scriptId,
        networkPartId: activeNetworkPart.partId,
        networkPartVersion: activeNetworkPart.partVersion,
        sourceUrl: urlInput || state?.url,
      });
      captureBrowserSessionRef.current = state?.activeBrowserSessionId ?? null;
      setVisualSeen(createVisualRuntimeSeenState());
      setCaptureStatus({
        status: session.status,
        session,
        browserSessionId: state?.activeBrowserSessionId,
        browserUrl: urlInput || state?.url,
      });
      setSelectedSessionId(session.captureSessionId);
      setVisualObservations(getVisualEvidenceForSession(session.captureSessionId));
      await refreshSessions();
      await loadEvidence(session.captureSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopCapture() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const stopped = await invoke<{
        status: CollectorCaptureStatus | "idle";
        session?: CollectorCaptureSessionRecord;
      }>({ type: "collectorNetworkCaptureStop", reason: "manual" });
      captureBrowserSessionRef.current = null;
      setCaptureStatus({
        status: stopped.status,
        session: stopped.session ?? null,
        browserSessionId: state?.activeBrowserSessionId,
        browserUrl: urlInput,
      });
      await refreshSessions();
      if (stopped.session?.captureSessionId) {
        setSelectedSessionId(stopped.session.captureSessionId);
        await loadEvidence(stopped.session.captureSessionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function observeVisualNow() {
    const liveSession = captureStatus.session;
    if (!capturing || !liveSession?.captureSessionId || !activeVisualPart || !visualReady) return;
    if (
      captureBrowserSessionRef.current &&
      state?.activeBrowserSessionId &&
      captureBrowserSessionRef.current !== state.activeBrowserSessionId
    ) {
      setError("Browser Session changed during capture. Stop and start a new Capture Session.");
      return;
    }
    setVisualBusy(true);
    setError("");
    setVisualMessage("Observing current viewport…");
    try {
      const result = await observeVisualFeedOnce({
        invoke,
        captureSessionId: liveSession.captureSessionId,
        browserSessionId: state?.activeBrowserSessionId,
        visualPart: activeVisualPart,
        sourceUrl: urlInput || state?.url,
        seen: visualSeen,
      });
      if (result.observation) {
        appendVisualEvidence(result.observation);
        setVisualObservations(getVisualEvidenceForSession(liveSession.captureSessionId));
      }
      if (!result.ok) {
        setError(result.error);
        setVisualMessage("Visual observation failed — Network evidence was not discarded.");
        return;
      }
      setVisualSeen(result.seen);
      setVisualMessage(
        `Observation ${result.observation.observationId}: estimated unique items ${result.observation.estimatedUniqueItemCount} (FOUND ${result.observation.boundaryFound}, ambiguous ${result.observation.boundaryAmbiguous}, rows ${result.observation.actionRowsDetected}). Not claimed equal to Network post count.`,
      );
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVisualMessage("Visual observation error — Network capture continues.");
    } finally {
      setVisualBusy(false);
    }
  }

  async function openUrl() {
    if (!electron || busy) return;
    setBusy(true);
    setError("");
    try {
      await collectorNavigate(invoke, urlInput);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function inspectBody(row: NetworkRequestMetaRecord) {
    setSelectedArtifact(row);
    setPreview(null);
    if (!row.bodyPath) {
      setPreview({
        ok: false,
        truncated: false,
        contentTypeHint: "text",
        preview: "",
        bytes: 0,
        error: "No body artifact for this request.",
      });
      return;
    }
    try {
      const result = await invoke<BodyPreviewResponse>({
        type: "collectorNetworkCaptureReadBodyPreview",
        captureSessionId: row.captureSessionId,
        artifactRef: row.bodyPath,
        maxBytes: PREVIEW_MAX_BYTES,
      });
      setPreview(result);
    } catch (err) {
      setPreview({
        ok: false,
        truncated: false,
        contentTypeHint: "text",
        preview: "",
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function goHome() {
    setActiveCollectorScriptId(null);
    navigate("collectors");
  }

  if (!scriptId || !script) {
    return (
      <section className="app-page collectors-page collector-script-workspace" aria-label="Collector Script Workspace">
        <div className="collectors-home-actions">
          <button type="button" onClick={goHome}>
            ← Collector Library
          </button>
        </div>
        <p role="alert">Open a saved Collector Script from the Collector Library to enter its Workspace.</p>
      </section>
    );
  }

  const session = captureStatus.session;
  const quotaMax = session?.limits.maxTotalArtifactBytes ?? 0;
  const quotaUsed = session?.stats.totalArtifactBytes ?? 0;
  const startDisabled =
    locked ||
    busy ||
    capturing ||
    !electron ||
    !state?.activeBrowserSessionId ||
    !activeNetworkPart;
  const observeDisabled =
    locked ||
    visualBusy ||
    busy ||
    !electron ||
    !capturing ||
    !session?.captureSessionId ||
    !visualReady;

  const sessionVisualTotal = visualObservations.reduce((n, o) => n + o.estimatedUniqueItemCount, 0);

  return (
    <section
      className="app-page collectors-page collector-script-workspace"
      aria-label="Collector Script Workspace"
    >
      <div className="csw-workspace-shell">
        <div className="csw-fixed-chrome">
          <div className="collectors-home-heading page-heading">
            <small>Collector Script Workspace · Capture Session</small>
            <h1>{script.name}</h1>
            <p>
              Script v{script.version} · {script.scriptId}. Network + Visual share one Capture Session. Part
              configs are not copied into the Script. Display order is not execution order.
            </p>
          </div>

          <div className="collectors-home-actions">
            <button type="button" onClick={goHome}>
              ← Collector Library
            </button>
          </div>

          {error ? (
            <p className="collector-banner warn" role="alert">
              {error}
            </p>
          ) : null}
          {visualMessage ? (
            <p className="hint" role="status">
              {visualMessage}
            </p>
          ) : null}

          <div className="csw-grid">
            <div className="collectors-home-panel" aria-label="Composition">
              <h2>Referenced Parts</h2>
              <p className="panel-hint">Display order is not execution order.</p>
              {resolvedRefs.length === 0 ? (
                <p className="collectors-home-empty">No Parts referenced.</p>
              ) : (
                <ul className="script-part-ref-list">
                  {resolvedRefs.map((ref, index) => (
                    <li
                      key={`${ref.partId}@${ref.partVersion}@${index}`}
                      className={ref.resolved ? undefined : "missing"}
                    >
                      <div className="script-part-ref-meta">
                        {ref.resolved ? (
                          <>
                            <b>{ref.name}</b>
                            <span className={`part-type-pill ${ref.partType}`}>{ref.partType}</span>
                            <span className="hint">v{ref.partVersion}</span>
                          </>
                        ) : (
                          <>
                            <b>Missing Part</b>
                            <span className="hint">
                              {ref.partId}@v{ref.partVersion}
                            </span>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="collectors-home-panel" aria-label="Capture controls">
              <h2>Network Capture</h2>
              <label className="session-selector">
                Browser Session
                <select
                  aria-label="Browser Session"
                  disabled={locked || busy || capturing || !state?.browserSessions?.length}
                  value={state?.activeBrowserSessionId ?? ""}
                  onChange={(e) => onSelectSession?.(e.target.value)}
                >
                  {(state?.browserSessions ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                Active: {state?.activeBrowserSessionId ?? "none"} · Switching sessions during capture stops
                capture and keeps partial evidence.
              </p>

              {networkBinding.kind === "none" ? (
                <p className="warn-banner" role="status">
                  {networkBinding.reason}
                </p>
              ) : null}
              {networkBinding.kind === "multiple" ? (
                <label>
                  Network Part for capture
                  <select
                    aria-label="Network Part for capture"
                    disabled={locked || capturing}
                    value={selectedNetworkKey ?? ""}
                    onChange={(e) => setSelectedNetworkKey(e.target.value || null)}
                  >
                    <option value="">Select Network Part…</option>
                    {networkBinding.options.map((o) => (
                      <option key={networkPartOptionKey(o)} value={networkPartOptionKey(o)}>
                        {o.name} @ v{o.partVersion}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {activeNetworkPart ? (
                <p className="hint">
                  Using Network Part <b>{activeNetworkPart.name}</b> @ v{activeNetworkPart.partVersion}
                </p>
              ) : null}

              <div className="csw-capture-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={startDisabled}
                  onClick={() => void startCapture()}
                >
                  Start Network Capture
                </button>
                <button type="button" disabled={locked || busy || !capturing} onClick={() => void stopCapture()}>
                  Stop Network Capture
                </button>
                <button type="button" disabled={busy || !electron} onClick={() => void refreshStatus()}>
                  Refresh status
                </button>
              </div>

              <dl className="csw-stats">
                <div>
                  <dt>Status</dt>
                  <dd>{captureStatus.status}</dd>
                </div>
                <div>
                  <dt>Capture session</dt>
                  <dd className="hint">{session?.captureSessionId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Requests tracked</dt>
                  <dd>{session?.stats.requestsTracked ?? 0}</dd>
                </div>
                <div>
                  <dt>Bodies fetched (CDP)</dt>
                  <dd>{session?.stats.bodiesFetched ?? 0}</dd>
                </div>
                <div>
                  <dt>Bodies persisted</dt>
                  <dd>{session?.stats.bodiesSaved ?? 0}</dd>
                </div>
                <div>
                  <dt>JSON parsed ok</dt>
                  <dd>{session?.stats.parseJsonOk ?? 0}</dd>
                </div>
                <div>
                  <dt>NDJSON parsed ok</dt>
                  <dd>{session?.stats.parseNdjsonOk ?? 0}</dd>
                </div>
                <div>
                  <dt>Parse failed / invalid</dt>
                  <dd>{session?.stats.parseInvalid ?? 0}</dd>
                </div>
                <div>
                  <dt>Skipped / unavailable</dt>
                  <dd>{session?.stats.bodiesSkipped ?? 0}</dd>
                </div>
                <div>
                  <dt>Body status breakdown</dt>
                  <dd className="hint">{formatBodyStatusCounts(session?.stats.bodyStatusCounts)}</dd>
                </div>
                <div>
                  <dt>Artifact bytes</dt>
                  <dd>
                    {quotaUsed.toLocaleString()}
                    {quotaMax ? ` / ${quotaMax.toLocaleString()}` : ""}
                    {session?.diagnostics?.some((d) => d.startsWith("quota:")) ? " · quota hit" : ""}
                  </dd>
                </div>
                <div>
                  <dt>Browser URL</dt>
                  <dd className="hint">{captureStatus.browserUrl || state?.url || "—"}</dd>
                </div>
              </dl>

              <div className="csw-visual-panel" aria-label="Visual observation">
                <h2>Visual Feed Observation</h2>
                <p className="panel-hint">
                  Uses Part Library templates only (not legacy globals). One viewport observe — not the
                  five-sample calibration loop. Scroll the embedded Browser manually, then observe.
                </p>
                {visualBinding.kind === "none" ? (
                  <p className="warn-banner" role="status">
                    {visualBinding.reason}
                  </p>
                ) : null}
                {visualBinding.kind === "incomplete" ? (
                  <p className="warn-banner" role="status">
                    {visualBinding.reason}
                  </p>
                ) : null}
                {visualBinding.kind === "multiple" ? (
                  <label>
                    Visual Part for observation
                    <select
                      aria-label="Visual Part for observation"
                      disabled={locked || visualBusy}
                      value={selectedVisualKey ?? ""}
                      onChange={(e) => setSelectedVisualKey(e.target.value || null)}
                    >
                      <option value="">Select Visual Part…</option>
                      {visualBinding.options.map((o) => (
                        <option key={visualPartOptionKey(o)} value={visualPartOptionKey(o)}>
                          {o.name} @ v{o.partVersion}
                          {o.templatesComplete ? "" : " (incomplete templates)"}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {visualBinding.kind === "multiple" && visualBinding.reason ? (
                  <p className="hint" role="status">
                    {visualBinding.reason}
                  </p>
                ) : null}
                {activeVisualPart ? (
                  <p className="hint">
                    Using Visual Part <b>{activeVisualPart.name}</b> @ v{activeVisualPart.partVersion} (
                    {activeVisualPart.partId}) · templates {activeVisualPart.templateKindsReady}/3
                  </p>
                ) : null}
                <div className="csw-capture-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={observeDisabled}
                    onClick={() => void observeVisualNow()}
                  >
                    Observe Visual Now
                  </button>
                </div>
                <dl className="csw-visual-stats">
                  <div>
                    <dt>Observations this session</dt>
                    <dd>{visualObservations.length}</dd>
                  </div>
                  <div>
                    <dt>Est. unique items (UI)</dt>
                    <dd>{sessionVisualTotal}</dd>
                  </div>
                  <div>
                    <dt>Latest FOUND</dt>
                    <dd>{visualObservations.at(-1)?.boundaryFound ?? "—"}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="collectors-home-panel csw-browser-panel" aria-label="Embedded browser">
          <h2>Browser</h2>
          <p className="panel-hint">
            Fixed host {WEB_WIDTH}×{WEB_HEIGHT} DIP. Workspace shell does not scroll this host — Evidence
            scrolls below independently.
          </p>
          <div className="csw-url-row">
            <input
              aria-label="Browser URL"
              value={urlInput}
              disabled={locked || busy}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://"
            />
            <button type="button" disabled={locked || busy || !electron} onClick={() => void openUrl()}>
              Open URL
            </button>
          </div>
          {!electron ? (
            <p className="warn-banner" role="status">
              Real Browser Core unavailable in web-dev. Use the Electron app for live capture.
            </p>
          ) : (
            <div className="csw-browser-panel-body">
              <div className="csw-browser-stage">
                <div
                  ref={hostRef}
                  className="csw-browser-host"
                  data-collector-browser-host="collector-script-workspace"
                  data-viewport-width={WEB_WIDTH}
                  data-viewport-height={WEB_HEIGHT}
                  style={{ width: WEB_WIDTH, height: WEB_HEIGHT }}
                  aria-label={`Browser host ${WEB_WIDTH} by ${WEB_HEIGHT}`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="csw-evidence-scroll" aria-label="Evidence scroll region">
          <div className="csw-evidence-grid">
            <div className="collectors-home-panel" aria-label="Evidence list">
              <h2>Evidence</h2>
              <label>
                Capture session
                <select
                  aria-label="Capture session"
                  value={selectedSessionId ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    setSelectedSessionId(e.target.value || null);
                    setSelectedArtifact(null);
                    setPreview(null);
                    if (e.target.value) {
                      setVisualObservations(getVisualEvidenceForSession(e.target.value));
                    } else {
                      setVisualObservations([]);
                    }
                  }}
                >
                  {sessions.length === 0 ? <option value="">No stored sessions</option> : null}
                  {sessions.map((s) => (
                    <option key={s.captureSessionId} value={s.captureSessionId}>
                      {s.startedAt} · {s.status} · {s.stats.requestsTracked} req
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                Network: {evidence.length} of {evidenceTotal} request rows · Visual observations:{" "}
                {visualObservations.length} (same captureSessionId). HTML container snapshots deferred —
                see diagnostics.
              </p>

              <h3>Visual observations</h3>
              {visualObservations.length === 0 ? (
                <p className="collectors-home-empty">No Visual observations for this session yet.</p>
              ) : (
                <ul className="csw-observation-list">
                  {visualObservations.map((obs) => (
                    <li key={obs.observationId}>
                      <b>{obs.observedAt}</b> · {obs.status} · est. unique {obs.estimatedUniqueItemCount} ·
                      rows {obs.actionRowsDetected} · FOUND {obs.boundaryFound} / amb{" "}
                      {obs.boundaryAmbiguous} / miss {obs.boundaryNotFound} · dup {obs.duplicateCount}
                      <div className="hint">
                        {obs.observationId} · part {obs.visualPartId}@v{obs.visualPartVersion} · session{" "}
                        {obs.captureSessionId}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <h3>Network requests</h3>
              {evidence.length === 0 ? (
                <p className="collectors-home-empty">No network evidence for this session yet.</p>
              ) : (
                <table className="collectors-home-table csw-evidence-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>URL (redacted)</th>
                      <th>Status</th>
                      <th>Type</th>
                      <th>Body</th>
                      <th>Parse</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.map((row) => (
                      <tr key={row.artifactId || `${row.requestId}-${row.timestamp}`}>
                        <td>{row.method}</td>
                        <td className="hint" title={row.urlRedacted}>
                          {truncate(row.urlRedacted, 72)}
                        </td>
                        <td>{row.statusCode ?? "—"}</td>
                        <td className="hint">{truncate(row.contentType || row.mimeType || "—", 28)}</td>
                        <td>{row.bodyPath ? "available" : "unavailable"}</td>
                        <td>{row.bodyStatus}</td>
                        <td>
                          <button type="button" disabled={!row.bodyPath} onClick={() => void inspectBody(row)}>
                            Preview
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="collectors-home-panel" aria-label="JSON preview">
              <h2>Read-only preview</h2>
              {!selectedArtifact ? (
                <p className="collectors-home-empty">Select a request with a body artifact.</p>
              ) : (
                <>
                  <p className="hint">
                    artifact {selectedArtifact.artifactId} · {selectedArtifact.bodyPath ?? "—"}
                  </p>
                  {preview?.error ? (
                    <p role="alert">{preview.error}</p>
                  ) : (
                    <pre className="csw-preview" aria-label="Artifact preview">
                      {preview?.preview ?? "Loading…"}
                      {preview?.truncated ? "\n…[truncated]" : ""}
                    </pre>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatBodyStatusCounts(
  counts: Partial<Record<string, number>> | undefined,
): string {
  if (!counts) return "—";
  const entries = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0);
  if (!entries.length) return "—";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status}=${n}`)
    .join(" · ");
}
