import React from "react";
import type { PostDetailHtmlExtractionResult } from "../../shared/post-detail-collector/types";

export function HtmlExtractionStep({ result, onBack }: { result: PostDetailHtmlExtractionResult | null; onBack: () => void }) {
  const [view, setView] = React.useState<"html" | "text">("html");
  if (!result) return <div className="pdc-step"><button className="pdc-btn" onClick={onBack}>← Back</button><div className="pdc-alert pdc-alert-warn">Chưa có HTML extraction result.</div></div>;
  return <div className="pdc-step pdc-html-extraction">
    <div className="pdc-section-header"><div><h2>Step 3 — HTML Extraction</h2><p className="pdc-subtitle">Action Row là boundary dưới; permalink/header cùng post là boundary trên.</p></div><button className="pdc-btn" onClick={onBack}>← Back</button></div>
    <div className={`pdc-alert ${result.ok ? "pdc-alert-ok" : "pdc-alert-warn"}`}>Boundary: <strong>{result.status}</strong></div>
    <div className="pdc-card"><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-tiny" onClick={()=>setView("html")}>HTML Preview</button><button className="pdc-btn pdc-btn-tiny" onClick={()=>setView("text")}>Text Preview</button></div><pre className="pdc-code-preview">{view === "html" ? result.extractedHtml : result.textPreview}</pre></div>
    <div className="pdc-card"><div className="pdc-section-header"><h3>Parsed JSON</h3><button className="pdc-btn pdc-btn-tiny" onClick={()=>void navigator.clipboard.writeText(JSON.stringify(result.parsed,null,2))}>Copy JSON</button></div><pre className="pdc-code-preview">{JSON.stringify(result.parsed,null,2)}</pre></div>
    <div className="pdc-card"><h3>Diagnostics</h3><pre className="pdc-code-preview">{JSON.stringify({ diagnostics: result.diagnostics, boundary: result.boundary, evidencePaths: result.evidencePaths },null,2)}</pre></div>
  </div>;
}
