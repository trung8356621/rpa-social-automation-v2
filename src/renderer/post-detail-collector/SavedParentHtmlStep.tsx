import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PostDetailSavedParentResolution } from "../../shared/post-detail-collector/types";
import { COLLECTOR_STORAGE_KEY, type CollectorStoreEnvelope } from "../../shared/collectors/types";
import { collectorReportBrowserHost, collectorSetBrowserVisible } from "../collectors/browser-capture";
import { claimCollectorHostOwner, releaseCollectorHostOwner } from "../collectors/collector-host-owner";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import { extractParentData, relativeXPathForPath, type ExtractedDataItem } from "./extract-parent-data";
import type { Invoke, PostDetailDomVariableMapping } from "./types";

type ExplorerNode = { element: Element; tagName: string; directText: string; textPreview: string; childCount: number; path: number[]; attrs: Record<string, string> };
type VariableOption = { collectorId: string; collectorName: string; id: string; key: string; label: string };
const pathKey = (path: number[]) => path.join("/");
const short = (value: string, max = 120) => value.replace(/\s+/g, " ").trim().slice(0, max);
const relativeXPath = (path: number[]) => `.${path.map(index => `/*[${index + 1}]`).join("")}`;
const relativeSelector = (path: number[]) => path.map(index => `:scope > :nth-child(${index + 1})`).join(" ");

function toNode(element: Element, path: number[]): ExplorerNode {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
  const directText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || "").join(" ");
  return { element, tagName: element.tagName.toLowerCase(), directText: short(directText, 100), textPreview: short(element.textContent || "", 180), childCount: element.children.length, path, attrs };
}
function nodeKind(node: ExplorerNode) {
  if (node.tagName === "img" || node.attrs.src) return "▧ image";
  if (node.tagName === "a" || node.attrs.href) return "↗ link";
  if (node.tagName === "button" || node.attrs.role === "button") return "◉ control";
  return node.directText ? "¶ text" : "◇ node";
}
function TreeNode({ node, expanded, selected, onToggle, onSelect, onFocus, onHover }: { node: ExplorerNode; expanded: Set<string>; selected: string; onToggle: (key: string) => void; onSelect: (node: ExplorerNode) => void; onFocus: (node: ExplorerNode) => void; onHover: (node: ExplorerNode | null) => void }) {
  const key = pathKey(node.path), open = expanded.has(key);
  const children = open ? Array.from(node.element.children).map((child, index) => toNode(child, [...node.path, index])) : [];
  return <li><div className={`pdc-dom-row ${selected === key ? "selected" : ""}`} onClick={() => onSelect(node)} onDoubleClick={() => onFocus(node)} onMouseEnter={() => onHover(node)} onMouseLeave={() => onHover(null)}>
    <button type="button" className="pdc-dom-toggle" disabled={!node.childCount} onClick={event => { event.stopPropagation(); onToggle(key); }}>{node.childCount ? open ? "▾" : "▸" : "·"}</button>
    <code>&lt;{node.tagName}&gt;</code><span>{node.directText || node.textPreview || "—"}</span><small>{nodeKind(node)} · {node.childCount}</small>
  </div>{open && <ul>{children.map(child => <TreeNode key={pathKey(child.path)} node={child} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} onFocus={onFocus} onHover={onHover} />)}</ul>}</li>;
}
function loadVariables(): VariableOption[] {
  try { const data = JSON.parse(localStorage.getItem(COLLECTOR_STORAGE_KEY) || "null") as CollectorStoreEnvelope | null; return (data?.collectors || []).flatMap(collector => collector.variables.map(variable => ({ collectorId: collector.id, collectorName: collector.name, id: variable.id, key: variable.key, label: variable.label }))); } catch { return []; }
}

export function SavedParentHtmlStep({ invoke, result, variableMappings, onVariableMappings, onRematch }: { invoke: Invoke; result: PostDetailSavedParentResolution | null; variableMappings: PostDetailDomVariableMapping[]; onVariableMappings: (mappings: PostDetailDomVariableMapping[]) => void; onRematch: () => void }) {
  const status = result?.status || "NOT_CONFIGURED";
  const hostRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"explorer" | "raw">("explorer");
  const [selectedDataId, setSelectedDataId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ExplorerNode | null>(null);
  const [focusPath, setFocusPath] = useState<number[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [treeRatio, setTreeRatio] = useState(55);
  const [variableId, setVariableId] = useState("");
  const [method, setMethod] = useState<"DOM_TEXT" | "DOM_ATTRIBUTE">("DOM_TEXT");
  const [attribute, setAttribute] = useState("href");
  const variables = useMemo(loadVariables, []);
  const parsed = useMemo(() => {
    if (status !== "PARENT_MATCHED" || !result?.innerHTML || typeof DOMParser === "undefined") return null;
    const doc = new DOMParser().parseFromString("<!doctype html><body></body>", "text/html"), root = doc.createElement("div"); root.innerHTML = result.innerHTML; return root;
  }, [result?.innerHTML, status]);
  const atPath = React.useCallback((path: number[]) => { let node: Element | null = parsed; for (const index of path) node = node?.children.item(index) || null; return node; }, [parsed]);
  const extractedData = useMemo(() => parsed ? extractParentData(parsed) : [], [parsed]);
  const selectedData = extractedData.find(item => item.id === selectedDataId) || null;
  const focusElement = atPath(focusPath);
  const nodes = useMemo(() => focusElement ? [toNode(focusElement, focusPath)] : [], [focusElement, focusPath]);

  useEffect(() => {
    const { ownerId } = claimCollectorHostOwner("pdc-step3"), publish = () => publishPostDetailBrowserHost(invoke, hostRef.current);
    void collectorSetBrowserVisible(invoke, true).then(publish);
    const observer = new ResizeObserver(publish); if (hostRef.current) observer.observe(hostRef.current); window.addEventListener("resize", publish);
    return () => { observer.disconnect(); window.removeEventListener("resize", publish); void invoke({ type: "postDetailClearParentNodeHighlight" }); releaseCollectorHostOwner(ownerId, () => { void collectorReportBrowserHost(invoke, null); void collectorSetBrowserVisible(invoke, false); }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void collectorSetBrowserVisible(invoke, !browserCollapsed); requestAnimationFrame(() => publishPostDetailBrowserHost(invoke, hostRef.current)); }, [browserCollapsed, invoke]);
  useEffect(() => { if (!isExpanded) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") setIsExpanded(false); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [isExpanded]);

  const highlight = (node: ExplorerNode | null) => void invoke(node ? { type: "postDetailHighlightParentNode", path: node.path } : selected ? { type: "postDetailHighlightParentNode", path: selected.path } : { type: "postDetailClearParentNodeHighlight" });
  const choose = (node: ExplorerNode) => { setSelected(node); highlight(node); };
  const focus = (node: ExplorerNode) => { setFocusPath(node.path); setSelected(node); setExpanded(new Set([pathKey(node.path)])); };
  const resetFocus = () => setFocusPath([]);
  const copy = (value: string) => void navigator.clipboard.writeText(value);
  const selectedValue = selected ? method === "DOM_ATTRIBUTE" ? selected.attrs[attribute] || "" : short(selected.element.textContent || "", 2000) : "";
  const selectedMatchCount = selected && parsed ? (() => { const snapshot = parsed.ownerDocument.evaluate(relativeXPath(selected.path), parsed, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return snapshot.snapshotLength; })() : 0;
  const saveMapping = () => {
    if (!selected || !variableId) return; const variable = variables.find(item => `${item.collectorId}:${item.id}` === variableId); if (!variable) return;
    const mapping: PostDetailDomVariableMapping = { collectorId: variable.collectorId, variableId: variable.id, variableKey: variable.key, variableLabel: variable.label, method, attribute: method === "DOM_ATTRIBUTE" ? attribute : undefined, relativePath: selected.path, relativeXPath: relativeXPath(selected.path), preview: selectedValue, confirmed: true, updatedAt: new Date().toISOString() };
    onVariableMappings([...variableMappings.filter(item => !(item.collectorId === mapping.collectorId && item.variableId === mapping.variableId)), mapping]);
  };
  const samePath = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  const mappingForItem = (item: ExtractedDataItem) => variableMappings.find(mapping =>
    item.sourcePaths.some(path => samePath(path, mapping.relativePath)) &&
    (!mapping.sourceContext || mapping.sourceContext === item.context) &&
    mapping.preview === item.value);
  const selectData = (item: ExtractedDataItem) => {
    setSelectedDataId(item.id);
    const mapping = mappingForItem(item);
    setVariableId(mapping ? `${mapping.collectorId}:${mapping.variableId}` : "");
    setMethod(item.attribute ? "DOM_ATTRIBUTE" : "DOM_TEXT");
    setAttribute(item.attribute || "href");
  };
  const applyDataMapping = () => {
    if (!selectedData || selectedData.sourcePaths.length !== 1 || !variableId) return;
    const variable = variables.find(item => `${item.collectorId}:${item.id}` === variableId);
    if (!variable) return;
    const path = selectedData.sourcePaths[0];
    const mapping: PostDetailDomVariableMapping = {
      collectorId: variable.collectorId, variableId: variable.id, variableKey: variable.key, variableLabel: variable.label,
      method: selectedData.attribute ? "DOM_ATTRIBUTE" : "DOM_TEXT", attribute: selectedData.attribute,
      relativePath: path, relativeXPath: relativeXPathForPath(path), preview: selectedData.value,
      sourceContext: selectedData.context, confirmed: true, updatedAt: new Date().toISOString(),
    };
    onVariableMappings([...variableMappings.filter(item => !(item.collectorId === mapping.collectorId && item.variableId === mapping.variableId)), mapping]);
  };
  const unmapData = () => {
    if (!selectedData) return;
    onVariableMappings(variableMappings.filter(mapping => !selectedData.sourcePaths.some(path => samePath(path, mapping.relativePath))));
    setVariableId("");
  };
  const mappingRows = variableMappings.map(mapping => { const element = atPath(mapping.relativePath), value = element ? mapping.method === "DOM_ATTRIBUTE" ? element.getAttribute(mapping.attribute || "") || "" : short(element.textContent || "", 2000) : ""; return { mapping, value, mappingStatus: element ? value ? "Mapped" : "Needs Attention" : "Missing" }; });
  const breadcrumbs = focusPath.map((_, index) => focusPath.slice(0, index + 1));
  const rematch = () => { void invoke({ type: "postDetailClearParentNodeHighlight" }); onRematch(); };

  return <div className={`pdc-step pdc-step3 ${isExpanded ? "pdc-explorer-expanded" : ""}`}>
    <div className="pdc-section-header"><div><h2>Step 3 — Extracted Data Review</h2><p className="pdc-subtitle">AUTO resolves the saved Parent and shows meaningful DOM values without wrapper markup.</p></div><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-secondary" onClick={() => setIsExpanded(value => !value)}>{isExpanded ? "Restore" : "Expand"}</button><button className="pdc-btn pdc-btn-secondary" onClick={rematch}>Customize · Rematch Parent</button></div></div>
    <div className={`pdc-alert ${status === "PARENT_MATCHED" ? "pdc-alert-ok" : "pdc-alert-warn"}`}>{status === "PARENT_MATCHED" ? "AUTO · Parent Matched" : status === "RESOLVING" ? "AUTO · Resolving Parent..." : `Needs Attention · ${result?.failureCode || status}`}</div>
    {result?.diagnostics.map(item => <p key={item} className="pdc-panel-desc">{item}</p>)}
    {status !== "NOT_CONFIGURED" && <div className={`pdc-dom-workspace ${browserCollapsed ? "browser-collapsed" : ""}`}><div className="pdc-dom-browser-wrap"><button className="pdc-btn pdc-btn-tiny" onClick={() => setBrowserCollapsed(value => !value)}>{browserCollapsed ? "Show Browser Preview" : "Collapse Browser Preview"}</button>{!browserCollapsed && <div ref={hostRef} className="pdc-browser-host pdc-dom-browser" data-browser-core-host="" />}</div><div className="pdc-dom-panel">
      {status === "PARENT_MATCHED" ? <><div className={`pdc-data-review ${selectedData ? "has-detail" : ""}`}>
        <div className="pdc-data-list" aria-label="Extracted values">
          <div className="pdc-data-list-header"><h3>Extracted values</h3><span>{extractedData.length} values</span></div>
          {extractedData.length ? extractedData.map(item => {
            const mapping = mappingForItem(item);
            const mappingStatus = item.sourcePaths.length > 1 ? "Needs Attention" : mapping ? "Auto Mapped" : "Unmapped";
            return <button key={item.id} type="button" title={item.label || item.value} className={`pdc-data-tag status-${mappingStatus.toLowerCase().replace(/\s+/g, "-")} ${selectedDataId === item.id ? "selected" : ""}`} onClick={() => selectData(item)} onMouseEnter={() => { if (item.sourcePaths.length === 1) void invoke({ type: "postDetailHighlightParentNode", path: item.sourcePaths[0] }); }} onMouseLeave={() => { void invoke({ type: "postDetailClearParentNodeHighlight" }); }}>
              <span className="pdc-data-value">{item.label || item.value}</span>
            </button>;
          }) : <p className="pdc-panel-desc">No meaningful DOM values were extracted from this Parent.</p>}
        </div>
        {selectedData && <div className="pdc-extracted-detail"><h3>Value detail</h3>
          <dl className="pdc-kv"><dt>Value</dt><dd>{selectedData.value}</dd><dt>Type</dt><dd>{selectedData.predictedType || selectedData.kind}</dd><dt>Context</dt><dd>{selectedData.context}</dd><dt>Source</dt><dd>{selectedData.sourcePaths.length === 1 ? "Unique DOM node" : `${selectedData.sourcePaths.length} nodes · Needs Attention`}</dd></dl>
          <p className="pdc-data-detail-status">{selectedData.sourcePaths.length > 1 ? "Needs Attention" : mappingForItem(selectedData) ? `Auto Mapped → ${mappingForItem(selectedData)?.variableLabel}` : "Unmapped"}</p>
          {variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`}>{variable.collectorName} · {variable.label} ({variable.key})</option>)}</select><p>Preview: {selectedData.value}</p><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-primary" disabled={!variableId || selectedData.sourcePaths.length !== 1} onClick={applyDataMapping}>{mappingForItem(selectedData) ? "Change Mapping" : "Apply Mapping"}</button><button className="pdc-btn pdc-btn-secondary" disabled={!mappingForItem(selectedData)} onClick={unmapData}>Unmap</button></div></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}
        </div>}
      </div><details className="pdc-advanced-debug"><summary>Advanced Debug</summary><div className="pdc-btn-row"><button className={`pdc-btn pdc-btn-tiny ${tab === "explorer" ? "active" : ""}`} onClick={() => setTab("explorer")}>DOM Explorer</button><button className={`pdc-btn pdc-btn-tiny ${tab === "raw" ? "active" : ""}`} onClick={() => setTab("raw")}>Raw HTML</button><button className="pdc-btn pdc-btn-tiny" disabled={!focusPath.length} onClick={resetFocus}>Reset Focus</button></div>
      {tab === "raw" ? <pre className="pdc-code-preview">{result?.innerHTML}</pre> : <><div className="pdc-dom-breadcrumb"><button onClick={resetFocus}>Root</button>{breadcrumbs.map(path => <button key={pathKey(path)} onClick={() => setFocusPath(path)}>› {atPath(path)?.tagName.toLowerCase()}</button>)}</div><label className="pdc-split-control">Tree width <input type="range" min="30" max="75" value={treeRatio} onChange={event => setTreeRatio(Number(event.target.value))} /></label><div className="pdc-dom-columns" style={{ gridTemplateColumns: `${treeRatio}fr ${100 - treeRatio}fr` }}><div className="pdc-dom-tree"><ul>{nodes.map(node => <TreeNode key={pathKey(node.path)} node={node} expanded={expanded} selected={selected ? pathKey(selected.path) : ""} onToggle={key => setExpanded(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} onSelect={choose} onFocus={focus} onHover={highlight} />)}</ul></div><div className="pdc-dom-inspector"><h3>Inspector</h3>{selected ? <>
        <section><h4>Attributes</h4><dl className="pdc-kv">{Object.entries(selected.attrs).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value}</dd></React.Fragment>)}</dl></section>
        <section><h4>Text</h4><p>{selected.directText || selected.textPreview || "—"}</p><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(selected.element.textContent || "")}>Copy Text</button><details><summary>Full text</summary><pre>{selected.element.textContent}</pre></details><details><summary>outerHTML</summary><pre>{selected.element.outerHTML}</pre></details></section>
        <section><h4>Selector</h4><code>{relativeXPath(selected.path)}</code><div className="pdc-btn-row"><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeXPath(selected.path))}>Copy XPath</button><button className="pdc-btn pdc-btn-tiny" onClick={() => copy(relativeSelector(selected.path))}>Copy Selector</button></div></section>
        <section><h4>Variables</h4>{variables.length ? <><select value={variableId} onChange={event => setVariableId(event.target.value)}><option value="">Select existing variable…</option>{variables.map(variable => <option key={`${variable.collectorId}:${variable.id}`} value={`${variable.collectorId}:${variable.id}`}>{variable.collectorName} · {variable.label} ({variable.key})</option>)}</select><select value={method} onChange={event => setMethod(event.target.value as typeof method)}><option value="DOM_TEXT">text</option><option value="DOM_ATTRIBUTE">attribute</option></select>{method === "DOM_ATTRIBUTE" && <input value={attribute} onChange={event => setAttribute(event.target.value)} placeholder="href" />}<p>Preview: {selectedValue || "Missing / Needs Attention"}</p><p>Locator matches: {selectedMatchCount} {selectedMatchCount === 1 ? "· verified" : "· Needs Attention"}</p><button className="pdc-btn pdc-btn-primary" disabled={!variableId || !selectedValue || selectedMatchCount !== 1} onClick={saveMapping}>Confirm Mapping</button></> : <p className="pdc-panel-desc">No existing Collector variables. Create schema in Collectors first.</p>}</section>
      </> : <p className="pdc-panel-desc">Chọn một node. Double-click để Focus Root.</p>}</div></div><section className="pdc-variable-status"><h3>Confirmed mappings</h3>{mappingRows.length ? mappingRows.map(({ mapping, value, mappingStatus }) => <div key={`${mapping.collectorId}:${mapping.variableId}`}><b>{mapping.variableLabel}</b> · <span>{mappingStatus}</span> · {value || "—"}</div>) : <p className="pdc-panel-desc">Unmapped · chưa có mapping đã xác nhận.</p>}</section></>}</details></> : <div><h3>Parent resolution failed</h3><p className="pdc-panel-desc">AUTO did not accept a Parent without identity, Action Row ownership, and Parent validation.</p>{result?.diagnosticMeta && <pre className="pdc-code-preview">{JSON.stringify(result.diagnosticMeta, null, 2)}</pre>}</div>}
    </div></div>}
  </div>;
}
