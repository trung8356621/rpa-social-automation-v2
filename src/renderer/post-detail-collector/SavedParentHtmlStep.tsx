import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import { collectorReportBrowserHost, collectorSetBrowserVisible } from "../collectors/browser-capture";
import { claimCollectorHostOwner, releaseCollectorHostOwner } from "../collectors/collector-host-owner";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import type { Invoke } from "./types";

type ExplorerNode = { tagName: string; directText: string; textContent: string; childCount: number; path: number[]; attrs: Record<string, string>; children: ExplorerNode[] };
const pathKey = (path: number[]) => path.join("/");
const short = (value: string, max = 120) => value.replace(/\s+/g, " ").trim().slice(0, max);

function toNode(element: Element, path: number[]): ExplorerNode {
  const attrs: Record<string, string> = {};
  for (const name of ["href", "src", "alt", "role", "aria-label"]) {
    const value = element.getAttribute(name);
    if (value) attrs[name] = value;
  }
  const directText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || "").join(" ");
  const children = Array.from(element.children).map((child, index) => toNode(child, [...path, index]));
  return { tagName: element.tagName.toLowerCase(), directText: short(directText, 70), textContent: short(element.textContent || "", 300), childCount: children.length, path, attrs, children };
}

function TreeNode({ node, expanded, selected, onToggle, onSelect }: { node: ExplorerNode; expanded: Set<string>; selected: string; onToggle: (key: string) => void; onSelect: (node: ExplorerNode) => void }) {
  const key = pathKey(node.path), open = expanded.has(key);
  return <li><div className={`pdc-dom-row ${selected === key ? "selected" : ""}`} onClick={() => onSelect(node)}>
    <button type="button" className="pdc-dom-toggle" disabled={!node.childCount} onClick={(event) => { event.stopPropagation(); onToggle(key); }}>{node.childCount ? (open ? "▾" : "▸") : "·"}</button>
    <code>&lt;{node.tagName}&gt;</code><span>{node.directText || "—"}</span><small>{node.childCount}</small>
  </div>{open && node.children.length > 0 && <ul>{node.children.map(child => <TreeNode key={pathKey(child.path)} node={child} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />)}</ul>}</li>;
}

export function SavedParentHtmlStep({ invoke, result, onRematch }: { invoke: Invoke; result: PostDetailSavedParentResolution | null; onRematch: () => void }) {
  const status = result?.status || "NOT_CONFIGURED";
  const hostRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"explorer" | "raw">("explorer");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ExplorerNode | null>(null);
  const nodes = useMemo(() => {
    if (status !== "PARENT_MATCHED" || !result?.innerHTML || typeof DOMParser === "undefined") return [];
    const doc = new DOMParser().parseFromString("<!doctype html><body></body>", "text/html");
    const root = doc.createElement("div");
    root.innerHTML = result.innerHTML;
    return Array.from(root.children).map((child, index) => toNode(child, [index]));
  }, [result?.innerHTML, status]);

  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-step3");
    const publish = () => publishPostDetailBrowserHost(invoke, hostRef.current);
    void collectorSetBrowserVisible(invoke, true).then(publish);
    const observer = new ResizeObserver(publish);
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); void invoke({ type: "postDetailClearParentNodeHighlight" }); releaseCollectorHostOwner(ownerId, () => { void collectorReportBrowserHost(invoke, null); void collectorSetBrowserVisible(invoke, false); }); };
    // The BrowserCore host belongs to this Step 3 mount, including RESOLVING.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (node: ExplorerNode) => { setSelected(node); void invoke({ type: "postDetailHighlightParentNode", path: node.path }); };
  const rematch = () => { void invoke({ type: "postDetailClearParentNodeHighlight" }); onRematch(); };

  return <div className="pdc-step">
    <div className="pdc-section-header"><div><h2>Step 3 — Parent DOM Explorer</h2><p className="pdc-subtitle">Tree chỉ chứa element descendants của Parent đã xác thực.</p></div><button type="button" className="pdc-btn pdc-btn-secondary" onClick={rematch}>Rematch Parent</button></div>
    <div className={`pdc-alert ${status === "PARENT_MATCHED" ? "pdc-alert-ok" : "pdc-alert-warn"}`}>{status === "PARENT_MATCHED" ? "Parent Matched" : status === "RESOLVING" ? "Resolving Parent..." : status === "REMATCH_REQUIRED" ? `Rematch Required${result?.failureCode ? ` · ${result.failureCode}` : ""}` : status === "BROWSER_NOT_READY" ? "Browser Not Ready" : "Not Configured"}</div>
    {result?.diagnostics.map(item => <p key={item} className="pdc-panel-desc">{item}</p>)}
    {status !== "NOT_CONFIGURED" && <div className="pdc-dom-workspace"><div ref={hostRef} className="pdc-browser-host pdc-dom-browser" data-browser-core-host="" /><div className="pdc-dom-panel">
      {status === "PARENT_MATCHED" ? <><div className="pdc-btn-row"><button type="button" className={`pdc-btn pdc-btn-tiny ${tab === "explorer" ? "active" : ""}`} onClick={() => setTab("explorer")}>DOM Explorer</button><button type="button" className={`pdc-btn pdc-btn-tiny ${tab === "raw" ? "active" : ""}`} onClick={() => setTab("raw")}>Raw HTML</button></div>
      {tab === "raw" ? <pre className="pdc-code-preview">{result?.innerHTML}</pre> : <div className="pdc-dom-columns"><div className="pdc-dom-tree"><ul>{nodes.map(node => <TreeNode key={pathKey(node.path)} node={node} expanded={expanded} selected={selected ? pathKey(selected.path) : ""} onToggle={(key) => setExpanded(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} onSelect={choose} />)}</ul></div><div className="pdc-dom-inspector"><h3>Inspector</h3>{selected ? <dl className="pdc-kv"><dt>tagName</dt><dd>{selected.tagName}</dd><dt>textContent</dt><dd>{selected.textContent || "—"}</dd>{Object.entries(selected.attrs).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}<dt>path</dt><dd>{pathKey(selected.path)}</dd><dt>children</dt><dd>{selected.childCount}</dd></dl> : <p className="pdc-panel-desc">Chọn một node trong tree.</p>}</div></div>}</> : <div><h3>{status === "RESOLVING" ? "Resolving Parent..." : "Parent resolution failed"}</h3><p className="pdc-panel-desc">BrowserCore remains live while the saved locator is validated.</p>{result?.diagnosticMeta && <pre className="pdc-code-preview">{JSON.stringify(result.diagnosticMeta, null, 2)}</pre>}</div>}
    </div></div>}
  </div>;
}
