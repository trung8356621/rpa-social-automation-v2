import React, { useRef, useState } from "react";
import type { Rect } from "../../../../experiments/visual-match-lab/src/types";
import type { LiveCapture } from "./types";

export type LiveIconKind = "like" | "comment" | "share";
export type LiveIconTemplate = { kind: LiveIconKind; dataUrl: string; width: number; height: number; sourceFrameId: string; bbox: Rect };
export type LiveIconTemplates = Partial<Record<LiveIconKind, LiveIconTemplate>>;
export const LIVE_TEMPLATE_KEY = "visual_match_lab_live_templates_v1";

import defaultRealTemplates from "./default-real-templates.json";

export const loadLiveTemplates = (): LiveIconTemplates => {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_TEMPLATE_KEY) ?? "{}");
    return { ...(defaultRealTemplates as LiveIconTemplates), ...saved };
  } catch {
    return defaultRealTemplates as LiveIconTemplates;
  }
};

export function LiveTemplateCalibration({ captures, templates, onChange, onRerun, running }: { captures: LiveCapture[]; templates: LiveIconTemplates; onChange: (templates: LiveIconTemplates) => void; onRerun: () => void; running: boolean }) {
  const [frameId, setFrameId] = useState(captures[0]?.id ?? ""); const [kind, setKind] = useState<LiveIconKind>("like"); const [rect, setRect] = useState<Rect | null>(null); const start = useRef<{ x: number; y: number } | null>(null);
  const capture = captures.find(item => item.id === frameId) ?? captures[0];
  const point = (event: React.PointerEvent<HTMLDivElement>) => { const bounds = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(capture.width, (event.clientX - bounds.left) * capture.width / bounds.width)), y: Math.max(0, Math.min(capture.height, (event.clientY - bounds.top) * capture.height / bounds.height)) }; };
  const save = async () => {
    if (!capture || !rect || rect.width < 4 || rect.height < 4) return;
    const image = new Image(); image.src = capture.dataUrl; await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("FRAME_IMAGE_LOAD_FAILED")); });
    const crop = document.createElement("canvas"); crop.width = Math.round(rect.width); crop.height = Math.round(rect.height); crop.getContext("2d")!.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, crop.width, crop.height);
    const next = { ...templates, [kind]: { kind, dataUrl: crop.toDataURL("image/png"), width: crop.width, height: crop.height, sourceFrameId: capture.id, bbox: rect } };
    localStorage.setItem(LIVE_TEMPLATE_KEY, JSON.stringify(next)); onChange(next); setRect(null);
  };
  if (!capture) return <div className="live-template-calibration"><b>Create Facebook templates</b><p>Run Live Scroll Test once to capture evidence frames.</p></div>;
  const ready = Boolean(templates.like && templates.comment && templates.share);
  return <div className="live-template-calibration">
    <h3>Facebook Template Calibration</h3><p>Select an evidence frame, choose an icon type, then drag tightly around the POST icon. Provisional groups are never accepted automatically.</p>
    <div className="template-controls"><select value={capture.id} onChange={event => { setFrameId(event.target.value); setRect(null); }}>{captures.map((item, index) => <option key={item.id} value={item.id}>Frame {index + 1} · scrollY={item.viewport.scrollY}</option>)}</select>{(["like", "comment", "share"] as LiveIconKind[]).map(value => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setRect(null); }}>{value.toUpperCase()}</button>)}<button disabled={!rect} onClick={() => void save()}>Save {kind} crop</button></div>
    <div className="template-crop-surface" onPointerDown={event => { start.current = point(event); setRect({ ...start.current, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!start.current) return; const end = point(event), x = Math.min(start.current.x, end.x), y = Math.min(start.current.y, end.y); setRect({ x, y, width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) }); }} onPointerUp={event => { if (start.current) setRect(current => current && ({ ...current, x: Math.round(current.x), y: Math.round(current.y), width: Math.round(current.width), height: Math.round(current.height) })); start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}>
      <img src={capture.dataUrl} alt="Evidence frame for template crop" draggable={false} />{rect && <span style={{ left: `${rect.x / capture.width * 100}%`, top: `${rect.y / capture.height * 100}%`, width: `${rect.width / capture.width * 100}%`, height: `${rect.height / capture.height * 100}%` }} />}
    </div>
    <div className="template-previews">{(["like", "comment", "share"] as LiveIconKind[]).map(value => <div key={value}><b>{value}</b>{templates[value] ? <img src={templates[value]!.dataUrl} alt={`${value} template`} /> : <span>MISSING</span>}</div>)}</div>
    <button disabled={!ready || running} onClick={onRerun}>Re-run Stage E on Existing Frames</button><strong>{ready ? "TEMPLATE_READY: three confirmed Facebook icon crops" : "TEMPLATE_NOT_READY: crop Like, Comment and Share"}</strong>
  </div>;
}
