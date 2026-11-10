import React, { useEffect, useRef, useState } from 'react';
import { TemplateMatcher } from './cv/template-matcher';
import type { DomMetadata, LabCandidate, LiveCapture, MatchMethod } from './types';

const button: React.CSSProperties = { padding: '8px 12px', border: '1px solid #475569', borderRadius: 4, background: '#334155', color: '#fff', cursor: 'pointer' };

async function canvasFrom(src: string) {
  const image = new Image(); image.src = src;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Image load failed')); });
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(image, 0, 0); return canvas;
}

export function LiveDomLab() {
  const [status, setStatus] = useState('Connecting to Creator V2 BrowserCore…');
  const [source, setSource] = useState<{ id: number; url: string } | null>(null);
  const [capture, setCapture] = useState<LiveCapture | null>(null);
  const [template, setTemplate] = useState<string>();
  const [method, setMethod] = useState<MatchMethod>('grayscale');
  const [threshold, setThreshold] = useState(.72);
  const [matches, setMatches] = useState<LabCandidate[]>([]);
  const [selected, setSelected] = useState(-1);
  const [dom, setDom] = useState<DomMetadata | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { void window.liveDomLab?.state().then((state) => {
    if (!state.connected || !state.loggedIn) throw new Error('FACEBOOK_NOT_LOGGED_IN');
    setSource({ id: state.webContentsId, url: state.url });
    setStatus(`CONNECTED · Creator BrowserCore webContents.id=${state.webContentsId} · Facebook logged in`);
  }).catch((error) => setStatus(String(error))); }, []);

  useEffect(() => {
    if (!capture || !canvasRef.current) return;
    void canvasFrom(capture.dataUrl).then((image) => {
      const canvas = canvasRef.current!; canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      matches.forEach((match, index) => {
        ctx.strokeStyle = index === selected ? '#ef4444' : '#f97316'; ctx.lineWidth = index === selected ? 4 : 2;
        ctx.strokeRect(match.bbox.x, match.bbox.y, match.bbox.width, match.bbox.height);
        ctx.fillStyle = ctx.strokeStyle; ctx.font = 'bold 12px sans-serif'; ctx.fillText(`#${index + 1} ${(match.score * 100).toFixed(1)}%`, match.bbox.x, Math.max(12, match.bbox.y - 3));
      });
    });
  }, [capture, matches, selected]);

  const captureBrowserCore = async () => {
    try {
      const next = await window.liveDomLab!.capture();
      if (source && next.webContentsId !== source.id) throw new Error('WRONG_BROWSER_INSTANCE');
      setSource({ id: next.webContentsId, url: next.viewport.url }); setCapture(next); setMatches([]); setSelected(-1); setDom(null);
      setStatus(`CAPTURED · webContents.id=${next.webContentsId} · scrollY=${next.viewport.scrollY}`);
    } catch (error) { setStatus(String(error)); }
  };
  const runMatch = async () => {
    if (!capture || !template) return setStatus('Capture BrowserCore and choose an icon template first.');
    try {
      const [templateCanvas, targetCanvas] = await Promise.all([canvasFrom(template), canvasFrom(capture.dataUrl)]);
      const result = await TemplateMatcher.match(templateCanvas, targetCanvas, method, threshold);
      setMatches(result.matches); setSelected(result.matches.length ? 0 : -1); setDom(null);
      setStatus(`${result.matches.length} visual candidates · ${result.timeMs.toFixed(1)} ms · DOM verification pending`);
    } catch (error) { setStatus(String(error)); }
  };
  const requestFor = (index: number) => {
    if (!capture || index < 0) return null; const b = matches[index].bbox;
    return { webContentsId: capture.webContentsId, point: { x: (b.x + b.width / 2) * capture.viewport.width / capture.width, y: (b.y + b.height / 2) * capture.viewport.height / capture.height } };
  };
  const inspect = async (index: number) => {
    const request = requestFor(index); if (!request) return;
    try {
      const response = await window.liveDomLab!.inspect(request); if (response.webContentsId !== request.webContentsId) throw new Error('WRONG_BROWSER_INSTANCE');
      setSelected(index); setDom(response.element); setMatches((old) => old.map((item, i) => i === index ? { ...item, dom: response.element, status: response.element?.clickable ? 'DOM_MAPPED' : 'NO_CLICKABLE_ANCESTOR' } : item));
      setStatus(response.element ? `DOM mapped on webContents.id=${response.webContentsId} · context=${response.element.context}` : 'No DOM element at match center.');
    } catch (error) { setStatus(String(error)); }
  };
  const highlight = async () => { const request = requestFor(selected); if (!request) return; try { const response = await window.liveDomLab!.highlight(request); setStatus(response.highlighted ? `HIGHLIGHTED on Creator BrowserCore webContents.id=${response.webContentsId}` : 'No element to highlight.'); } catch (error) { setStatus(String(error)); } };
  const parent = async () => { const request = requestFor(selected); if (!request) return; try { const response = await window.liveDomLab!.inspectParent(request); setDom(response.element); setStatus(response.element ? `Parent inspected on webContents.id=${response.webContentsId}` : 'No parent.'); } catch (error) { setStatus(String(error)); } };
  const scroll = async () => { if (!source) return; try { await window.liveDomLab!.scroll({ webContentsId: source.id, deltaY: 650 }); setCapture(null); setMatches([]); setSelected(-1); setDom(null); setStatus('BrowserCore scrolled. Capture again; old coordinates were invalidated.'); } catch (error) { setStatus(String(error)); } };

  return <div style={{ padding: '16px 24px', maxWidth: 1500, margin: '0 auto' }}>
    <header style={{ paddingBottom: 16, borderBottom: '1px solid #475569', marginBottom: 20 }}><h1 style={{ fontSize: 20 }}>RPA — Visual Image Recognition Lab</h1><p style={{ color: '#94a3b8', marginTop: 4 }}>Creator BrowserCore Screenshot → Stage E Visual Matching → DOM Verification</p></header>
    <div style={{ padding: 10, border: `1px solid ${source ? '#059669' : '#dc2626'}`, color: source ? '#34d399' : '#f87171', borderRadius: 5 }}>{status}</div>
    <section style={{ marginTop: 16, background: '#1e293b', border: '1px solid #475569', borderRadius: 8, padding: 16 }}>
      <h2 style={{ fontSize: 14, textTransform: 'uppercase' }}>Stage E: Visual Template Matching (Live BrowserCore)</h2>
      <p style={{ margin: '8px 0', color: '#94a3b8' }}>{source ? `Source: webContents.id=${source.id} · ${source.url}` : 'Creator V2 BrowserCore is required. No fallback browser will be opened.'}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={button} onClick={() => void captureBrowserCore()}>Capture BrowserCore</button>
        <label style={button}>Choose Icon Template<input type="file" accept="image/*" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) setTemplate(URL.createObjectURL(file)); }} /></label>
        <select value={method} onChange={(e) => setMethod(e.target.value as MatchMethod)} style={button}><option value="grayscale">Grayscale Normalized Cross-Correlation</option><option value="normxcorr">Norm XCorr</option><option value="edge">Edge</option><option value="masked">Masked</option></select>
        <label>Threshold <input type="number" min="0" max="1" step=".01" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 62 }} /></label>
        <button style={{ ...button, background: '#0369a1' }} onClick={() => void runMatch()}>Run Visual Match</button>
        <button style={button} onClick={() => void scroll()}>Scroll +650</button>
      </div>
      <div style={{ marginTop: 14, background: '#000', maxHeight: 560, overflow: 'auto' }}><canvas ref={canvasRef} style={{ maxWidth: '100%', display: 'block', cursor: 'crosshair' }} onClick={(e) => { const canvas = canvasRef.current!; const r = canvas.getBoundingClientRect(); const x = (e.clientX - r.left) * canvas.width / r.width; const y = (e.clientY - r.top) * canvas.height / r.height; const index = matches.findIndex((m) => x >= m.bbox.x && x <= m.bbox.x + m.bbox.width && y >= m.bbox.y && y <= m.bbox.y + m.bbox.height); if (index >= 0) void inspect(index); }} /></div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><button style={button} onClick={() => void highlight()}>Highlight DOM</button><button style={button} onClick={() => void parent()}>Inspect Parent</button></div>
      <table style={{ width: '100%', marginTop: 12, fontSize: 12, borderCollapse: 'collapse' }}><thead><tr><th>Rank</th><th>Score</th><th>Coordinates</th><th>DOM element</th><th>Context</th><th>Status</th></tr></thead><tbody>{matches.map((m, i) => <tr key={m.id} onClick={() => void inspect(i)} style={{ cursor: 'pointer', background: i === selected ? 'rgba(239,68,68,.12)' : undefined }}><td>#{i + 1}</td><td>{(m.score * 100).toFixed(1)}%</td><td>({m.bbox.x}, {m.bbox.y})</td><td>{m.dom?.tag || 'not inspected'}</td><td>{m.dom?.context || '—'}</td><td>{m.status || 'VISUAL_ONLY'}</td></tr>)}</tbody></table>
    </section>
    <section style={{ marginTop: 16, background: '#1e293b', border: '1px solid #475569', borderRadius: 8, padding: 16 }}><h2 style={{ fontSize: 14, textTransform: 'uppercase' }}>Verification Report</h2><pre style={{ marginTop: 10, padding: 10, background: '#111827', whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify({ browserCoreWebContentsId: source?.id ?? null, screenshotWebContentsId: capture?.webContentsId ?? null, screenshotSourceVerified: Boolean(source && capture && source.id === capture.webContentsId), visualMatchScore: selected >= 0 ? matches[selected]?.score : null, domSourceVerified: Boolean(dom && source && capture && source.id === capture.webContentsId), domElement: dom && { tag: dom.tag, role: dom.role, label: dom.ariaLabel, rect: dom.rect }, clickableAncestor: dom?.clickable, context: dom?.context, pass: Boolean(dom && matches[selected]?.score !== undefined && source && capture && source.id === capture.webContentsId) }, null, 2)}</pre></section>
  </div>;
}
