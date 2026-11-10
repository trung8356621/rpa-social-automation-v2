import React, { useEffect, useState } from "react";
import type { Command } from "../../../shared/contracts";
import { App as OriginalVisualMatchLab } from "../../../../experiments/visual-match-lab/src/App";
import type { FixtureItem } from "../../../../experiments/visual-match-lab/src/fixtures/fixture-manager";
import type { MatchCandidate } from "../../../../experiments/visual-match-lab/src/types";
import type { DomElement, LiveCapture } from "./types";
import { MultiItemRecognition } from "./MultiItemRecognition";
import { LiveScrollTest } from "./LiveScrollTest";
import "./visual-match-lab.css";

type Invoke = <T>(command: Command) => Promise<T>;
type LabState = { connected: boolean; loggedIn: boolean; webContentsId: number; url: string };
const control: React.CSSProperties = { padding: "7px 10px", border: "1px solid #46566b", borderRadius: 4, background: "#26364a", color: "#eef4fb" };

export function VisualMatchLabPage({ invoke }: { invoke: Invoke }) {
  const [connection, setConnection] = useState<LabState | null>(null);
  const [capture, setCapture] = useState<LiveCapture | null>(null);
  const [target, setTarget] = useState<FixtureItem | null>(null);
  const [selected, setSelected] = useState<MatchCandidate | null>(null);
  const [dom, setDom] = useState<DomElement | null>(null);
  const [status, setStatus] = useState("Đang kiểm tra BrowserCore…");

  useEffect(() => { let active = true; void invoke<LabState>({ type: "visualMatchLabState" }).then(value => { if (active) { setConnection(value); setStatus(`CONNECTED · BrowserCore webContents.id=${value.webContentsId} · Facebook logged in`); } }).catch(error => { if (active) setStatus(String(error)); }); return () => { active = false; }; }, []);
  const takeCapture = async () => { try { const next = await invoke<LiveCapture>({ type: "visualMatchLabCapture" }); if (connection && next.webContentsId !== connection.webContentsId) throw new Error("WRONG_BROWSER_INSTANCE"); setConnection({ connected: true, loggedIn: true, webContentsId: next.webContentsId, url: next.viewport.url }); setCapture(next); setTarget({ id: next.id, name: `BrowserCore #${next.webContentsId}`, description: next.viewport.url, width: next.width, height: next.height, isRealFixture: true, dataUrl: next.dataUrl }); setSelected(null); setDom(null); setStatus(`CAPTURED · webContents.id=${next.webContentsId} · scrollY=${next.viewport.scrollY}`); } catch (error) { setStatus(String(error)); } };
  const request = () => { if (!capture || !selected) return null; const box = selected.bbox; return { captureId: capture.id, webContentsId: capture.webContentsId, point: { x: (box.x + box.width / 2) * capture.viewport.width / capture.width, y: (box.y + box.height / 2) * capture.viewport.height / capture.height } }; };
  const inspect = async (parent = false) => { const value = request(); if (!value) return; try { const result = await invoke<{ webContentsId: number; element: DomElement | null }>({ type: "visualMatchLabInspect", ...value, parent }); if (result.webContentsId !== value.webContentsId) throw new Error("WRONG_BROWSER_INSTANCE"); setDom(result.element); setStatus(result.element ? `DOM ${result.element.tag} · ${result.element.context} · webContents.id=${result.webContentsId}` : "Không có DOM element tại tâm candidate."); } catch (error) { setStatus(String(error)); } };
  const highlight = async () => { const value = request(); if (!value) return; try { const result = await invoke<{ webContentsId: number; highlighted: boolean }>({ type: "visualMatchLabHighlight", ...value }); setStatus(result.highlighted ? `Highlighted trên BrowserCore webContents.id=${result.webContentsId}` : "Không tìm thấy element để highlight."); } catch (error) { setStatus(String(error)); } };
  const scroll = async () => { if (!connection) return; try { await invoke({ type: "visualMatchLabScroll", webContentsId: connection.webContentsId, deltaY: 650 }); setCapture(null); setTarget(null); setSelected(null); setDom(null); setStatus("Đã scroll BrowserCore; candidates cũ đã bị vô hiệu. Capture lại để tiếp tục."); } catch (error) { setStatus(String(error)); } };

  return <section className="app-page visual-match-lab-page" aria-label="Visual Match Lab">
    <div className="page-heading"><h1>Visual Match Lab</h1><p>Full image pipeline → Stage E BrowserCore target → DOM Verification</p></div>
    <div className={connection ? "collector-banner ok" : "collector-banner error"} role="status">{status}</div>
    <div style={{ display: "flex", gap: 8, margin: "10px 0", alignItems: "center" }}><button style={control} onClick={() => void takeCapture()}>Capture BrowserCore</button><button style={control} onClick={() => void scroll()}>Scroll +650</button><code>{connection ? `webContents.id=${connection.webContentsId} · ${connection.url}` : "No fallback browser/session"}</code></div>
    <OriginalVisualMatchLab liveMode liveTarget={target} onSelectLiveMatch={match => { setSelected(match); setDom(null); setStatus(`Selected candidate ${(match.score * 100).toFixed(1)}% · DOM verification pending`); }} renderAfterPipeline={({ currentFixture, targetImage, matches, actionGroups, matchMethod, matchThreshold }) => <>
      <MultiItemRecognition invoke={invoke} targetImage={targetImage} matches={matches} actionGroups={actionGroups} />
      <LiveScrollTest invoke={invoke} currentFixture={currentFixture} actionGroups={actionGroups} method={matchMethod} threshold={matchThreshold} />
    </>} />
    <div className="card" style={{ padding: 16, marginTop: 12 }}><h2 style={{ fontSize: 14 }}>DOM Verification</h2><div style={{ display: "flex", gap: 8 }}><button style={control} onClick={() => void inspect(false)}>Inspect Match</button><button style={control} onClick={() => void inspect(true)}>Inspect Parent</button><button style={control} onClick={() => void highlight()}>Highlight DOM</button></div><pre>{JSON.stringify({ browserCoreWebContentsId: connection?.webContentsId ?? null, screenshotWebContentsId: capture?.webContentsId ?? null, screenshotSourceVerified: Boolean(connection && capture && connection.webContentsId === capture.webContentsId), visualMatchScore: selected?.score ?? null, domElement: dom && { tag: dom.tag, role: dom.role, label: dom.ariaLabel, rect: dom.rect }, clickableAncestor: dom?.clickable, context: dom?.context, pass: Boolean(dom && selected && connection && capture && connection.webContentsId === capture.webContentsId) }, null, 2)}</pre></div>
  </section>;
}
