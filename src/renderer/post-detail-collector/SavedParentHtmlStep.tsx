import React from "react";
import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";

export function SavedParentHtmlStep({ result, onRematch }: { result: PostDetailSavedParentResolution | null; onRematch: () => void }) {
  const status = result?.status || "NOT_CONFIGURED";
  return <div className="pdc-step">
    <div className="pdc-section-header"><div><h2>Step 3 — Parent HTML</h2><p className="pdc-subtitle">Chỉ hiển thị innerHTML của Parent đã resolve và xác thực.</p></div><button type="button" className="pdc-btn pdc-btn-secondary" onClick={onRematch}>Rematch Parent</button></div>
    <div className={`pdc-alert ${status === "PARENT_MATCHED" ? "pdc-alert-ok" : "pdc-alert-warn"}`}>{status === "PARENT_MATCHED" ? "Parent Matched" : status === "REMATCH_REQUIRED" ? "Rematch Required" : "Not Configured"}</div>
    {result?.diagnostics.map(item => <p key={item} className="pdc-panel-desc">{item}</p>)}
    {status === "PARENT_MATCHED" && <pre className="pdc-code-preview">{result?.innerHTML}</pre>}
  </div>;
}
